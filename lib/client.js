/**
 * `@lyw/dsh-qqbot` 的浏览器半：在「设置 → 插件 → 插件配置」里注册一张卡片。
 *
 * DSH 的插件配置标签只渲染「Host 提供的设置命名空间 ∩ 浏览器端注册的卡片」
 * （见 dsh-client-ui-settings-plugins 的 tab-store），所以纯 Host 插件即使注册了
 * `qqbot` 命名空间也不会出现在设置里——必须由本文件把卡片注册到
 * `settings.plugin.item`，key 与命名空间同名。
 *
 * 卡片的数据与操作直接走 Host 半自己的 HTTP 接口（`/plugins/qqbot/api/*`），
 * 因此不需要 Typert Remote 那一层。本文件是手写的运行时产物，不经构建链，
 * 格式与仓库里 tsdown 产出的 client bundle 一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 */
window.__ModuleLoader__.load({
  id: '@lyw/dsh-qqbot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host 半提供的配置页接口。 */
    const API = '/plugins/qqbot/api'
    /** 卡片所在页面的链接地址。 */
    const PAGE = '/plugins/qqbot'

    const COLORS = {
      primary: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #57606a)',
      tertiary: 'var(--dsw-alias-label-tertiary, #6b7280)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      brand: 'var(--dsw-alias-brand-primary, #2563eb)',
      ok: 'var(--dsw-alias-label-success, #16a34a)',
      error: 'var(--dsw-alias-label-error, #dc2626)',
    }

    const cardStyle = {
      border: '0.5px solid ' + COLORS.border,
      borderRadius: 12,
      padding: '14px 16px',
      margin: '8px 0',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }
    const titleRowStyle = { display: 'flex', alignItems: 'center', gap: 8 }
    const titleStyle = { fontSize: 13, fontWeight: 600, color: COLORS.primary, flex: 1 }
    const hintStyle = { margin: 0, fontSize: 12, lineHeight: 1.6, color: COLORS.tertiary }
    const gridStyle = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '4px 10px', fontSize: 12 }
    const keyStyle = { color: COLORS.tertiary }
    const valueStyle = { color: COLORS.primary, wordBreak: 'break-all', margin: 0 }
    const actionsStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
    const buttonStyle = {
      font: 'inherit',
      fontSize: 12,
      padding: '5px 12px',
      borderRadius: 8,
      border: '0.5px solid ' + COLORS.border,
      background: 'transparent',
      color: COLORS.brand,
      cursor: 'pointer',
    }
    const linkStyle = Object.assign({}, buttonStyle, { textDecoration: 'none', display: 'inline-block' })

    function pillStyle(kind) {
      const color = kind === 'on' ? COLORS.ok : kind === 'err' ? COLORS.error : COLORS.tertiary
      return {
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: 999,
        border: '0.5px solid ' + color,
        color: color,
        whiteSpace: 'nowrap',
      }
    }

    function request(path, init) {
      return fetch(API + path, init).then((response) =>
        response.text().then((text) => {
          let body = null
          try {
            body = text.length > 0 ? JSON.parse(text) : null
          } catch {
            body = null
          }
          if (!response.ok) throw new Error((body && body.error) || 'HTTP ' + response.status)
          return body
        }),
      )
    }

    /** 每 5 秒拉一次网关状态；页面隐藏时不打扰。返回 `[state, reload]`。 */
    function useGatewayState() {
      const [state, setState] = React.useState({ loaded: false })
      const mounted = React.useRef(true)
      const load = () => {
        request('/state')
          .then((value) => {
            if (mounted.current) setState({ loaded: true, value: value })
          })
          .catch((error) => {
            if (mounted.current) setState({ loaded: true, failed: String((error && error.message) || error) })
          })
      }
      React.useEffect(() => {
        mounted.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          load()
        }, 5000)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [])
      return [state, load]
    }

    function QqbotCard() {
      const [state, reload] = useGatewayState()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const value = state.value || {}
      const connected = Boolean(value.connection && value.connection.connected)
      const bound = value.boundUserOpenId || null
      const allowUsers = Array.isArray(value.allowUsers) ? value.allowUsers : []
      const locked = bound !== null && allowUsers.length > 0

      const run = (path, body, done) => {
        setBusy(true)
        setNotice(null)
        request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then(() => {
            setNotice({ ok: true, text: done })
            reload()
          })
          .catch((error) => setNotice({ ok: false, text: String((error && error.message) || error) }))
          .then(() => setBusy(false))
      }

      const status = !state.loaded
        ? '读取中…'
        : state.failed
          ? '插件未响应'
          : connected
            ? '已连接'
            : value.gatewayState === 'missing-app-id' || value.gatewayState === 'missing-app-secret'
              ? '未配置凭据'
              : '未连接'

      const rows = [
        ['AppID', value.appId ? value.appId : '（未配置）'],
        ['AppSecret', value.secretReady ? '已保存' : '（未配置）'],
        ['绑定账号', bound ? bound : '—'],
        ['连接', (value.connection && value.connection.detail) || '—'],
        ['白名单', allowUsers.length > 0 ? allowUsers.join(', ') : '未限制（任何 QQ 都可驱动 DSH）'],
        ['工作目录', value.workdir || '—'],
      ]

      const children = [
        React.createElement(
          'div',
          { key: 'head', style: titleRowStyle },
          React.createElement('span', { key: 't', style: titleStyle }, 'QQ 机器人'),
          React.createElement(
            'span',
            {
              key: 'p',
              style: pillStyle(state.failed ? 'err' : connected ? 'on' : 'off'),
              title: state.failed || undefined,
            },
            status,
          ),
        ),
        React.createElement(
          'p',
          { key: 'desc', style: hintStyle },
          '通过 QQ 官方机器人跟 DSH 对话：私聊直接发消息，群里 @ 机器人触发。',
        ),
        React.createElement(
          'div',
          { key: 'grid', style: gridStyle },
          rows.flatMap(([key, text], index) => [
            React.createElement('span', { key: 'k' + index, style: keyStyle }, key),
            React.createElement('span', { key: 'v' + index, style: valueStyle }, text),
          ]),
        ),
        React.createElement(
          'div',
          { key: 'actions', style: actionsStyle },
          React.createElement(
            'a',
            { key: 'open', href: PAGE, target: '_blank', rel: 'noreferrer', style: linkStyle },
            '打开配置 / 扫码绑定页',
          ),
          React.createElement(
            'button',
            {
              key: 'restart',
              type: 'button',
              style: buttonStyle,
              disabled: busy,
              onClick: () => run('/restart', {}, '已请求重启网关。'),
            },
            '重启网关',
          ),
          bound !== null && !locked
            ? React.createElement(
                'button',
                {
                  key: 'lock',
                  type: 'button',
                  style: buttonStyle,
                  disabled: busy,
                  onClick: () => run('/lockdown', {}, '已收紧：只有绑定的 QQ 号可用。'),
                },
                '只允许绑定的 QQ 使用',
              )
            : null,
        ),
        notice
          ? React.createElement(
              'p',
              { key: 'notice', style: { margin: 0, fontSize: 12, color: notice.ok ? COLORS.ok : COLORS.error } },
              notice.text,
            )
          : null,
      ].filter((child) => child !== null)

      return React.createElement('section', { style: cardStyle }, children)
    }

    /**
     * Client plugin body：把卡片注册进插件配置标签。
     * key 必须与 Host 端注册的设置命名空间同名（'qqbot'）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register({ name: 'settings.plugin.item', key: 'qqbot' }, QqbotCard),
      )
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    exports.QqbotCard = QqbotCard
    return module.exports
  },
})
