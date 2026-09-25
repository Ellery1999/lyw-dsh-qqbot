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

/**
 * 按需标记 volatile：仅当运行中的 schemastery 支持 `.volatile()` 时生效。
 *
 * 0.1.7-rc.2 的 ctx.settings 是 SettingsForms，其 write() 要求条目含 volatile 字段
 * （无则抛 `Plugin entry "ns" has no volatile fields`，非 volatile 路径抛
 * `Config field "x" is not volatile`），扫码绑定/配置页保存/白名单都依赖
 * `settings.update('qqbot', ...)`，因此 0.1.7 下这 10 个字段必须 volatile。
 *
 * 但 0.1.5-rc.2 安装的 schemastery 3.18.2 没有这个方法，直接调用会在模块加载时
 * 抛 TypeError，导致 0.1.5 也无法启动。所以这里做能力探测：老版本上退化为普通字段，
 * 同一份文件在两个版本都能加载。0.1.5 下设置写入沿用不了新语义（旧 installSection
 * 已删），但插件本身、网关、配置页读取都正常。
 * @param schema - 字段 schema。
 * @returns 支持时返回 volatile 标记后的 schema，否则返回原 schema。
 */
function liveField(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

/**
 * 宿主是否跑在 Electron 里（桌面版）。
 *
 * 桌面版把整个 DSH 运行时放进 `app.asar`，宿主进程就是 `DeepSeek Harness.exe` 本身，
 * 因此 `process.versions.electron` 有值、`process.execPath` 是那个 exe。
 * 影响两件事：网关子进程怎么起（见 start() 的 ELECTRON_RUN_AS_NODE），
 * 以及 ACP 命令默认值怎么算（见 defaultAcpCommand()）。
 * @returns 运行在 Electron 中时为 true。
 */
function isElectronRuntime() {
  return typeof process.versions?.electron === 'string' && process.versions.electron.length > 0
}

/**
 * 默认的 ACP 命令。
 *
 * 桌面版 PATH 上没有 `dsh`，所以 `dsh --profile acp` 在桌面版里必然 ENOENT。
 * 按运行形态探测：
 *   1. 环境里显式给了 DSH_QQBOT_ACP_COMMAND 就用它（最高优先级）；
 *   2. 宿主是 Electron 应用且 app.asar 内的 CLI 入口存在 —— 用同一个可执行文件跑
 *      asar 里的 bin.js。asar 只有 Electron 自己能读，所以网关侧会补
 *      ELECTRON_RUN_AS_NODE=1（见 start() 传给网关的环境）；
 *   3. 其余情况保持 `dsh --profile acp`（PATH 上有 dsh 的安装）。
 * @returns 默认的 ACP 命令行。
 */
function defaultAcpCommand() {
  const explicit = process.env.DSH_QQBOT_ACP_COMMAND
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  if (isElectronRuntime()) {
    const executable = process.execPath
    const cli = join(
      dirname(executable),
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    )
    if (existsSync(cli)) return `"${executable}" "${cli}" --profile acp`
  }
  return 'dsh --profile acp'
}

const Config = z.object({
  enabled: liveField(z.boolean().default(true)).description('启用 QQ 机器人网关'),
  appId: liveField(z.string().default('')).description('QQ 开放平台机器人的 AppID'),
  appSecret: liveField(z.string().role('secret').default('')).description('QQ 开放平台机器人的 AppSecret'),
  sandbox: liveField(z.boolean().default(false)).description('使用沙箱环境（sandbox.api.sgroup.qq.com）'),
  workspace: liveField(z.string().default('')).description('DSH 会话的工作目录；留空使用 $DSH_HOME/qqbot/workspace'),
  acpCommand: liveField(z.string().default(defaultAcpCommand())).description('启动 ACP agent 的命令行'),
  autoApprove: liveField(z.boolean().default(true)).description('自动允许 ACP 权限请求（关闭时需授权的能力会被拒绝）'),
  allowUsers: liveField(z.array(z.string()).default([])).description('允许私聊的 user_openid 白名单；留空不限制'),
  allowGroups: liveField(z.array(z.string()).default([])).description('允许的 group_openid 白名单；留空不限制'),
  extraPrompt: liveField(z.string().default('')).description('附加到每条 QQ 消息后的额外要求'),
})

/** Config 字段顺序（与上面的 schema 一致）。 */
const CONFIG_FIELDS = [
  'enabled', 'appId', 'appSecret', 'sandbox', 'workspace',
  'acpCommand', 'autoApprove', 'allowUsers', 'allowGroups', 'extraPrompt',
]

/**
 * 读取一份配置快照。
 *
 * 0.1.7 起 volatile 字段由 loader 以引用形式交给 `apply`，实时值用 `.get()` 读；
 * 同时兼容普通值（便于在旧版本或测试里直接调用）。调用方一次取一份快照再使用，
 * 避免同一次操作中途读到前后不一致的值。
 * @param source - `apply` 收到的 config（引用集合或普通对象）。
 * @returns 展开后的普通配置对象。
 */
function readConfig(source) {
  const value = source ?? {}
  const out = {}
  for (const field of CONFIG_FIELDS) {
    const raw = value[field]
    out[field] = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw
  }
  return out
}

function resolveHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
}

/** 需要从「当前 profile」搬进 ACP profile 的条目 id：模型/provider 相关。 */
const SHARED_ENTRY_IDS = ['llm-pi-ai', 'agent-default-model', 'permission']

/**
 * 从当前 profile 的 `cordis.patch.yml` 里切出模型/provider 相关条目，原样复制。
 *
 * 为什么不做 YAML 解析：这些条目是顶层数组里「`- id: <name>` 起头、到下一个
 * 顶层 `- ` 为止」的块，逐行扫描既够用又不引入依赖（qrcode-generator 之外
 * 本插件没有运行时依赖）。缩进里出现的 `- ` 不算顶层（要求第 0 列）。
 * @param text - profile patch 文件内容。
 * @returns 被选中的条目块文本（含首个 `- ` 行），按原顺序。
 */
function extractSharedEntries(text) {
  const lines = text.split(/\r?\n/)
  const blocks = []
  let current = null
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current !== null) blocks.push(current)
      current = [line]
      continue
    }
    if (current !== null) current.push(line)
  }
  if (current !== null) blocks.push(current)
  return blocks
    .filter((block) => {
      const match = /^- id:\s*["']?([^"'\s]+)["']?\s*$/.exec(block[0])
      return match !== null && SHARED_ENTRY_IDS.includes(match[1])
    })
    .map((block) => block.join('\n').replace(/\s+$/, ''))
}

/**
 * 让 QQ 用的 ACP profile 自动复用「当前 profile」的 provider/模型配置。
 *
 * 背景：qqbot 拉起的是 `dsh --profile acp`，QQ 里 `/model` 能看到的 provider
 * 完全取决于 acp profile 自己的组合。用户在主界面（desktop）或 web profile 里
 * 配的 provider，acp 默认看不到 —— 旧做法是让用户手抄一份配置，这里改成自动同步。
 *
 * 为什么写到 acp profile 而不是 `$DSH_HOME/cordis.patch.yml`：home 级 patch 会
 * 叠加**所有** profile（含 desktop）之后，会遮蔽用户在设置里的后续修改；
 * acp 是纯下游消费者，只同步它最安全。
 *
 * 为什么不用 YAML 解析：见 extractSharedEntries。
 * @param home - $DSH_HOME。
 * @param logger - 日志出口。
 * @returns 是否真的写入（内容无变化时不写）。
 */
function syncAcpProviderConfig(home, logger) {
  try {
    const activeDir = process.env.DSH_PROFILE_DIR
    const activeProfile = process.env.DSH_PROFILE
    if (typeof activeDir !== 'string' || activeDir.length === 0) return false
    // 已经在 acp 里跑（某些部署会这样）就没有「上游」可抄。
    if (activeProfile === 'acp') return false

    const source = join(activeDir, 'cordis.patch.yml')
    if (!existsSync(source)) return false
    const blocks = extractSharedEntries(readFileSync(source, 'utf8'))
    if (blocks.length === 0) return false

    const targetDir = join(home, 'profiles', 'acp')
    const target = join(targetDir, 'cordis.patch.yml')
    /**
     * 只在 acp profile **已经初始化**时才写。
     *
     * profile 目录必须由启动器创建（package.json / cordis.yml / pnpm-workspace.yaml
     * 一整套），自己 mkdir 一个只有 cordis.patch.yml 的目录会做出一个启动不了的
     * 半成品 profile。首次拉起 ACP 时命令行会自己初始化它，之后下一次同步再补上。
     */
    if (!existsSync(join(targetDir, 'package.json'))) return false
    const marker = '# 由 @lyw/dsh-qqbot 自动同步'
    const header = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries (id-targeted config',
      '# overrides, disables, and insert lists; `!!js` expressions allowed).',
      '#',
      `${marker}：以下条目复制自当前 profile（${activeProfile ?? activeDir}）的`,
      '# cordis.patch.yml，让 QQ 网关用的 ACP 会话复用同一份 provider/模型配置。',
      '# 手动修改会在下次同步时被覆盖；要改模型请改主 profile 的设置。',
      '#',
    ].join('\n')
    const next = `${header}\n${blocks.join('\n')}\n`
    const previous = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (previous === next) return false
    writeFileSync(target, next)
    logger.info(
      `qqbot: 已把 ${activeProfile ?? activeDir} 的 provider/模型配置同步到 acp profile（${blocks.length} 个条目）`,
    )
    return true
  } catch (error) {
    logger.warn?.(`qqbot: 同步 acp provider 配置失败：${error?.message ?? error}`)
    return false
  }
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const stateDir = join(resolveHome(), 'qqbot')
  const gatewayLog = join(stateDir, 'gateway.log')
  const statusFile = join(stateDir, 'status.json')
  const selfFile = join(stateDir, 'plugin.json')

  /**
   * 当前配置快照读取器。
   *
   * 0.1.7 起 Config 字段是 volatile 引用，每次读取都取实时值；写入由
   * `ctx.settings.update('qqbot', ...)` 落盘，随后 loader 发 `loader/volatile-update`
   * 触发上面的重启。旧的 `setSource` 回灌机制随 installSection 一起消失。
   */
  const current = () => readConfig(config)
  /** 运行中的网关句柄。 */
  let running = null
  /** 主动停止时为 true，避免看门狗/重试逻辑把进程重新拉起。 */
  let stopping = false
  /** 意外的退出自动重启预算（连续崩溃时不会无限重试）。 */
  let restartBudget = 3
  /** 本进程本次启动时刻，用于判断是「刚起来就崩」还是「跑了很久才崩」。 */
  let startedAt = 0
  /** 当前扫码绑定会话。 */
  let bindSession = null
  /** 本次绑定是否已写回设置。 */
  let bindApplied = false

  /**
   * 让 ACP profile 复用本 profile 的 provider/模型配置。
   *
   * 每次要拉起网关前都做一次（挂载时、配置变更后、手动重启时）：用户在设置里
   * 换模型后，QQ 侧下一次启动就是新的 provider 列表，不需要手改任何文件。
   */
  const syncProviderConfig = () => syncAcpProviderConfig(resolveHome(), logger)
  syncProviderConfig()

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
    // 每次真正拉起网关前刷新一次 ACP 的 provider/模型配置，
    // 这样用户在主界面换模型后，QQ 侧下一次启动自动跟上。
    syncProviderConfig()
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
      /**
       * 桌面版修一个必须的坑：宿主就是 Electron 可执行文件（process.execPath =
       * DeepSeek Harness.exe），照原样 spawn 出来的是**第二个 GUI 实例**而不是 node。
       * 加上这个变量，Electron 才以 Node 模式跑 gateway.mjs；它会被网关继续继承给
       * ACP 子进程，于是第 2 条默认 ACP 命令（同一 exe 跑 app.asar 里的 CLI）也成立。
       */
      ...(isElectronRuntime() ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
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

  // PORT 2026-09-25（0.1.7-rc.2）: `ctx.settings.installSection()` 在 0.1.7 已被删除
  // （连同 SettingsSectionHooks / settings/updated 事件 / settings-file 包）。
  //
  // 为什么必须加 `.volatile()`：0.1.7 的 `ctx.settings` 是 SettingsForms，它的
  // `write()` 对没有 volatile 字段的条目直接抛 `Plugin entry "ns" has no volatile fields`
  // （packages/settings/settings/src/index.ts:386），`update()` 还会对非 volatile 路径抛
  // `Config field "x" is not volatile`（同文件 :388）。扫码绑定/配置页保存/白名单都依赖
  // `settings.update('qqbot', ...)` 落盘，因此 10 个字段全部标记 volatile。
  //
  // 代价：loader 交给 `apply` 的 `config` 变成引用对象，必须用 `.get()` 读；
  // 所有读取统一走下面的 readConfig() 投影。
  //
  // 「配置已变更」的回调语义（旧 onChange）改由 `loader/volatile-update` 承担：
  // 该事件只发给所属实例，值已先提交，且不依赖设置服务是否存在。
  ctx.on('loader/volatile-update', () => {
    logger.info('qqbot: 配置已更新，重启网关')
    void restart().catch((error) => logger.warn?.(`qqbot: 重启失败：${error?.message ?? error}`))
  })

  // 设置服务仅在写入时使用，且是可选的：缺席时各路由原有的 try/catch 会报错。
  const settingsService = () => ctx.get('settings')

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

  /**
   * 扫码成功后写回设置：凭据 + **把扫码人自己加进私聊白名单**。
   *
   * 腾讯的扫码结果里带 `user_openid`（就是扫码那个 QQ 号），所以不需要让用户
   * 再去别处查 id 手动填白名单 —— 扫码授权本身就是「允许这个 QQ 使用」的意思。
   * 已存在的白名单只做追加去重，不会被覆盖。
   */
  const applyBindResult = async () => {
    if (bindApplied) return
    const credentials = bindSession?.consumeCredentials()
    if (credentials === null || credentials === undefined) return
    bindApplied = true
    const settings = settingsService()
    if (settings === undefined || settings === null) {
      logger.error('qqbot: 扫码成功但设置服务不可用，无法写入凭据')
      return
    }
    const openId =
      typeof credentials.userOpenId === 'string' && credentials.userOpenId.length > 0 ? credentials.userOpenId : null
    const existing = Array.isArray(current()?.allowUsers) ? current().allowUsers : []
    const allowUsers = openId === null || existing.includes(openId) ? existing : [...existing, openId]
    try {
      await settings.update('qqbot', {
        appId: credentials.appId,
        appSecret: credentials.clientSecret,
        ...(openId === null ? {} : { allowUsers }),
      })
      logger.info(
        `qqbot: 扫码绑定完成，已写入设置（appId=${credentials.appId}` +
          (openId === null ? '；未返回 openid，白名单未改动）' : `；已把扫码的 QQ 加入私聊白名单：${openId}）`),
      )
      writeSelf({
        gatewayState: 'running',
        boundAt: new Date().toISOString(),
        boundUserOpenId: openId,
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
        if (settingsService() === undefined || settingsService() === null) throw new Error('设置服务不可用')
        await settingsService().update('qqbot', patch)
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
        if (settingsService() === undefined || settingsService() === null) throw new Error('设置服务不可用')
        await settingsService().update('qqbot', { allowUsers: [openId] })
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
