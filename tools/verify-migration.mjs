/**
 * 迁移后校验：确认 9 个任务的投递方式已切到 qqbot_send，且改动是**外科手术式**的
 * （除投递那一行外，prompt 其余内容逐字未变；其他字段不受影响）。
 *
 * 用法：node tools/verify-migration.mjs <迁移前备份>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const CURRENT = join(home, 'storages', 'schedule.json')
const BEFORE = process.argv[2]

if (!BEFORE) {
  console.error('用法：node tools/verify-migration.mjs <迁移前备份路径>')
  process.exit(2)
}

const after = JSON.parse(readFileSync(CURRENT, 'utf8'))
const before = JSON.parse(readFileSync(BEFORE, 'utf8'))
const TARGET = '43D2934CEA20221738F8C23D34CDFDC2'
const OLD_TARGET = '873C9AD60093A5B75F5B637821F8A5B6'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const afterTasks = after.tables.tasks
const beforeTasks = before.tables.tasks
const ids = Object.keys(afterTasks).filter((id) => /^schedule-/.test(id))

console.log(`迁移前备份：${BEFORE}`)
console.log(`任务数：${ids.length}\n`)

console.log('[每个任务的投递方式]')
for (const id of ids) {
  const a = afterTasks[id].record
  const b = beforeTasks[id]?.record
  const title = a?.title ?? id
  const hasOld = /hermes\.exe["']?\s+send\s+--to\s+qqbot:/.test(a?.prompt ?? '')
  const hasNew = a?.prompt?.includes('qqbot_send') ?? false
  const hasTarget = a?.prompt?.includes(TARGET) ?? false
  const hasOldTarget = a?.prompt?.includes(OLD_TARGET) ?? false
  console.log(`  ${title}`)
  check(`    ${title}：已无 hermes send`, hasOld === false)
  check(`    ${title}：含 qqbot_send`, hasNew === true)
  check(`    ${title}：目标为插件 openid`, hasTarget === true)
  check(`    ${title}：不再引用 Hermes openid`, hasOldTarget === false)
  void b
}

console.log('\n[改动必须是外科手术式的]')
for (const id of ids) {
  const a = afterTasks[id].record
  const b = beforeTasks[id]?.record
  if (!a || !b) continue
  const title = a.title ?? id
  const aLines = a.prompt.split('\n')
  const bLines = b.prompt.split('\n')
  const changedA = aLines.filter((l) => /qqbot_send/.test(l))
  const changedB = bLines.filter((l) => /hermes\.exe["']?\s+send/.test(l))
  // 行数应完全一致（只换内容，不增删行）
  check(`${title}：prompt 行数未变（未增删行）`, aLines.length === bLines.length, `${bLines.length} -> ${aLines.length}`)
  check(`${title}：恰好替换 1 行投递指令`, changedA.length === 1 && changedB.length === 1, `new=${changedA.length} old=${changedB.length}`)
  /**
   * 允许的改动上限：1 行投递指令 + 1 行「投递到 QQ（--file 传正文）」标题清理。
   * 超过 2 行说明正则误伤了别的内容，必须拦下。
   */
  const diffCount = aLines.filter((line, i) => line !== bLines[i]).length
  check(`${title}：改动行数 ≤2（投递指令 + --file 标题清理）`, diffCount <= 2, `changed lines=${diffCount}`)
  // 只有黄金 5 个任务有「--file 传正文」标题需要清理；其余任务应只改 1 行。
  const hadFileFlag = bLines.some((l) => /投递/.test(l) && /--file/.test(l))
  const expected = hadFileFlag ? 2 : 1
  check(`${title}：改动行数正好为 ${expected}`, diffCount === expected, `changed lines=${diffCount}`)
}

console.log('\n[其他字段不受影响]')
check('任务数量未变', Object.keys(afterTasks).length === Object.keys(beforeTasks).length,
  `${Object.keys(beforeTasks).length} -> ${Object.keys(afterTasks).length}`)
for (const id of ids) {
  const a = afterTasks[id]
  const b = beforeTasks[id]
  if (!a || !b) continue
  const title = a.record?.title ?? id
  const sameRecord = ['id', 'kind', 'title', 'expression', 'timeZone', 'afterSeconds', 'everySeconds', 'scheduledAt', 'time', 'weekdays']
    .every((k) => JSON.stringify(a.record?.[k]) === JSON.stringify(b.record?.[k]))
  check(`${title}：时间/规则/标题未变`, sameRecord)
  check(`${title}：状态未变`, a.status === b.status, `${b.status} -> ${a.status}`)
  check(`${title}：会话绑定未变`, a.sessionId === b.sessionId)
}

console.log('\n[文件格式]')
const raw = readFileSync(CURRENT, 'utf8')
check('JSON 可被解析（未写坏）', typeof after === 'object')
check('顶层结构完整（tables.tasks）', after.tables?.tasks !== undefined)
check('文件以换行结尾', raw.endsWith('\n'))

console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项未通过`} =====`)
process.exit(failed === 0 ? 0 : 1)
