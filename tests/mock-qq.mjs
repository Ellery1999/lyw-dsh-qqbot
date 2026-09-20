/**
 * 本地模拟的 QQ 开放平台，用来在没有真实凭据的情况下端到端验证网关。
 *
 * 提供：
 *   POST /app/getAppAccessToken          -> { access_token, expires_in }
 *   GET  /gateway                        -> { url: ws://127.0.0.1:<port>/websocket }
 *   POST /v2/users/:openid/messages      -> 记录发出的 C2C 消息
 *   POST /v2/groups/:gid/messages        -> 记录发出的群消息
 *   WS   /websocket                      -> op10 hello / op2 identify -> READY / op1 -> op11
 *
 * 只用于测试，不属于发布内容。
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** 1×1 合法 PNG，够让下游按魔数认出图片格式。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/** 语音 WAV 端点的占位字节。 */
const WAV_BYTES = Buffer.from('RIFF0000WAVEfmt ', 'utf8')

export async function startMockQq({ heartbeatInterval = 1000 } = {}) {
  const sent = []
  const requests = []
  const attachmentDownloads = []
  /** 富媒体分片上传各阶段的记录，供测试断言。 */
  const prepared = []
  const uploadedParts = []
  const finishedParts = []
  const merged = []
  let socket = null
  let seq = 0
  let identified = false

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // 监听之后才拿得到端口，所以这里现算，不能提到 server 创建之前。
    const mockBaseUrl = `http://127.0.0.1:${server.address().port}`
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      requests.push({ method: req.method, path: url.pathname, body })

      const json = (code, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
        res.end(text)
      }

      if (url.pathname === '/app/getAppAccessToken' && req.method === 'POST') {
        return json(200, { access_token: 'mock-access-token', expires_in: 7200 })
      }
      if (url.pathname === '/gateway' && req.method === 'GET') {
        return json(200, { url: `ws://127.0.0.1:${server.address().port}/websocket` })
      }
      const messageMatch = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/messages$/)
      if (messageMatch !== null && req.method === 'POST') {
        sent.push({ kind: messageMatch[1] === 'users' ? 'c2c' : 'group', target: messageMatch[2], body })
        return json(200, { id: `sent-${sent.length}`, timestamp: Date.now() })
      }
      // 附件下载端点：QQ 的 CDN 同样要求 `Authorization: QQBot <token>`。
      const attachmentMatch = url.pathname.match(/^\/attachment\/(.+)$/)
      if (attachmentMatch !== null && req.method === 'GET') {
        attachmentDownloads.push({ name: attachmentMatch[1], authorization: req.headers.authorization ?? null })
        const bytes = attachmentMatch[1].endsWith('.silk') ? WAV_BYTES : PNG_BYTES
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
        return res.end(bytes)
      }

      // 富媒体上传：预上传 → 分片 PUT（走 server 自身） → 分片完成 → 合并。
      const prepareMatch = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/upload_prepare$/)
      if (prepareMatch !== null && req.method === 'POST') {
        prepared.push({ target: prepareMatch[2], body })
        const total = Number(body?.file_size ?? 0)
        const blockSize = Math.max(1, Math.ceil(total / 2) || 1)
        const count = Math.max(1, Math.ceil(total / blockSize))
        // 故意按 1 开始编号：官方文档写 parts[].index 从 0 开始，而 Hermes 是按
        // (part_index - 1) * block_size 算偏移的（等于当作 1 开始）。线上两种都存在，
        // 用 1 开始能验证网关不依赖任何一种基准。
        return json(200, {
          upload_id: `upload-${prepared.length}`,
          block_size: String(blockSize),
          parts: Array.from({ length: count }, (_, position) => ({
            part_index: position + 1,
            // 指向本服务自己的 PUT 端点，方便断言分片真的被传上来了。
            presigned_url: `${mockBaseUrl}/presigned/${prepareMatch[2]}/${position + 1}`,
            block_size: String(blockSize),
          })),
          upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
        })
      }

      const partMatch = url.pathname.match(/^\/presigned\/[^/]+\/(\d+)$/)
      if (partMatch !== null && req.method === 'PUT') {
        const bytes = Buffer.concat(chunks)
        uploadedParts.push({ index: Number(partMatch[1]), bytes: bytes.length, digest: bytes.toString('hex').slice(0, 16) })
        res.writeHead(200, { 'content-length': '0' })
        return res.end()
      }

      const finishMatch = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/upload_part_finish$/)
      if (finishMatch !== null && req.method === 'POST') {
        finishedParts.push(body)
        return json(200, {})
      }

      const filesMatch = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/files$/)
      if (filesMatch !== null && req.method === 'POST') {
        merged.push({ target: filesMatch[2], body })
        return json(200, { file_uuid: 'uuid-mock', file_info: `file-info-${merged.length}`, ttl: 300 })
      }

      return json(404, { message: `mock: 未实现的接口 ${req.method} ${url.pathname}` })
    })
  })

  const wss = new WebSocketServer({ server, path: '/websocket' })
  wss.on('connection', (ws) => {
    socket = ws
    identified = false
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatInterval } }))
    ws.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        return
      }
      if (frame.op === 2) {
        identified = true
        ws.send(
          JSON.stringify({
            op: 0,
            s: ++seq,
            t: 'READY',
            d: { session_id: 'mock-session', user: { id: 'mock-bot', username: 'MockBot' } },
          }),
        )
        return
      }
      if (frame.op === 1) {
        ws.send(JSON.stringify({ op: 11, d: null }))
        return
      }
      if (frame.op === 6) {
        identified = true
        ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'RESUMED', d: { session_id: 'mock-session' } }))
      }
    })
    ws.on('close', () => {
      if (socket === ws) socket = null
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/app/getAppAccessToken`,
    sent,
    requests,
    attachmentDownloads,
    prepared,
    uploadedParts,
    finishedParts,
    merged,
    get connected() {
      return socket !== null && socket.readyState === 1
    },
    get identified() {
      return identified
    },
    /** 推一条 QQ 事件给网关。 */
    emit(type, data) {
      if (socket === null || socket.readyState !== 1) throw new Error('mock: 网关尚未连接')
      socket.send(JSON.stringify({ op: 0, s: ++seq, t: type, d: data }))
    },
    async waitFor(predicate, { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = predicate()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      throw new Error(`mock: 等待超时（${label}）`)
    },
    async close() {
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
