/**
 * 把定时任务的投递方式从 `hermes send` 换成 qqbot 插件的主动推送（qqbot_send 工具）。
 *
 * 背景：8 个任务的 prompt 里硬编码了
 *   & "C:\...\hermes.exe" send --to qqbot:873C9AD6… "【标题】..."
 * 其中 873C9AD6 属于 **Hermes 机器人（1905236309）**，而 qqbot 插件用的是
 * **1905619785** —— 两个 openid 分属不同机器人，不能照搬。
 *
 * 本脚本直接改写 schedule.json（DSH schedule 的 JSON 后端就是这个文件），
 * 采用「读 → 备份 → 原子替换」的方式，且只动 prompt 里的投递那一段。
 *
 * ⚠️ 需要 DSH 未在运行，或改完立刻重启：schedule 的 domain 在内存里，
 *    进程内的写回会覆盖本脚本的改动。
 *
 * 用法：
 *   node tools/migrate-schedules.mjs --dry-run   # 只打印将要做的替换
 *   node tools/migrate-schedules.mjs --apply
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCHEDULE = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'storages', 'schedule.json')
/** 与用户确认过的推送目标：qqbot 插件（1905619785）下的私聊 openid。 */
const TARGET = '43D2934CEA20221738F8C23D34CDFDC2'

const dryRun = !process.argv.includes('--apply')

/**
 * 把 prompt 里「hermes send 投递」那一段换成 qqbot_send 工具调用。
 *
 * 只替换**投递指令那一行**，保留紧随其后的「失败重试…」说明（各任务本来就有，
 * 不要再补一句，否则会出现两遍重试要求）。
 *
 * 另外清掉投递步骤标题里 `--file 传正文` 这类 **Hermes 专有参数说明**：
 * 它在新链路上不存在，留着会误导模型去找一个不存在的参数。
 *
 * @param {string} prompt 原始 prompt
 * @param {string} title 任务标题（用于替换后的示例文案）
 * @returns {{prompt: string, changed: number, cleaned: number}} 改写结果与替换行数
 */
function migratePrompt(prompt, title) {
  const lines = prompt.split('\n')
  let changed = 0
  let cleaned = 0
  const out = []
  for (const line of lines) {
    // 命中「调用 hermes.exe send --to qqbot:...」的命令行（含缩进与前置 &）。
    // 注意：不能匹配解释器路径里出现的 "hermes"（venv/Scripts/python.exe 等）。
    if (/hermes\.exe["']?\s+send\s+--to\s+qqbot:/.test(line)) {
      changed += 1
      const indent = /^(\s*)/.exec(line)?.[1] ?? ''
      out.push(`${indent}调用 qqbot_send 工具推送：text 填完整消息正文（含【${title}】标题行），target=${TARGET}，kind=c2c。`)
      continue
    }
    // 少数任务写成不带路径的 `hermes send --to qqbot:...`
    if (/(^|[^a-z])hermes\s+send\s+--to\s+qqbot:/.test(line) && !/hermes\.exe/.test(line) && !/qqbot_send/.test(line)) {
      changed += 1
      const indent = /^(\s*)/.exec(line)?.[1] ?? ''
      out.push(`${indent}调用 qqbot_send 工具推送：text 填完整消息正文，target=${TARGET}，kind=c2c。`)
      continue
    }
    // 去掉投递步骤标题里的 Hermes 专有参数括号说明，例如「投递到 QQ（--file 传正文）：」。
    if (/投递/.test(line) && /--file/.test(line)) {
      cleaned += 1
      out.push(line.replace(/（[^）]*--file[^）]*）/g, '').replace(/\([^)]*--file[^)]*\)/g, ''))
      continue
    }
    out.push(line)
  }
  return { prompt: out.join('\n'), changed, cleaned }
}

console.log(`schedule 文件：${SCHEDULE}`)
const raw = readFileSync(SCHEDULE, 'utf8')
const doc = JSON.parse(raw)

const tasks = doc?.tables?.tasks ?? {}
let totalChanged = 0
const planned = []

for (const [id, entry] of Object.entries(tasks)) {
  const record = entry?.record
  if (record === undefined || typeof record.prompt !== 'string') continue
  const { prompt, changed, cleaned } = migratePrompt(record.prompt, record.title ?? '通知')
  // 两类改动都算：替换投递指令，或清掉 Hermes 专有参数说明。
  // 分开判断是为了让「已替换过、只剩残留说明」的情况也能被幂等地再跑一遍。
  if (changed === 0 && cleaned === 0) continue
  planned.push({ id, title: record.title, changed, cleaned, before: record.prompt, after: prompt })
  totalChanged += changed
}

if (planned.length === 0) {
  console.log('\n没有需要迁移的任务（prompt 里已无 hermes send / --file 残留）。')
  process.exit(0)
}

console.log(`\n将迁移 ${planned.length} 个任务，共 ${totalChanged} 处投递指令：\n`)
for (const item of planned) {
  console.log(`── ${item.title}（${item.id}：替换 ${item.changed} 处，清理 ${item.cleaned} 处）`)
  // 只打印**真正被替换的行**：按 hermes.exe send 过滤，避免把解释器路径那些行也列出来。
  const before = item.before.split('\n').filter((l) => /hermes\.exe["']?\s+send\s+--to\s+qqbot:/.test(l))
  const after = item.after.split('\n').filter((l) => /qqbot_send/.test(l))
  for (const line of before) console.log(`   -  ${line.trim().slice(0, 140)}`)
  for (const line of after) console.log(`   +  ${line.trim().slice(0, 140)}`)
  // 清理项单独展示（否则看不出这一步做了什么）
  const cleanedBefore = item.before.split('\n').filter((l) => /投递/.test(l) && /--file/.test(l))
  const cleanedAfter = item.after.split('\n').filter((l) => /投递/.test(l) && !/--file/.test(l) && /QQ/.test(l))
  for (const line of cleanedBefore) console.log(`   -  ${line.trim().slice(0, 140)}`)
  for (const line of cleanedAfter) console.log(`   +  ${line.trim().slice(0, 140)}`)
  console.log('')
}

if (dryRun) {
  console.log('（--dry-run，未写入。加 --apply 才真正落盘）')
  process.exit(0)
}

// 落盘：先备份，再原子替换（写 .tmp 后 rename），避免半截 JSON 让 schedule 起不来。
const backup = `${SCHEDULE}.bak-before-push-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(SCHEDULE, backup)
console.log(`已备份：${backup}`)

for (const item of planned) {
  tasks[item.id].record.prompt = item.after
}
const tmp = `${SCHEDULE}.tmp`
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
renameSync(tmp, SCHEDULE)
console.log(`已写入 ${planned.length} 个任务的 prompt。`)
console.log('\n⚠️ 请重启 DSH（或在 schedule 页面确认任务已刷新），让新的 prompt 生效。')
