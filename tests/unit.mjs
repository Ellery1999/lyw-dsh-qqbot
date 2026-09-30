/**
 * 纯逻辑单测：分片、文本清洗、命令行切分、扫码密文解密、openid 兜底恢复。
 * 用法：node tests/unit.mjs
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentFileName,
  attachmentPromptLines,
  chunkText,
  collectAttachments,
  formatSessionList,
  parseCommandLine,
  parseOutgoingFiles,
  quotedTextOf,
  readLastUserOpenId,
  toPlainText,
  VERSION,
} from '../lib/gateway.mjs'
import { PROTOCOL, fileTypeFor, normalizePrepare } from '../lib/qq-transport.mjs'
import { decryptClientSecret, renderQrSvg } from '../lib/bind.mjs'
import { acpDefaultBlock, syncAcpProviderConfig } from '../lib/index.js'
import {
  MAX_PUSH_FILES,
  buildPushPolicy,
  checkPushTarget,
  claimPushRequests,
  clearPushResult,
  idOfArtifact,
  newRequestId,
  outboxDir,
  outboxSnapshot,
  pruneOutbox,
  readPushResult,
  settlePushRequest,
  validateRequestShape,
  waitForPushResult,
  writePushRequest,
} from '../lib/outbox.mjs'

const results = []
function check(name, condition, detail = '') {
  results.push(Boolean(condition))
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition || detail === '' ? '' : ` — ${detail}`}`)
}

console.log('[chunkText]')
check('短文本不分片', chunkText('你好', 100).length === 1)
check('超长单行被切开', chunkText('a'.repeat(250), 100).every((c) => c.length <= 100))
check('按行聚合且不超限', (() => {
  const text = Array.from({ length: 30 }, (_, i) => `第 ${i} 行内容`).join('\n')
  const chunks = chunkText(text, 40)
  return chunks.length > 1 && chunks.every((c) => c.length <= 40) && chunks.join('\n') === text
})())
check('空行不产生空分片', chunkText('a\n\n\nb', 10).every((c) => c.trim().length > 0))

console.log('\n[toPlainText]')
check('去掉代码围栏', toPlainText('```js\nconst a = 1\n```').trim() === 'const a = 1')
check('无语言标记的围栏也去掉', toPlainText('```\nplain\n```').trim() === 'plain')
check('去掉行内反引号', toPlainText('用 `dsh run` 执行') === '用 dsh run 执行')
check('去掉标题井号', !toPlainText('## 标题').includes('#'))
check('加粗还原为纯文本', toPlainText('**重点**') === '重点')
check('列表符号替换为 ·', toPlainText('- 一\n- 二').startsWith('· 一'))
check('链接保留文字与地址', toPlainText('[文档](https://x.test)') === '文档 (https://x.test)')
check('三连空行压缩', !toPlainText('a\n\n\n\n\nb').includes('\n\n\n'))

console.log('\n[parseCommandLine]')
check('基本切分', JSON.stringify(parseCommandLine('dsh --profile acp')) === JSON.stringify(['dsh', '--profile', 'acp']))
check('带引号的参数', JSON.stringify(parseCommandLine('node "C:\\a b\\x.js" --flag')) === JSON.stringify(['node', 'C:\\a b\\x.js', '--flag']))
check('多余空白不影响', JSON.stringify(parseCommandLine('  a   b  ')) === JSON.stringify(['a', 'b']))

console.log('\n[decryptClientSecret]')
check('按 IV(12)‖ct‖tag(16) 布局解出明文', (() => {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update('secret-value-123', 'utf8'), cipher.final()])
  const raw = Buffer.concat([iv, ciphertext, cipher.getAuthTag()])
  const decrypted = decryptClientSecret(key.toString('base64'), raw.toString('base64'))
  return decrypted === 'secret-value-123'
})())
check('错误密钥抛出（GCM 校验失败）', (() => {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update('x', 'utf8'), cipher.final()])
  const raw = Buffer.concat([iv, ciphertext, cipher.getAuthTag()])
  try {
    decryptClientSecret(randomBytes(32).toString('base64'), raw.toString('base64'))
    return false
  } catch {
    return true
  }
})())
check('长度不足时报错而不是静默出错', (() => {
  try {
    decryptClientSecret(randomBytes(32).toString('base64'), Buffer.alloc(10).toString('base64'))
    return false
  } catch {
    return true
  }
})())

console.log('\n[renderQrSvg]')
check('生成 SVG 且尺寸与模块数一致', (() => {
  const svg = renderQrSvg('https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc&_wv=2&source=dsh')
  const match = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  if (match === null) return false
  const size = Number(match[1])
  return svg.startsWith('<svg') && svg.includes('</svg>') && size > 100 && size % 1 === 0
})())
check('内容不同则二维码不同', renderQrSvg('a') !== renderQrSvg('b'))

console.log('\n[readLastUserOpenId]')
/** 用临时 state 目录跑一个场景，返回恢复出的 openid。 */
function recoverFrom({ status, log }) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-unit-state-'))
  try {
    if (status !== undefined) writeFileSync(join(dir, 'status.json'), JSON.stringify(status))
    if (log !== undefined) writeFileSync(join(dir, 'gateway.log'), log)
    return readLastUserOpenId(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}
check('status.json 有记录时直接采用', recoverFrom({ status: { lastUserOpenId: 'openid-from-status' } }) === 'openid-from-status')
check('status.json 缺字段时回退日志', recoverFrom({
  status: { version: '0.2.1' },
  log: 'qq: 收到 私聊消息 key=c2c:openid-from-log len=5\n',
}) === 'openid-from-log')
check('日志取最后一次出现的私聊 key', recoverFrom({
  log: 'key=c2c:older\nkey=c2c:newer\n',
}) === 'newer')
check('群聊 group_openid 不会被当成用户身份', recoverFrom({
  log: 'key=c2c:user-x\nqq: 收到 群消息 key=group:group-y\n',
}) === 'user-x')
check('两者都没有时返回 null', recoverFrom({ status: { version: '0.2.1' } }) === null)
check('目录为空时返回 null 而不是抛错', recoverFrom({}) === null)

console.log('\n[attachmentFileName]')
check('filename 为空时按 content_type 补扩展名', attachmentFileName({ filename: '' }, 'image/png', 0, false) === 'attachment-0.png')
check('filename 缺失时同样兜底', attachmentFileName({}, 'image/jpeg', 2, false) === 'attachment-2.jpg')
check('已有扩展名不改写', attachmentFileName({ filename: 'report.xlsx' }, 'file', 0, false) === 'report.xlsx')
check('QQ 传 content_type 当文件名也能补出扩展名', attachmentFileName({}, 'image/png', 0, false).endsWith('.png'))
check('中文文件名被保留', attachmentFileName({ filename: '每日报送.xlsx' }, 'file', 0, false) === '每日报送.xlsx')
check('语音统一落成 .wav', attachmentFileName({}, 'voice', 1, true) === 'attachment-1.wav')
check('未知类型不强加扩展名', attachmentFileName({}, '', 3, false) === 'attachment-3')
check('路径分隔符被抹掉', !attachmentFileName({ filename: '../../etc/passwd' }, 'file', 0, false).includes('/'))
check('超长文件名被截断', attachmentFileName({ filename: 'x'.repeat(200) }, 'file', 0, false).length <= 60)

console.log('\n[collectAttachments]')
check('读顶层 attachments', collectAttachments({ attachments: [{ url: 'a' }] }).length === 1)
check('读引用消息里嵌套的 attachments', collectAttachments({
  content: '看这个',
  msg_elements: [{ content: '旧的', attachments: [{ url: 'nested' }] }],
}).length === 1)
check('顶层与嵌套同时存在时都收', collectAttachments({
  attachments: [{ url: 'top' }],
  msg_elements: [{ attachments: [{ url: 'inner' }] }],
}).length === 2)
check('递归更深的 msg_elements', collectAttachments({
  msg_elements: [{ msg_elements: [{ attachments: [{ url: 'deep' }] }] }],
}).length === 1)
check('没有附件时返回空数组', collectAttachments({ content: '纯文本' }).length === 0)
check('null / 非法输入不抛错', collectAttachments(null).length === 0 && collectAttachments({ attachments: 'x' }).length === 0)

console.log('\n[quotedTextOf]')
check('取出引用正文', quotedTextOf({ msg_elements: [{ content: '上周的报表' }] }) === '上周的报表')
check('多条引用拼接', quotedTextOf({ msg_elements: [{ content: 'a' }, { content: 'b' }] }) === 'a / b')
check('没有引用时返回空串', quotedTextOf({ content: '你好' }) === '' && quotedTextOf(undefined) === '')
check('空正文被忽略', quotedTextOf({ msg_elements: [{ content: '   ' }, { content: 'x' }] }) === 'x')

console.log('\n[attachmentPromptLines]')
check('无附件时不产生任何提示行', attachmentPromptLines([]).length === 0)
check('列出落盘路径与类型', (() => {
  const lines = attachmentPromptLines([{ path: 'C:\\a\\x.png', type: 'image/png' }])
  return lines.some((line) => line.includes('C:\\a\\x.png') && line.includes('image/png'))
})())
check('图片会要求先用 read_image 查看', attachmentPromptLines([{ path: 'p.png', type: 'image/png' }])
  .some((line) => line.includes('read_image')))
check('非图片不要求 read_image', !attachmentPromptLines([{ path: 'p.xlsx', type: 'file' }])
  .some((line) => line.includes('read_image')))
check('语音带上 ASR 转写', attachmentPromptLines([{ path: 'v.wav', type: 'voice', transcript: '明天九点开会' }])
  .some((line) => line.includes('明天九点开会')))
check('没有转写时不加空行', !attachmentPromptLines([{ path: 'v.wav', type: 'voice' }])
  .some((line) => line.includes('语音转写')))

console.log('\n[parseOutgoingFiles]')
check('没有指令行时原样返回', (() => {
  const r = parseOutgoingFiles('你好，这是回复')
  return r.text === '你好，这是回复' && r.files.length === 0
})())
check('摘出 [[send:路径]] 并移除该行', (() => {
  const r = parseOutgoingFiles('文件给你：\n[[send:D:\\out\\报表.xlsx]]')
  return r.files.length === 1 && r.files[0] === 'D:\\out\\报表.xlsx' && !r.text.includes('send')
})())
check('正文与附件顺序无关', (() => {
  const r = parseOutgoingFiles('[[send:C:\\a.png]]\n图在上面')
  return r.text === '图在上面' && r.files[0] === 'C:\\a.png'
})())
check('多个附件按出现顺序', (() => {
  const r = parseOutgoingFiles('[[send:C:\\a.png]]\n看看\n[[send:C:\\b.pdf]]')
  return r.files.length === 2 && r.files[0] === 'C:\\a.png' && r.files[1] === 'C:\\b.pdf'
})())
check('容忍空格与大小写', (() => {
  const r = parseOutgoingFiles('[[ SEND : C:\\a.png ]]')
  return r.files.length === 1 && r.files[0] === 'C:\\a.png'
})())
check('剥掉路径外的引号', (() => {
  const r = parseOutgoingFiles('[[send:"C:\\有 空格\\a.png"]]')
  return r.files[0] === 'C:\\有 空格\\a.png'
})())
check('内联出现不误判（必须独占一行）', (() => {
  const r = parseOutgoingFiles('说明见 [[send:C:\\a.png]] 这一行')
  return r.files.length === 0 && r.text.includes('send')
})())
check('空路径不产生附件', parseOutgoingFiles('[[send:   ]]').files.length === 0)
check('指令行留下的空行被压缩', !parseOutgoingFiles('A\n[[send:C:\\a.png]]\nB').text.includes('\n\n'))
check('null 不抛错', (() => {
  const r = parseOutgoingFiles(null)
  return r.text === '' && r.files.length === 0
})())

console.log('\n[fileTypeFor]')
check('.png 判为图片', fileTypeFor('a.png') === 1)
check('.jpg / .jpeg 判为图片', fileTypeFor('a.jpg') === 1 && fileTypeFor('a.JPEG') === 1)
check('.gif / .webp / .bmp 也算图片', fileTypeFor('a.gif') === 1 && fileTypeFor('a.webp') === 1 && fileTypeFor('a.bmp') === 1)
check('.mp4 判为视频', fileTypeFor('a.mp4') === 2)
check('.silk 判为语音', fileTypeFor('a.silk') === 3)
check('其余一律当文件', fileTypeFor('a.xlsx') === 4 && fileTypeFor('a.zip') === 4)
check('没有扩展名当文件', fileTypeFor('README') === 4)

console.log('\n[normalizePrepare]')
const PREPARE_DOC = {
  upload_id: 'up-doc',
  block_size: '10485760',
  parts: [
    { index: 0, presigned_url: 'https://cos/p0', block_size: '10485760' },
    { index: 1, presigned_url: 'https://cos/p1', block_size: '10485760' },
  ],
}
// Hermes 按 (part_index - 1) * block_size 算偏移，即当成 1 开始；官方文档写从 0 开始。
// 两种基准都必须能正确排序，偏移由累计块大小决定，不押注基准。
const PREPARE_ONE_BASED = {
  data: {
    upload_id: 'up-one',
    parts: [
      { part_index: 2, url: 'https://cos/p1', block_size: 10485760 },
      { part_index: 1, url: 'https://cos/p0', block_size: 10485760 },
    ],
  },
}
check('文档形状（index 从 0 开始）', (() => {
  const p = normalizePrepare(PREPARE_DOC)
  return p.uploadId === 'up-doc' && p.parts.length === 2 && p.parts[0].url === 'https://cos/p0'
})())
check('变体形状（part_index 从 1 开始 + data 包装 + url 字段）', (() => {
  const p = normalizePrepare(PREPARE_ONE_BASED)
  return p.uploadId === 'up-one' && p.parts.length === 2 &&
    p.parts[0].url === 'https://cos/p0' && p.parts[1].url === 'https://cos/p1'
})())
check('乱序的分片被按序号排好', (() => {
  const p = normalizePrepare(PREPARE_ONE_BASED)
  return p.parts[0].index === 1 && p.parts[1].index === 2
})())
check('part_list 变体也认', normalizePrepare({ upload_id: 'u', part_list: [{ index: 0, presigned_url: 'https://cos/x', block_size: 1 }] }).parts.length === 1)
check('序号原样保留（回传给 part_finish 不换基准）', normalizePrepare(PREPARE_ONE_BASED).parts.map((p) => p.index).join(',') === '1,2')
check('缺 upload_id 时返回空串（由调用方报错）', normalizePrepare({ parts: [{ index: 0, presigned_url: 'u' }] }).uploadId === '')
check('没有分片时返回空数组', normalizePrepare({ upload_id: 'u' }).parts.length === 0)
check('null / 垃圾输入不抛错', (() => {
  const a = normalizePrepare(null)
  const b = normalizePrepare({ parts: 'x', part_list: null })
  return a.parts.length === 0 && a.uploadId === '' && b.parts.length === 0
})())
check('服务端下发的 retry_timeout 被采纳', normalizePrepare({ upload_id: 'u', upload_config: { retry_timeout: 300 } }).retryTimeoutMs === 300_000)
check('retry_timeout 缺省 120s、封顶 600s', (() => {
  const d = normalizePrepare({ upload_id: 'u' })
  const big = normalizePrepare({ upload_id: 'u', retry_timeout: 99999 })
  return d.retryTimeoutMs === 120_000 && big.retryTimeoutMs === 600_000
})())

console.log('\n[被动回复上限]')
check('单聊 4 条 / 60 分钟', PROTOCOL.passiveReply.c2c.maxReplies === 4 && PROTOCOL.passiveReply.c2c.windowMs === 3600000)
check('群聊 5 条 / 5 分钟', PROTOCOL.passiveReply.group.maxReplies === 5 && PROTOCOL.passiveReply.group.windowMs === 300000)
check('去重窗口取两者更长', PROTOCOL.dedupeWindowMs === PROTOCOL.passiveReply.c2c.windowMs)
check('md5_10m 前缀取官方值', PROTOCOL.md5PrefixBytes === 10002432)
check('上传硬限制 200MB', PROTOCOL.maxUploadBytes === 200 * 1024 * 1024)

console.log('\n[formatSessionList]')
check('有备注时显示备注而不是裸 id', (() => {
  const text = formatSessionList(
    [{ sessionId: 'aaaa1111-2222', cwd: 'C:\\w' }],
    new Map([['aaaa1111-2222', '重保日报']]),
    null,
  )
  return text.includes('重保日报') && !text.includes('aaaa1111  ') && text.includes('[aaaa1111]')
})())
check('没有备注时退回 id + 工作目录', (() => {
  const text = formatSessionList([{ sessionId: 'bbbb2222-3333', cwd: 'C:\\w' }], new Map(), null)
  return text.includes('bbbb2222') && text.includes('C:\\w')
})())
check('当前会话被标出来', formatSessionList(
  [{ sessionId: 'aaaa1111', cwd: 'C:\\w' }], new Map(), 'aaaa1111',
).includes('← 当前'))
check('非当前会话不标', !formatSessionList(
  [{ sessionId: 'aaaa1111', cwd: 'C:\\w' }], new Map(), 'zzzz9999',
).includes('← 当前'))
check('编号从 1 开始且连续', (() => {
  const list = [0, 1, 2].map((i) => ({ sessionId: `id${i}`, cwd: 'C:\\w' }))
  const text = formatSessionList(list, new Map(), null)
  return text.includes('  1. ') && text.includes('  2. ') && text.includes('  3. ')
})())
check('完全没有备注时给出说明', formatSessionList(
  [{ sessionId: 'aaaa1111', cwd: 'C:\\w' }], new Map(), null,
).includes('还没有备注'))
check('有备注时不加说明', !formatSessionList(
  [{ sessionId: 'aaaa1111', cwd: 'C:\\w' }], new Map([['aaaa1111', 'x']]), null,
).includes('还没有备注'))
check('坏数据不抛错', (() => {
  const text = formatSessionList([{ sessionId: 'abc' }, {}], new Map(), null)
  return typeof text === 'string' && text.includes('abc')
})())

console.log('\n[VERSION]')
check('网关版本取自 package.json', VERSION === JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
check('不再写死已经漂移的旧版本号', VERSION !== '0.3.2' && /^\d+\.\d+\.\d+/.test(VERSION))

console.log('\n[acp 配置同步]')
/** 一份典型的源 profile 补丁：3 个要搬运的条目 + 1 个不该搬的。 */
const SOURCE_PATCH = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      yyapi-1:',
  '        apiKeyEnv: YYAPI_1_API_KEY',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: yyapi-1',
  '    model: deepseek-flash',
  '    reasoningEffort: high',
  '- id: permission',
  '  name: "@deepseek-ai/dsh-permission-presets"',
  '  config:',
  '    defaultPreset: danger-full-access',
  '- id: qqbot',
  '  name: "@lyw/dsh-qqbot"',
  '  config:',
  '    appId: "1"',
  '',
].join('\n')

/** 静默 logger：同步逻辑的日志不是断言对象。 */
const SILENT = { info() {}, warn() {} }

/** 造一个「有内容的 desktop profile + 已初始化的空 acp profile」的临时 $DSH_HOME。 */
function makeSyncFixture({ initAcp = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'qqbot-sync-'))
  const sourceDir = join(home, 'profiles', 'desktop')
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'cordis.patch.yml'), SOURCE_PATCH)
  if (initAcp) {
    const acpDir = join(home, 'profiles', 'acp')
    mkdirSync(acpDir, { recursive: true })
    writeFileSync(join(acpDir, 'package.json'), '{"name":"dsh-profile-acp"}\n')
  }
  return { home, sourceDir, acpPatch: join(home, 'profiles', 'acp', 'cordis.patch.yml') }
}

/** 取出 patch 文件里的顶层 `- id:` 列表。 */
function topLevelIds(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^- id:/.test(line))
    .map((line) => line.replace(/^- id:\s*/, '').trim())
}

/** 在临时 home 上跑两次同步（第二次用来验证幂等），跑完清干净。 */
function runSync({ initAcp = true, passContext = true } = {}) {
  const fixture = makeSyncFixture({ initAcp })
  const ctx = passContext ? { name: 'desktop', dir: fixture.sourceDir } : undefined
  try {
    const first = syncAcpProviderConfig(fixture.home, SILENT, ctx)
    const second = syncAcpProviderConfig(fixture.home, SILENT, ctx)
    return {
      first,
      second,
      text: existsSync(fixture.acpPatch) ? readFileSync(fixture.acpPatch, 'utf8') : null,
    }
  } finally {
    rmSync(fixture.home, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** 在临时 fixture 上跑一次自定义断言，跑完清干净。 */
function withFixture(fn, options) {
  const fixture = makeSyncFixture(options)
  try {
    return fn(fixture)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** 临时清掉两个环境变量后执行，结束后恢复。 */
function withoutProfileEnv(fn) {
  const savedDir = process.env.DSH_PROFILE_DIR
  const savedProfile = process.env.DSH_PROFILE
  delete process.env.DSH_PROFILE_DIR
  delete process.env.DSH_PROFILE
  try {
    return fn()
  } finally {
    if (savedDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = savedDir
    if (savedProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = savedProfile
  }
}

check('acpDefaultBlock 由 agent-default-model 推出 provider/model', (() => {
  const block = acpDefaultBlock([
    '- id: agent-default-model\n  config:\n    provider: yyapi-1\n    model: deepseek-flash\n    reasoningEffort: high',
  ])
  return block.startsWith('- id: acp') && block.includes('provider: yyapi-1') && block.includes('model: deepseek-flash')
})())
check('acpDefaultBlock 声明 acp 插件名', (() => {
  const block = acpDefaultBlock(['- id: agent-default-model\n  config:\n    provider: a\n    model: b'])
  return block.includes('name: "@deepseek-ai/dsh-acp"')
})())
check('acpDefaultBlock 不带 reasoningEffort（dsh-acp 没这个字段）', (() => {
  const block = acpDefaultBlock([
    '- id: agent-default-model\n  config:\n    provider: a\n    model: b\n    reasoningEffort: high',
  ])
  return !block.includes('reasoningEffort')
})())
check('没有 agent-default-model 时 acpDefaultBlock 返回 undefined', acpDefaultBlock([
  '- id: permission\n  config:\n    defaultPreset: x',
]) === undefined)
check('条目里没有 provider/model 时返回 undefined', acpDefaultBlock(['- id: agent-default-model\n  config: {}']) === undefined)
check('空条目列表返回 undefined', acpDefaultBlock([]) === undefined)

check('profileContext 在时真的写入 acp profile（回归：以前读 process.env 永不写）', (() => {
  const r = runSync()
  return r.first === true && r.text !== null
})())
check('写出 3 个复制条目 + 1 个 acp 覆盖块，顺序稳定', (() => {
  const r = runSync()
  return JSON.stringify(topLevelIds(r.text)) ===
    JSON.stringify(['llm-pi-ai', 'agent-default-model', 'permission', 'acp'])
})())
check('不搬运无关条目（qqbot 自己不会被复制进 acp）', !runSync().text.includes('- id: qqbot'))
check('写出后第二次同步返回 false（幂等，不反复写盘）', runSync().second === false)
check('文件头保留「自动同步」标记（说明是生成物）', runSync().text.includes('# 由 @lyw/dsh-qqbot 自动同步'))
check('无 profileContext 且环境变量未注入时不写（即修复前的行为）', withoutProfileEnv(() => {
  const r = runSync({ passContext: false })
  return r.first === false && r.second === false && r.text === null
}))
check('process.env 回退仍然可用（外部注入了这两个变量的部署）', withoutProfileEnv(() => withFixture((f) => {
  process.env.DSH_PROFILE_DIR = f.sourceDir
  process.env.DSH_PROFILE = 'desktop'
  return syncAcpProviderConfig(f.home, SILENT, undefined) === true
})))
check('源 profile 就是 acp 时不动（没有上游可抄）', withFixture(
  (f) => syncAcpProviderConfig(f.home, SILENT, { name: 'acp', dir: f.sourceDir }) === false,
))
check('acp profile 未初始化时不写（不造启动不了的半成品 profile）', (() => {
  const r = runSync({ initAcp: false })
  return r.first === false && r.text === null
})())
check('源 profile 没有 cordis.patch.yml 时不写', withFixture((f) => {
  rmSync(join(f.sourceDir, 'cordis.patch.yml'), { force: true })
  return syncAcpProviderConfig(f.home, SILENT, { name: 'desktop', dir: f.sourceDir }) === false
}))
check('源 profile 只有无关条目时不写', withFixture((f) => {
  writeFileSync(join(f.sourceDir, 'cordis.patch.yml'), '- id: qqbot\n  config:\n    appId: "1"\n')
  return syncAcpProviderConfig(f.home, SILENT, { name: 'desktop', dir: f.sourceDir }) === false
}))
check('写盘失败时不抛错，只返回 false', withFixture((f) => {
  // 把 acp 的 patch 位置占成目录，writeFileSync 必然失败
  mkdirSync(join(f.home, 'profiles', 'acp', 'cordis.patch.yml'), { recursive: true })
  return syncAcpProviderConfig(f.home, SILENT, { name: 'desktop', dir: f.sourceDir }) === false
}))

console.log('\n[outbox：文件协议]')
/** 造一个临时 stateDir 跑一段 outbox 场景，跑完清干净。 */
function withOutbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-outbox-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

check('目录挂在 stateDir 下的 outbox 子目录', outboxDir('C:\\s').endsWith(join('s', 'outbox')))
check('请求 id 是文件名安全的', /^[a-z0-9]+-[0-9a-f]+$/.test(newRequestId()))
check('连续两轮的请求 id 不同', newRequestId() !== newRequestId())
check('idOfArtifact 认请求文件', idOfArtifact('req-abc-123.json') === 'abc-123')
check('idOfArtifact 认已认领文件', idOfArtifact('req-abc-123.json.claimed') === 'abc-123')
check('idOfArtifact 拒绝结果文件（前缀不同）', idOfArtifact('res-abc-123.json') === null)
check('idOfArtifact 拒绝无关文件', idOfArtifact('gateway.log') === null && idOfArtifact(null) === null)

check('写请求后再认领能拿到同一条', withOutbox((dir) => {
  const { id } = writePushRequest(dir, { kind: 'c2c', target: 'user-a', text: '你好' })
  const claimed = claimPushRequests(dir)
  return claimed.length === 1 && claimed[0].id === id && claimed[0].request.text === '你好'
}))

check('默认 kind 是 c2c、files 是空数组', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  const request = claimPushRequests(dir)[0].request
  return request.kind === 'c2c' && Array.isArray(request.files) && request.files.length === 0
}))

check('同一个请求只会被认领一次（rename 互斥）', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  const first = claimPushRequests(dir)
  const second = claimPushRequests(dir)
  return first.length === 1 && second.length === 0
}))

check('多条请求一次全部认领', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: '1' })
  writePushRequest(dir, { target: 'user-b', text: '2' })
  writePushRequest(dir, { target: 'user-c', text: '3' })
  return claimPushRequests(dir).length === 3
}))

check('内容损坏的请求被丢弃而不是反复重试', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  // 认领后把内容写坏，模拟落盘被截断
  writeFileSync(claimed.path, '{ 坏掉的 JSON')
  return claimPushRequests(dir).length === 0
}))

check('目录不存在时认领返回空数组而不是抛错', claimPushRequests(join(tmpdir(), 'qqbot-definitely-missing-dir')).length === 0)

check('结果可回写并按 id 读回', withOutbox((dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: true, segments: 1, files: 0, durationMs: 42 })
  const result = readPushResult(dir, id)
  return result.ok === true && result.segments === 1 && result.durationMs === 42
}))

check('回写结果会删掉已认领的请求文件', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: true })
  return !existsSync(claimed.path) && claimPushRequests(dir).length === 0
}))

check('失败结果保留 error 与业务码', withOutbox((dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: false, error: '主动消息额度已用完', code: '40034128' })
  const result = readPushResult(dir, id)
  return result.ok === false && result.error.includes('额度') && result.code === '40034128'
}))

check('未写出的结果读回 null', withOutbox((dir) => readPushResult(dir, 'nothing-here') === null))
check('clearPushResult 删掉结果且可重复调用', withOutbox((dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: true })
  clearPushResult(dir, id)
  clearPushResult(dir, id)
  return readPushResult(dir, id) === null
}))

check('快照分别统计待处理/已认领/结果', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: '1' })
  writePushRequest(dir, { target: 'user-b', text: '2' })
  const claimed = claimPushRequests(dir)
  settlePushRequest(dir, claimed[0], { ok: true })
  const snapshot = outboxSnapshot(dir)
  return snapshot.claimed === 1 && snapshot.results === 1 && snapshot.pending === 0
}))
check('空目录快照全为 0', withOutbox((dir) => {
  const s = outboxSnapshot(dir)
  return s.pending === 0 && s.claimed === 0 && s.results === 0
}))

console.log('\n[outbox：清理]')
check('ttl 内的文件不动', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  return pruneOutbox(dir) === 0 && outboxSnapshot(dir).pending === 1
}))
check('过期的待处理请求被清掉', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  const removed = pruneOutbox(dir, { now: Date.now() + 25 * 60 * 60 * 1000 })
  return removed === 1 && outboxSnapshot(dir).pending === 0
}))
check('过期的结果文件被清掉', withOutbox((dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: true })
  pruneOutbox(dir, { now: Date.now() + 25 * 60 * 60 * 1000 })
  return readPushResult(dir, id) === null
}))
check('已认领但过期的请求也会被清（不补发）', withOutbox((dir) => {
  writePushRequest(dir, { target: 'user-a', text: 'x' })
  claimPushRequests(dir)
  const removed = pruneOutbox(dir, { now: Date.now() + 25 * 60 * 60 * 1000 })
  return removed === 1 && outboxSnapshot(dir).claimed === 0
}))
check('清理不存在的目录返回 0', pruneOutbox(join(tmpdir(), 'qqbot-definitely-missing-dir-2')) === 0)

console.log('\n[outbox：请求形状校验]')
check('纯文本合法', validateRequestShape({ kind: 'c2c', target: 'user-a', text: '你好' }).length === 0)
check('只带附件也合法', validateRequestShape({ kind: 'c2c', target: 'user-a', files: ['C:\\a.xlsx'] }).length === 0)
check('没有正文也没有附件被拒', validateRequestShape({ kind: 'c2c', target: 'user-a' }).length === 1)
check('空白正文且无附件被拒', validateRequestShape({ text: '   ', files: [] }).length === 1)
check('非法的 kind 被拒', validateRequestShape({ kind: 'guild', text: 'x', target: 'a' })[0].includes('kind'))
check('target 含路径分隔符被拒', validateRequestShape({ text: 'x', target: '../etc' }).length === 1)
check('target 含查询串被拒', validateRequestShape({ text: 'x', target: 'a?b=c' }).length === 1)
check('合法字符集的 target 通过', validateRequestShape({ text: 'x', target: 'AbC-123_x' }).length === 0)
check('files 非数组被拒', validateRequestShape({ text: 'x', files: 'a.xlsx' }).length === 1)
check('files 含空串被拒', validateRequestShape({ text: 'x', files: [''] }).length === 1)
check(`附件超过 ${MAX_PUSH_FILES} 个被拒`, validateRequestShape({ text: 'x', files: ['a', 'b', 'c', 'd'] }).length === 1)
check('subject 非字符串被拒', validateRequestShape({ text: 'x', subject: 1 }).length === 1)
check('null 不抛错', validateRequestShape(null).length === 1)

console.log('\n[outbox：目标白名单策略]')
const POLICY_EMPTY = buildPushPolicy({})
check('默认不放开任意目标', POLICY_EMPTY.allowAnyTarget === false)
check('白名单为空时私聊目标被拒', checkPushTarget(POLICY_EMPTY, 'c2c', 'unknown-user').ok === false)
check('白名单为空时给出可操作指引', checkPushTarget(POLICY_EMPTY, 'c2c', 'unknown-user').reason.includes('发一条消息'))
check('群白名单为空时群推送被拒', checkPushTarget(POLICY_EMPTY, 'group', 'group-x').ok === false)
check('群被拒时提示要加 allowGroups', checkPushTarget(POLICY_EMPTY, 'group', 'group-x').reason.includes('allowGroups'))

const POLICY_FILLED = buildPushPolicy({
  allowUsers: ['user-a', 'user-b'],
  allowGroups: ['group-g'],
  lastUserOpenId: 'user-recent',
})
check('白名单内的私聊放行', checkPushTarget(POLICY_FILLED, 'c2c', 'user-a').ok)
check('最近私聊身份也放行', checkPushTarget(POLICY_FILLED, 'c2c', 'user-recent').ok)
check('白名单外的私聊被拒', checkPushTarget(POLICY_FILLED, 'c2c', 'user-z').ok === false)
check('被拒原因里点名该加哪个 openid', checkPushTarget(POLICY_FILLED, 'c2c', 'user-z').reason.includes('user-z'))
check('白名单内的群放行', checkPushTarget(POLICY_FILLED, 'group', 'group-g').ok)
check('白名单外的群被拒', checkPushTarget(POLICY_FILLED, 'group', 'group-z').ok === false)
check('私聊白名单不适用于群（两个命名空间独立）', checkPushTarget(POLICY_FILLED, 'group', 'user-a').ok === false)
check('群白名单不适用于私聊', checkPushTarget(POLICY_FILLED, 'c2c', 'group-g').ok === false)

check('显式配置的默认推送目标被放行（否则「默认目标」会被自己拦下）', (() => {
  const policy = buildPushPolicy({ defaultTarget: 'user-configured' })
  return checkPushTarget(policy, 'c2c', 'user-configured').ok === true
})())
check('默认推送目标不会连带放行别的目标', (() => {
  const policy = buildPushPolicy({ defaultTarget: 'user-configured' })
  return checkPushTarget(policy, 'c2c', 'someone-else').ok === false
})())
check('默认推送目标不影响群推送（群仍默认关闭）', (() => {
  const policy = buildPushPolicy({ defaultTarget: 'user-configured' })
  return checkPushTarget(policy, 'group', 'user-configured').ok === false
})())

const POLICY_OPEN = buildPushPolicy({ allowAnyTarget: true })
check('打开开关后任意合法私聊目标放行', checkPushTarget(POLICY_OPEN, 'c2c', 'whoever').ok)
check('打开开关后任意合法群放行', checkPushTarget(POLICY_OPEN, 'group', 'whatever').ok)
check('开关不绕过字符集校验（防 URL 注入）', checkPushTarget(POLICY_OPEN, 'c2c', '../etc').ok === false)
check('开关不放行非法 kind', checkPushTarget(POLICY_OPEN, 'guild', 'x').ok === false)
check('空 target 一律被拒', checkPushTarget(POLICY_OPEN, 'c2c', '').ok === false)

console.log('\n[outbox：等待结果]')
check('结果已存在时立即返回并清掉结果文件', await (async () => withOutbox(async (dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  settlePushRequest(dir, claimed, { ok: true, segments: 1 })
  const result = await waitForPushResult(dir, id, { timeoutMs: 1000, intervalMs: 10 })
  return result.ok === true && result.segments === 1 && readPushResult(dir, id) === null
}))())
check('稍后才写出的结果会被等到', await (async () => withOutbox(async (dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const [claimed] = claimPushRequests(dir)
  setTimeout(() => settlePushRequest(dir, claimed, { ok: true, segments: 2 }), 120)
  const result = await waitForPushResult(dir, id, { timeoutMs: 3000, intervalMs: 20 })
  return result.ok === true && result.segments === 2
}))())
check('超时返回 ok:false 且说明原因（不抛错）', await (async () => withOutbox(async (dir) => {
  const { id } = writePushRequest(dir, { target: 'user-a', text: 'x' })
  const result = await waitForPushResult(dir, id, { timeoutMs: 150, intervalMs: 20 })
  return result.ok === false && result.error.includes('超时')
}))())

console.log('\n[/push-test 接口校验]')
/**
 * 回归：/push-test 的空内容校验曾写成 `throw new Error(...)`，于是接口回 HTTP 500，
 * 前端只能显示「HTTP 500」，用户看不出「只是没填内容」。
 * 这里对 handleApi 打桩，验证校验失败必须是 200 + ok:false + 可读原因。
 */
{
  const routes = []
  const webServer = { port: 0, register: (route) => { routes.push(route); return () => {} } }
  /** 注入后的子上下文：自带 webServer 与 effect（真实 cordis 也是这么给的）。 */
  const makeCtx = () => ({
    logger: { info() {}, warn() {}, error() {} },
    // 插件用的是 ctx.webServer 属性（不是 ctx.get），两者都提供以免与真实用法脱节。
    webServer,
    get: (name) => (name === 'webServer' ? webServer : undefined),
    on() {},
    // 路由是在 effect 回调里注册的，桩必须真的把回调跑掉。
    effect(callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
    inject(names, callback) { if (names.includes('webServer')) callback(makeCtx()) },
  })
  const fakeCtx = makeCtx()
  const hostMod = await import('../lib/index.js')
  // 用最小配置挂载：enabled=false 不会去 spawn 网关，仅注册路由。
  hostMod.apply(fakeCtx, { enabled: false, appId: '', appSecret: '', pushMaxChars: 3000, pushAllowAnyTarget: false, pushDefaultTarget: '' })

  const apiRoute = routes.find((route) => route.kind === 'prefix')
  check('插件注册了配置页 API 路由', apiRoute !== undefined)

  /** 造一个最小 req/res，跑一次 API 调用。 */
  const callApi = async (path, body) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    /**
     * 必须用 `[Symbol.asyncIterator]()` 返回一个**全新**的迭代器：
     * `readJsonBody` 用 `for await (const chunk of req)` 消费，若直接给生成器函数体，
     * 每个消费者会共享/耗尽同一个生成器，导致 body 收不到（表现为接口无响应）。
     */
    const req = {
      url: path,
      method: body === undefined ? 'GET' : 'POST',
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          async next() {
            if (data === null || sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: data }
          },
        }
      },
    }
    let status = null
    let payload = ''
    let settle = null
    // 路由注册的是 `(req, res) => void handleApi(...)`：handler 的返回值是 undefined，
    // 响应在它自己那条 Promise 上异步完成。所以要等 res.end，而不是等 handler 返回。
    const done = new Promise((resolve) => { settle = resolve })
    const res = {
      writeHead: (code) => { status = code },
      end: (text) => { payload = text ?? ''; settle() },
    }
    await apiRoute.handler(req, res)
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))])
    let parsed = null
    try { parsed = JSON.parse(payload) } catch { parsed = payload }
    return { status, body: parsed }
  }

  const empty = await callApi('/plugins/qqbot/api/push-test', { text: '   ' })
  check('空内容回 200（不是 500）', empty.status === 200, `status=${empty.status}`)
  check('空内容回 ok:false', empty.body?.ok === false, JSON.stringify(empty.body))
  check('空内容给出可读原因', String(empty.body?.error ?? '').includes('请输入'), String(empty.body?.error))

  const wrongMethod = await callApi('/plugins/qqbot/api/push-test')
  check('方法不匹配回 404 而不是抛错', wrongMethod.status === 404, `status=${wrongMethod.status}`)
}

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
