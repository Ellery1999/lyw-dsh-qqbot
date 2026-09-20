/**
 * `@lyw/dsh-qqbot` — 把 DSH 接到 QQ 官方机器人（QQ Bot API v2）。
 *
 * Host 半职责：
 *   1. 注册 `qqbot` 设置命名空间，DSH 的「设置 → 插件 → 配置」自动生成表单；
 *   2. 按当前配置以子进程方式拉起 `lib/gateway.mjs`（QQ 网关 + ACP 客户端）；
 *   3. 配置变更时重启子进程，插件卸载时终止子进程；
 *   4. 在 `/plugins/qqbot` 提供配置页：状态、扫码绑定、手动填写、重启。
 *
 * QQ 协议、ACP 交互、扫码流程分别在 lib/qq-transport.mjs、lib/acp-client.mjs、
 * lib/bind.mjs 中实现，GUI 进程只负责配置、生命周期与这几个 HTTP 路由。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { BindSession } from './bind.mjs'
import { API_PREFIX, PAGE_PATH, renderPage } from './page.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'qqbot'

/** 本插件强依赖子进程服务；settings / webServer 为可选。 */
export const inject = ['subprocess']

const HERE = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SCRIPT = join(HERE, 'gateway.mjs')
const STATUS_POLL_MS = 15_000

const Config = z.object({
  enabled: z.boolean().default(true).description('启用 QQ 机器人网关'),
  appId: z.string().default('').description('QQ 开放平台机器人的 AppID'),
  appSecret: z.string().role('secret').default('').description('QQ 开放平台机器人的 AppSecret'),
  sandbox: z.boolean().default(false).description('使用沙箱环境（sandbox.api.sgroup.qq.com）'),
  workspace: z.string().default('').description('DSH 会话的工作目录；留空使用 $DSH_HOME/qqbot/workspace'),
  acpCommand: z.string().default('dsh --profile acp').description('启动 ACP agent 的命令行'),
  autoApprove: z.boolean().default(true).description('自动允许 ACP 权限请求（关闭时需授权的能力会被拒绝）'),
  allowUsers: z.array(z.string()).default([]).description('允许私聊的 user_openid 白名单；留空不限制'),
  allowGroups: z.array(z.string()).default([]).description('允许的 group_openid 白名单；留空不限制'),
  extraPrompt: z.string().default('').description('附加到每条 QQ 消息后的额外要求'),
})

function resolveHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const stateDir = join(resolveHome(), 'qqbot')
  const gatewayLog = join(stateDir, 'gateway.log')
  const statusFile = join(stateDir, 'status.json')
  const selfFile = join(stateDir, 'plugin.json')

  /** 当前权威配置：组合 base，被设置页覆盖后由 installSection 回灌。 */
  let current = () => config
  /** 运行中的网关句柄。 */
  let running = null
  /** 主动停止时为 true，避免看门狗/重试逻辑把进程重新拉起。 */
  let stopping = false
  /** 意外的退出自动重启预算（连续崩溃时不会无限重试）。 */
  let restartBudget = 3
  /** 本进程本次启动时刻，用于判断是「刚起来就崩」还是「跑了很久才崩」。 */
  let startedAt = 0
  /** 设置服务（扫码成功后写入凭据用）。 */
  let settingsService = null
  /** 当前扫码绑定会话。 */
  let bindSession = null
  /** 本次绑定是否已写回设置。 */
  let bindApplied = false

  const workspaceOf = (value) =>
    typeof value?.workspace === 'string' && value.workspace.length > 0 ? value.workspace : join(stateDir, 'workspace')

  /**
   * 插件自身的可观测记录：确认它被 loader 挂载过、看到的是哪份配置。
   * ACP 等没有 logger exporter 的 profile 里，这是唯一的现场证据。
   */
  const writeSelf = (extra = {}) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      const value = current()
      const { appSecret, ...rest } = value ?? {}
      writeFileSync(
        selfFile,
        JSON.stringify(
          {
            plugin: '@lyw/dsh-qqbot',
            mountedAt: new Date().toISOString(),
            hostPid: process.pid,
            config: { ...rest, appSecret: appSecret ? '***' : '' },
            gatewayScript: GATEWAY_SCRIPT,
            gatewayPid: running?.pid ?? null,
            gatewayLog,
            ...extra,
          },
          null,
          2,
        ),
      )
    } catch {
      /* 诊断文件写失败不影响主流程 */
    }
  }

  const stop = () => {
    stopping = true
    if (running === null) return
    try {
      running.terminate()
    } catch (error) {
      logger.warn?.(`qqbot: 终止网关失败：${error?.message ?? error}`)
    }
    running = null
    writeSelf({ gatewayState: 'stopped', stoppedAt: new Date().toISOString() })
  }

  /**
   * 优雅停止并等待退出。
   *
   * DSH 的 subprocess 在 Windows 上会给子进程套一层 wrapper，`terminate()` 可能只
   * 杀掉 wrapper，真正的网关会变成孤儿进程并继续占着单实例锁——于是紧接着启动的
   * 新网关会被锁挡掉，机器人就没有网关了。所以这里先写退出请求文件（网关每秒检查），
   * 等它自己释放锁；超时才 fallback 到 terminate()。
   */
  const stopAndWait = async (waitMs = 8000) => {
    stopping = true
    const handle = running
    running = null
    const requestFile = join(stateDir, 'shutdown.request')
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(requestFile, String(Date.now()))
    } catch {
      /* ignore */
    }
    if (handle === null) {
      // 没有句柄时也要给旧进程留出退出的时间
      await new Promise((resolve) => setTimeout(resolve, 1200))
      try {
        if (existsSync(requestFile)) writeFileSync(requestFile, String(Date.now()))
      } catch {
        /* ignore */
      }
      return
    }
    const exited = await Promise.race([
      handle.waitForExit?.().then(() => true).catch(() => true) ?? Promise.resolve(false),
      new Promise((resolve) => setTimeout(() => resolve(false), waitMs)),
    ])
    if (exited !== true) {
      logger.warn('qqbot: 网关未在等待时间内退出，改用 terminate()')
      try {
        handle.terminate()
      } catch (error) {
        logger.warn?.(`qqbot: terminate 失败：${error?.message ?? error}`)
      }
    }
    // 等锁文件真正释放（网关自身的退出流程还会清理一次）
    await new Promise((resolve) => setTimeout(resolve, 800))
    writeSelf({ gatewayState: 'stopped', stoppedAt: new Date().toISOString() })
  }

  const start = () => {
    stopping = false
    const value = current()
    if (value.enabled !== true) {
      logger.info('qqbot: 已禁用，不启动网关')
      writeSelf({ gatewayState: 'disabled' })
      return
    }
    if (typeof value.appId !== 'string' || value.appId.length === 0) {
      logger.warn('qqbot: 尚未配置 AppID，网关未启动（请在 设置 → 插件 → 配置 中填写，或打开配置页扫码）')
      writeSelf({ gatewayState: 'missing-app-id' })
      return
    }
    if (typeof value.appSecret !== 'string' || value.appSecret.length === 0) {
      logger.warn('qqbot: 尚未配置 AppSecret，网关未启动')
      writeSelf({ gatewayState: 'missing-app-secret' })
      return
    }
    if (!existsSync(GATEWAY_SCRIPT)) {
      logger.error(`qqbot: 找不到网关脚本 ${GATEWAY_SCRIPT}`)
      writeSelf({ gatewayState: 'missing-gateway-script' })
      return
    }

    const workspace = workspaceOf(value)
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    // 上一轮的退出请求必须清掉，否则新网关一起来就会退出。
    try {
      const requestFile = join(stateDir, 'shutdown.request')
      if (existsSync(requestFile)) rmSync(requestFile, { force: true })
    } catch {
      /* ignore */
    }

    const env = {
      ...process.env,
      DSH_QQBOT_APP_ID: value.appId,
      DSH_QQBOT_APP_SECRET: value.appSecret,
      DSH_QQBOT_SANDBOX: value.sandbox === true ? '1' : '0',
      DSH_QQBOT_WORKDIR: workspace,
      DSH_QQBOT_ACP_COMMAND: value.acpCommand,
      DSH_QQBOT_AUTO_APPROVE: value.autoApprove === true ? '1' : '0',
      DSH_QQBOT_ALLOW_USERS: (value.allowUsers ?? []).join(','),
      DSH_QQBOT_ALLOW_GROUPS: (value.allowGroups ?? []).join(','),
      DSH_QQBOT_EXTRA_PROMPT: value.extraPrompt ?? '',
      DSH_QQBOT_STATE_DIR: stateDir,
      DSH_QQBOT_EXIT_ON_STDIN_END: '1',
    }

    try {
      running = ctx.subprocess.spawn({
        argv: [process.execPath, GATEWAY_SCRIPT],
        cwd: stateDir,
        stdio: {
          stdin: 'pipe',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 1024 * 1024 },
        },
        graceMs: 5000,
        env,
      })
      logger.info(`qqbot: 网关已启动（pid ${running.pid ?? '?'}，workspace=${workspace}）`)
      writeSelf({ gatewayState: 'running', startedAt: new Date().toISOString() })
      startedAt = Date.now()
      running.done
        .then((outcome) => {
          logger.warn(`qqbot: 网关已退出（code=${outcome.exitCode} signal=${outcome.signal}）`)
          if (running !== null) running = null
          writeSelf({ gatewayState: 'exited', exitCode: outcome.exitCode })
          // 跑够 60 秒算一次健康运行，重置重试预算
          if (Date.now() - startedAt > 60_000) restartBudget = 3
          if (stopping || outcome.exitCode === 0 || restartBudget <= 0) return
          restartBudget -= 1
          const delay = 5000 * (4 - restartBudget)
          logger.warn(`qqbot: ${delay / 1000}s 后自动重启网关（剩余重试 ${restartBudget} 次）`)
          setTimeout(() => {
            if (!stopping) start()
          }, delay)
        })
        .catch((error) => {
          logger.error(`qqbot: 网关异常退出：${error?.message ?? error}`)
          if (running !== null) running = null
          writeSelf({ gatewayState: 'crashed', error: String(error?.message ?? error) })
        })
    } catch (error) {
      logger.error(`qqbot: 启动网关失败：${error?.stack ?? error?.message ?? error}`)
      running = null
      writeSelf({ gatewayState: 'spawn-failed', error: String(error?.message ?? error) })
    }
  }

  const restart = async () => {
    await stopAndWait()
    start()
  }

  // ---- 设置 ---------------------------------------------------------------

  ctx.inject(['settings'], (settingsCtx) => {
    settingsService = settingsCtx.settings
    settingsCtx.settings.installSection(ctx, 'qqbot', Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        logger.info('qqbot: 配置已更新，重启网关')
        void restart()
      },
    })
  })

  // ---- HTTP：配置页与绑定接口 --------------------------------------------

  const readStatusFile = () => {
    try {
      return JSON.parse(readFileSync(statusFile, 'utf8'))
    } catch {
      return null
    }
  }

  const readSelfFile = () => {
    try {
      return JSON.parse(readFileSync(selfFile, 'utf8'))
    } catch {
      return null
    }
  }

  const readLogTail = (maxChars = 8000) => {
    try {
      return readFileSync(gatewayLog, 'utf8').slice(-maxChars)
    } catch {
      return ''
    }
  }

  const sendJson = (res, code, body) => {
    const text = JSON.stringify(body ?? null)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  const sendHtml = (res, html) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    })
    res.end(html)
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text.length === 0 ? {} : JSON.parse(text)
  }

  const statePayload = () => {
    const value = current()
    const status = readStatusFile()
    const self = readSelfFile()
    return {
      appId: value?.appId ?? '',
      secretReady: typeof value?.appSecret === 'string' && value.appSecret.length > 0,
      acpCommand: value?.acpCommand ?? '',
      workdir: workspaceOf(value),
      sandbox: value?.sandbox === true,
      allowUsers: value?.allowUsers ?? [],
      allowGroups: value?.allowGroups ?? [],
      gatewayState: self?.gatewayState ?? (running === null ? 'stopped' : 'running'),
      gatewayPid: running?.pid ?? self?.gatewayPid ?? null,
      connection: status?.connection ?? null,
      sessionCount: Array.isArray(status?.sessions) ? status.sessions.length : undefined,
      stats: status?.stats ?? null,
      boundUserOpenId: self?.boundUserOpenId ?? null,
      boundAt: self?.boundAt ?? null,
      /**
       * 兜底身份：plugin.json 每次 writeSelf 整份覆盖，绑定写入的 openid 会被后续
       * 网关启动抹掉；status.json 由网关自己维护，因此留一份更持久的记录。
       */
      lastUserOpenId: status?.lastUserOpenId ?? null,
      lastError: status?.lastError ?? self?.error ?? null,
      logTail: readLogTail(),
    }
  }

  /** 扫码成功后把凭据写回设置（触发 onChange → 网关重启）。 */
  const applyBindResult = async () => {
    if (bindApplied) return
    const credentials = bindSession?.consumeCredentials()
    if (credentials === null || credentials === undefined) return
    bindApplied = true
    if (settingsService === undefined || settingsService === null) {
      logger.error('qqbot: 扫码成功但设置服务不可用，无法写入凭据')
      return
    }
    try {
      await settingsService.update('qqbot', {
        appId: credentials.appId,
        appSecret: credentials.clientSecret,
      })
      logger.info(`qqbot: 扫码绑定完成，已写入设置（appId=${credentials.appId}）`)
      writeSelf({
        gatewayState: 'running',
        boundAt: new Date().toISOString(),
        boundUserOpenId: credentials.userOpenId ?? null,
      })
    } catch (error) {
      bindApplied = false
      logger.error(`qqbot: 写入扫码凭据失败：${error?.message ?? error}`)
    }
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.slice(API_PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    try {
      if (action === '/state' && method === 'GET') return sendJson(res, 200, statePayload())

      if (action === '/bind/start' && method === 'POST') {
        bindSession = new BindSession({
          portalHost: current()?.sandbox === true ? 'sandbox.q.qq.com' : 'q.qq.com',
          log: (message) => logger.info(`qqbot: ${message}`),
        })
        bindApplied = false
        const snapshot = await bindSession.start()
        return sendJson(res, 200, snapshot)
      }

      if (action === '/bind/poll' && method === 'GET') {
        if (bindSession === null) return sendJson(res, 200, { state: 'idle' })
        const snapshot = bindSession.snapshot()
        if (snapshot.state === 'completed' && !bindApplied) await applyBindResult()
        return sendJson(res, 200, snapshot)
      }

      if (action === '/bind/cancel' && method === 'POST') {
        const snapshot = bindSession?.cancel() ?? { state: 'idle' }
        return sendJson(res, 200, snapshot)
      }

      if (action === '/save' && method === 'POST') {
        const body = await readJsonBody(req)
        const patch = {}
        if (typeof body.appId === 'string' && body.appId.trim().length > 0) patch.appId = body.appId.trim()
        if (typeof body.appSecret === 'string' && body.appSecret.length > 0) patch.appSecret = body.appSecret
        if (typeof body.workdir === 'string' && body.workdir.trim().length > 0) patch.workspace = body.workdir.trim()
        if (typeof body.acpCommand === 'string' && body.acpCommand.trim().length > 0) patch.acpCommand = body.acpCommand.trim()
        if (typeof body.allowUsers === 'string') patch.allowUsers = splitList(body.allowUsers)
        if (typeof body.allowGroups === 'string') patch.allowGroups = splitList(body.allowGroups)
        if (settingsService === undefined || settingsService === null) throw new Error('设置服务不可用')
        await settingsService.update('qqbot', patch)
        return sendJson(res, 200, statePayload())
      }

      if (action === '/restart' && method === 'POST') {
        await restart()
        return sendJson(res, 200, { ok: true })
      }

      // 一键收紧权限：只允许绑定的那个 QQ 号驱动 DSH。
      // 绑定记录缺失时回退到网关记录的最近私聊发送者——只要用户给机器人发过消息，
      // 这个值就存在，不必再去啃日志或 /whoami。
      if (action === '/lockdown' && method === 'POST') {
        const self = readSelfFile()
        const status = readStatusFile()
        const bound = self?.boundUserOpenId ?? null
        const last = status?.lastUserOpenId ?? null
        const openId = bound ?? last
        if (openId === null) {
          throw new Error('还没有收到过私聊消息，无法确定要放行的 openid；先给机器人发一条 /whoami，或手动填写白名单')
        }
        if (settingsService === undefined || settingsService === null) throw new Error('设置服务不可用')
        await settingsService.update('qqbot', { allowUsers: [openId] })
        logger.info(
          `qqbot: 已把白名单收紧为 ${bound !== null ? '绑定的' : '最近私聊的'} openid（${openId}）`,
        )
        return sendJson(res, 200, statePayload())
      }

      return sendJson(res, 404, { error: `未知接口 ${method} ${action}` })
    } catch (error) {
      logger.warn(`qqbot: 接口 ${action} 失败：${error?.message ?? error}`)
      return sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const unregisterPage = webCtx.webServer.register({
        kind: 'exact',
        path: PAGE_PATH,
        handler: (_req, res) => sendHtml(res, renderPage()),
      })
      const unregisterApi = webCtx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => void handleApi(req, res),
      })
      const port = typeof webCtx.webServer.port === 'number' ? webCtx.webServer.port : 3080
      logger.info(`qqbot: 配置页 http://127.0.0.1:${port}${PAGE_PATH}`)
      writeSelf({ configPageUrl: `http://127.0.0.1:${port}${PAGE_PATH}` })
      return () => {
        unregisterApi()
        unregisterPage()
      }
    }, 'qqbot: config page routes')
  })

  // ---- 状态观测 ----------------------------------------------------------

  let lastDetail = null
  const poll = setInterval(() => {
    try {
      if (!existsSync(statusFile)) return
      const status = JSON.parse(readFileSync(statusFile, 'utf8'))
      const detail = status?.connection?.detail ?? 'unknown'
      if (detail !== lastDetail) {
        lastDetail = detail
        logger.info(
          `qqbot: 连接状态 ${status?.connection?.connected === true ? '已连接' : '未连接'}（${detail}）` +
            (status?.lastError ? ` 最近错误：${status.lastError}` : ''),
        )
      }
    } catch {
      /* 状态文件处于半写状态，忽略 */
    }
  }, STATUS_POLL_MS)
  poll.unref?.()

  ctx.effect(() => () => {
    clearInterval(poll)
    bindSession?.cancel()
    void stopAndWait(2000)
  }, 'qqbot: gateway lifecycle')

  start()
}

function splitList(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return []
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export { Config }
