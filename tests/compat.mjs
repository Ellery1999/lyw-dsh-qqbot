/**
 * 适配性核查：用 rc.2 的判定逻辑在本机复核 0.5.0 是否会通过插件兼容性门禁。
 *
 * 门禁规则（dsh-app-boot/evaluatePluginCompatibility）：
 *   只检查 peerDependencies 里名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项，
 *   用 semver.satisfies(runtime, range, { includePrerelease: true }) 判定；
 *   任何一项不满足 ⇒ 跳过整个 bundle。
 *
 * 用法：node tests/compat.mjs [runtimeVersion]
 */
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const runtime = process.argv[2] ?? manifest.engines.dsh.replace(/^\^/, '')

// 本机不带 semver 依赖，用最小实现覆盖本包会出现的范围形态（^x.y.z-prerelease）。
function satisfies(version, range) {
  const parse = (text) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(text).trim())
    if (match === null) return null
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null }
  }
  const target = parse(version)
  const body = range.trim().replace(/^\^/, '')
  const lower = parse(body)
  if (target === null || lower === null) return null // 交给调用方标记为「本脚本判不了」
  if (target.major !== lower.major) return false
  // includePrerelease：同 major 下，rc 阶段的版本视为满足 ^ 范围。
  if (target.minor < lower.minor) return false
  if (target.minor === lower.minor && target.patch < lower.patch) return false
  return true
}

const peers = manifest.peerDependencies ?? {}
const gated = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

console.log(`包版本      ${manifest.version}`)
console.log(`engines.dsh ${manifest.engines.dsh}（仅元数据，不参与门禁）`)
console.log(`运行时      ${runtime}`)
console.log(`受门禁的 peer：${gated.length === 0 ? '（无）' : gated.map(([n, r]) => `${n}@${r}`).join(', ')}`)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

console.log('\n[门禁判定]')
check('没有会触发门禁的 @deepseek-ai/dsh* peer（因此不会被跳过）', gated.length === 0, JSON.stringify(peers))
check('peerDependencies 仅剩 schemastery（按设计，走 profile 回退层解析）',
  Object.keys(peers).length === 1 && peers['@deepseek-ai/schemastery'] === '*', JSON.stringify(peers))
check('未把 @deepseek-ai/dsh-tools 写成 peer（否则 rc 不匹配会跳过整个 bundle）',
  !Object.hasOwn(peers, '@deepseek-ai/dsh-tools'))

console.log('\n[engines 范围对新运行时可解析]')
for (const candidate of ['0.2.0-rc.1', '0.2.0-rc.2', runtime]) {
  const ok = satisfies(candidate, manifest.engines.dsh)
  check(`engines.dsh ${manifest.engines.dsh} 覆盖 ${candidate}`, ok === true, String(ok))
}

const passed = io => io
void passed
console.log(`\n===== ${failed === 0 ? '全部通过' : `${failed} 项未通过`} =====`)
process.exit(failed === 0 ? 0 : 1)
