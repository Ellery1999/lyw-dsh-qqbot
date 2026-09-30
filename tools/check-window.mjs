/** 检查 schedule.json 迁移是否仍完好，以及下一个任务窗口。 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const file = join(home, 'storages', 'schedule.json')
const doc = JSON.parse(readFileSync(file, 'utf8'))

let qqbotSend = 0
let hermesSend = 0
for (const entry of Object.values(doc.tables.tasks)) {
  const prompt = entry?.record?.prompt
  if (typeof prompt !== 'string') continue
  qqbotSend += (prompt.match(/qqbot_send/g) ?? []).length
  hermesSend += (prompt.match(/hermes\.exe["']?\s+send/g) ?? []).length
}

console.log(`qqbot_send=${qqbotSend}  hermesSend=${hermesSend}`)
console.log(`文件 mtime=${statSync(file).mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
console.log(`现在      =${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)

// 列出未来 24 小时内会触发的任务（只做粗略 cron 判断，够用于提醒）
console.log('\n未来会写盘的任务窗口（每次投递都会用内存覆盖磁盘）：')
const now = new Date()
for (const entry of Object.values(doc.tables.tasks)) {
  const r = entry?.record
  if (!r || entry.status !== 'active' || typeof r.expression !== 'string' || r.expression.length === 0) continue
  const parts = r.expression.split(/\s+/)
  if (parts.length !== 5) continue
  const [minute, hour, dom, , dow] = parts
  // 只处理形如 "M H * * *" / "M H * * 1-5" 的简单形态
  const m = /^\d+$/.test(minute) ? Number(minute) : null
  const h = /^\d+$/.test(hour) ? Number(hour) : null
  if (m === null || h === null) continue
  const days = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : (dow.match(/^(\d)-(\d)$/) ? null : null)
  const allowedDow = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : (() => {
    const mm = /^(\d)-(\d)$/.exec(dow)
    if (mm === null) return null
    const out = []
    for (let d = Number(mm[1]); d <= Number(mm[2]); d += 1) out.push(d % 7)
    return out
  })()
  if (allowedDow === null) continue
  void days
  for (let offset = 0; offset <= 1; offset += 1) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(h, m, 0, 0)
    if (candidate <= now) continue
    // cron 的 dow：0/7 = 周日
    if (!allowedDow.includes(candidate.getDay())) continue
    const diffMin = Math.round((candidate - now) / 60000)
    if (diffMin <= 24 * 60) {
      console.log(`  ${candidate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  ${r.title}（${diffMin} 分钟后）`)
    }
  }
}
