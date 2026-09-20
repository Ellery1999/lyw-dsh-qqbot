/**
 * QQ 机器人配置 / 扫码绑定页面的 HTML。
 *
 * 单页、零外部资源（二维码 SVG 由宿主渲染后返回），通过
 * `/plugins/qqbot/api/*` 与插件通信。任何接口都不会回显 AppSecret 明文。
 */

export const PAGE_PATH = '/plugins/qqbot'
export const API_PREFIX = '/plugins/qqbot/api'

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH ⇄ QQ 机器人</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #6b7280; --line: #e5e7eb; --bg: #ffffff; --card: #f8fafc; --accent: #2563eb; --ok: #16a34a; --err: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --muted: #9ca3af; --line: #333; --bg: #16181d; --card: #1e2128; --accent: #60a5fa; --ok: #4ade80; --err: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; }
  button { margin-top: 14px; padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .kv { display: grid; grid-template-columns: 132px 1fr; gap: 6px 12px; font-variant-numeric: tabular-nums; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
  .pill.on { color: var(--ok); border-color: var(--ok); }
  .pill.off { color: var(--muted); }
  .pill.err { color: var(--err); border-color: var(--err); }
  .qr { display: flex; gap: 20px; align-items: flex-start; margin-top: 14px; flex-wrap: wrap; }
  .qr svg { width: 220px; height: 220px; background: #fff; border-radius: 8px; padding: 6px; }
  .hint { color: var(--muted); font-size: 13px; }
  .msg { margin-top: 12px; font-size: 13px; }
  .msg.ok { color: var(--ok); }
  .msg.err { color: var(--err); }
  code { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
  details { margin-top: 14px; }
  summary { cursor: pointer; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>DSH ⇄ QQ 机器人</h1>
  <p class="sub">用 QQ 官方机器人（QQ Bot API v2）跟 DSH 对话：私聊直接发消息，群里 @ 机器人触发。</p>

  <section>
    <h2>连接状态</h2>
    <dl class="kv" id="state">
      <dt>网关</dt><dd><span class="pill off" id="pill">读取中…</span></dd>
      <dt>AppID</dt><dd id="appId">—</dd>
      <dt>AppSecret</dt><dd id="secret">—</dd>
      <dt>ACP 命令</dt><dd id="acp">—</dd>
      <dt>工作目录</dt><dd id="workdir">—</dd>
      <dt>会话数</dt><dd id="sessions">—</dd>
      <dt>收发统计</dt><dd id="stats">—</dd>
      <dt>绑定账号</dt><dd id="bound">—</dd>
      <dt>最近私聊 openid</dt><dd id="lastUser">—</dd>
      <dt>最近错误</dt><dd id="lastError">—</dd>
    </dl>
    <div class="row">
      <button class="ghost" id="restart">重启网关</button>
      <button class="ghost" id="openLog">查看网关日志</button>
      <button id="lockdown">只允许绑定的 QQ 使用</button>
    </div>
    <div class="msg" id="stateMsg"></div>
    <p class="hint" style="margin-top:10px">⚠️ 白名单为空时，<b>任何</b>能给机器人发消息的 QQ 用户都能驱动 DSH（当前权限预设含完整文件与命令权限）。建议绑定后点右侧按钮收紧。</p>
  </section>

  <section>
    <h2>扫码绑定机器人（推荐）</h2>
    <p class="hint">点下面的按钮，用<b>手机 QQ</b> 扫描二维码并选择要接入的机器人，AppID / AppSecret 会自动写入 DSH 设置。</p>
    <div class="row">
      <button id="bind">生成绑定二维码</button>
      <button class="ghost" id="cancel" style="display:none">取消</button>
    </div>
    <div class="qr" id="qrBox" style="display:none">
      <div id="qrSvg"></div>
      <div>
        <p class="hint" id="bindStatus">等待扫码…</p>
        <p class="hint">扫不出来？也可以在手机 QQ 里打开链接：</p>
        <p><a id="bindLink" href="#" target="_blank" rel="noreferrer"></a></p>
      </div>
    </div>
    <div class="msg" id="bindMsg"></div>
  </section>

  <section>
    <h2>手动配置</h2>
    <p class="hint">在 <a href="https://q.qq.com" target="_blank" rel="noreferrer">q.qq.com</a> 创建机器人后，把 AppID 与 AppSecret 填在这里也可以。</p>
    <label for="inAppId">AppID</label>
    <input id="inAppId" placeholder="例如 102xxxxxx" autocomplete="off">
    <label for="inSecret">AppSecret</label>
    <input id="inSecret" type="password" placeholder="留空表示不修改已保存的值" autocomplete="off">
    <label for="inWorkdir">DSH 工作目录（可选）</label>
    <input id="inWorkdir" placeholder="留空使用 $DSH_HOME/qqbot/workspace" autocomplete="off">
    <div class="row">
      <button id="save">保存并重启网关</button>
    </div>
    <div class="msg" id="saveMsg"></div>
    <details>
      <summary>白名单与高级选项</summary>
      <label for="inUsers">允许私聊的 user_openid（逗号分隔，留空不限制）</label>
      <input id="inUsers" autocomplete="off">
      <label for="inGroups">允许的 group_openid（逗号分隔，留空不限制）</label>
      <input id="inGroups" autocomplete="off">
      <label for="inAcp">ACP 启动命令</label>
      <input id="inAcp" autocomplete="off">
    </details>
  </section>
</main>

<script>
const api = (path, init) => fetch('${API_PREFIX}' + path, init).then(async (r) => {
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error((body && (body.error || body.message)) || ('HTTP ' + r.status));
  return body;
});
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const $ = (id) => document.getElementById(id);
const setMsg = (id, text, ok) => { const el = $(id); el.textContent = text || ''; el.className = 'msg ' + (text ? (ok === false ? 'err' : 'ok') : ''); };

/**
 * 一键收紧要放行的 openid：优先扫码绑定记录，缺失时回退最近私聊发送者。
 * 只有白名单仍为空时才提供——已经有白名单说明用户自己配过了，不该再覆盖。
 */
function lockdownTarget(s) {
  if (s.allowUsers && s.allowUsers.length > 0) return null;
  return s.boundUserOpenId || s.lastUserOpenId || null;
}

let pollTimer = null;
/** 最近一次 /state 结果，供 lockdownTarget 在点击时判定 */
let lastState = {};

async function refreshState() {
  try {
    const s = await api('/state');
    lastState = s;
    const pill = $('pill');
    if (s.connection && s.connection.connected) { pill.textContent = '已连接'; pill.className = 'pill on'; }
    else { pill.textContent = s.gatewayState || (s.connection && s.connection.detail) || '未运行'; pill.className = 'pill ' + (s.gatewayState === 'missing-app-id' ? 'err' : 'off'); }
    $('appId').textContent = s.appId || '（未配置）';
    $('secret').textContent = s.secretReady ? '已保存' : '（未配置）';
    $('acp').textContent = s.acpCommand || '—';
    $('workdir').textContent = s.workdir || '—';
    $('sessions').textContent = s.sessionCount === undefined ? '—' : String(s.sessionCount);
    $('stats').textContent = s.stats ? ('收到 ' + (s.stats.inbound ?? 0) + ' / 回复 ' + (s.stats.replies ?? 0) + ' / 失败 ' + (s.stats.errors ?? 0)) : '—';
    $('bound').textContent = s.boundUserOpenId ? (s.boundUserOpenId + (s.boundAt ? '（' + new Date(s.boundAt).toLocaleString() + '）' : '')) : '—';
    $('lastUser').textContent = s.lastUserOpenId || '—';
    $('lockdown').style.display = lockdownTarget(s) ? 'inline-block' : 'none';
    $('lastError').textContent = s.lastError || '—';
    if (!$('inAppId').value && s.appId) $('inAppId').value = s.appId;
    if (!$('inAcp').value && s.acpCommand) $('inAcp').value = s.acpCommand;
    if (!$('inWorkdir').value && s.workdir) $('inWorkdir').value = s.workdir;
  } catch (error) {
    $('pill').textContent = '插件未响应';
    $('pill').className = 'pill err';
  }
}

async function refreshBind() {
  try {
    const b = await api('/bind/poll');
    if (b.state === 'idle' || b.state === 'cancelled') return;
    if (b.qrSvg && !$('qrSvg').innerHTML) $('qrSvg').innerHTML = b.qrSvg;
    if (b.url) { $('bindLink').textContent = b.url; $('bindLink').href = b.url; }
    if (b.state === 'completed') {
      stopPoll();
      $('bindStatus').textContent = '绑定成功：' + (b.appId || '') + (b.userOpenId ? '（openid ' + b.userOpenId + '）' : '');
      setMsg('bindMsg', '已写入设置并重启网关，连接状态见上方。', true);
      $('inAppId').value = b.appId || $('inAppId').value;
      await refreshState();
      return;
    }
    if (b.state === 'expired' || b.state === 'failed') {
      stopPoll();
      $('bindStatus').textContent = b.state === 'expired' ? '二维码已过期，请重新生成' : '绑定失败';
      setMsg('bindMsg', b.error || '', false);
      return;
    }
    $('bindStatus').textContent = '等待扫码…（任务 ' + (b.taskId || '').slice(0, 12) + '）';
  } catch (error) {
    stopPoll();
    setMsg('bindMsg', '绑定状态查询失败：' + error.message, false);
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(refreshBind, 2000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

$('bind').addEventListener('click', async () => {
  $('bind').disabled = true;
  setMsg('bindMsg', '正在申请二维码…');
  $('qrSvg').innerHTML = '';
  try {
    const b = await post('/bind/start');
    $('qrBox').style.display = 'flex';
    $('cancel').style.display = 'inline-block';
    $('qrSvg').innerHTML = b.qrSvg || '';
    $('bindLink').textContent = b.url || '';
    $('bindLink').href = b.url || '#';
    $('bindStatus').textContent = '等待扫码…';
    setMsg('bindMsg', '请用手机 QQ 扫码并选择机器人。');
    startPoll();
  } catch (error) {
    setMsg('bindMsg', '生成二维码失败：' + error.message, false);
  } finally {
    $('bind').disabled = false;
  }
});

$('cancel').addEventListener('click', async () => {
  stopPoll();
  await post('/bind/cancel').catch(() => {});
  $('qrBox').style.display = 'none';
  $('cancel').style.display = 'none';
  setMsg('bindMsg', '已取消。');
});

$('save').addEventListener('click', async () => {
  setMsg('saveMsg', '正在保存…');
  try {
    await post('/save', {
      appId: $('inAppId').value.trim(),
      appSecret: $('inSecret').value,
      workdir: $('inWorkdir').value.trim(),
      acpCommand: $('inAcp').value.trim(),
      allowUsers: $('inUsers').value,
      allowGroups: $('inGroups').value,
    });
    $('inSecret').value = '';
    setMsg('saveMsg', '已保存，网关正在重启。', true);
    setTimeout(refreshState, 1500);
  } catch (error) {
    setMsg('saveMsg', '保存失败：' + error.message, false);
  }
});

$('restart').addEventListener('click', async () => {
  setMsg('stateMsg', '正在重启…');
  try { await post('/restart'); setMsg('stateMsg', '已请求重启。', true); setTimeout(refreshState, 1500); }
  catch (error) { setMsg('stateMsg', '重启失败：' + error.message, false); }
});

$('lockdown').addEventListener('click', async () => {
  const target = lockdownTarget(lastState);
  const who = target ? ('openid ' + target) : '扫码绑定的那个 QQ 号';
  if (!confirm('只允许 ' + who + ' 驱动 DSH，其余消息一律忽略。继续？')) return;
  setMsg('stateMsg', '正在收紧白名单…');
  try { await post('/lockdown'); setMsg('stateMsg', '已收紧：现在只有 ' + who + ' 可用。', true); setTimeout(refreshState, 1200); }
  catch (error) { setMsg('stateMsg', '收紧失败：' + error.message, false); }
});

$('openLog').addEventListener('click', () => {
  const raw = api('/state').then((s) => {
    const text = (s.logTail || '（暂无日志）');
    const w = window.open('', '_blank');
    if (w) { w.document.title = 'QQ 机器人网关日志'; const pre = w.document.createElement('pre'); pre.textContent = text; w.document.body.appendChild(pre); }
  }).catch(() => {});
  return raw;
});

refreshState();
setInterval(refreshState, 4000);
</script>
</body>
</html>
`
}
