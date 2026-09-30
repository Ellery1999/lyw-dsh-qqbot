/**
 * 校验 release tarball：确认它含主动推送代码（路由、投递箱模块），
 * 且与仓库源码一致 —— 排除「装错包」这类隐患。
 *
 * 用法：node tests/verify-tarball.mjs [tarball]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
/** 期望版本跟着仓库 package.json 走，避免每次发包都要改这个测试。 */
const expectedVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const tar = process.argv[2] ?? join(ROOT, `lyw-dsh-qqbot-${expectedVersion}.tgz`)

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}
const norm = (text) => text.replace(/\r\n/g, '\n')
const readFromTar = (entry) =>
  execFileSync('tar', ['-xzOf', tar, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

if (!existsSync(tar)) {
  console.log(`找不到 tarball：${tar}`)
  process.exit(2)
}

console.log(`tarball: ${tar}`)
console.log(`sha256 : ${createHash('sha256').update(readFileSync(tar)).digest('hex')}`)

const pkg = JSON.parse(readFromTar('package/package.json'))
check(`版本与仓库一致（${expectedVersion}）`, pkg.version === expectedVersion, pkg.version)
check('engines.dsh 覆盖 rc.1 与 rc.2', pkg.engines?.dsh === '^0.2.0-rc.1', pkg.engines?.dsh)
check('没有会被兼容性闸门拦下的 dsh* peer',
  !Object.keys(pkg.peerDependencies ?? {}).some((n) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-')),
  JSON.stringify(pkg.peerDependencies))

const index = readFromTar('package/lib/index.js')
check('Host 半含 /push-test 路由', index.includes("action === '/push-test'"))
check('Host 半注册 qqbot_send 工具', index.includes("name: 'qqbot_send'"))
check('Host 半含主动推送配置字段',
  index.includes('pushMaxChars') && index.includes('pushAllowAnyTarget') && index.includes('pushDefaultTarget'))
check('Host 半向网关传推送环境变量', index.includes('DSH_QQBOT_PUSH_MAX_CHARS'))

const outbox = readFromTar('package/lib/outbox.mjs')
check('含投递箱模块 outbox.mjs', outbox.includes('claimPushRequests') && outbox.includes('buildPushPolicy'))
check('投递箱修掉了结果文件不清理的问题', outbox.includes('resultIdOf'))

const gateway = readFromTar('package/lib/gateway.mjs')
check('网关含主动推送发送逻辑', gateway.includes('deliverPush') && gateway.includes('drainOutbox'))
check('网关主动推送不带 msg_id（主动消息语义）', /sendText\(kind, target, chunk\)/.test(gateway))

const client = readFromTar('package/lib/client.js')
check('浏览器半含主动推送测试区块', client.includes('主动推送测试') && client.includes("post('/push-test'"))

check('tarball 里 index.js 与仓库源码一致（未装错包）', norm(index) === norm(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')))
check('tarball 里 gateway.mjs 与仓库源码一致', norm(gateway) === norm(readFileSync(join(ROOT, 'lib', 'gateway.mjs'), 'utf8')))
check('tarball 里 outbox.mjs 与仓库源码一致', norm(outbox) === norm(readFileSync(join(ROOT, 'lib', 'outbox.mjs'), 'utf8')))

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
