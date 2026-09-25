/**
 * DSH ⇄ QQ 官方机器人网关。
 *
 * 常驻进程：接收 QQ 私聊/群聊 @ 消息 → 通过 ACP stdio 驱动 `dsh --profile acp`
 * → 把助手回复发回 QQ。每个 QQ 会话（私聊 openid / 群 group_openid）对应一个
 * DSH ACP 会话，映射持久化后在重启时 resume。
 *
 * 用法：
 *   node lib/gateway.mjs                 # 从环境变量读配置（插件以此方式启动）
 *   node lib/gateway.mjs --self-test "你好"   # 不连 QQ，只验证 ACP 链路
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AcpClient } from './acp-client.mjs'
import { PROTOCOL, QqApi, QqGateway } from './qq-transport.mjs'

const VERSION = '0.3.2'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function parseCommandLine(line) {
  // 只做引号感知的简单切分：够用于 `dsh --profile acp` 这类命令。
  const parts = []
  let current = ''
  let quote = null
  for (const char of line.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function loadConfig(argv) {
  const stateDir = process.env.DSH_QQBOT_STATE_DIR ?? join(homedir(), '.dsh', 'qqbot')
  const config = {
    appId: process.env.DSH_QQBOT_APP_ID ?? '',
    appSecret: process.env.DSH_QQBOT_APP_SECRET ?? '',
    sandbox: process.env.DSH_QQBOT_SANDBOX === '1',
    workdir: process.env.DSH_QQBOT_WORKDIR ?? process.cwd(),
    acpCommand: process.env.DSH_QQBOT_ACP_COMMAND ?? 'dsh --profile acp',
    stateDir,
    autoApprove: process.env.DSH_QQBOT_AUTO_APPROVE !== '0',
    allowUsers: splitList(process.env.DSH_QQBOT_ALLOW_USERS),
    allowGroups: splitList(process.env.DSH_QQBOT_ALLOW_GROUPS),
    maxChars: Number(process.env.DSH_QQBOT_MAX_CHARS ?? 1200),
    progressMs: Number(process.env.DSH_QQBOT_PROGRESS_MS ?? 20000),
    markdown: process.env.DSH_QQBOT_MARKDOWN === '1',
    extraPrompt: process.env.DSH_QQBOT_EXTRA_PROMPT ?? '',
    /** 端点覆盖：用于本地模拟平台/自建代理，默认走官方域名。 */
    tokenUrl: process.env.DSH_QQBOT_TOKEN_URL ?? undefined,
    apiBase: process.env.DSH_QQBOT_API_BASE ?? undefined,
    /** 只有确认 stdin 是管道（由插件拉起）时才把 stdin EOF 当作退出信号。 */
    exitOnStdinEnd: process.env.DSH_QQBOT_EXIT_ON_STDIN_END === '1',
    selfTest: null,
    /** 最近一次私聊发送者 openid，跨重启保留，供配置页「只允许绑定的 QQ」兜底。 */
    lastUserOpenId: readLastUserOpenId(stateDir),
  }
  const selfTestIndex = argv.indexOf('--self-test')
  if (selfTestIndex !== -1) config.selfTest = argv[selfTestIndex + 1] ?? '你好，请用一句话介绍你自己。'
  return config
}

function splitList(value) {
  if (value === undefined || value.trim().length === 0) return []
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

// ---------------------------------------------------------------------------
// 日志与状态
// ---------------------------------------------------------------------------

function createLogger(stateDir) {
  const logFile = join(stateDir, 'gateway.log')
  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}`
    process.stdout.write(line + '\n')
    try {
      // 简单轮转：超过 5MB 时清空重来
      if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) writeFileSync(logFile, '')
      appendFileSync(logFile, line + '\n')
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }
  return {
    log: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    file: logFile,
  }
}

function writeStatus(stateDir, status) {
  try {
    writeFileSync(join(stateDir, 'status.json'), JSON.stringify(status, null, 2))
  } catch {
    /* ignore */
  }
}

/**
 * 上次运行记录的「最近私聊发送者 openid」。
 *
 * 插件的 plugin.json 每次 writeSelf 都是整份覆盖，扫码绑定写入的 openid 会被后续
 * 网关启动抹掉；status.json 由网关自己维护，所以在这里留一份兜底身份。
 * 旧版本没写过这个字段时回退扫描日志，让升级后无需再发一条消息即可恢复身份。
 */
function readLastUserOpenId(stateDir) {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8')).lastUserOpenId
    if (typeof value === 'string' && value.length > 0) return value
  } catch {
    /* 首次运行没有状态文件，继续尝试日志 */
  }
  try {
    const log = readFileSync(join(stateDir, 'gateway.log'), 'utf8')
    // 取最后一次出现的私聊 key；群聊的 group_openid 不是用户身份，不参与。
    const matches = [...log.matchAll(/key=c2c:([A-Za-z0-9_-]+)/g)]
    const last = matches.at(-1)?.[1]
    return last !== undefined && last.length > 0 ? last : null
  } catch {
    /* 无日志可回溯 */
    return null
  }
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

/** 去掉 Markdown 装饰，让纯文本在 QQ 里可读。 */
function toPlainText(text) {
  return text
    // 代码围栏：去掉围栏本身与紧随其后的语言标记
    .replace(/```[^\S\n]*([\s\S]*?)```/g, (_m, code) =>
      code.replace(/^[ \t]*[A-Za-z0-9+#._-]{1,20}[ \t]*\r?\n/, '').trim(),
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按行切分成不超过 maxChars 的分片。 */
function chunkText(text, maxChars) {
  const chunks = []
  let current = ''
  for (const line of text.split('\n')) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    if (current.length > 0) chunks.push(current)
    if (line.length <= maxChars) {
      current = line
      continue
    }
    for (let index = 0; index < line.length; index += maxChars) {
      chunks.push(line.slice(index, index + maxChars))
    }
    current = ''
  }
  if (current.length > 0) chunks.push(current)
  return chunks.filter((chunk) => chunk.trim().length > 0)
}

const HELP_TEXT = [
  'DSH ⇄ QQ 机器人',
  '',
  '直接把消息发给我（群里需要 @我），我会转交给 DSH 处理。',
  '',
  '会话：',
  '  /new            开始新会话（清空上下文）',
  '  /stop           中断当前任务',
  '  /usage          查看上下文用量',
  '  /status         网关 / 模型 / 会话状态',
  '  /whoami         当前会话标识',
  '  /send <路径>    把一个本地文件作为 QQ 附件发给你',
  '',
  '模型与思考强度：',
  '  /model          列出可选模型',
  '  /model <编号>   切换到第 N 个模型',
  '  /model <p>/<m>  按 provider/model 切换',
  '  /effort         列出思考强度',
  '  /effort <值>    设置（low / high / max / 空=默认）',
  '',
  '会话与工作区：',
  '  /sessions       列出可恢复的 DSH 会话',
  '  /switch <编号|id>  切换到这个会话',
  '  /cd <目录>      换工作目录（下一个新会话生效）',
  '  /help           显示这条帮助',
].join('\n')

// ---------------------------------------------------------------------------
// 网关主体
// ---------------------------------------------------------------------------

class QqBotGateway {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.api = null
    this.gateway = null
    this.acp = null
    /** conversationKey -> { sessionId, alive } */
    this.sessions = new Map()
    /** sessionId -> 人话备注。ACP 的 session/list 不带标题，这份是 QQ 侧唯一的来源。 */
    this.sessionLabels = new Map()
    /** conversationKey -> 还没绑定到 sessionId 的备注（会话要下一条消息才建出来）。 */
    this.pendingLabels = new Map()
    /** conversationKey -> Promise chain，保证同一会话串行 */
    this.queues = new Map()
    /** conversationKey -> 正在执行的 job */
    this.activeJobs = new Map()
    /** messageId -> 已用掉的被动回复序号 */
    this.seqCounters = new Map()
    this.seenMessageIds = new Map()
    this.startedAt = new Date().toISOString()
    this.lastError = null
    this.lockFile = undefined
    this.lockTimer = undefined
    this.controlTimer = undefined
    this.parentTimer = undefined
    this.shutdownRequestFile = undefined
    this.connection = { connected: false, detail: 'starting' }
    this.stats = { inbound: 0, replies: 0, prompts: 0, errors: 0 }
    this.sessionsFile = join(config.stateDir, 'sessions.json')
  }

  // ---- 生命周期 ----------------------------------------------------------

  async startAcp() {
    const [command, ...args] = parseCommandLine(this.config.acpCommand)
    if (command === undefined) throw new Error('acpCommand 为空')
    this.acp = new AcpClient({
      command,
      args,
      cwd: this.config.workdir,
      /**
       * 桌面版：ACP 命令指向 Electron 可执行文件（它才读得到 app.asar 里的 CLI），
       * 因此必须显式带上 ELECTRON_RUN_AS_NODE —— 否则那个 exe 会去起 GUI。
       * 这里不依赖从宿主环境继承，用户手填的命令只要碰到 app.asar 也一并适用。
       */
      env: /app\.asar/i.test(this.config.acpCommand) ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
      log: (message) => this.logger.log(message),
      onNotification: (event) => this.onAcpNotification(event),
      onPermission: () => (this.config.autoApprove ? 'allow-once' : 'reject-once'),
      onExit: () => {
        this.connection = { connected: false, detail: 'acp exited' }
        this.persistStatus()
      },
    })
    await this.acp.start()
    this.loadSessions()
  }

  async startQq() {
    if (this.config.selfTest !== null) return
    if (this.config.appId.length === 0 || this.config.appSecret.length === 0) {
      throw new Error('缺少 AppID / AppSecret：请先在 DSH 设置里填写 QQ 机器人凭据')
    }
    this.api = new QqApi({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      sandbox: this.config.sandbox,
      tokenUrl: this.config.tokenUrl,
      apiBase: this.config.apiBase,
      log: (message) => this.logger.log(message),
    })
    const intents = PROTOCOL.intents.groupAndC2c | PROTOCOL.intents.interaction
    this.gateway = new QqGateway({
      api: this.api,
      intents,
      log: (message) => this.logger.log(message),
      onState: (state) => {
        this.connection = state
        this.persistStatus()
        this.logger.log(`qq: 连接状态 ${JSON.stringify(state)}`)
      },
      onEvent: (type, data) => void this.onQqEvent(type, data),
    })
    await this.gateway.start()
  }

  async run() {
    mkdirSync(this.config.stateDir, { recursive: true })
    mkdirSync(this.config.workdir, { recursive: true })
    if (!this.acquireLock()) {
      this.logger.warn('检测到已有 QQ 网关在运行，本次不再重复连接（同一 AppID 双连接会被 QQ 判为发送过快）')
      process.exit(0)
    }
    await this.startAcp()
    this.logger.log(`acp: 就绪（workspace=${this.config.workdir}）`)

    if (this.config.selfTest !== null) {
      const reply = await this.runPrompt('self-test', this.config.selfTest, { quiet: true })
      this.logger.log('=== self-test 回复开始 ===')
      process.stdout.write(reply + '\n')
      this.logger.log('=== self-test 回复结束 ===')
      this.acp.dispose()
      this.releaseLock()
      return
    }

    await this.startQq()
    this.persistStatus()
    this.logger.log(`qqbot 网关已启动 v${VERSION}（state=${this.config.stateDir}）`)

    // 宿主清理信号：插件写这个文件请求优雅退出，不依赖 stdio 或信号，
    // 因为 Windows 上 DSH 的子进程外层还有 wrapper，terminate() 可能只杀掉 wrapper。
    this.shutdownRequestFile = join(this.config.stateDir, 'shutdown.request')
    try {
      if (existsSync(this.shutdownRequestFile)) unlinkSync(this.shutdownRequestFile)
    } catch {
      /* ignore */
    }
    this.controlTimer = setInterval(() => {
      if (this.shutdownRequestFile !== undefined && existsSync(this.shutdownRequestFile)) {
        this.logger.log('收到退出请求文件，正在退出')
        void shutdown('shutdown request')
      }
    }, 1000)
    this.controlTimer.unref?.()

    // 父进程看门狗：wrapper 被杀后本进程会变成孤儿，继续占着单实例锁并让新网关起不来。
    if (process.env.DSH_QQBOT_IGNORE_PARENT !== '1') {
      this.parentTimer = setInterval(() => {
        if (!isProcessAlive(process.ppid)) {
          this.logger.warn(`父进程 ${process.ppid} 已退出，本网关随之退出以避免成为孤儿`)
          void shutdown('parent exited')
        }
      }, 20_000)
      this.parentTimer.unref?.()
    }

    const shutdown = async (signal) => {
      this.logger.log(`收到 ${signal}，正在退出`)
      if (this.controlTimer !== undefined) clearInterval(this.controlTimer)
      if (this.parentTimer !== undefined) clearInterval(this.parentTimer)
      this.gateway?.stop()
      this.acp?.dispose()
      this.persistStatus()
      this.releaseLock()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    // 父进程（DSH 插件）关闭 stdin 即视为取消；直接跑在终端时不启用这条路径。
    if (this.config.exitOnStdinEnd) {
      process.stdin.on('end', () => void shutdown('stdin end'))
      process.stdin.resume()
    }
  }

  // ---- 状态持久化 --------------------------------------------------------

  /**
   * 单实例保护：同一台机器上多个 DSH profile 都可能挂载本插件，而同一个
   * AppID 双连接会被 QQ 判为「发送过快」（4008）。锁文件带心跳，只有确认
   * 上一个进程还活着且心跳新鲜时才退出。
   */
  acquireLock() {
    const lockFile = join(this.config.stateDir, 'gateway.lock')
    try {
      if (existsSync(lockFile)) {
        const previous = JSON.parse(readFileSync(lockFile, 'utf8'))
        const pid = Number(previous.pid)
        const heartbeatAt = Date.parse(previous.heartbeatAt ?? previous.startedAt ?? '')
        const fresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 90_000
        if (pid !== process.pid && fresh && isProcessAlive(pid)) {
          this.logger.warn(`已有网关进程在运行（pid=${pid}，心跳 ${previous.heartbeatAt}），本次退出`)
          return false
        }
      }
    } catch {
      /* 锁文件损坏：直接覆盖 */
    }
    this.lockFile = lockFile
    this.writeLock()
    this.lockTimer = setInterval(() => this.writeLock(), 20_000)
    this.lockTimer.unref?.()
    return true
  }

  writeLock() {
    if (this.lockFile === undefined) return
    try {
      writeFileSync(
        this.lockFile,
        JSON.stringify({ pid: process.pid, startedAt: this.startedAt, heartbeatAt: new Date().toISOString() }),
      )
    } catch {
      /* ignore */
    }
  }

  releaseLock() {
    if (this.lockTimer !== undefined) {
      clearInterval(this.lockTimer)
      this.lockTimer = undefined
    }
    if (this.lockFile === undefined) return
    try {
      const current = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (Number(current.pid) === process.pid) unlinkSync(this.lockFile)
    } catch {
      /* ignore */
    }
  }

  loadSessions() {
    try {
      if (!existsSync(this.sessionsFile)) return
      const parsed = JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
      for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
        // v1 是 `key -> sessionId`；v2 是 `key -> { sessionId, cwd }`
        if (typeof value === 'string') {
          this.sessions.set(key, { sessionId: value, alive: false })
          continue
        }
        if (value !== null && typeof value === 'object') {
          this.sessions.set(key, {
            sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
            alive: false,
            ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
          })
        }
      }
      for (const [id, label] of Object.entries(parsed.labels ?? {})) {
        if (typeof label === 'string' && label.length > 0) this.sessionLabels.set(id, label)
      }
      this.logger.log(
        `acp: 载入 ${this.sessions.size} 个历史会话映射（首次使用时会 resume）、${this.sessionLabels.size} 条会话备注`,
      )
    } catch (error) {
      this.logger.warn(`acp: 会话映射读取失败：${error.message}`)
    }
  }

  saveSessions() {
    try {
      const sessions = {}
      for (const [key, value] of this.sessions) {
        // 只保留有会话 id 或显式工作目录的记录（`/cd` 之后可能还没有会话）
        if (typeof value.sessionId !== 'string' && value.cwd === undefined) continue
        sessions[key] = {
          sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
          ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        }
      }
      writeFileSync(this.sessionsFile, JSON.stringify({
        version: 2,
        sessions,
        labels: Object.fromEntries(this.sessionLabels),
      }, null, 2))
    } catch (error) {
      this.logger.warn(`acp: 会话映射写入失败：${error.message}`)
    }
  }

  /** 按 ACP session id 反查会话记录（usage 等运行期状态挂在它上面）。 */
  recordForSession(sessionId) {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record
    }
    return undefined
  }

  persistStatus() {
    writeStatus(this.config.stateDir, {
      version: VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      connection: this.connection,
      stats: this.stats,
      sessions: [...this.sessions.entries()].map(([key, value]) => ({
        key,
        sessionId: value.sessionId,
        resumed: value.alive,
        cwd: value.cwd ?? null,
        model: this.modelLabel(value.configOptions?.find?.((option) => option.id === 'model')),
        usage: value.usage ?? null,
      })),
      workdir: this.config.workdir,
      acpCommand: this.config.acpCommand,
      lastError: this.lastError,
      logFile: this.logger.file,
      /** 供配置页兜底展示/一键收紧；不是 QQ 侧状态，仅本机可读。 */
      lastUserOpenId: this.config.lastUserOpenId ?? null,
    })
  }

  // ---- ACP ---------------------------------------------------------------

  onAcpNotification(event) {
    if (event.method !== 'session/update') return
    const params = event.params ?? {}
    this.onUpdate(params.sessionId, params.update ?? {})
  }

  onUpdate(sessionId, update) {
    // 上下文用量：usage_update 是会话级状态，与是否在跑 prompt 无关。
    if (update.sessionUpdate === 'usage_update') {
      const record = this.recordForSession(sessionId)
      if (record !== undefined) {
        record.usage = { used: update.used ?? null, size: update.size ?? null, at: Date.now() }
      }
    }
    const job = this.activeJobFor(sessionId)
    if (job === undefined) return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') job.text += update.content.text ?? ''
        break
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') job.lastThought = (update.content.text ?? '').slice(-160)
        break
      case 'tool_call':
        job.lastTool = update.title ?? update.kind ?? 'tool'
        break
      case 'tool_call_update':
        if (update.status === 'completed') job.lastTool = null
        break
      default:
        break
    }
  }

  activeJobFor(sessionId) {
    for (const job of this.activeJobs.values()) {
      if (job.sessionId === sessionId) return job
    }
    return undefined
  }

  /** 取（必要时创建/恢复）某会话对应的 ACP session。 */
  async ensureSession(key) {
    const record = this.sessions.get(key)
    const cwd = record?.cwd ?? this.config.workdir
    if (record !== undefined && typeof record.sessionId === 'string' && record.sessionId.length > 0) {
      if (record.alive) return record.sessionId
      try {
        const resumed = await this.acp.resumeSession(record.sessionId, cwd, [])
        record.alive = true
        if (Array.isArray(resumed?.configOptions)) record.configOptions = resumed.configOptions
        this.logger.log(`acp: 已恢复会话 ${key} → ${record.sessionId}`)
        return record.sessionId
      } catch (error) {
        this.logger.warn(`acp: 恢复会话 ${key} 失败（${error.message}），将新建`)
        this.sessions.delete(key)
      }
    }
    const created = await this.acp.newSession(cwd, [])
    this.sessions.set(key, {
      sessionId: created.sessionId,
      alive: true,
      cwd,
      configOptions: created.configOptions,
      usage: null,
    })
    this.bindPendingLabel(key, created.sessionId)
    this.saveSessions()
    this.logger.log(`acp: 新建会话 ${key} → ${created.sessionId}（cwd=${cwd}）`)
    return created.sessionId
  }

  /** 当前会话的配置项状态（模型 / 思考强度）。 */
  configState(key) {
    const record = this.sessions.get(key)
    const options = record?.configOptions
    const model = Array.isArray(options) ? options.find((option) => option.id === 'model') : undefined
    const effort = Array.isArray(options) ? options.find((option) => option.id === 'reasoning_effort') : undefined
    return { record, model, effort }
  }

  /** 把 model 配置项摊平成可编号的列表。 */
  modelChoices(modelOption) {
    const choices = []
    for (const group of modelOption?.options ?? []) {
      for (const item of group.options ?? []) {
        choices.push({
          group: group.group ?? group.name ?? '',
          value: item.value,
          name: item.name ?? item.value,
          description: item.description,
        })
      }
    }
    return choices
  }

  /** `["provider","model"]` → `provider/model`。 */
  modelLabel(modelOption) {
    const raw = modelOption?.currentValue
    if (typeof raw !== 'string' || raw.length === 0) return '（未设置）'
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) && parsed.length >= 2 ? `${parsed[0]}/${parsed[1]}` : raw
    } catch {
      return raw
    }
  }

  /** 运行一轮 prompt，返回助手最终文本。 */
  async runPrompt(key, text, options = {}) {
    const sessionId = await this.ensureSession(key)
    const job = { sessionId, text: '', lastTool: null, lastThought: null, startedAt: Date.now() }
    this.activeJobs.set(key, job)
    this.stats.prompts += 1

    const progressTimer =
      options.quiet === true
        ? null
        : setTimeout(() => {
            if (job.text.trim().length > 0) return
            const hint = job.lastTool !== null ? `正在运行 ${job.lastTool}…` : '正在思考…'
            void options.onProgress?.(hint)
          }, this.config.progressMs)
    progressTimer?.unref?.()

    try {
      const result = await this.acp.prompt(sessionId, text)
      const stopReason = result?.stopReason ?? 'unknown'
      let output = toPlainText(job.text)
      if (output.length === 0) output = `（本轮没有文本输出，stopReason=${stopReason}）`
      return output
    } catch (error) {
      this.stats.errors += 1
      this.lastError = `${new Date().toISOString()} ${error.message}`
      this.logger.error(`acp: prompt 失败：${error.stack ?? error.message}`)
      throw error
    } finally {
      if (progressTimer !== null) clearTimeout(progressTimer)
      this.activeJobs.delete(key)
      this.persistStatus()
    }
  }

  // ---- QQ 事件 -----------------------------------------------------------

  async onQqEvent(type, data) {
    if (type !== PROTOCOL.events.c2c && type !== PROTOCOL.events.group) {
      this.logger.log(`qq: 忽略事件 ${type}`)
      return
    }
    const isGroup = type === PROTOCOL.events.group
    const target = isGroup ? data.group_openid : data.author?.user_openid
    if (typeof target !== 'string' || target.length === 0) {
      this.logger.warn(`qq: ${type} 缺少目标 openid，已忽略`)
      return
    }

    const messageId = data.id
    if (typeof messageId === 'string') {
      if (this.seenMessageIds.has(messageId)) {
        this.logger.log(`qq: 重复消息 ${messageId}，已忽略`)
        return
      }
      this.seenMessageIds.set(messageId, Date.now())
      this.pruneSeen()
    }

    this.stats.inbound += 1

    const sender = isGroup ? data.author?.member_openid : data.author?.user_openid
    const allowList = isGroup ? this.config.allowGroups : this.config.allowUsers
    const allowTarget = isGroup ? target : sender
    // 私聊身份在任何过滤之前记录：白名单为空时它是唯一能让用户自己查出 openid 的来源，
    // 被白名单拒绝时也仍要更新（否则改错白名单后无从恢复）。
    if (!isGroup && typeof sender === 'string' && sender.length > 0 && sender !== this.config.lastUserOpenId) {
      this.config.lastUserOpenId = sender
      this.persistStatus()
    }
    if (allowList.length > 0 && !allowList.includes(allowTarget)) {
      this.logger.log(`qq: ${isGroup ? '群' : '用户'} ${allowTarget} 不在白名单，已忽略`)
      return
    }

    const key = isGroup ? `group:${target}` : `c2c:${target}`
    const kind = isGroup ? 'group' : 'c2c'
    const text = String(data.content ?? '').trim()
    const attachments = collectAttachments(data)
    const quoted = quotedTextOf(data)

    this.logger.log(
      `qq: 收到 ${isGroup ? '群' : '私聊'}消息 key=${key} len=${text.length} 附件=${attachments.length} ` +
        `id=${messageId} text=${JSON.stringify(text.slice(0, 60))}`,
    )

    const reply = (content) => this.sendReply(kind, target, messageId, content)
    const sendFile = (filePath) => this.sendFileNow(kind, target, messageId, filePath)
    const prompt = await this.composePrompt(key, text, attachments, isGroup, sender, quoted)
    this.rememberLabel(key, text, quoted, attachments)
    // 同一会话已有任务在跑：先告诉用户已排队（enqueue 保证串行）。
    const busy = this.activeJobs.has(key) || this.queues.has(key)

    // 命令
    if (text.startsWith('/')) {
      const handled = await this.handleCommand(text, key, reply, sendFile)
      if (handled) {
        this.persistStatus()
        return
      }
    }

    this.enqueue(key, () => this.handleMessage(key, prompt, reply, busy))
  }

  /** 同一会话串行执行，避免 ACP 单会话并发 prompt。 */
  enqueue(key, task) {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error) => {
        this.logger.error(`任务失败 key=${key}: ${error?.stack ?? error?.message ?? error}`)
      })
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key)
      })
    this.queues.set(key, next)
    return next
  }

  async handleMessage(key, prompt, reply, busy = false) {
    if (busy) await reply('⏳ 上一条还在处理中，这条已排队。')
    let progressSent = false
    try {
      const output = await this.runPrompt(key, prompt, {
        onProgress: async (hint) => {
          if (progressSent) return
          progressSent = true
          await reply(`⏳ ${hint}`)
        },
      })
      this.logger.log(`qq: 本轮回复 ${output.length} 字：${JSON.stringify(output.slice(0, 60))}`)
      await reply(output)
    } catch (error) {
      await reply(`❌ 处理失败：${error.message}`)
    }
  }

  /** 上下文用量一行摘要。 */
  usageLine(key) {
    const usage = this.sessions.get(key)?.usage
    const used = usage?.used
    const size = usage?.size
    if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) {
      return '上下文用量：暂无数据（先发一条消息，DSH 会在本轮回复后上报）'
    }
    const percent = ((used / size) * 100).toFixed(1)
    return `上下文用量：${used.toLocaleString('en-US')} / ${size.toLocaleString('en-US')} tokens（${percent}%）`
  }

  /** /status 的多行输出。 */
  statusReport(key) {
    const { record, model, effort } = this.configState(key)
    const lines = [
      `连接：${this.connection.connected ? '已连接' : '未连接'}（${this.connection.detail ?? '-'}）`,
      `模型：${this.modelLabel(model)}`,
      `思考强度：${effort === undefined ? '—' : (effort.currentValue === '' ? '默认' : effort.currentValue)}`,
      this.usageLine(key),
      `工作目录：${record?.cwd ?? this.config.workdir}`,
      `会话：${record?.sessionId ?? '（尚未创建）'}`,
      `处理中：${this.activeJobs.size}　ACP 会话数：${this.sessions.size}`,
      `统计：收到 ${this.stats.inbound}，回复 ${this.stats.replies}，失败 ${this.stats.errors}`,
    ]
    if (this.lastError !== null) lines.push(`最近错误：${this.lastError}`)
    return lines.join('\n')
  }

  async handleCommand(line, key, reply, sendFile) {
    const trimmed = line.trim()
    const [name, ...rest] = trimmed.split(/\s+/)
    const argument = rest.join(' ').trim()
    switch (name) {
      case '/help':
      case '/?':
        await reply(HELP_TEXT)
        return true
      case '/new':
      case '/reset': {
        const record = this.sessions.get(key)
        if (record !== undefined) {
          await this.acp.closeSession(record.sessionId)
          this.sessions.delete(key)
          this.saveSessions()
        }
        await reply('🆕 已开始新会话，之前的上下文已清空。')
        return true
      }
      case '/stop': {
        const record = this.sessions.get(key)
        if (record === undefined) {
          await reply('当前没有进行中的会话。')
          return true
        }
        await this.acp.cancel(record.sessionId)
        await reply('🛑 已请求中断当前任务。')
        return true
      }
      case '/usage': {
        await reply(this.usageLine(key))
        return true
      }
      case '/status': {
        await reply(this.statusReport(key))
        return true
      }
      case '/whoami':
        await reply(`会话标识：${key}`)
        return true

      case '/model': {
        await this.ensureSession(key)
        const { model } = this.configState(key)
        if (model === undefined) {
          await reply('当前会话没有可切换的模型配置项。')
          return true
        }
        const choices = this.modelChoices(model)
        if (argument.length === 0) {
          const lines = [`当前模型：${this.modelLabel(model)}`, '', '可选模型：']
          choices.forEach((choice, index) => {
            lines.push(`  ${index + 1}. ${choice.group ? `[${choice.group}] ` : ''}${choice.name}`)
          })
          lines.push('', '用 /model <编号> 或 /model <provider>/<model> 切换。')
          await reply(lines.join('\n'))
          return true
        }
        let target
        const asIndex = Number(argument)
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
          target = choices[asIndex - 1]
        } else {
          const normalized = argument.replace(/\s+/g, '/').toLowerCase()
          target = choices.find((choice) => {
            const label = `${choice.group}/${choice.name}`.toLowerCase()
            return label === normalized || choice.name.toLowerCase() === normalized || choice.value.toLowerCase() === normalized
          })
        }
        if (target === undefined) {
          await reply(`没找到「${argument}」。用 /model 看可选列表（当前 ${this.modelLabel(model)}）。`)
          return true
        }
        try {
          const record = this.sessions.get(key)
          const configOptions = await this.acp.setConfigOption(record.sessionId, 'model', target.value)
          record.configOptions = configOptions
          const next = configOptions.find((option) => option.id === 'model')
          await reply(`✅ 模型已切换为 ${this.modelLabel(next ?? { currentValue: target.value })}（下一条消息生效）`)
          this.logger.log(`qq: ${key} 切换模型 → ${target.value}`)
        } catch (error) {
          await reply(`❌ 切换模型失败：${error.message}`)
        }
        return true
      }

      case '/effort':
      case '/think': {
        await this.ensureSession(key)
        const { effort } = this.configState(key)
        if (effort === undefined) {
          await reply('当前会话没有可切换的思考强度配置项。')
          return true
        }
        const options = effort.options ?? []
        if (argument.length === 0) {
          const lines = [`当前思考强度：${effort.currentValue === '' ? '默认' : effort.currentValue}`, '', '可选值：']
          options.forEach((option, index) => {
            const label = option.value === '' ? '（默认）' : option.value
            lines.push(`  ${index + 1}. ${label} — ${option.name ?? ''}`)
          })
          lines.push('', '用 /effort <编号或值> 设置。')
          await reply(lines.join('\n'))
          return true
        }
        let value = argument
        const asIndex = Number(argument)
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) value = options[asIndex - 1].value
        if (!options.some((option) => option.value === value)) {
          await reply(`没找到「${argument}」。用 /effort 看可选值。`)
          return true
        }
        try {
          const record = this.sessions.get(key)
          const configOptions = await this.acp.setConfigOption(record.sessionId, 'reasoning_effort', value)
          record.configOptions = configOptions
          const next = configOptions.find((option) => option.id === 'reasoning_effort')
          await reply(`✅ 思考强度已设为 ${(next?.currentValue ?? value) === '' ? '默认' : (next?.currentValue ?? value)}（下一条消息生效）`)
          this.logger.log(`qq: ${key} 切换思考强度 → ${JSON.stringify(value)}`)
        } catch (error) {
          await reply(`❌ 设置思考强度失败：${error.message}`)
        }
        return true
      }

      case '/sessions': {
        try {
          const sessions = await this.acp.listSessions()
          const record = this.sessions.get(key)
          this.lastSessionList = sessions.slice(0, 20)
          if (this.lastSessionList.length === 0) {
            await reply('没有可恢复的 DSH 会话。')
            return true
          }
          await reply(formatSessionList(this.lastSessionList, this.sessionLabels, record?.sessionId ?? null))
        } catch (error) {
          await reply(`❌ 读取会话列表失败：${error.message}`)
        }
        return true
      }

      case '/switch': {
        if (argument.length === 0) {
          await reply('用法：/switch <编号|会话 id>（先用 /sessions 看列表）')
          return true
        }
        let target = null
        const asIndex = Number(argument)
        if (Number.isInteger(asIndex) && Array.isArray(this.lastSessionList) && asIndex >= 1 && asIndex <= this.lastSessionList.length) {
          target = this.lastSessionList[asIndex - 1]
        } else if (typeof argument === 'string' && argument.length >= 6) {
          const all = await this.acp.listSessions().catch(() => [])
          target = all.find((session) => session.sessionId === argument) ?? all.find((session) => session.sessionId.startsWith(argument)) ?? null
        }
        if (target === null) {
          await reply(`没找到会话「${argument}」。先用 /sessions 列一次，再按编号切换。`)
          return true
        }
        const previous = this.sessions.get(key)
        if (previous !== undefined && previous.sessionId !== target.sessionId) await this.acp.closeSession(previous.sessionId)
        this.sessions.set(key, { sessionId: target.sessionId, alive: false, cwd: target.cwd ?? this.config.workdir })
        this.saveSessions()
        try {
          await this.ensureSession(key)
          await reply(`✅ 已切换到会话 ${target.sessionId.slice(0, 8)}（工作目录 ${target.cwd ?? this.config.workdir}）`)
          this.logger.log(`qq: ${key} 切换会话 → ${target.sessionId}`)
        } catch (error) {
          await reply(`⚠️ 已记录会话 ${target.sessionId.slice(0, 8)}，但恢复失败：${error.message}`)
        }
        return true
      }

      case '/cd': {
        if (argument.length === 0) {
          await reply(`当前工作目录：${this.sessions.get(key)?.cwd ?? this.config.workdir}\n用法：/cd <绝对路径>`)
          return true
        }
        const target = argument.replace(/^"|"$/g, '')
        if (!existsSync(target)) {
          await reply(`目录不存在：${target}`)
          return true
        }
        const record = this.sessions.get(key)
        if (record?.sessionId !== undefined && record?.sessionId !== null) {
          await this.acp.closeSession(record.sessionId)
        }
        // 只留工作目录：下一条消息会在新目录里新建会话。
        this.sessions.set(key, { sessionId: null, alive: false, cwd: target })
        this.saveSessions()
        await reply(`📁 工作目录已设为 ${target}，下一条消息会在新目录里新建会话。`)
        this.logger.log(`qq: ${key} 切换工作目录 → ${target}`)
        return true
      }

      case '/send': {
        if (argument.length === 0) {
          await reply('用法：/send <文件的绝对路径>\n例如：/send C:\\Users\\liyin\\Desktop\\报表.xlsx')
          return true
        }
        await sendFile(argument)
        return true
      }

      default:
        if (/^\/[a-z?]+$/i.test(name)) {
          await reply(`未知命令 ${name}\n\n${HELP_TEXT}`)
          return true
        }
        return false
    }
  }

  /**
   * 组装给 DSH 的提示词：包含来源信息、引用上下文与附件本地路径。
   *
   * 顺序有讲究：**用户正文放最前面，来源信封挪到最后**。DSH 的会话标题在
   * 没有模型总结时会退化成「提示词前 40 字节」，信封放开头的话标题就变成
   * `[来自 QQ 私聊（user_openid=…` 这种纯样板文字，会话列表里完全认不出是哪条。
   * 正文在前，退化的标题至少是用户自己说的话。
   */
  async composePrompt(key, text, attachments, isGroup, sender, quoted = '') {
    const parts = []
    if (text.length > 0) parts.push(text)
    if (quoted.length > 0) parts.push(`[用户引用的消息] ${quoted}`)
    if (attachments.length > 0) {
      const saved = await this.saveAttachments(attachments)
      if (saved.length > 0) parts.push(...attachmentPromptLines(saved))
      else parts.push('用户发送了附件，但下载失败。')
    }
    const source = isGroup ? `QQ 群聊（group_openid=${key.slice(6)}，发送者 member_openid=${sender ?? '未知'}）` : `QQ 私聊（user_openid=${sender ?? key.slice(4)}）`
    parts.push(
      '',
      `[来自 ${source} 的消息]`,
      '[回复要求] 你的回复会直接作为 QQ 消息发给用户：用纯文本、不要 Markdown 表格、避免超长代码块；需要分点时用「·」。' +
        `要发文件或图片给用户时，在回复里单独一行写 [[send:绝对路径]]（一行一个，最多 ${MAX_OUTGOING_FILES} 个）——` +
        '这一行不会展示给用户，文件会作为 QQ 附件真正发出去；不要用这个方式发目录，也不要对同一路径重复发。' +
        (this.config.extraPrompt.length > 0 ? ` ${this.config.extraPrompt}` : ''),
    )
    return parts.join('\n')
  }

  /** QQ 附件需要带鉴权头下载，URL 有时效，收到即取。 */
  async saveAttachments(attachments) {
    const saved = []
    const dir = join(this.config.stateDir, 'attachments')
    mkdirSync(dir, { recursive: true })
    for (const [index, attachment] of attachments.entries()) {
      const contentType = typeof attachment?.content_type === 'string' ? attachment.content_type : ''
      const isVoice = contentType === 'voice'
      // 语音消息 QQ 另外给一个转好的 WAV；原始 silk 存下来 DSH 也读不了。
      const url = isVoice && typeof attachment.voice_wav_url === 'string' && attachment.voice_wav_url.length > 0
        ? attachment.voice_wav_url
        : attachment?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const name = attachmentFileName(attachment, contentType, index, isVoice)
      const dest = join(dir, `${Date.now()}-${index}-${name}`)
      try {
        const token = await this.api?.token()
        const response = await fetch(url, {
          headers: token === undefined || token === null ? {} : { authorization: `${PROTOCOL.authScheme} ${token}` },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        writeFileSync(dest, buffer)
        const transcript = typeof attachment.asr_refer_text === 'string' ? attachment.asr_refer_text.trim() : ''
        saved.push({
          path: dest,
          type: isVoice ? 'voice' : contentType,
          ...(transcript.length === 0 ? {} : { transcript }),
        })
        this.logger.log(
          `qq: 附件已保存 ${dest}（${buffer.length} 字节，类型=${contentType || '未知'}${isVoice ? '，已取 WAV' : ''}）`,
        )
      } catch (error) {
        this.logger.warn(`qq: 附件下载失败 ${url}：${error.message}`)
      }
    }
    return saved
  }

  pruneSeen() {
    const cutoff = Date.now() - PROTOCOL.dedupeWindowMs
    for (const [id, at] of this.seenMessageIds) {
      if (at < cutoff) this.seenMessageIds.delete(id)
    }
  }

  // ---- 发送 --------------------------------------------------------------

  /**
   * 给会话记一句人话备注，用于 `/sessions` 列表。
   *
   * ACP 的 `session/list` 只返回 sessionId 和 cwd，**不带标题**，所以 QQ 这边想认出
   * 「哪条会话是什么」只能自己留一份。只记第一条有内容的用户消息：备注要代表这条会话的
   * 起点，跟着后续对话走就没意义了。
   *
   * 时序上有个坑：用户消息到达时，新会话还没建出来（`ensureSession` 在队列里才跑），
   * 所以先按 conversationKey 存成待定，等 sessionId 出来再绑定。
   */
  rememberLabel(key, text, quoted, attachments) {
    // 命令不是会话内容：把 /help 记成备注毫无意义，而且会把真正的第一句话挤掉。
    if (text.startsWith('/')) return
    const source = text.length > 0
      ? text
      : quoted.length > 0
        ? `（引用）${quoted}`
        : attachments.length > 0
          ? `（附件）${attachments[0]?.filename ?? attachments[0]?.content_type ?? '文件'}`
          : ''
    if (source.length === 0) return
    const label = source.replace(/\s+/g, ' ').trim().slice(0, 24)
    const record = this.sessions.get(key)
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : null
    if (sessionId === null) {
      if (!this.pendingLabels.has(key)) this.pendingLabels.set(key, label)
      return
    }
    if (this.sessionLabels.has(sessionId)) return
    this.sessionLabels.set(sessionId, label)
    this.saveSessions()
  }

  /** 会话建好之后，把待定备注绑到它的 sessionId 上。 */
  bindPendingLabel(key, sessionId) {
    const label = this.pendingLabels.get(key)
    if (label === undefined) return
    this.pendingLabels.delete(key)
    if (this.sessionLabels.has(sessionId)) return
    this.sessionLabels.set(sessionId, label)
  }

  /**
   * 直接发一个本地文件（`/send` 用），走的是和 `[[send:路径]]` 完全相同的
   * 分片上传 + msg_type=7 流程。成功时不额外发文字：一条被动回复额度很贵。
   */
  async sendFileNow(kind, target, messageId, filePath) {
    const limits = PROTOCOL.passiveReply[kind] ?? PROTOCOL.passiveReply.group
    if (limits.maxReplies - this.seqOf(messageId) <= 0) {
      await this.sendReply(kind, target, messageId, '❌ 这条消息的被动回复额度已用完，请重新发一条消息再试。')
      return
    }
    try {
      const uploaded = await this.api.uploadLocalFile(kind, target, filePath)
      await this.api.sendMedia(kind, target, uploaded.fileInfo, { msgId: messageId, msgSeq: this.nextSeq(messageId) })
      this.stats.replies += 1
      this.logger.log(`qq: /send 已发出 ${uploaded.fileName}（${uploaded.bytes} 字节）`)
    } catch (error) {
      this.lastError = `${new Date().toISOString()} /send 失败：${error.message}`
      this.logger.warn(`qq: /send 失败 ${filePath}：${error.message}`)
      await this.sendReply(kind, target, messageId, `❌ 发送失败：${String(error.message).slice(0, 200)}`)
    }
    this.persistStatus()
  }

  /**
   * 回一条被动消息：正文按段发，`[[send:路径]]` 指到的文件走富媒体附件。
   *
   * msg_seq 在一条用户消息内递增，额度按场景不同（单聊 4 条 / 群聊 5 条）。
   * 附件优先占位：文本至少留 1 段，剩下的额度给附件 —— 否则长回复会把额度吃光，
   * 真正想发的文件反而发不出去。
   */
  async sendReply(kind, target, messageId, content) {
    if (this.config.selfTest !== null) {
      process.stdout.write(content + '\n')
      return
    }
    const raw = typeof content === 'string' ? content.trim() : ''
    if (raw.length === 0) return
    const { text, files } = parseOutgoingFiles(raw)
    const limits = PROTOCOL.passiveReply[kind] ?? PROTOCOL.passiveReply.group
    const budget = Math.max(0, limits.maxReplies - this.seqOf(messageId))
    const wanted = files.slice(0, MAX_OUTGOING_FILES)
    if (files.length > wanted.length) {
      this.logger.warn(`qq: 一条回复最多带 ${MAX_OUTGOING_FILES} 个附件，忽略多余的 ${files.length - wanted.length} 个`)
    }
    const fileBudget = Math.max(0, Math.min(wanted.length, budget - (text.length > 0 ? 1 : 0)))
    const textBudget = Math.max(0, budget - fileBudget)
    const chunks = text.length === 0 ? [] : chunkText(text, this.config.maxChars)

    this.logger.log(
      `qq: 准备回复 ${text.length} 字 / ${chunks.length} 段，附件 ${wanted.length} 个，` +
        `额度 ${budget}（文本 ${textBudget} + 附件 ${fileBudget}）`,
    )

    let sent = 0
    for (const chunk of chunks.slice(0, textBudget)) {
      const seq = this.nextSeq(messageId)
      try {
        await this.api.sendText(kind, target, chunk, { msgId: messageId, msgSeq: seq })
        sent += 1
        this.stats.replies += 1
      } catch (error) {
        this.logger.warn(`qq: 发送失败（seq=${seq}）：${error.message}`)
        this.lastError = `${new Date().toISOString()} 发送失败：${error.message}`
        break
      }
    }
    if (chunks.length > textBudget) {
      const overflowFile = join(this.config.stateDir, `reply-${Date.now()}.md`)
      try {
        writeFileSync(overflowFile, text)
      } catch {
        /* ignore */
      }
      this.logger.warn(`qq: 回复过长，仅发送 ${sent}/${chunks.length} 段，全文见 ${overflowFile}`)
    }

    const failures = []
    let mediaSent = 0
    for (const filePath of wanted.slice(0, fileBudget)) {
      try {
        const uploaded = await this.api.uploadLocalFile(kind, target, filePath)
        await this.api.sendMedia(kind, target, uploaded.fileInfo, { msgId: messageId, msgSeq: this.nextSeq(messageId) })
        mediaSent += 1
        this.stats.replies += 1
        this.logger.log(`qq: 已发出附件 ${uploaded.fileName}（${uploaded.bytes} 字节）`)
      } catch (error) {
        failures.push(`${basename(filePath)}：${error.message}`)
        this.lastError = `${new Date().toISOString()} 附件发送失败：${error.message}`
        this.logger.warn(`qq: 附件发送失败 ${filePath}：${error.message}`)
      }
    }
    if (wanted.length > fileBudget) failures.push(`被动回复额度只剩 ${budget} 条，${wanted.length - fileBudget} 个附件未发送`)

    // 一条都没发出去时必须让用户知道原因，否则就是静默失败。
    if (sent === 0 && mediaSent === 0 && failures.length > 0 && budget > 0) {
      try {
        await this.api.sendText(kind, target, `❌ 附件发送失败：${failures.join('；').slice(0, 300)}`, {
          msgId: messageId,
          msgSeq: this.nextSeq(messageId),
        })
        this.stats.replies += 1
      } catch (error) {
        this.logger.warn(`qq: 连失败提示都没发出去：${error.message}`)
      }
    }
    this.persistStatus()
  }

  seqOf(messageId) {
    return this.seqCounters.get(messageId) ?? 0
  }

  nextSeq(messageId) {
    const next = this.seqOf(messageId) + 1
    this.seqCounters.set(messageId, next)
    const cutoff = Date.now() - PROTOCOL.dedupeWindowMs
    for (const [id] of this.seqCounters) {
      if (!this.seenMessageIds.has(id) || (this.seenMessageIds.get(id) ?? 0) < cutoff) this.seqCounters.delete(id)
    }
    return next
  }
}

/**
 * 回复里用来指认要发出的文件的指令行，例如 `[[send:D:\out\报表.xlsx]]`。
 * 容忍大小写、多余空白，以及模型习惯加的引号/反引号。
 */
const SEND_MARKER = /^\[\[\s*send\s*:\s*(.+?)\s*\]\]$/i

/** 一条回复最多带几个附件：被动回复额度本来就只有 4~5 条。 */
const MAX_OUTGOING_FILES = 3

/**
 * 把回复文本拆成「给用户看的正文」和「要作为附件发出的文件路径」。
 *
 * DSH 用一行 `[[send:绝对路径]]` 指认附件；这一行本身不会出现在用户看到的消息里。
 * 之所以走文本约定而不是新工具：ACP 会话 id 对 agent 不可见，工具无法自证
 * 「我属于哪个 QQ 会话」，而回复文本天然就带这个上下文。
 *
 * @param {string} text 模型产出的回复
 * @returns {{text: string, files: string[]}} 去掉指令行后的正文与文件路径
 */
function parseOutgoingFiles(text) {
  const files = []
  const kept = []
  for (const line of String(text ?? '').split('\n')) {
    const match = line.trim().match(SEND_MARKER)
    if (match === null) {
      kept.push(line)
      continue
    }
    const path = match[1].trim().replace(/^[`"']+/, '').replace(/[`"']+$/, '').trim()
    if (path.length > 0) files.push(path)
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), files }
}

/**
 * 把 `/sessions` 的列表渲染成给人看的几行。
 *
 * 抽成纯函数是因为能拿到的只有 ACP 的 `session/list`（只有 sessionId + cwd）和网关
 * 自己记的备注：ACP 的 `session/list` 只列**已持久化**的会话，刚建出来的那条往往还
 * 不在里面，所以端到端断言不可靠，这份渲染逻辑改由单测覆盖。
 *
 * @param {{sessionId: string, cwd?: string}[]} sessions 会话列表
 * @param {Map<string, string>} labels sessionId → 备注
 * @param {string|null} currentSessionId 当前会话 id，用于标「← 当前」
 * @returns {string} 回复正文
 */
function formatSessionList(sessions, labels, currentSessionId) {
  const lines = ['最近的 DSH 会话（用 /switch <编号> 切换）：']
  sessions.forEach((session, index) => {
    // ACP 一定给 sessionId，但渲染层不该因为一条坏数据就整条命令崩掉。
    const id = typeof session?.sessionId === 'string' ? session.sessionId : ''
    const shortId = id.length > 0 ? id.slice(0, 8) : '(未知会话)'
    const current = id.length > 0 && id === currentSessionId ? ' ← 当前' : ''
    const label = id.length > 0 ? labels.get(id) : undefined
    const head = label === undefined
      ? `${shortId}  ${session?.cwd ?? ''}`
      : `${label}　[${shortId}]`
    lines.push(`  ${index + 1}. ${head}${current}`)
  })
  if (labels.size === 0) {
    lines.push('', '（还没有备注：备注只在「从 QQ 发消息建会话」时记下，网页端建的会话没有）')
  }
  return lines.join('\n')
}

/** 保留 Unicode 字母数字：QQ 的文件名多为中文，`\w` 会把整串压成下划线。 */
function sanitizeName(name) {
  return String(name)
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 60)
}

/** QQ 的 content_type → 落盘扩展名；缺扩展名下游工具认不出格式。 */
const EXTENSION_BY_CONTENT_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
}

/**
 * 附件落盘文件名：优先 QQ 给的 filename，缺扩展名时按 content_type 补齐。
 * @param {object} attachment QQ 附件对象
 * @param {string} contentType 已解析的 content_type，未知时为空串
 * @param {number} index 同一条消息内的序号
 * @param {boolean} isVoice 是否语音（走 voice_wav_url，落盘为 .wav）
 * @returns {string} 安全的文件名
 */
function attachmentFileName(attachment, contentType, index, isVoice) {
  const provided = typeof attachment?.filename === 'string' ? attachment.filename.trim() : ''
  const stripped = sanitizeName(provided.length > 0 ? provided : `attachment-${index}`).replace(/^[.\-_]+/, '')
  const base = stripped.length > 0 ? stripped : `attachment-${index}`
  if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base
  if (isVoice) return `${base}.wav`
  return `${base}${EXTENSION_BY_CONTENT_TYPE[contentType] ?? ''}`
}

/**
 * 收集一条消息里的全部附件。引用消息（message_type=103）把被引用的内容放在
 * msg_elements 里，附件也嵌套在其中；只读顶层 attachments 会把它们丢掉。
 * @param {object} data QQ 事件体
 * @returns {object[]} 附件列表
 */
function collectAttachments(data) {
  const found = []
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.attachments)) found.push(...node.attachments)
    if (Array.isArray(node.msg_elements)) for (const element of node.msg_elements) visit(element)
  }
  visit(data)
  return found
}

/**
 * 被引用消息的正文（来自 msg_elements）；没有引用时返回空串。
 * @param {object} data QQ 事件体
 * @returns {string} 引用正文
 */
function quotedTextOf(data) {
  if (!Array.isArray(data?.msg_elements)) return ''
  return data.msg_elements
    .map((element) => (typeof element?.content === 'string' ? element.content.trim() : ''))
    .filter((text) => text.length > 0)
    .join(' / ')
}

/**
 * 附件写进提示词的说明行：图片指明先看图，语音附上 QQ 自带的转写结果。
 * @param {{path: string, type: string, transcript?: string}[]} saved 已落盘的附件
 * @returns {string[]} 提示词行
 */
function attachmentPromptLines(saved) {
  if (saved.length === 0) return []
  const lines = ['用户同时发送了附件，已下载到本地：']
  for (const item of saved) {
    lines.push(`- ${item.path}${item.type.length > 0 ? `（${item.type}）` : ''}`)
    if (typeof item.transcript === 'string' && item.transcript.length > 0) {
      lines.push(`  语音转写：${item.transcript}`)
    }
  }
  if (saved.some((item) => item.type.startsWith('image/'))) {
    lines.push('图片请先用 read_image 工具查看画面，再据此回答；不要只凭文件名猜测内容。')
  }
  return lines
}

/** 进程是否存活（信号 0 探测；EPERM 也算存活）。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig(process.argv.slice(2))
  mkdirSync(config.stateDir, { recursive: true })
  const logger = createLogger(config.stateDir)
  logger.log(`qqbot gateway v${VERSION} 启动：${JSON.stringify({ ...config, appSecret: config.appSecret ? '***' : '' })}`)

  const gateway = new QqBotGateway(config, logger)
  try {
    await gateway.run()
  } catch (error) {
    logger.error(`启动失败：${error?.stack ?? error?.message ?? error}`)
    gateway.releaseLock()
    writeStatus(config.stateDir, {
      version: VERSION,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      connection: { connected: false, detail: 'failed' },
      lastError: String(error?.message ?? error),
      logFile: logger.file,
    })
    process.exit(1)
  }
}

// 只有被直接执行时才起进程；被 import（单测、复用解析函数）时保持无副作用。
const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isDirectRun) void main()

export {
  QqBotGateway,
  chunkText,
  toPlainText,
  parseCommandLine,
  readLastUserOpenId,
  attachmentFileName,
  attachmentPromptLines,
  collectAttachments,
  formatSessionList,
  parseOutgoingFiles,
  quotedTextOf,
  MAX_OUTGOING_FILES,
}
