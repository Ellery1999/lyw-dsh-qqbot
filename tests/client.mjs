/**
 * 客户端 bundle 契约测试（不需要浏览器）。
 *
 * 用与宿主一致的 `window.__ModuleLoader__.load({id, factory})` 契约执行
 * lib/client.js：校验注册 id、导出、槽位注册的 key，并用 react-dom/server
 * 真正渲染一次卡片，确认静态内容正确。
 *
 * 用法：node tests/client.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const results = []
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok))
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

// react / react-dom 从部署的 profile 回退层解析（本包不把它们作为运行依赖）
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const candidates = [
  process.env.DSH_QQBOT_REACT_ROOT,
  join(home, 'profiles', 'web', 'package.json'),
  join(home, 'profiles', 'package.json'),
  'D:/deepseek-harness/packages/client/ui-jobs/package.json',
  'D:/deepseek-harness/apps/web/package.json',
].filter((value) => typeof value === 'string' && value.length > 0)

let React = null
let renderToStaticMarkup = null
let reactFrom = null
for (const candidate of candidates) {
  try {
    const req = createRequire(candidate)
    React = req('react')
    renderToStaticMarkup = req('react-dom/server').renderToStaticMarkup
    reactFrom = candidate
    break
  } catch {
    /* 试下一个候选 */
  }
}
if (React === null) {
  console.log('SKIP：本机找不到 react/react-dom，无法执行客户端 bundle 契约测试')
  console.log(`  试过：${candidates.join(', ')}`)
  process.exit(0)
}
console.log(`[react 来自 ${reactFrom}]`)

console.log('[bundle registration]')
let registration = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (entry) => { registration = entry },
    },
  },
  document: { hidden: false },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: () => Promise.reject(new Error('no network in test')),
  Symbol,
  Object,
  JSON,
  Array,
  String,
  Boolean,
  Number,
  Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.js' })

check('bundle 调用 __ModuleLoader__.load 注册自己', registration !== null)
check('注册 id 等于包名', registration?.id === '@lyw/dsh-qqbot', String(registration?.id))
check('factory 是函数', typeof registration?.factory === 'function')

const requireStub = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`bundle 只能 require('react')，实际请求了 ${specifier}`)
}
const plugin = registration.factory(requireStub)
check('导出 apply()', typeof plugin.apply === 'function')
check('导出 inject（客户端服务）', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))

console.log('\n[slot registration]')
const registrations = []
const fakeCtx = {
  slots: {
    inject: (name, callback) => { registrations.push({ name, callback }) },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}
plugin.apply(fakeCtx)
check('订阅了 settings.plugin.item 槽位', registrations.some((r) => r.name === 'settings.plugin.item'))
// 触发 inject 回调，模拟槽位声明后真正注册
for (const entry of registrations) {
  if (typeof entry.callback === 'function') entry.callback()
}
const card = registrations.find((r) => r.options !== undefined)
check('注册进 settings.plugin.item', card?.options?.name === 'settings.plugin.item')
check('卡片 key 与设置命名空间同名（qqbot）', card?.options?.key === 'qqbot', String(card?.options?.key))
check('卡片是 React 组件', typeof card?.component === 'function')

console.log('\n[render]')
let html = ''
try {
  html = renderToStaticMarkup(React.createElement(card.component))
  check('卡片能渲染（初始=读取中）', html.length > 0)
} catch (error) {
  check('卡片能渲染', false, error.message)
}
check('渲染出标题「QQ 机器人」', html.includes('QQ 机器人'))
check('渲染出配置页入口链接', html.includes('/plugins/qqbot'))
check('渲染出未加载时的状态', html.includes('读取中') || html.includes('未配置'))
check('渲染出「重启网关」按钮', html.includes('重启网关'))
check('渲染不产生 React 警告级错误', !html.includes('undefined'))

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
