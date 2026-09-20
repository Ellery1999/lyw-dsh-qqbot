/**
 * QQ 官方机器人 API v2 传输层（零依赖：Node.js 内置 fetch / WebSocket）。
 *
 * 覆盖：AppAccessToken 获取与刷新、WebSocket 网关（hello / identify / resume /
 * 心跳 / 断线重连 / close code 处理）、C2C 与群聊消息发送。
 *
 * 协议常量集中在 PROTOCOL，便于按官方文档校正。
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

export const PROTOCOL = {
  /** 获取 AppAccessToken。 */
  tokenUrl: 'https://bots.qq.com/app/getAppAccessToken',
  /** 正式环境 OpenAPI 基址；沙箱为 https://sandbox.api.sgroup.qq.com。 */
  apiBase: 'https://api.sgroup.qq.com',
  sandboxApiBase: 'https://sandbox.api.sgroup.qq.com',
  /** 获取 WebSocket 网关地址。 */
  gatewayPath: '/gateway',
  /** 鉴权头前缀：`Authorization: QQBot <access_token>`。 */
  authScheme: 'QQBot',
  /** intents 位。 */
  intents: {
    /** 群聊 @ 与私聊（C2C）：GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE。 */
    groupAndC2c: 1 << 25,
    /** 频道 @ 消息：AT_MESSAGE_CREATE。 */
    publicGuildMessages: 1 << 30,
    /** 频道私信：DIRECT_MESSAGE_CREATE。 */
    directMessage: 1 << 12,
    /** 按钮交互回调：INTERACTION_CREATE。 */
    interaction: 1 << 26,
  },
  /** 关注的事件名。 */
  events: {
    c2c: 'C2C_MESSAGE_CREATE',
    group: 'GROUP_AT_MESSAGE_CREATE',
    guildAt: 'AT_MESSAGE_CREATE',
    guildDirect: 'DIRECT_MESSAGE_CREATE',
    interaction: 'INTERACTION_CREATE',
  },
  /** 收到用户消息后可用于被动回复的窗口（毫秒）。 */
  passiveReplyWindowMs: 5 * 60 * 1000,
  /** 同一条用户消息允许的最大被动回复条数（msg_seq 上限）。 */
  maxPassiveReplies: 5,
  /**
   * 被动回复上限，单聊与群聊并不相同（官方文档「发送单聊消息 / 发送群聊消息」）：
   * 单聊 60 分钟内最多 4 条，群聊 5 分钟内最多 5 条。超限报 40034128。
   * 上面两个常量是群聊的值，保留给旧调用方；新代码请按 kind 取。
   */
  passiveReply: {
    c2c: { windowMs: 60 * 60 * 1000, maxReplies: 4 },
    group: { windowMs: 5 * 60 * 1000, maxReplies: 5 },
  },
  /** 消息去重保留多久：取两场景中更长的窗口，短窗口场景的重投也覆盖得到。 */
  dedupeWindowMs: 60 * 60 * 1000,
  /** 富媒体上传硬限制（字节）：超过它 QQ 必然报错，先拦下省一次白跑的上传。 */
  maxUploadBytes: 200 * 1024 * 1024,
  /** `md5_10m` 覆盖的前缀字节数，官方给定值。 */
  md5PrefixBytes: 10002432,
  /** 富媒体的 file_type：1=图片 2=视频 3=语音 4=文件。 */
  fileType: { image: 1, video: 2, voice: 3, file: 4 },
}

const TOKEN_REFRESH_SLACK_MS = 60_000

/**
 * 扩展名 → 富媒体 file_type。
 *
 * 图片这一档取官方「富媒体消息概述」的完整列表（jpg/png/gif/webp/bmp）——上传接口
 * 那张 file_type 表只写了 png/jpg，但概述明确列了五种，且 Hermes 的 qqbot 适配器
 * 对任何图片都直接发 file_type=1（send_image_file 固定传 MEDIA_TYPE_IMAGE），
 * 没有按扩展名设限。所以按完整列表来。
 */
const FILE_TYPE_BY_EXTENSION = {
  '.png': PROTOCOL.fileType.image,
  '.jpg': PROTOCOL.fileType.image,
  '.jpeg': PROTOCOL.fileType.image,
  '.gif': PROTOCOL.fileType.image,
  '.webp': PROTOCOL.fileType.image,
  '.bmp': PROTOCOL.fileType.image,
  '.mp4': PROTOCOL.fileType.video,
  '.silk': PROTOCOL.fileType.voice,
}

/** 分片上传「重试有用」的业务码：分片转存通道抖动。 */
const PART_FINISH_RETRY_CODE = 40093001
/** 分片上传「重试没用」的业务码：当天发送文件容量已用尽。 */
const DAILY_UPLOAD_LIMIT_CODE = 40093002
const PART_PUT_MAX_RETRIES = 2
const PART_PUT_BASE_DELAY_MS = 1000
const PART_FINISH_RETRY_INTERVAL_MS = 1000
const PART_FINISH_DEFAULT_TIMEOUT_MS = 120_000
const PART_FINISH_MAX_TIMEOUT_MS = 600_000

/** 错误里是否出现了某个业务码（QQ 把 biz_code 塞在 message 或 body 里）。 */
function hasBizCode(error, code) {
  if (error === null || typeof error !== 'object') return false
  if (String(error.message ?? '').includes(String(code))) return true
  try {
    return JSON.stringify(error.body ?? null).includes(String(code))
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 按文件名推断富媒体 file_type。
 * @param {string} fileName 文件名（或任意带扩展名的路径）
 * @returns {number} 1=图片 2=视频 3=语音 4=文件
 */
export function fileTypeFor(fileName) {
  return FILE_TYPE_BY_EXTENSION[extname(String(fileName)).toLowerCase()] ?? PROTOCOL.fileType.file
}

/**
 * 把 `upload_prepare` 的响应规整成统一形状。
 *
 * 官方文档只描述了一种拼法（`parts[].index`，写「从 0 开始」），但线上还存在
 * `part_list`、`url`、`part_index` 等变体 —— Hermes 的 qqbot 适配器就在同时认这些
 * （hermes-agent/gateway/platforms/qqbot/chunked_upload.py），所以都接受。
 *
 * 序号**只用来排序**，真正的文件偏移由排序后的累计块大小决定：文档说从 0 开始，
 * 而 Hermes 按 `(part_index - 1) * block_size` 算偏移（等于当作 1 开始），两者矛盾。
 * 不押注任何一方，就不会因为基准不同而读到错误的字节。
 *
 * @param {object} raw upload_prepare 的原始响应
 * @returns {{uploadId: string, blockSize: number, retryTimeoutMs: number,
 *   parts: {index: number, url: string, blockSize: number}[]}}
 */
export function normalizePrepare(raw) {
  const wrapped = raw !== null && typeof raw === 'object' ? raw.data : undefined
  const src = wrapped !== null && typeof wrapped === 'object' ? wrapped : raw ?? {}
  const list = Array.isArray(src.parts) ? src.parts : Array.isArray(src.part_list) ? src.part_list : []
  const parts = []
  for (const [position, entry] of list.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const url = entry.presigned_url ?? entry.url
    if (typeof url !== 'string' || url.length === 0) continue
    const rawIndex = Number(entry.part_index ?? entry.index)
    parts.push({
      // 原样回传给 upload_part_finish：服务端给的是什么基准就用什么基准。
      index: Number.isFinite(rawIndex) ? rawIndex : position,
      url,
      blockSize: Number(entry.block_size ?? src.block_size ?? 0),
    })
  }
  parts.sort((left, right) => left.index - right.index)
  const retryTimeoutSeconds = Number(src.retry_timeout ?? src.upload_config?.retry_timeout ?? 0)
  return {
    uploadId: typeof src.upload_id === 'string' ? src.upload_id : '',
    blockSize: Number(src.block_size ?? 0),
    retryTimeoutMs: Math.min(
      retryTimeoutSeconds > 0 ? retryTimeoutSeconds * 1000 : PART_FINISH_DEFAULT_TIMEOUT_MS,
      PART_FINISH_MAX_TIMEOUT_MS,
    ),
    parts,
  }
}

/**
 * 算出上传接口要的三个校验值。整文件用流式读取，避免把上百 MB 一次性读进内存。
 * @param {string} filePath 本地文件路径
 * @param {number} size 文件字节数
 * @returns {Promise<{md5: string, sha1: string, md5OfPrefix: string}>} 十六进制摘要
 */
async function digestFile(filePath, size) {
  const info = await open(filePath, 'r')
  try {
    const prefixLength = Math.min(size, PROTOCOL.md5PrefixBytes)
    const prefix = Buffer.alloc(prefixLength)
    if (prefixLength > 0) await info.read(prefix, 0, prefixLength, 0)

    const md5 = createHash('md5')
    const sha1 = createHash('sha1')
    for await (const chunk of info.createReadStream({ autoClose: false })) {
      md5.update(chunk)
      sha1.update(chunk)
    }
    return {
      md5: md5.digest('hex'),
      sha1: sha1.digest('hex'),
      md5OfPrefix: createHash('md5').update(prefix).digest('hex'),
    }
  } finally {
    await info.close()
  }
}

export class QqApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'QqApiError'
    this.status = status
    this.body = body
  }
}

/** REST 客户端：appId/appSecret 换 access_token，并发送消息。 */
export class QqApi {
  #token = null
  #expiresAt = 0

  constructor({ appId, appSecret, sandbox = false, tokenUrl, apiBase, log = () => {} }) {
    if (!appId || !appSecret) throw new Error('QqApi: appId 与 appSecret 必填')
    this.appId = appId
    this.appSecret = appSecret
    this.apiBase = apiBase ?? (sandbox ? PROTOCOL.sandboxApiBase : PROTOCOL.apiBase)
    this.tokenUrl = tokenUrl ?? PROTOCOL.tokenUrl
    this.log = log
  }

  /** 最近一次成功获取的 token（identify/resume 需要同步取用）。 */
  get currentToken() {
    return this.#token
  }

  /** 丢弃缓存，强制下一次 token() 重新获取。 */
  invalidate() {
    this.#token = null
    this.#expiresAt = 0
  }

  /** 返回有效 access_token（提前 60s 刷新）。 */
  async token() {
    if (this.#token !== null && Date.now() < this.#expiresAt - TOKEN_REFRESH_SLACK_MS) return this.#token
    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new QqApiError(`换取 access_token 失败：响应不是 JSON（HTTP ${response.status}）`, response.status, text)
    }
    if (!response.ok || typeof payload.access_token !== 'string') {
      const detail = payload?.message ?? payload?.code ?? ''
      throw new QqApiError(`换取 access_token 失败：HTTP ${response.status} ${detail}`.trim(), response.status, payload)
    }
    this.#token = payload.access_token
    const expiresIn = Number(payload.expires_in ?? 7200)
    this.#expiresAt = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000
    this.log(`qq: 已获取 access_token（${Math.round(expiresIn)}s 后过期）`)
    return this.#token
  }

  /** 取 WebSocket 网关地址。 */
  async gatewayUrl() {
    const result = await this.request('GET', PROTOCOL.gatewayPath)
    if (typeof result?.url !== 'string') throw new QqApiError('网关地址响应缺少 url 字段', 200, result)
    return result.url
  }

  /** 带鉴权的 OpenAPI 请求。 */
  async request(method, path, body) {
    const token = await this.token()
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `${PROTOCOL.authScheme} ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let payload = null
    if (text.length > 0) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    if (!response.ok) {
      const detail =
        typeof payload === 'object' && payload !== null ? payload.message ?? JSON.stringify(payload) : String(payload)
      throw new QqApiError(`${method} ${path} 失败：HTTP ${response.status} ${detail}`, response.status, payload)
    }
    return payload
  }

  #messagePath(kind, target) {
    return kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target)}/messages`
      : `/v2/groups/${encodeURIComponent(target)}/messages`
  }

  /**
   * 发送文本消息。
   * @param {'c2c'|'group'} kind
   * @param {string} target C2C 为 user_openid，群聊为 group_openid
   * @param {string} content 文本内容
   * @param {{msgId?: string, msgSeq?: number}} [reply] 被动回复所需的 msg_id / msg_seq
   */
  async sendText(kind, target, content, reply = {}) {
    return await this.request('POST', this.#messagePath(kind, target), {
      content,
      msg_type: 0,
      ...(reply.msgId === undefined ? {} : { msg_id: reply.msgId }),
      ...(reply.msgSeq === undefined ? {} : { msg_seq: reply.msgSeq }),
    })
  }

  /**
   * 发送 Markdown 消息（msg_type 2）。部分场景不支持，失败时调用方应回退纯文本。
   */
  async sendMarkdown(kind, target, markdown, reply = {}) {
    return await this.request('POST', this.#messagePath(kind, target), {
      msg_type: 2,
      markdown: { content: markdown },
      ...(reply.msgId === undefined ? {} : { msg_id: reply.msgId }),
      ...(reply.msgSeq === undefined ? {} : { msg_seq: reply.msgSeq }),
    })
  }

  /**
   * 发送富媒体消息（msg_type 7）。`fileInfo` 来自 {@link uploadLocalFile}。
   * 同样占用被动回复额度：一条附件就是一条回复。
   */
  async sendMedia(kind, target, fileInfo, reply = {}) {
    return await this.request('POST', this.#messagePath(kind, target), {
      msg_type: 7,
      media: { file_info: fileInfo },
      ...(reply.msgId === undefined ? {} : { msg_id: reply.msgId }),
      ...(reply.msgSeq === undefined ? {} : { msg_seq: reply.msgSeq }),
    })
  }

  #filePath(kind, target) {
    return kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target)}/files`
      : `/v2/groups/${encodeURIComponent(target)}/files`
  }

  #uploadPath(kind, target, action) {
    return kind === 'c2c'
      ? `/v2/users/${encodeURIComponent(target)}/${action}`
      : `/v2/groups/${encodeURIComponent(target)}/${action}`
  }

  /** 分片上传第一步：换取 upload_id 与各分片的预签名 PUT 地址。 */
  async uploadPrepare(kind, target, { fileType, fileSize, fileName, md5, sha1, md5OfPrefix }) {
    return await this.request('POST', this.#uploadPath(kind, target, 'upload_prepare'), {
      file_type: fileType,
      file_size: String(fileSize),
      file_name: fileName,
      md5,
      sha1,
      md5_10m: md5OfPrefix,
    })
  }

  /** 分片上传第三步：通知服务端某个分片已就位。 */
  async uploadPartFinish(kind, target, { uploadId, partIndex, blockSize, md5 }) {
    return await this.request('POST', this.#uploadPath(kind, target, 'upload_part_finish'), {
      upload_id: uploadId,
      part_index: partIndex,
      block_size: String(blockSize),
      md5,
    })
  }

  /** 分片上传第四步：带 upload_id 调上传接口完成合并，返回 file_info。 */
  async uploadFile(kind, target, { fileType, fileName, uploadId, srvSendMsg = false }) {
    return await this.request('POST', this.#filePath(kind, target), {
      file_type: fileType,
      file_name: fileName,
      upload_id: uploadId,
      srv_send_msg: srvSendMsg,
    })
  }

  /**
   * 把一个本地文件按官方「分片上传」流程送到 QQ，返回 `file_info`。
   *
   * 为什么不用 URL 直传：那条路要求文件已在公网可访问，而 DSH 手上的文件都在本机。
   * 官方也明确写了分片上传「适用于大文件或本地文件」。
   *
   * 只做上传、不发消息：发消息要占被动回复额度，由调用方决定什么时候发。
   *
   * @param {'c2c'|'group'} kind 会话类型
   * @param {string} target user_openid 或 group_openid
   * @param {string} filePath 本地文件的绝对路径
   * @returns {Promise<{fileInfo: string, fileName: string, fileType: number, ttl: number, bytes: number}>}
   */
  async uploadLocalFile(kind, target, filePath) {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error(`${filePath} 不是文件`)
    if (info.size === 0) throw new Error(`${filePath} 是空文件，QQ 不接受`)
    if (info.size > PROTOCOL.maxUploadBytes) {
      const limitMb = Math.round(PROTOCOL.maxUploadBytes / 1024 / 1024)
      throw new Error(`${filePath} 有 ${(info.size / 1024 / 1024).toFixed(1)}MB，超过 QQ 的 ${limitMb}MB 上限`)
    }
    const fileName = basename(filePath)
    const fileType = fileTypeFor(fileName)
    const digests = await digestFile(filePath, info.size)

    const prepared = normalizePrepare(
      await this.uploadPrepare(kind, target, {
        fileType,
        fileSize: info.size,
        fileName,
        md5: digests.md5,
        sha1: digests.sha1,
        md5OfPrefix: digests.md5OfPrefix,
      }),
    )
    if (prepared.uploadId.length === 0 || prepared.parts.length === 0) {
      throw new QqApiError('upload_prepare 未返回 upload_id / 分片列表', 200, null)
    }

    // 预签名 URL 自带鉴权，PUT 时不能再带 QQBot 头，否则 COS 会拒。
    const handle = await open(filePath, 'r')
    try {
      let offset = 0
      for (const part of prepared.parts) {
        const blockSize = part.blockSize > 0 ? part.blockSize : prepared.blockSize
        const length = Math.min(blockSize, info.size - offset)
        if (length <= 0) break
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        const chunk = buffer.subarray(0, bytesRead)
        await this.#putChunk(part.url, chunk)
        await this.#partFinishWithRetry(
          kind,
          target,
          {
            uploadId: prepared.uploadId,
            partIndex: part.index,
            blockSize: length,
            md5: createHash('md5').update(chunk).digest('hex'),
          },
          prepared.retryTimeoutMs,
        )
        offset += bytesRead
      }
      if (offset !== info.size) {
        throw new QqApiError(`分片合计 ${offset} 字节，与文件大小 ${info.size} 不符，已中止`, 200, null)
      }
    } finally {
      await handle.close()
    }

    const merged = await this.uploadFile(kind, target, { fileType, fileName, uploadId: prepared.uploadId })
    const fileInfo = merged?.file_info
    if (typeof fileInfo !== 'string' || fileInfo.length === 0) {
      throw new QqApiError('上传完成但未返回 file_info', 200, merged)
    }
    this.log(`qq: 已上传 ${fileName}（${info.size} 字节，file_type=${fileType}，ttl=${merged?.ttl ?? '?'}s）`)
    return {
      fileInfo,
      fileName,
      fileType,
      ttl: Number(merged?.ttl ?? 0),
      bytes: info.size,
    }
  }

  /** 把一片 PUT 到预签名地址；网络抖动重试几次，其余错误直接抛。 */
  async #putChunk(url, chunk) {
    let lastError = null
    for (let attempt = 0; attempt <= PART_PUT_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, { method: 'PUT', body: chunk })
        if (response.ok) return
        lastError = new QqApiError(`分片 PUT 失败：HTTP ${response.status}`, response.status, null)
      } catch (error) {
        lastError = error
      }
      if (attempt < PART_PUT_MAX_RETRIES) await delay(PART_PUT_BASE_DELAY_MS * 2 ** attempt)
    }
    throw lastError
  }

  /**
   * 确认一个分片。40093001 是「分片转存通道抖动」，官方明说重试即可；
   * 40093002 是当天容量用尽，重试没意义，直接翻译成人话抛出去。
   */
  async #partFinishWithRetry(kind, target, body, retryTimeoutMs) {
    const deadline = Date.now() + retryTimeoutMs
    for (;;) {
      try {
        return await this.uploadPartFinish(kind, target, body)
      } catch (error) {
        if (hasBizCode(error, DAILY_UPLOAD_LIMIT_CODE)) {
          throw new QqApiError('今天的文件发送容量已用完（40093002），明天再试或发小一点的文件', 200, null)
        }
        if (!hasBizCode(error, PART_FINISH_RETRY_CODE) || Date.now() >= deadline) throw error
        await delay(PART_FINISH_RETRY_INTERVAL_MS)
      }
    }
  }
}

const CLOSE_CODE_MEANING = {
  4001: '无效的 opcode',
  4002: '无效的 payload',
  4004: '鉴权失败（token 无效）',
  4006: '无效的 session',
  4007: 'seq 错误',
  4008: '发送过快',
  4009: '连接过期',
  4010: '无效的 shard',
  4011: '需要分片',
  4012: '无效的版本',
  4013: 'intents 无效',
  4014: 'intents 无权限',
  4900: '内部错误',
  4914: '机器人已下线',
  4915: '机器人被封禁',
}

/** 必须丢弃 session（无法 resume）的 close code。4004 还要清 token。 */
const DROP_SESSION_CODES = new Set([4004, 4006, 4007])
/** 4900-4913 属于内部错误段，同样重建 session。 */
function dropsSession(code) {
  return DROP_SESSION_CODES.has(code) || (code >= 4900 && code <= 4913)
}
/** 致命 close code：重连无意义。 */
const FATAL_CODES = new Set([4013, 4014, 4914, 4915])

/**
 * WebSocket 网关客户端：identify / 心跳 / resume / 指数退避重连。
 * 事件经 `onEvent(type, data)` 回调抛出；READY 由本类内部消化。
 */
export class QqGateway {
  #socket = null
  #heartbeatTimer = null
  #reconnectTimer = null
  #attempt = 0
  #stopped = false
  #sessionId = null
  #lastSeq = null

  constructor(options) {
    this.api = options.api
    this.onEvent = options.onEvent
    this.onState = options.onState ?? (() => {})
    this.intents = options.intents ?? PROTOCOL.intents.groupAndC2c
    this.log = options.log ?? (() => {})
  }

  get connected() {
    return this.#socket !== null && this.#socket.readyState === 1 && this.#sessionId !== null
  }

  get sessionId() {
    return this.#sessionId
  }

  async start() {
    this.#stopped = false
    await this.api.token()
    await this.#connect()
  }

  stop() {
    this.#stopped = true
    this.#clearTimers()
    if (this.#socket !== null) {
      try {
        this.#socket.close(1000, 'gateway shutdown')
      } catch {
        /* already closed */
      }
    }
    this.#socket = null
    this.onState({ connected: false, detail: 'stopped' })
  }

  #clearTimers() {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  async #connect() {
    if (this.#stopped) return
    let url
    try {
      url = await this.api.gatewayUrl()
    } catch (error) {
      this.log(`qq: 获取网关地址失败：${error.message}`)
      this.#scheduleReconnect()
      return
    }
    this.log(`qq: 连接网关 ${url}`)
    const socket = new WebSocket(url)
    this.#socket = socket

    socket.onopen = () => {
      this.log('qq: WebSocket 已连接，等待 op 10 hello')
      this.onState({ connected: false, detail: 'handshaking' })
    }
    socket.onmessage = (event) => {
      let frame
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        this.log('qq: 收到非 JSON 帧，已忽略')
        return
      }
      void this.#onFrame(frame)
    }
    socket.onerror = (event) => {
      this.log(`qq: WebSocket 错误：${event?.message ?? 'unknown'}`)
    }
    socket.onclose = (event) => {
      this.#clearTimers()
      const meaning = CLOSE_CODE_MEANING[event.code] ?? ''
      this.log(`qq: WebSocket 关闭 code=${event.code} ${meaning} ${event.reason ?? ''}`.trim())
      this.onState({ connected: false, detail: `closed ${event.code} ${meaning}`.trim() })
      if (this.#stopped) return
      if (FATAL_CODES.has(event.code)) {
        this.log('qq: 致命 close code，停止重连；请检查机器人状态与 AppID/Secret')
        return
      }
      if (dropsSession(event.code)) {
        this.#sessionId = null
        this.#lastSeq = null
        if (event.code === 4004) this.api.invalidate()
      }
      // 4009 故意保留 session 以便 resume；4008（发送过快）需要等待更久。
      if (event.code === 4008) {
        this.log('qq: 触发频率限制，60s 后重连')
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = null
          void this.#connect()
        }, 60_000)
        this.#reconnectTimer.unref?.()
        return
      }
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect() {
    if (this.#stopped) return
    const ladder = [2, 5, 10, 30, 60, 120]
    const delay = ladder[Math.min(this.#attempt, ladder.length - 1)] * 1000
    this.#attempt += 1
    this.log(`qq: ${delay / 1000}s 后重连（第 ${this.#attempt} 次）`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delay)
    this.#reconnectTimer.unref?.()
  }

  async #onFrame(frame) {
    const op = frame.op
    if (frame.s !== undefined && frame.s !== null) this.#lastSeq = frame.s

    if (op === 10) {
      const interval = Number(frame.d?.heartbeat_interval ?? 30000)
      this.#startHeartbeat(interval)
      if (this.#sessionId !== null && this.#lastSeq !== null) await this.#sendResume()
      else await this.#sendIdentify()
      return
    }
    if (op === 11) return
    if (op === 1) {
      this.#sendHeartbeat()
      return
    }
    if (op === 7) {
      this.log('qq: 服务端要求重连')
      this.#socket?.close(4000, 'server requested reconnect')
      return
    }
    if (op === 9) {
      const resumable = frame.d === true
      this.log(`qq: invalid session（可恢复=${resumable}）`)
      if (!resumable) {
        this.#sessionId = null
        this.#lastSeq = null
      }
      setTimeout(() => {
        void (resumable ? this.#sendResume() : this.#sendIdentify())
      }, 1500)
      return
    }
    if (op === 0) {
      const type = frame.t
      const data = frame.d ?? {}
      if (type === 'READY' || type === 'RESUMED') {
        this.#sessionId = data.session_id ?? this.#sessionId
        this.#attempt = 0
        this.log(`qq: ${type}，session=${this.#sessionId}`)
        this.onState({ connected: true, detail: type.toLowerCase(), sessionId: this.#sessionId ?? undefined })
        return
      }
      try {
        this.onEvent(type, data)
      } catch (error) {
        this.log(`qq: 事件处理失败 ${type}: ${error?.stack ?? error?.message ?? error}`)
      }
    }
  }

  #startHeartbeat(intervalMs) {
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer)
    const period = Math.max(5000, Math.floor(intervalMs * 0.8))
    this.#heartbeatTimer = setInterval(() => this.#sendHeartbeat(), period)
    this.#heartbeatTimer.unref?.()
    this.log(`qq: 心跳间隔 ${period}ms`)
  }

  #sendHeartbeat() {
    this.#send({ op: 1, d: this.#lastSeq })
  }

  async #sendIdentify() {
    const token = await this.api.token()
    this.log(`qq: 发送 identify（intents=${this.intents}）`)
    this.#send({
      op: 2,
      d: {
        token: `${PROTOCOL.authScheme} ${token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-qqbot', $device: 'dsh-qqbot' },
      },
    })
  }

  async #sendResume() {
    const token = await this.api.token()
    this.log(`qq: 发送 resume（session=${this.#sessionId} seq=${this.#lastSeq}）`)
    this.#send({
      op: 6,
      d: { token: `${PROTOCOL.authScheme} ${token}`, session_id: this.#sessionId, seq: this.#lastSeq },
    })
  }

  #send(frame) {
    if (this.#socket === null || this.#socket.readyState !== 1) return
    this.#socket.send(JSON.stringify(frame))
  }
}
