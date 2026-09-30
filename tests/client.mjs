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
  join(home, 'profiles', 'desktop', 'node_modules', '@lyw', 'dsh-qqbot', 'package.json'),
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
// 没有 react 时不再整体退出：注册契约与源码断言不依赖 react，仍然必须跑。
const hasReact = React !== null
if (hasReact) console.log(`[react 来自 ${reactFrom}]`)
else {
  console.log('[本机找不到 react/react-dom：跳过真实渲染用例，其余契约照常断言]')
  console.log(`  试过：${candidates.join(', ')}`)
}

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
check('订阅了 plugins.bundle.config 槽位', registrations.some((r) => r.name === 'plugins.bundle.config'))
// 触发 inject 回调，模拟槽位声明后真正注册
for (const entry of registrations) {
  if (typeof entry.callback === 'function') entry.callback()
}
const card = registrations.find((r) => r.options !== undefined)
check('注册进 plugins.bundle.config', card?.options?.name === 'plugins.bundle.config')
check('卡片 key 等于组合包包名', card?.options?.key === '@lyw/dsh-qqbot', String(card?.options?.key))
check('卡片是 React 组件', typeof card?.component === 'function')

console.log('\n[render]')
if (!hasReact) {
  // 没有 react 时用源码断言兜底：至少保证新 UI 的元素名与接口路径真的写在 bundle 里，
  // 否则「测试通过」会掩盖「按钮根本没加」。
  const source = readFileSync(BUNDLE, 'utf8')
  console.log('  （无 react，改用源码断言）')
  check('bundle 源码含主动推送区块标题', source.includes('主动推送测试'))
  check('bundle 源码含「发送测试消息」按钮', source.includes('发送测试消息'))
  check('bundle 源码调用 /push-test 接口', source.includes("post('/push-test'"))
  check('bundle 源码含推送配置字段', source.includes('pushMaxChars') && source.includes('pushAllowAnyTarget') && source.includes('pushDefaultTarget'))
  check('bundle 源码含会话类型选择', source.includes("'c2c'") && source.includes("'group'"))
} else {
  let html = ''
  try {
    html = renderToStaticMarkup(React.createElement(card.component))
    check('卡片能渲染（初始=读取中）', html.length > 0)
  } catch (error) {
    check('卡片能渲染', false, error.message)
  }
  check('渲染出标题「QQ 机器人」', html.includes('QQ 机器人'))
  check('渲染出「重启网关」按钮', html.includes('重启网关'))
  check('渲染出主动推送区块', html.includes('主动推送测试'))
  check('渲染出「发送测试消息」按钮', html.includes('发送测试消息'))
  check('渲染出推送目标输入框', html.includes('目标 openid'))
  check('渲染出会话类型选择（私聊/群聊）', html.includes('私聊（c2c）') && html.includes('群聊（group）'))
  check('渲染出推送配置项（字数上限/默认目标）', html.includes('推送字数上限') && html.includes('默认推送目标'))
  check('渲染出允许任意目标开关', html.includes('允许任意目标'))
  check('渲染不产生 React 警告级错误', !html.includes('undefined'))
}

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
