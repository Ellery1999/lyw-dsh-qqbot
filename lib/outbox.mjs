/**
 * 主动推送的「投递箱」：Host 进程与网关进程之间唯一的跨进程通道。
 *
 * 为什么需要它：网关是 Host `ctx.subprocess.spawn` 出来的独立子进程，独占 QQ
 * 连接与 access_token；而 `qqbot_send` 工具与插件页按钮都跑在 Host 进程里。
 * 两者必须通信。可选方案里，让 Host 自己直连 QQ REST 会引入第二个 token
 * （重复获取会顶掉网关在用的那个），也绕开了网关的分段/纯文本清洗/附件上传
 * 与白名单校验。所以这里复用网关**已经**在用的轮询模式（见 gateway.mjs 里对
 * `shutdown.request` 的处理）：Host 写请求文件，网关每 1 秒扫一次并回写结果。
 *
 * 文件协议（全部在 `$DSH_HOME/qqbot/outbox/`）：
 *   req-<id>.json          请求（Host 写，原子落盘）
 *   req-<id>.json.claimed  已被网关认领（rename 得来，源文件消失即互斥）
 *   res-<id>.json          结果（网关写，原子落盘；Host 读走后删除）
 *   .tmp-<id>              写入中转，不参与扫描（避免读到半截 JSON）
 *
 * 本模块只做纯逻辑与文件操作，不碰网络、不读配置环境变量以外的全局状态，
 * 以便 tests/unit.mjs 直接回归。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 支持的会话类型：C2C 私聊与群聊。频道（guild）不在本次范围。 */
export const PUSH_KINDS = ['c2c', 'group']

/**
 * 目标标识的字符集。
 *
 * QQ 的 `user_openid` / `group_openid` 都是 `[A-Za-z0-9_-]` 组成的不透明串，
 * 这个校验**不是**安全边界（白名单才是），而是防止把 `../` 或查询串拼进
 * `/v2/users/<target>/messages` 的 URL 路径里。
 */
export const TARGET_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** 一条主动推送最多带几个附件：与被动回复的出站上限保持一致。 */
export const MAX_PUSH_FILES = 3

/** 请求/结果文件的保留时长；超过即视为孤儿清理掉。 */
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000

/** 请求文件前缀与后缀，扫描时按它们识别。 */
const REQUEST_PREFIX = 'req-'
const REQUEST_SUFFIX = '.json'
const CLAIM_SUFFIX = '.claimed'
const RESULT_PREFIX = 'res-'

/** 投递箱目录（跟随 stateDir，便于 e2e 指向临时目录）。 */
export function outboxDir(stateDir) {
  return join(stateDir, 'outbox')
}

/** 生成一个文件名安全、且大致按时间有序的请求 id。 */
export function newRequestId() {
  const time = Date.now().toString(36)
  const random = Math.random().toString(16).slice(2, 8)
  return `${time}-${random}`
}

/** 请求 id 的形状：`<时间 base36>-<随机 hex>`。 */
const ID_PATTERN = /^[a-z0-9]+-[0-9a-f]+$/

/** 从请求/结果文件名里取回 id；不是本模块的文件名时返回 null。 */
export function idOfArtifact(fileName) {
  if (typeof fileName !== 'string') return null
  const name = fileName.endsWith(CLAIM_SUFFIX) ? fileName.slice(0, -CLAIM_SUFFIX.length) : fileName
  if (!name.startsWith(REQUEST_PREFIX) || !name.endsWith(REQUEST_SUFFIX)) return null
  const id = name.slice(REQUEST_PREFIX.length, -REQUEST_SUFFIX.length)
  return ID_PATTERN.test(id) ? id : null
}

/**
 * 从结果文件名里取回 id；不是结果文件时返回 null。
 *
 * 单独一个函数（而不是把 `res-` 也塞进 `idOfArtifact`）：请求与结果在清理、
 * 快照、认领三处的处理都不同，混成一个「是投递箱文件」的判断会让认领逻辑
 * 把结果文件也当成待发送的请求。v0.5.0 就是漏了这个分支，导致结果文件永不
 * 过期、越积越多（由单测『过期的结果文件被清掉』发现）。
 */
export function resultIdOf(fileName) {
  if (typeof fileName !== 'string') return null
  if (!fileName.startsWith(RESULT_PREFIX) || !fileName.endsWith(REQUEST_SUFFIX)) return null
  const id = fileName.slice(RESULT_PREFIX.length, -REQUEST_SUFFIX.length)
  return ID_PATTERN.test(id) ? id : null
}

/** 原子写：先写 `.tmp-` 再 rename，读方永远看不到半截文件。 */
function writeAtomic(dir, finalPath, payload) {
  const tmp = join(dir, `.tmp-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`)
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
  try {
    renameSync(tmp, finalPath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * 读一个 JSON 文件；不存在或内容损坏时返回 null。
 *
 * 损坏返回 null 而不是抛错：投递箱是尽力而为的通道，一个坏文件不该让整个
 * 轮询循环停摆（真正的错误由调用方按 null 处理并记日志）。
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 校验请求的形状（不做白名单判断，那是网关的策略）。
 * @param {object} request 待校验的请求
 * @returns {string[]} 问题列表；为空表示形状合法
 */
export function validateRequestShape(request) {
  const problems = []
  if (request === null || typeof request !== 'object') return ['请求必须是对象']
  if (typeof request.text === 'string' && request.text.trim().length > 0) {
    // 正文存在即可
  } else if (Array.isArray(request.files) && request.files.length > 0) {
    // 只发附件也允许
  } else {
    problems.push('text 与 files 至少要有一个')
  }
  if (request.kind !== undefined && !PUSH_KINDS.includes(request.kind)) {
    problems.push(`kind 必须是 ${PUSH_KINDS.join(' 或 ')}`)
  }
  if (request.target !== undefined && request.target !== null) {
    if (typeof request.target !== 'string' || !TARGET_PATTERN.test(request.target)) {
      problems.push('target 含非法字符（只允许字母、数字、_ 和 -，最长 128）')
    }
  }
  if (request.files !== undefined) {
    if (!Array.isArray(request.files)) problems.push('files 必须是数组')
    else if (request.files.some((item) => typeof item !== 'string' || item.length === 0)) {
      problems.push('files 只能包含非空字符串路径')
    } else if (request.files.length > MAX_PUSH_FILES) {
      problems.push(`一条消息最多 ${MAX_PUSH_FILES} 个附件`)
    }
  }
  if (request.subject !== undefined && typeof request.subject !== 'string') problems.push('subject 必须是字符串')
  return problems
}

/**
 * 目标白名单策略。
 *
 * 入站的白名单（`allowUsers` / `allowGroups`）语义是「谁能驱动 DSH」，这里复用它
 * 表达「允许推给谁」：主动推送是出站动作，默认应当比入站更保守，所以只有落在
 * 白名单（或已知的绑定/最近私聊身份）上的目标才放行，除非显式打开
 * `allowAnyTarget`。
 *
 * @param {{allowUsers?: string[], allowGroups?: string[], lastUserOpenId?: string|null, defaultTarget?: string|null, allowAnyTarget?: boolean}} options
 * @returns {{allowAnyTarget: boolean, c2c: Set<string>, group: Set<string>}}
 */
export function buildPushPolicy(options = {}) {
  const allowUsers = Array.isArray(options.allowUsers) ? options.allowUsers : []
  const allowGroups = Array.isArray(options.allowGroups) ? options.allowGroups : []
  const c2c = new Set(allowUsers.filter((item) => typeof item === 'string' && item.length > 0))
  // 绑定过 / 最近私聊过的身份也算已知目标：白名单为空时，用户至少能推给自己。
  if (typeof options.lastUserOpenId === 'string' && options.lastUserOpenId.length > 0) {
    c2c.add(options.lastUserOpenId)
  }
  /**
   * 显式配置的默认推送目标同样是「用户自己指定的身份」，必须放行。
   * 否则会出现自相矛盾的配置：默认目标填了 A，推送却被自己拦下。
   */
  if (typeof options.defaultTarget === 'string' && options.defaultTarget.length > 0) {
    c2c.add(options.defaultTarget)
  }
  return {
    allowAnyTarget: options.allowAnyTarget === true,
    c2c,
    group: new Set(allowGroups.filter((item) => typeof item === 'string' && item.length > 0)),
  }
}

/**
 * 判断一个目标是否允许推送。
 * @param {ReturnType<typeof buildPushPolicy>} policy 策略
 * @param {'c2c'|'group'} kind 会话类型
 * @param {string} target openid
 * @returns {{ok: boolean, reason?: string}} 判定结果
 */
export function checkPushTarget(policy, kind, target) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) {
    return { ok: false, reason: 'target 缺失或含非法字符' }
  }
  if (!PUSH_KINDS.includes(kind)) return { ok: false, reason: `不支持的会话类型 ${kind}` }
  if (policy.allowAnyTarget) return { ok: true }

  const allowed = policy[kind]
  if (allowed.has(target)) return { ok: true }
  if (kind === 'c2c') {
    // 白名单为空说明用户还没配置过：给出可操作的指引，而不是干巴巴一句「不允许」。
    return {
      ok: false,
      reason:
        allowed.size === 0
          ? '没有可用的推送目标：私聊白名单为空且还没有绑定/最近私聊记录。先在 QQ 里给机器人发一条消息，或到插件页绑定。'
          : `目标 ${target} 不在私聊白名单内。要推给它，请把它加入 allowUsers，或打开「允许推送给任意目标」。`,
    }
  }
  return {
    ok: false,
    reason:
      allowed.size === 0
        ? '群推送默认关闭：群白名单为空。要推给群，请把 group_openid 加入 allowGroups。'
        : `群 ${target} 不在群白名单内（当前白名单：${[...allowed].join(', ')}）。`,
  }
}

/**
 * 写一条推送请求。
 * @param {string} stateDir 网关状态目录
 * @param {object} request `{kind, target, text, files, subject, source}`
 * @returns {{id: string, path: string}} 请求 id 与落盘路径
 */
export function writePushRequest(stateDir, request) {
  const dir = outboxDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const id = newRequestId()
  const payload = {
    id,
    kind: request.kind ?? 'c2c',
    target: request.target ?? null,
    text: typeof request.text === 'string' ? request.text : '',
    files: Array.isArray(request.files) ? request.files : [],
    subject: typeof request.subject === 'string' ? request.subject : '',
    source: request.source ?? 'unknown',
    createdAt: new Date().toISOString(),
  }
  const path = join(dir, `${REQUEST_PREFIX}${id}${REQUEST_SUFFIX}`)
  writeAtomic(dir, path, payload)
  return { id, path }
}

/**
 * 认领所有待处理的请求。
 *
 * 互斥靠 `rename` 的原子性：源文件被移走之后，第二个调用方的 rename 会
 * ENOENT。目标名里带唯一 id，所以不会有覆盖冲突（POSIX 的 rename 会覆盖
 * 同名目标，这点必须靠唯一名规避）。
 *
 * @param {string} stateDir 网关状态目录
 * @returns {{id: string, path: string, request: object}[]} 已认领的请求
 */
export function claimPushRequests(stateDir) {
  const dir = outboxDir(stateDir)
  if (!existsSync(dir)) return []
  const claimed = []
  for (const name of readdirSync(dir)) {
    const id = idOfArtifact(name)
    if (id === null || name.endsWith(CLAIM_SUFFIX)) continue
    const from = join(dir, name)
    const to = join(dir, `${name}${CLAIM_SUFFIX}`)
    try {
      renameSync(from, to)
    } catch {
      // 已被别的调用方认领（ENOENT），或文件正在被清理：跳过。
      continue
    }
    const request = readJson(to)
    if (request === null) {
      // 内容坏了：清掉，避免每轮都重试同一个坏文件。
      rmSync(to, { force: true })
      continue
    }
    claimed.push({ id, path: to, request })
  }
  return claimed
}

/**
 * 回写一条请求的结果，并删除已认领的请求文件。
 *
 * 请求文件先删除再写结果：结果文件才是 Host 等待的信号，顺序反过来的话
 * Host 可能在网关还没删请求时就返回，留下垃圾。
 *
 * @param {string} stateDir 网关状态目录
 * @param {{id: string, path: string}} claimed 认领信息
 * @param {{ok: boolean, segments?: number, files?: number, error?: string, code?: string, durationMs?: number}} result
 */
export function settlePushRequest(stateDir, claimed, result) {
  const dir = outboxDir(stateDir)
  mkdirSync(dir, { recursive: true })
  rmSync(claimed.path, { force: true })
  writeAtomic(dir, join(dir, `${RESULT_PREFIX}${claimed.id}${REQUEST_SUFFIX}`), {
    id: claimed.id,
    ok: result.ok === true,
    segments: result.segments ?? 0,
    files: result.files ?? 0,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.code === undefined ? {} : { code: result.code }),
    durationMs: result.durationMs ?? 0,
    at: new Date().toISOString(),
  })
}

/** 读取某条请求的结果；还没写出来时返回 null。 */
export function readPushResult(stateDir, id) {
  return readJson(join(outboxDir(stateDir), `${RESULT_PREFIX}${id}${REQUEST_SUFFIX}`))
}

/** 删除某条请求的结果文件（Host 读到之后调用）。 */
export function clearPushResult(stateDir, id) {
  rmSync(join(outboxDir(stateDir), `${RESULT_PREFIX}${id}${REQUEST_SUFFIX}`), { force: true })
}

/**
 * 等待某条请求的结果。
 *
 * 超时返回一个 `ok:false` 的结果而不是抛错：调用方（工具/卡片）需要的是
 * 「为什么没发出去」这句话，而超时本身就是最可能的答案。
 *
 * @param {string} stateDir 网关状态目录
 * @param {string} id 请求 id
 * @param {{timeoutMs?: number, intervalMs?: number}} [options] 轮询参数
 * @returns {Promise<object>} 结果对象
 */
export async function waitForPushResult(stateDir, id, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = readPushResult(stateDir, id)
    if (result !== null) {
      clearPushResult(stateDir, id)
      return result
    }
    if (Date.now() >= deadline) {
      return {
        id,
        ok: false,
        segments: 0,
        files: 0,
        error: `等待网关发送结果超时（${Math.round(timeoutMs / 1000)}s）。网关可能未运行或正忙；稍后可在网关日志里确认是否最终发出。`,
        durationMs: timeoutMs,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 清理孤儿文件：过期的请求、已认领但未完成的请求、久未被读走的结果。
 *
 * 启动时与每轮轮询前调用。**不补发**已认领的请求——网关崩溃前可能已经把
 * 消息发出去了，重发会造成重复打扰，宁可让那一条静默丢失并留在日志里。
 *
 * @param {string} stateDir 网关状态目录
 * @param {{now?: number, ttlMs?: number}} [options] 时钟与保留时长（测试可注入）
 * @returns {number} 清理掉的文件数
 */
export function pruneOutbox(stateDir, options = {}) {
  const dir = outboxDir(stateDir)
  if (!existsSync(dir)) return 0
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.tmp-')) {
      // 半截的写入中转文件：超过 ttl 必定是崩溃残留。
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs > ttlMs) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch {
        /* 已被别处删掉 */
      }
      continue
    }
    const isArtifact = idOfArtifact(name) !== null || resultIdOf(name) !== null
    if (!isArtifact) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > ttlMs) {
        rmSync(path, { force: true })
        removed += 1
      }
    } catch {
      /* 已被别处删掉 */
    }
  }
  return removed
}

/**
 * 投递箱的可观测快照，供 status.json / 插件页显示。
 * @param {string} stateDir 网关状态目录
 * @returns {{pending: number, claimed: number, results: number}} 各类文件计数
 */
export function outboxSnapshot(stateDir) {
  const dir = outboxDir(stateDir)
  const snapshot = { pending: 0, claimed: 0, results: 0 }
  if (!existsSync(dir)) return snapshot
  for (const name of readdirSync(dir)) {
    if (resultIdOf(name) !== null) snapshot.results += 1
    else if (name.endsWith(CLAIM_SUFFIX)) snapshot.claimed += 1
    else if (idOfArtifact(name) !== null) snapshot.pending += 1
  }
  return snapshot
}
