/**
 * 纯逻辑单测：分片、文本清洗、命令行切分、扫码密文解密、openid 兜底恢复。
 * 用法：node tests/unit.mjs
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
} from '../lib/gateway.mjs'
import { PROTOCOL, fileTypeFor, normalizePrepare } from '../lib/qq-transport.mjs'
import { decryptClientSecret, renderQrSvg } from '../lib/bind.mjs'

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

const passed = results.filter(Boolean).length
console.log(`\n===== ${passed}/${results.length} 通过 =====`)
process.exit(passed === results.length ? 0 : 1)
