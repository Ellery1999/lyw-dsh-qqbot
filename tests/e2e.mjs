/**
 * 端到端测试：模拟 QQ 开放平台 → 网关 → ACP(`dsh --profile acp`) → 回复发回 QQ。
 *
 * 用法：node tests/e2e.mjs            （需要 dsh 在 PATH 上）
 *      node tests/e2e.mjs --skip-llm （跳过需要真实模型的对话用例）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockQq } from './mock-qq.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATEWAY = join(HERE, '..', 'lib', 'gateway.mjs')
const SKIP_LLM = process.argv.includes('--skip-llm')

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}${condition || detail === '' ? '' : ` — ${detail}`}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'qqbot-e2e-state-'))
  const workdir = mkdtempSync(join(tmpdir(), 'qqbot-e2e-work-'))
  const mock = await startMockQq()
  console.log(`mock QQ 平台已启动：${mock.baseUrl}`)

  const child = spawn(process.execPath, [GATEWAY], {
    cwd: dirname(GATEWAY),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_QQBOT_APP_ID: 'mock-app-id',
      DSH_QQBOT_APP_SECRET: 'mock-app-secret',
      DSH_QQBOT_TOKEN_URL: mock.tokenUrl,
      DSH_QQBOT_API_BASE: mock.baseUrl,
      DSH_QQBOT_STATE_DIR: stateDir,
      DSH_QQBOT_WORKDIR: workdir,
      DSH_QQBOT_ACP_COMMAND: 'dsh --profile acp',
      DSH_QQBOT_EXIT_ON_STDIN_END: '1',
      DSH_QQBOT_PROGRESS_MS: '8000',
      ...(process.env.E2E_ALLOW_USERS ? { DSH_QQBOT_ALLOW_USERS: process.env.E2E_ALLOW_USERS } : {}),
    },
  })

  const logs = []
  const collect = (chunk) => {
    const text = chunk.toString('utf8')
    logs.push(text)
    if (process.env.E2E_VERBOSE === '1') process.stdout.write(`  [gw] ${text}`)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  let failed = 0
  try {
    console.log('\n[1] 握手与鉴权')
    await mock.waitFor(() => mock.connected, { timeoutMs: 60_000, label: 'WebSocket 连接' })
    await mock.waitFor(() => mock.identified, { timeoutMs: 30_000, label: 'identify' })
    const tokenRequest = mock.requests.find((r) => r.path === '/app/getAppAccessToken')
    check('向 token 端点请求了 access_token', tokenRequest !== undefined)
    check(
      '请求体使用 camelCase appId/clientSecret',
      tokenRequest !== undefined && tokenRequest.body?.appId === 'mock-app-id' && tokenRequest.body?.clientSecret === 'mock-app-secret',
      JSON.stringify(tokenRequest?.body),
    )
    check('identify 已发出（op 2）', mock.identified)
    check('README/状态文件已生成', (() => {
      try {
        return JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8')).connection?.connected === true
      } catch {
        return false
      }
    })())

    console.log('\n[2] 命令：/help（不经过模型）')
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-help-1',
      content: '/help',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-A' },
    })
    const helpReply = await mock.waitFor(() => mock.sent.find((m) => m.target === 'user-openid-A'), {
      timeoutMs: 20_000,
      label: '/help 回复',
    })
    check('/help 回复包含命令说明', String(helpReply.body?.content ?? '').includes('/new'), helpReply.body?.content?.slice(0, 60))
    check('被动回复带 msg_id', helpReply.body?.msg_id === 'msg-help-1')
    check('msg_seq 从 1 开始递增', helpReply.body?.msg_seq === 1)

    console.log('\n[3] 命令：/whoami')
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-who-1',
      content: '/whoami',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-B' },
    })
    const whoReply = await mock.waitFor(() => mock.sent.find((m) => m.target === 'user-openid-B'), {
      timeoutMs: 20_000,
      label: '/whoami 回复',
    })
    check('/whoami 回显会话标识', String(whoReply.body?.content ?? '').includes('c2c:user-openid-B'), whoReply.body?.content)

    console.log('\n[3.5] 最近私聊 openid 落盘（配置页兜底身份）')
    const statusAfterWho = JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8'))
    check(
      'status.json 记录最近私聊发送者 openid',
      statusAfterWho.lastUserOpenId === 'user-openid-B',
      `lastUserOpenId=${JSON.stringify(statusAfterWho.lastUserOpenId)}`,
    )

    console.log('\n[4] 白名单与去重')
    if (process.env.E2E_ALLOW_USERS) {
      const allowed = mock.sent.length
      mock.emit('C2C_MESSAGE_CREATE', {
        id: 'msg-blocked-1',
        content: '/help',
        timestamp: new Date().toISOString(),
        author: { user_openid: 'user-openid-Z' },
      })
      await sleep(2500)
      check('白名单外的 openid 被忽略', mock.sent.length === allowed, `sent ${allowed} -> ${mock.sent.length}`)
      check('白名单内的 openid 仍正常（见用例 2/3）', allowed > 0)
    } else {
      check('未配置白名单时全部放行（非安全默认，需自行收紧）', true)
    }
    const before = mock.sent.length
    // 同一条消息重复推送（QQ 会重投）应被去重
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-help-1',
      content: '/help',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-A' },
    })
    await sleep(1500)
    check('重复 message id 被忽略', mock.sent.length === before, `sent ${before} -> ${mock.sent.length}`)

    console.log('\n[4.5] 入站附件：下载到本地（不经过模型）')
    const attachDir = join(stateDir, 'attachments')
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-attach-1',
      content: '看看这张图',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-A' },
      // 真机上 QQ 的 filename 常为空，只给 content_type —— 扩展名要靠它兜底。
      attachments: [
        { url: `${mock.baseUrl}/attachment/photo.png`, filename: '', content_type: 'image/png', width: 1, height: 1, size: 68 },
      ],
    })
    const downloaded = await mock.waitFor(() => mock.attachmentDownloads[0], { timeoutMs: 20_000, label: '附件下载' })
    check('附件带 Authorization 头下载', downloaded.authorization === 'QQBot mock-access-token', String(downloaded.authorization))
    const savedFile = await mock.waitFor(
      () => (existsSync(attachDir) ? readdirSync(attachDir).find((name) => name.endsWith('.png')) : undefined),
      { timeoutMs: 20_000, label: '附件落盘' },
    )
    check('图片按 content_type 补出 .png 扩展名', savedFile !== undefined, String(savedFile))
    check('落盘内容为真实 PNG 魔数', (() => {
      try {
        return readFileSync(join(attachDir, savedFile)).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      } catch {
        return false
      }
    })())
    await mock.waitFor(
      () => logs.join('').includes('附件=1'),
      { timeoutMs: 10_000, label: '网关记录附件数' },
    )
    check('网关日志记录到 1 个附件', logs.join('').includes('附件=1'))

    console.log('\n[4.6] 语音转写与引用消息附件')
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-attach-2',
      content: '',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-A' },
      attachments: [
        {
          url: `${mock.baseUrl}/attachment/raw.silk`,
          voice_wav_url: `${mock.baseUrl}/attachment/converted.silk`,
          filename: '',
          content_type: 'voice',
          asr_refer_text: '明天上午九点开会',
        },
      ],
    })
    const voiceDownload = await mock.waitFor(
      () => mock.attachmentDownloads.find((item) => item.name === 'converted.silk'),
      { timeoutMs: 20_000, label: '语音 WAV 下载' },
    )
    check('语音走 voice_wav_url 而不是原始 silk', voiceDownload !== undefined)
    const voiceFile = await mock.waitFor(
      () => (existsSync(attachDir) ? readdirSync(attachDir).find((name) => name.endsWith('.wav')) : undefined),
      { timeoutMs: 20_000, label: '语音落盘' },
    )
    check('语音落盘为 .wav', voiceFile !== undefined, String(voiceFile))

    // 引用消息（message_type=103）：附件嵌套在 msg_elements 里，顶层没有。
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-attach-3',
      content: '这张图里是什么',
      message_type: 103,
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-A' },
      msg_elements: [
        {
          msg_idx: 'REFIDX_x==',
          message_type: 0,
          content: '上周的报表',
          attachments: [
            { url: `${mock.baseUrl}/attachment/nested.png`, filename: '报表.png', content_type: 'image/png' },
          ],
        },
      ],
    })
    const nested = await mock.waitFor(
      () => mock.attachmentDownloads.find((item) => item.name === 'nested.png'),
      { timeoutMs: 20_000, label: '嵌套附件下载' },
    )
    check('引用消息里嵌套的附件也被下载', nested !== undefined)
    const nestedFile = await mock.waitFor(
      () => (existsSync(attachDir) ? readdirSync(attachDir).find((name) => name.includes('报表')) : undefined),
      { timeoutMs: 20_000, label: '嵌套附件落盘' },
    )
    check('中文文件名被保留', nestedFile !== undefined, String(nestedFile))

    console.log('\n[4.7] 出站附件：/send 走分片上传 + msg_type=7')
    const outFile = join(workdir, '出站报表.xlsx')
    writeFileSync(outFile, Buffer.alloc(3 * 1024 * 1024 + 7, 0x41)) // 3MB+，确保切成多个分片
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-send-1',
      content: `/send ${outFile}`,
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-D' },
    })
    const mediaMsg = await mock.waitFor(
      () => mock.sent.find((m) => m.body?.msg_type === 7 && m.target === 'user-openid-D'),
      { timeoutMs: 60_000, intervalMs: 200, label: '富媒体消息' },
    )
    check('发出了 msg_type=7 的富媒体消息', mediaMsg.body?.msg_type === 7)
    check('带 file_info', typeof mediaMsg.body?.media?.file_info === 'string' && mediaMsg.body.media.file_info.length > 0,
      String(mediaMsg.body?.media?.file_info))
    check('富媒体也是被动回复（带 msg_id/msg_seq）', mediaMsg.body?.msg_id === 'msg-send-1' && mediaMsg.body?.msg_seq >= 1)

    const prep = mock.prepared.find((p) => p.body?.file_name === '出站报表.xlsx')
    check('调用了 upload_prepare', prep !== undefined)
    check('file_type=4（xlsx 当文件发）', prep?.body?.file_type === 4, String(prep?.body?.file_type))
    check('报了 file_size', prep?.body?.file_size === String(3 * 1024 * 1024 + 7), String(prep?.body?.file_size))
    check('md5 是 32 位十六进制', /^[0-9a-f]{32}$/.test(String(prep?.body?.md5)), String(prep?.body?.md5))
    check('sha1 是 40 位十六进制', /^[0-9a-f]{40}$/.test(String(prep?.body?.sha1)), String(prep?.body?.sha1))
    check('md5_10m 是 32 位十六进制', /^[0-9a-f]{32}$/.test(String(prep?.body?.md5_10m)), String(prep?.body?.md5_10m))
    check('分片被真正 PUT 上来', mock.uploadedParts.length >= 2, `parts=${mock.uploadedParts.length}`)
    check('分片字节数与文件一致',
      mock.uploadedParts.reduce((sum, part) => sum + part.bytes, 0) === 3 * 1024 * 1024 + 7,
      String(mock.uploadedParts.reduce((sum, part) => sum + part.bytes, 0)))
    check('每个分片都被确认（upload_part_finish）',
      mock.finishedParts.length === mock.uploadedParts.length,
      `finish=${mock.finishedParts.length} put=${mock.uploadedParts.length}`)
    check('带 upload_id 调用了合并接口', mock.merged.some((m) => m.body?.upload_id === 'upload-1'))

    // mock 故意按 1 开始编号分片（官方文档写从 0 开始，Hermes 却按 1 开始算偏移）。
    // 网关必须不依赖基准：各片字节拼起来要和原文件完全一致。
    const expectedHead = Buffer.alloc(3 * 1024 * 1024 + 7, 0x41)
    const reassembled = mock.uploadedParts
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((part) => part.digest)
      .join('')
    check('分片序号按 1 开始时仍拼回原文件',
      mock.uploadedParts.every((part) => expectedHead.subarray(0, part.bytes).toString('hex').startsWith(part.digest.slice(0, 8))),
      JSON.stringify(mock.uploadedParts.map((p) => p.index)))
    check('回传的分片序号与服务端给的一致（不换基准）',
      mock.finishedParts.map((p) => p.part_index).join(',') === mock.uploadedParts.map((p) => p.index).sort((a, b) => a - b).join(','),
      `finish=${JSON.stringify(mock.finishedParts.map((p) => p.part_index))}`)
    check('没有多传或少传分片', mock.uploadedParts.length === 2, `parts=${mock.uploadedParts.length}`)

    console.log('\n[4.8] 出站附件：错误路径要回话，不能静默')
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-send-2',
      content: '/send C:\\definitely\\missing\\nope.xlsx',
      timestamp: new Date().toISOString(),
      author: { user_openid: 'user-openid-D' },
    })
    const failReply = await mock.waitFor(
      () => mock.sent.find((m) => m.body?.msg_id === 'msg-send-2'),
      { timeoutMs: 30_000, intervalMs: 200, label: '失败提示' },
    )
    check('文件不存在时明确报错', String(failReply.body?.content ?? '').includes('发送失败'), String(failReply.body?.content ?? '').slice(0, 90))

    console.log('\n[4.9] 出站附件：被动回复额度按场景区分')
    const seqSeen = []
    for (let i = 0; i < 6; i += 1) {
      mock.emit('C2C_MESSAGE_CREATE', {
        id: `msg-quota-${i}`,
        content: '/help',
        timestamp: new Date().toISOString(),
        author: { user_openid: 'user-openid-Q' },
      })
      await sleep(300)
      seqSeen.push(mock.sent.filter((m) => m.body?.msg_id === `msg-quota-${i}`).map((m) => m.body?.msg_seq))
    }
    check('单聊每条消息的 msg_seq 都从 1 开始', seqSeen.every((seqs) => seqs[0] === 1), JSON.stringify(seqSeen.slice(0, 3)))
    check('单聊单条消息不会超发到第 5 条',
      seqSeen.every((seqs) => seqs.every((seq) => seq <= 4)),
      JSON.stringify(seqSeen.map((s) => s.length)))

    console.log('\n[4.95] 会话备注：/sessions 能认出哪条是什么')
    const labelKey = 'user-openid-L'
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-label-1',
      content: '帮我整理重保日报的告警统计',
      timestamp: new Date().toISOString(),
      author: { user_openid: labelKey },
    })
    const labelStatus = await mock.waitFor(() => {
      try {
        const parsed = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
        // 按 conversationKey 找，不要假设它是第一条 —— 前面的用例也会产生备注。
        const id = parsed.sessions?.[`c2c:${labelKey}`]?.sessionId
        return id !== undefined && parsed.labels?.[id] !== undefined ? { parsed, id } : undefined
      } catch {
        return undefined
      }
    }, { timeoutMs: 30_000, intervalMs: 300, label: '备注落盘' })
    const labelValue = labelStatus.parsed.labels[labelStatus.id]
    check('备注按 sessionId 落盘', typeof labelValue === 'string' && labelValue.includes('重保日报'), String(labelValue))
    check('备注就是用户说的那句话（不是提示词信封）',
      !labelValue.includes('user_openid') && !labelValue.includes('[来自'),
      String(labelValue))
    check('备注绑定到了真实会话', labelStatus.parsed.sessions[`c2c:${labelKey}`].sessionId === labelStatus.id)
    check('命令不会被记成备注', Object.values(labelStatus.parsed.labels).every((label) => !label.startsWith('/')),
      JSON.stringify(Object.values(labelStatus.parsed.labels)))

    // 第二条消息不能覆盖备注：备注代表会话的起点。
    mock.emit('C2C_MESSAGE_CREATE', {
      id: 'msg-label-2',
      content: '换个话题，帮我看看磁盘占用',
      timestamp: new Date().toISOString(),
      author: { user_openid: labelKey },
    })
    await sleep(3000)
    const afterSecond = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8'))
    check('后续消息不覆盖备注', afterSecond.labels[labelStatus.id] === labelValue, String(afterSecond.labels[labelStatus.id]))

    const listReply = await (async () => {
      mock.emit('C2C_MESSAGE_CREATE', {
        id: 'cmd-label-1',
        content: '/sessions',
        timestamp: new Date().toISOString(),
        author: { user_openid: labelKey },
      })
      const message = await mock.waitFor(() => mock.sent.find((m) => m.body?.msg_id === 'cmd-label-1'), {
        timeoutMs: 30_000,
        intervalMs: 200,
        label: '/sessions 回复',
      })
      return { text: String(message.body?.content ?? '') }
    })()
    // `/sessions` 只断言「命令跑通、回了列表头」。列表内容依赖 ACP 的 session/list，
    // 而它只列**已持久化**的会话，刚建出来的那条通常还不在里面 —— 渲染逻辑改由
    // tests/unit.mjs 的 formatSessionList 用例覆盖，这里不押时序。
    check('/sessions 正常回列表', listReply.text.includes('DSH 会话'), listReply.text.slice(0, 120))
    check('/sessions 没有走异常分支', !listReply.text.includes('读取会话列表失败'), listReply.text.slice(0, 120))

    if (!SKIP_LLM) {
      console.log('\n[5] 真实对话：QQ 消息 → ACP → 回复')
      const started = Date.now()
      mock.emit('C2C_MESSAGE_CREATE', {
        id: 'msg-chat-1',
        content: '只回复两个字：收到',
        timestamp: new Date().toISOString(),
        author: { user_openid: 'user-openid-C' },
      })
      const chatReply = await mock.waitFor(() => mock.sent.find((m) => m.target === 'user-openid-C'), {
        timeoutMs: 180_000,
        intervalMs: 500,
        label: '对话回复',
      })
      const content = String(chatReply.body?.content ?? '')
      check('模型回复已发回 QQ', content.length > 0, content.slice(0, 80))
      check('回复内容符合预期', content.includes('收到'), content.slice(0, 80))
      console.log(`      （耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)

      console.log('\n[6] 会话持久化')
      const sessions = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')).sessions
      check('会话映射已落盘', Object.keys(sessions).length > 0, JSON.stringify(sessions))
      check('每个 QQ 会话独立', sessions['c2c:user-openid-C'] !== undefined && sessions['c2c:user-openid-A'] === undefined)

      console.log('\n[7] 群聊 @ 消息')
      mock.emit('GROUP_AT_MESSAGE_CREATE', {
        id: 'msg-group-1',
        content: '只回复两个字：收到',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-G',
        author: { member_openid: 'member-openid-M' },
      })
      const groupReply = await mock.waitFor(
        () => mock.sent.find((m) => m.kind === 'group' && !String(m.body?.content ?? '').startsWith('⏳')),
        {
          timeoutMs: 180_000,
          intervalMs: 500,
          label: '群聊回复',
        },
      )
      check('群聊回复发到 group_openid', groupReply.target === 'group-openid-G')
      check('群聊回复内容符合预期', String(groupReply.body?.content ?? '').includes('收到'))
    } else {
      console.log('\n[5-7] 已按 --skip-llm 跳过模型相关用例')
    }

    console.log('\n[8] 命令：/usage /model /effort /sessions /cd /status')
    const ask = async (content, id, target = 'user-openid-C') => {
      mock.emit('C2C_MESSAGE_CREATE', {
        id,
        content,
        timestamp: new Date().toISOString(),
        author: { user_openid: target },
      })
      const message = await mock.waitFor(() => mock.sent.find((m) => m.body?.msg_id === id), {
        timeoutMs: 30_000,
        intervalMs: 200,
        label: `${content} 回复`,
      })
      return { text: String(message.body?.content ?? ''), raw: message.body }
    }

    const usage = await ask('/usage', 'cmd-usage-1')
    check('/usage 报出上下文用量', usage.text.includes('上下文用量'), usage.text.slice(0, 60))
    if (!SKIP_LLM) check('/usage 含 token 数（本轮已上报）', /tokens/.test(usage.text), usage.text.slice(0, 80))

    const models = await ask('/model', 'cmd-model-1')
    check('/model 列出可选模型', models.text.includes('可选模型'), models.text.slice(0, 60))
    check('/model 标出当前模型', models.text.includes('当前模型'), models.text.slice(0, 60))

    const efforts = await ask('/effort', 'cmd-effort-1')
    check('/effort 列出可选强度', efforts.text.includes('可选值'), efforts.text.slice(0, 60))
    const setEffort = await ask('/effort high', 'cmd-effort-2')
    check('/effort 真正写入 ACP 配置项', setEffort.text.includes('✅'), setEffort.text.slice(0, 80))
    const statusAfter = await ask('/status', 'cmd-status-1')
    check('/status 显示思考强度已变更', /思考强度：high/.test(statusAfter.text), statusAfter.text.slice(0, 220))

    const sessionsList = await ask('/sessions', 'cmd-sessions-1')
    check(
      '/sessions 列出可恢复会话',
      sessionsList.text.includes('DSH 会话') || sessionsList.text.includes('没有可恢复'),
      sessionsList.text.slice(0, 60),
    )

    const cdDir = mkdtempSync(join(tmpdir(), 'qqbot-cd-'))
    const cd = await ask(`/cd ${cdDir}`, 'cmd-cd-1')
    check('/cd 接受新工作目录', cd.text.includes('工作目录已设为'), cd.text.slice(0, 90))
    const statusCd = await ask('/status', 'cmd-status-2')
    check('/status 反映新的工作目录', statusCd.text.includes(cdDir), statusCd.text.slice(0, 220))
    const missing = await ask('/cd C:\\definitely\\missing\\dir', 'cmd-cd-2')
    check('/cd 对不存在的目录报错', missing.text.includes('目录不存在'), missing.text.slice(0, 60))

    console.log('\n[9] 优雅退出：退出请求文件 + 单实例锁释放')
    const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    writeFileSync(join(stateDir, 'shutdown.request'), String(Date.now()))
    const exitedCode = await Promise.race([exitPromise, sleep(8000).then(() => 'timeout')])
    check('网关收到退出请求后自行退出', exitedCode !== 'timeout', `exit=${exitedCode}`)
    check('单实例锁已释放', !existsSync(join(stateDir, 'gateway.lock')))
  } catch (error) {
    failed += 1
    console.log(`\n✗ 测试中断：${error.message}`)
    console.log('--- 网关日志尾部 ---')
    console.log(logs.join('').split('\n').slice(-25).join('\n'))
  } finally {
    child.kill()
    await sleep(1200)
    await mock.close()
    // Windows 上刚被杀掉的子进程可能还占着工作目录，清理尽力而为即可
    for (const dir of [stateDir, workdir]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* 临时目录残留不影响结论 */
      }
    }
  }

  const passed = results.filter((r) => r.ok).length
  failed += results.length - passed
  console.log(`\n===== ${passed}/${results.length} 通过 =====`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
