/**
 * 真机验证 `qqbot_send` 工具能否被注册（不需要连 QQ、不消耗模型额度）。
 *
 * 做法：把已安装的插件目录挂进一个**临时 profile**，用 `--patch` 覆盖层插入插件行，
 * 让 `apply()` 真的跑一遍，检查它有没有把工具注册进 tools 注册表。
 *
 * 为什么不直接跑 desktop profile：CLI 拒绝 desktop（由 Electron 独占管理），
 * 而临时 profile 与桌面端的解析层行为一致（同一套 app-boot 解析/拦截逻辑）。
 *
 * 用法：node tests/tool-register.mjs
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const EXE = process.env.DSH_EXE ?? 'D:\\DSH Desktop\\DeepSeek Harness.exe'
const BIN = process.env.DSH_BIN
  ?? 'D:\\DSH Desktop\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

// bin.js 在 app.asar **内部**，existsSync 看不到它，所以只检查 exe 与 asar 本体。
const ASAR = process.env.DSH_ASAR ?? 'D:\\DSH Desktop\\resources\\app.asar'
if (!existsSync(EXE) || !existsSync(ASAR)) {
  console.log(`SKIP：找不到 DSH 运行时（${EXE} / ${ASAR}），跳过工具注册验证`)
  process.exit(0)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

// 临时 profile：把待测插件目录链进它的 node_modules，模拟真实安装布局。
const profileName = `qqbot-toolcheck-${process.pid}`
const profileDir = join(DSH_HOME, 'profiles', profileName)
const probeOut = join(PKG_ROOT, 'tests', '.tool-register-out.json')

/** 把插件目录复制进临时 profile 的 node_modules（复制而非链接，避免影响真实安装）。 */
function installIntoProfile() {
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules', '@lyw'), { recursive: true })
  const target = join(profileDir, 'node_modules', '@lyw', 'dsh-qqbot')
  // 用 junction/symlink 会因 asar 解析差异带来噪声，直接复制 lib 更可控。
  mkdirSync(target, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) {
    writeFileSync(join(target, file), readFileSync(join(PKG_ROOT, file)))
  }
  mkdirSync(join(target, 'lib'), { recursive: true })
  for (const file of ['index.js', 'gateway.mjs', 'outbox.mjs', 'qq-transport.mjs', 'acp-client.mjs', 'bind.mjs', 'page.mjs', 'client.js']) {
    writeFileSync(join(target, 'lib', file), readFileSync(join(PKG_ROOT, 'lib', file)))
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  /**
   * peer 依赖要**连同它们的传递依赖**一起搬过来。
   * schemastery 自己依赖 @deepseek-ai/cosmokit；只拷 schemastery 会让它在 import 时
   * ERR_MODULE_NOT_FOUND，表现出来却像「插件 failed to import」，很容易误判。
   * 真实安装由 pnpm 处理这些关系，所以这里只要把 desktop profile 里那几个现成的包搬过去。
   */
  const desktopModules = join(DSH_HOME, 'profiles', 'desktop', 'node_modules')
  for (const rel of [
    join('@deepseek-ai', 'schemastery'),
    join('@deepseek-ai', 'cosmokit'),
    join('@standard-schema', 'spec'),
    'qrcode-generator',
  ]) {
    const from = join(desktopModules, rel)
    if (!existsSync(from)) continue
    cpSync(from, join(profileDir, 'node_modules', rel), { recursive: true })
  }
  // 探针插件：等插件完成（异步）注册后，读 tools 注册表确认 qqbot_send 在不在。
  // 注意：cordis 会把 `export const name` 当作插件名吃掉，所以这里不导出 name；
  // 服务必须通过 inject 声明，否则 ctx.tools 会抛 "cannot get property ... without inject"。
  writeFileSync(join(profileDir, 'toolcheck.mjs'), `import { writeFileSync } from 'node:fs'
export const inject = ['tools']
export const apply = (ctx) => {
  const out = ${JSON.stringify(probeOut)}
  setTimeout(async () => {
    try {
      /**
       * 只走公开 API，不遍历 ctx.tools 内部结构：
       * cordis 的 ctx 是代理，读未 inject 的属性会抛 "cannot get property ... without inject"，
       * 递归访问内部字段既脆弱又会误报。这里改为「注册一个探针工具，然后在 execute 里问注册表
       * 认不认识 qqbot_send」，用注册表自己的解析结果作为证据。
       */
      const fs = await import('node:fs')
      const probe = {
        name: 'toolcheck_ping',
        description: 'probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute() { return 'pong' },
      }
      ctx.tools.register(probe)

      /**
       * 关键证据：宿主自己的插件诊断入口。
       * 插件插件（plugin-manager）暴露了 listPlugins()，行里带 id/name/enabled；
       * 但更直接的证据是**重名注册会失败**：再注册一个 qqbot_send 若抛错，
       * 说明插件已经先一步把它注册进去了。
       */
      let duplicateRejected = false
      try {
        ctx.tools.register({
          name: 'qqbot_send',
          description: 'duplicate probe',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
          async execute() { return '' },
        })
      } catch {
        // 同名已存在 ⇒ 注册表拒绝重复项，正是我们要的反证。
        duplicateRejected = true
      }
      fs.writeFileSync(out, JSON.stringify({ ok: true, toolsUsable: true, duplicateRejected }, null, 2))
    } catch (error) {
      writeFileSync(out, JSON.stringify({ ok: false, error: String((error && error.stack) || (error && error.message) || error) }, null, 2))
    }
  }, 4000)
}
`)
  writeFileSync(join(profileDir, 'overlay.yml'), [
    '- insert:',
    "    - id: qqbot",
    "      name: '@lyw/dsh-qqbot'",
    "    - id: toolcheck",
    "      name: './toolcheck.mjs'",
    '',
  ].join('\n'))
}

/** 直接 import 插件并检查它是否尝试注册工具（不依赖注册表内部结构）。 */
async function probeByImport() {
  // 用一个假 ctx 调用 apply()，确认它调用到 tools.register 且工具名正确。
  const calls = []
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'tools' ? { register: (def) => { calls.push(def); return () => {} } } : undefined),
    on() {},
    effect() { return () => {} },
    inject() {},
  }
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  mod.apply(fakeCtx, {})
  // registerPushTool 是异步的（动态 import），给它时间落地。
  for (let i = 0; i < 40 && calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { mod, calls }
}

console.log('[组合包在真实 profile 里加载并注册工具]')
/**
 * 这一段必须在**真实 profile** 里跑：`@deepseek-ai/dsh-tools` 只存在于宿主的解析层，
 * 仓库目录下 `import('@deepseek-ai/dsh-tools')` 必然 ERR_MODULE_NOT_FOUND，
 * 因此用假 ctx 直接调 apply() 永远测不到注册那一步（已实测确认）。
 */
mkdirSync(dirname(probeOut), { recursive: true })
rmSync(probeOut, { force: true })
try {
  installIntoProfile()
  const child = spawn(EXE, [BIN, '--profile', profileName, '--patch', join(profileDir, 'overlay.yml')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME,
      // 探针要读的注册表快照路径
      QQBOT_TOOLCHECK_OUT: probeOut,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
  child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && !existsSync(probeOut)) await new Promise((r) => setTimeout(r, 250))
  child.kill()
  await new Promise((r) => setTimeout(r, 400))

  if (process.env.TOOLCHECK_VERBOSE === '1') {
    console.log('--- stdout ---')
    console.log(stdout.slice(-3000) || '(empty)')
    console.log('--- stderr ---')
    console.log(stderr.slice(-3000) || '(empty)')
  }

  if (existsSync(probeOut)) {
    const report = JSON.parse(readFileSync(probeOut, 'utf8'))
    check('临时 profile 里插件加载后 tools 服务可用', report.toolsUsable === true, JSON.stringify(report).slice(0, 300))
    check('qqbot_send 已在注册表中（重名注册被拒 = 插件已注册它）', report.duplicateRejected === true,
      JSON.stringify(report).slice(0, 300))
  } else {
    check('临时 profile 取到探针结果', false, stderr.trim().split('\n').slice(-4).join(' | '))
  }
} finally {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
  rmSync(probeOut, { force: true })
}

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
