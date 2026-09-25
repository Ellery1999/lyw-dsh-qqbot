/**
 * `@lyw/dsh-qqbot` 的浏览器半：在「插件」页（侧栏插件管理器）里本组合包的详情页注册配置页。
 *
 * PORT（0.1.7-rc.2）: 旧插件系统的插件配置入口是 `settings.plugin.item`
 * （0.1.5 由 configurable 标签页拥有），0.1.7 起该标签页连同 slot 一起从客户端树上删除，
 * 纯 Host 插件不再能靠「注册设置命名空间」出现在设置里。
 *
 * 0.1.7 的官方插件页 `dsh-client-ui-plugin-manager` 自己声明了三个配置插槽：
 *   - `plugins.item`          list  —— 官方插件的配置页
 *   - `plugins.bundle.config` keyed —— 组合包自己的配置页（key = 组合包 npm 包名）
 *   - `plugins.row.config`    keyed —— 某一行（`<包名>#<行 id>`）的配置页
 * 本插件是组合包，因此注册 `plugins.bundle.config`，key 为 `@lyw/dsh-qqbot`。
 * 该插槽只以 `view: 'page'` 渲染在组合包详情页，并且**不会**收到 `form` prop
 * （官方只给 `plugins.item` / `plugins.row.config` 传 form），所以本卡片自带数据流。
 *
 * 数据流不走 Typert Remote，而是 Host 半自己的 HTTP 接口 `/plugins/qqbot/api/*`：
 *   GET  /state        状态快照（网关/连接/凭据/白名单/工作目录/统计）
 *   POST /save         保存配置（appId / appSecret / workdir / acpCommand / 白名单）
 *   POST /bind/start   开始扫码绑定
 *   GET  /bind/poll    轮询扫码进度（返回 qrSvg）
 *   POST /bind/cancel  取消扫码
 *   POST /restart      重启网关
 *   POST /lockdown     白名单收紧为已绑定的 openid
 *
 * 桌面端注意：**不要**用 `<a target="_blank" href="/plugins/qqbot">` 打开独立页面。
 * Electron 外壳的 setWindowOpenHandler 要么直接 deny、要么只把 https: 交给
 * shell.openExternal（见应用 main.js），本地 http://127.0.0.1 链接会被静默丢弃，
 * 表现为「点了没反应」。因此配置与扫码一律在本卡片内完成，不依赖系统浏览器。
 *
 * 本文件是手写的运行时产物，不经构建链，格式与 tsdown 产出的 client bundle 一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 * `id` 必须正好是包名（不带 `/client` 子路径），loader 行只按这个说明符挂浏览器半。
 */
window.__ModuleLoader__.load({
  id: '@lyw/dsh-qqbot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Host 半提供的接口前缀。 */
    const API = '/plugins/qqbot/api'
    /** 独立配置页（仅作为「复制链接」用；桌面端不会自动跳浏览器）。 */
    const PAGE = '/plugins/qqbot'
    /** 本组合包的 npm 包名，同时是 `plugins.bundle.config` 插槽的 key。 */
    const BUNDLE = '@lyw/dsh-qqbot'

    const COLORS = {
      primary: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #57606a)',
      tertiary: 'var(--dsw-alias-label-tertiary, #6b7280)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      brand: 'var(--dsw-alias-brand-primary, #2563eb)',
      ok: 'var(--dsw-alias-label-success, #16a34a)',
      error: 'var(--dsw-alias-label-error, #dc2626)',
      field: 'var(--dsw-alias-bg-base, rgba(127,127,127,0.06))',
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
    const sectionStyle = { fontSize: 12, fontWeight: 600, color: COLORS.secondary, marginTop: 2 }
    const hintStyle = { margin: 0, fontSize: 12, lineHeight: 1.6, color: COLORS.tertiary }
    const gridStyle = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '4px 10px', fontSize: 12 }
    const formGridStyle = { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px 10px', alignItems: 'center', fontSize: 12 }
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
    const inputStyle = {
      font: 'inherit',
      fontSize: 12,
      padding: '4px 8px',
      borderRadius: 6,
      border: '0.5px solid ' + COLORS.border,
      background: COLORS.field,
      color: COLORS.primary,
      width: '100%',
      boxSizing: 'border-box',
    }
    const preStyle = {
      margin: 0,
      padding: '8px 10px',
      borderRadius: 8,
      border: '0.5px solid ' + COLORS.border,
      background: COLORS.field,
      color: COLORS.secondary,
      fontSize: 11,
      lineHeight: 1.5,
      maxHeight: 160,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    }
    const qrStyle = { width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 6 }

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

    const post = (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

    /** 每 5 秒拉一次状态；页面隐藏时不打扰。返回 `[state, reload]`。 */
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

    /** 扫码绑定会话：start / 轮询 / cancel。 */
    function useBind() {
      const [bind, setBind] = React.useState(null)
      const timer = React.useRef(null)
      const stop = () => {
        if (timer.current !== null) {
          clearInterval(timer.current)
          timer.current = null
        }
      }
      React.useEffect(() => stop, [])

      const poll = () => {
        request('/bind/poll')
          .then((snapshot) => {
            setBind(snapshot)
            if (snapshot && (snapshot.state === 'completed' || snapshot.state === 'failed' || snapshot.state === 'cancelled' || snapshot.state === 'expired')) stop()
          })
          .catch((error) => {
            setBind({ state: 'failed', message: String((error && error.message) || error) })
            stop()
          })
      }
      const start = () => {
        stop()
        post('/bind/start')
          .then((snapshot) => {
            setBind(snapshot)
            if (snapshot && snapshot.state === 'pending') timer.current = setInterval(poll, 2000)
          })
          .catch((error) => setBind({ state: 'failed', message: String((error && error.message) || error) }))
      }
      const cancel = () => {
        stop()
        post('/bind/cancel')
          .then((snapshot) => setBind(snapshot))
          .catch(() => setBind(null))
      }
      return { bind, start, cancel }
    }

    const BIND_STATE_TEXT = {
      idle: '未开始',
      pending: '等待扫码',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      expired: '已过期',
    }

    function field(label, node) {
      return [
        React.createElement('span', { key: 'l', style: keyStyle }, label),
        React.createElement('span', { key: 'f' }, node),
      ]
    }

    function textInput(key, value, onChange, options) {
      const extra = options || {}
      return React.createElement('input', {
        key,
        style: inputStyle,
        type: extra.type || 'text',
        value: value,
        placeholder: extra.placeholder || '',
        onChange: (event) => onChange(event.target.value),
      })
    }

    function checkboxInput(key, value, onChange, label) {
      return React.createElement(
        'label',
        { key, style: { display: 'flex', alignItems: 'center', gap: 6, color: COLORS.primary } },
        React.createElement('input', { type: 'checkbox', checked: value === true, onChange: (event) => onChange(event.target.checked) }),
        React.createElement('span', null, label),
      )
    }

    function QqbotCard() {
      const [state, reload] = useGatewayState()
      const { bind, start: startBind, cancel: cancelBind } = useBind()
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const draftRef = React.useRef(null)
      const [dirty, setDirty] = React.useState(false)
      const value = state.value || {}
      const connected = Boolean(value.connection && value.connection.connected)
      const bound = value.boundUserOpenId || null
      const allowUsers = Array.isArray(value.allowUsers) ? value.allowUsers : []
      const allowGroups = Array.isArray(value.allowGroups) ? value.allowGroups : []
      const locked = bound !== null && allowUsers.length > 0

      const run = (path, body, done) => {
        setBusy(true)
        setNotice(null)
        post(path, body)
          .then(() => {
            setNotice({ ok: true, text: done })
            reload()
          })
          .catch((error) => setNotice({ ok: false, text: String((error && error.message) || error) }))
          .then(() => setBusy(false))
      }

      // 首次拿到状态后填一次表单草稿；此后不再被轮询覆盖（保留用户正在编辑的内容）。
      if (state.loaded && !state.failed && draftRef.current === null) {
        const next = {
          appId: value.appId || '',
          appSecret: '',
          workdir: value.workdir || '',
          acpCommand: value.acpCommand || '',
          allowUsers: allowUsers.join(', '),
          allowGroups: allowGroups.join(', '),
          autoApprove: value.autoApprove !== false,
          sandbox: value.sandbox === true,
        }
        draftRef.current = next
        setDraft(next)
      }

      const edit = (key) => (next) => {
        setDraft((current) => Object.assign({}, current || {}, { [key]: next }))
        setDirty(true)
      }

      const save = () => {
        if (draft === null) return
        const patch = {
          workdir: draft.workdir,
          acpCommand: draft.acpCommand,
          allowUsers: draft.allowUsers,
          allowGroups: draft.allowGroups,
        }
        if (draft.appId.length > 0) patch.appId = draft.appId
        if (draft.appSecret.length > 0) patch.appSecret = draft.appSecret
        setBusy(true)
        setNotice(null)
        post('/save', patch)
          .then(() => {
            setNotice({ ok: true, text: '已保存；网关会按新配置重启。' })
            setDirty(false)
            setDraft((current) => Object.assign({}, current || {}, { appSecret: '' }))
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
        ['网关', value.gatewayState || '—'],
        ['白名单', allowUsers.length > 0 ? allowUsers.join(', ') : '未限制（任何 QQ 都可驱动 DSH）'],
        ['群白名单', allowGroups.length > 0 ? allowGroups.join(', ') : '未限制'],
        ['工作目录', value.workdir || '—'],
        ['ACP', value.acpCommand || '—'],
        ['会话数', value.sessionCount === undefined ? '—' : String(value.sessionCount)],
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
          '通过 QQ 官方机器人跟 DSH 对话：私聊直接发消息，群里 @ 机器人触发。配置与扫码都可在此页完成。',
        ),
        React.createElement(
          'div',
          { key: 'grid', style: gridStyle },
          rows.flatMap(([key, text], index) => [
            React.createElement('span', { key: 'k' + index, style: keyStyle }, key),
            React.createElement('span', { key: 'v' + index, style: valueStyle }, text),
          ]),
        ),
        React.createElement('div', { key: 's1', style: sectionStyle }, '配置'),
        draft === null
          ? React.createElement('p', { key: 'd0', style: hintStyle }, '读取配置中…')
          : React.createElement(
              'div',
              { key: 'form', style: formGridStyle },
              field('AppID', textInput('appId', draft.appId, edit('appId'), { placeholder: 'QQ 开放平台机器人 AppID' })),
              field('AppSecret', textInput('appSecret', draft.appSecret, edit('appSecret'), { type: 'password', placeholder: value.secretReady ? '已保存，留空则不修改' : 'QQ 开放平台机器人 AppSecret' })),
              field('工作目录', textInput('workdir', draft.workdir, edit('workdir'), { placeholder: '留空使用 $DSH_HOME/qqbot/workspace' })),
              field('ACP 命令', textInput('acpCommand', draft.acpCommand, edit('acpCommand'), { placeholder: 'dsh --profile acp' })),
              field('私聊白名单', textInput('allowUsers', draft.allowUsers, edit('allowUsers'), { placeholder: '逗号或空格分隔的 user_openid，留空不限制' })),
              field('群白名单', textInput('allowGroups', draft.allowGroups, edit('allowGroups'), { placeholder: '逗号或空格分隔的 group_openid，留空不限制' })),
            ),
        draft === null
          ? null
          : React.createElement(
              'div',
              { key: 'save', style: actionsStyle },
              React.createElement(
                'button',
                { type: 'button', style: buttonStyle, disabled: busy || !dirty, onClick: save },
                dirty ? '保存配置' : '已保存',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: buttonStyle,
                  disabled: busy,
                  onClick: () => {
                    draftRef.current = null
                    setDraft(null)
                    setDirty(false)
                    reload()
                  },
                },
                '重新读取',
              ),
            ),
        React.createElement('div', { key: 's2', style: sectionStyle }, '扫码绑定'),
        React.createElement(
          'div',
          { key: 'bind', style: actionsStyle },
          React.createElement(
            'button',
            { type: 'button', style: buttonStyle, disabled: busy || (bind !== null && bind.state === 'pending'), onClick: startBind },
            '开始扫码绑定',
          ),
          bind !== null && bind.state === 'pending'
            ? React.createElement('button', { type: 'button', style: buttonStyle, onClick: cancelBind }, '取消')
            : null,
          React.createElement('span', { style: hintStyle }, '状态：' + BIND_STATE_TEXT[(bind && bind.state) || 'idle']),
        ),
        bind !== null && bind.qrSvg
          ? React.createElement('div', {
              key: 'qr',
              style: qrStyle,
              // qrSvg 由本插件 Host 半用 qrcode-generator 生成，是本进程自己的产物。
              dangerouslySetInnerHTML: { __html: bind.qrSvg },
            })
          : null,
        bind !== null && bind.url
          ? React.createElement('p', { key: 'bindurl', style: hintStyle }, '用手机 QQ 扫码，或打开：' + bind.url)
          : null,
        bind !== null && bind.message ? React.createElement('p', { key: 'bindmsg', style: hintStyle }, bind.message) : null,
        React.createElement('div', { key: 's3', style: sectionStyle }, '操作'),
        React.createElement(
          'div',
          { key: 'actions', style: actionsStyle },
          React.createElement(
            'button',
            { type: 'button', style: buttonStyle, disabled: busy, onClick: () => run('/restart', {}, '已请求重启网关。') },
            '重启网关',
          ),
          bound !== null && !locked
            ? React.createElement(
                'button',
                { type: 'button', style: buttonStyle, disabled: busy, onClick: () => run('/lockdown', {}, '已收紧：只有绑定的 QQ 号可用。') },
                '只允许绑定的 QQ 使用',
              )
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              disabled: busy,
              onClick: () => {
                const url = (typeof location !== 'undefined' ? location.origin : '') + PAGE
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                  navigator.clipboard.writeText(url).then(
                    () => setNotice({ ok: true, text: '已复制配置页地址：' + url }),
                    () => setNotice({ ok: false, text: url }),
                  )
                } else {
                  setNotice({ ok: false, text: url })
                }
              },
            },
            '复制配置页地址',
          ),
        ),
        notice
          ? React.createElement(
              'p',
              { key: 'notice', style: { margin: 0, fontSize: 12, color: notice.ok ? COLORS.ok : COLORS.error } },
              notice.text,
            )
          : null,
        value.logTail
          ? React.createElement(
              'details',
              { key: 'log' },
              React.createElement('summary', { style: hintStyle }, '查看网关日志尾部'),
              React.createElement('pre', { style: preStyle }, String(value.logTail)),
            )
          : null,
      ].filter((child) => child !== null)

      return React.createElement('section', { style: cardStyle }, children)
    }

    /**
     * Client plugin body：把卡片注册进「插件」页里本组合包的配置页。
     *
     * `plugins.bundle.config` 是 keyed slot（key = 组合包 npm 包名），由
     * dsh-client-ui-plugin-manager 的 `main` 面板声明为 root 作用域子 slot，
     * 只以 `view: 'page'` 渲染在组合包详情页里（描述与插件行之间）。
     * `ctx.slots.inject` 会等到该 slot 出现再注册，因此不依赖面板的加载顺序。
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE }, QqbotCard),
      )
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    exports.QqbotCard = QqbotCard
    return module.exports
  },
})
