/**
 * QQ 开放平台「扫码绑定机器人」流程。
 *
 * 复刻自 Hermes Agent 的 `gateway/platforms/qqbot/onboard.py` + `crypto.py`
 * （腾讯未公开的 lite 接口）：
 *
 *   1. POST https://{portal}/lite/create_bind_task   {"key": base64(32B)}
 *   2. 二维码内容 https://q.qq.com/qqbot/openclaw/connect.html?task_id=...&_wv=2&source=...
 *   3. 每 2s POST https://{portal}/lite/poll_bind_result {"task_id"}
 *      → data{status, bot_appid, bot_encrypt_secret, user_openid}
 *   4. bot_encrypt_secret = base64(IV(12) ‖ ciphertext ‖ tag(16))，
 *      用第 1 步的 key 做 AES-256-GCM 解密得到 client_secret。
 *
 * status: 0 NONE / 1 PENDING / 2 COMPLETED / 3 EXPIRED
 * 关键坑：portal 请求必须带 `Accept: application/json`，否则 q.qq.com 会返回
 * JS 反爬挑战页而不是 JSON。
 */
import { createDecipheriv, randomBytes } from 'node:crypto'
import qrcode from 'qrcode-generator'

/** portal 请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 10_000
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 2_000
/** 整个绑定流程的总超时（毫秒）。 */
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000
/** 任务过期后最多重建几次。 */
const MAX_REFRESHES = 3
/** 用户代理：标识来源，便于平台侧统计。 */
const USER_AGENT = 'DSH-QQBot/0.1 (+deepseek-harness)'

const STATUS = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 }

/** 生成二维码 SVG（服务端渲染，页面直接注入）。 */
export function renderQrSvg(content, cellSize = 5, margin = 8) {
  const qr = qrcode(0, 'M')
  qr.addData(content)
  qr.make()
  return qr.createSvgTag({ cellSize, margin, scalable: true })
}

async function portalPost(portalHost, path, payload) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`https://${portalHost}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 200)}`)
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${path} 返回的不是 JSON（可能被反爬页面拦截）：${text.slice(0, 120)}`)
    }
    if (body.retcode !== 0) throw new Error(`${path} retcode=${body.retcode} ${body.msg ?? ''}`.trim())
    return body.data ?? {}
  } finally {
    clearTimeout(timer)
  }
}

/** 按 IV(12) ‖ ciphertext ‖ tag(16) 的布局解出 client_secret。 */
export function decryptClientSecret(keyBase64, encryptedBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  if (raw.length < 12 + 16 + 1) throw new Error('bot_encrypt_secret 长度异常')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * 一次扫码绑定会话。生命周期：start() → 轮询 → completed / expired / failed，
 * 也可以 cancel()。所有状态都通过 `snapshot()` 读取，UI 只读它。
 */
export class BindSession {
  #state = 'idle'
  #taskId = null
  #key = null
  #url = null
  #qrSvg = null
  #appId = null
  #clientSecret = null
  #userOpenId = null
  #error = null
  #refreshes = 0
  #startedAt = 0
  #deadline = 0
  #pollTimer = null
  #stopped = false

  constructor({ portalHost = 'q.qq.com', timeoutMs = TOTAL_TIMEOUT_MS, log = () => {} } = {}) {
    this.portalHost = portalHost
    this.timeoutMs = timeoutMs
    this.log = log
  }

  snapshot() {
    return {
      state: this.#state,
      taskId: this.#taskId,
      url: this.#url,
      qrSvg: this.#qrSvg,
      appId: this.#appId,
      userOpenId: this.#userOpenId,
      // 只回传是否拿到，绝不在 UI 里回显明文 secret
      secretReady: this.#clientSecret !== null,
      error: this.#error,
      refreshes: this.#refreshes,
      startedAt: this.#startedAt === 0 ? null : new Date(this.#startedAt).toISOString(),
      expiresAt: this.#deadline === 0 ? null : new Date(this.#deadline).toISOString(),
    }
  }

  /** 取出解密后的凭据（仅宿主内部使用，成功后一次性消费）。 */
  consumeCredentials() {
    if (this.#appId === null || this.#clientSecret === null) return null
    return { appId: this.#appId, clientSecret: this.#clientSecret, userOpenId: this.#userOpenId }
  }

  async start() {
    if (this.#state === 'pending') return this.snapshot()
    this.#stopped = false
    this.#refreshes = 0
    this.#error = null
    this.#appId = null
    this.#clientSecret = null
    this.#userOpenId = null
    this.#startedAt = Date.now()
    this.#deadline = Date.now() + this.timeoutMs
    await this.#createTask()
    return this.snapshot()
  }

  cancel() {
    this.#stopped = true
    this.#clearTimer()
    if (this.#state === 'pending') this.#state = 'cancelled'
    return this.snapshot()
  }

  #clearTimer() {
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
  }

  async #createTask() {
    try {
      this.#key = randomBytes(32).toString('base64')
      const data = await portalPost(this.portalHost, '/lite/create_bind_task', { key: this.#key })
      this.#taskId = data.task_id ?? null
      if (this.#taskId === null) throw new Error('create_bind_task 未返回 task_id')
      this.#url =
        'https://q.qq.com/qqbot/openclaw/connect.html' +
        `?task_id=${encodeURIComponent(this.#taskId)}&_wv=2&source=dsh`
      this.#qrSvg = renderQrSvg(this.#url)
      this.#state = 'pending'
      this.log(`bind: 已创建绑定任务 task_id=${this.#taskId}`)
      this.#schedulePoll()
    } catch (error) {
      this.#state = 'failed'
      this.#error = error.message
      this.log(`bind: 创建绑定任务失败：${error.message}`)
    }
  }

  #schedulePoll() {
    if (this.#stopped) return
    if (Date.now() > this.#deadline) {
      this.#state = 'expired'
      this.#error = '绑定超时（10 分钟内未完成扫码）'
      this.log('bind: 超时未完成')
      return
    }
    this.#pollTimer = setTimeout(() => void this.#poll(), POLL_INTERVAL_MS)
    this.#pollTimer.unref?.()
  }

  async #poll() {
    if (this.#stopped) return
    try {
      const data = await portalPost(this.portalHost, '/lite/poll_bind_result', { task_id: this.#taskId })
      const status = Number(data.status ?? STATUS.NONE)
      if (status === STATUS.COMPLETED) {
        const encrypted = data.bot_encrypt_secret
        if (typeof encrypted !== 'string' || encrypted.length === 0) throw new Error('缺少 bot_encrypt_secret')
        this.#clientSecret = decryptClientSecret(this.#key, encrypted)
        this.#appId = data.bot_appid === undefined ? null : String(data.bot_appid)
        this.#userOpenId = data.user_openid ?? null
        this.#state = 'completed'
        this.log(`bind: 绑定完成 app_id=${this.#appId} user_openid=${this.#userOpenId}`)
        return
      }
      if (status === STATUS.EXPIRED) {
        this.log('bind: 任务已过期')
        if (this.#refreshes >= MAX_REFRESHES) {
          this.#state = 'expired'
          this.#error = `二维码已过期（重建 ${this.#refreshes} 次仍未完成）`
          return
        }
        this.#refreshes += 1
        this.log(`bind: 重建任务（第 ${this.#refreshes} 次）`)
        await this.#createTask()
        return
      }
    } catch (error) {
      // 网络抖错不终止流程，交给 deadline 兜底
      this.log(`bind: 轮询失败（继续重试）：${error.message}`)
    }
    this.#schedulePoll()
  }
}

export { STATUS as BIND_STATUS }
