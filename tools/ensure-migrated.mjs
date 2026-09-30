/**
 * 一键确认并（必要时）重放定时任务迁移。
 *
 * 背景：schedule.json 的**内存状态是权威**。如果 DSH 在迁移后、重启前又发生过任务投递，
 * 进程会用内存里的旧 prompt 覆盖磁盘 —— 迁移看起来「自己回退了」。
 *
 * 本脚本就是为这个场景准备的：检测到 `hermes send` 回退就自动重放迁移，并再次校验。
 *
 * 用法：
 *   node tools/ensure-migrated.mjs          # 只检查，报告状态
 *   node tools/ensure-migrated.mjs --apply  # 检测到回退就自动重放
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SCHEDULE = join(home, 'storages', 'schedule.json')
const apply = process.argv.includes('--apply')

/** 统计当前 state 里的迁移指标。 */
function inspect() {
  const doc = JSON.parse(readFileSync(SCHEDULE, 'utf8'))
  let qqbotSend = 0
  let hermesSend = 0
  for (const entry of Object.values(doc.tables.tasks)) {
    const prompt = entry?.record?.prompt
    if (typeof prompt !== 'string') continue
    qqbotSend += (prompt.match(/qqbot_send/g) ?? []).length
    hermesSend += (prompt.match(/hermes\.exe["']?\s+send/g) ?? []).length
  }
  return { qqbotSend, hermesSend, mtime: statSync(SCHEDULE).mtime }
}

const before = inspect()
console.log(`当前：qqbot_send=${before.qqbotSend}  hermesSend=${before.hermesSend}`)
console.log(`文件 mtime：${before.mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)

if (before.hermesSend === 0 && before.qqbotSend > 0) {
  console.log('\n✓ 迁移完好（9 处 qqbot_send，无 hermes 残留）。')
  process.exit(0)
}

console.log('\n⚠️ 检测到迁移回退（又出现 hermes send）。')
if (!apply) {
  console.log('   加 --apply 可自动重放迁移。')
  process.exit(1)
}

console.log('\n重放迁移…')
execFileSync(process.execPath, [join(HERE, 'migrate-schedules.mjs'), '--apply'], { stdio: 'inherit' })

const after = inspect()
console.log(`\n重放后：qqbot_send=${after.qqbotSend}  hermesSend=${after.hermesSend}`)
if (after.hermesSend === 0 && after.qqbotSend > 0) {
  console.log('✓ 已恢复。记得**重启 DSH** 让新 prompt 生效。')
  process.exit(0)
}
console.log('✗ 重放后仍有残留，请手工检查。')
process.exit(1)
