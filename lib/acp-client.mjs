/**
 * Minimal ACP (Agent Client Protocol) v1 stdio client.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over the agent's stdin/stdout, which is
 * exactly what `dsh --profile acp` serves. Verified against
 * deepseek-harness 0.1.5-rc.2: initialize / session/new / session/resume /
 * session/close / session/prompt / session/cancel, `session/update`
 * notifications, and `session/request_permission` requests.
 *
 * The permission reply uses the modern ACP v1 result shape
 * (`{ outcome: { outcome: 'selected', optionId } }`), the shape
 * @agentclientprotocol/sdk 1.4.0 validates.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** session/new composes a real agent; give it more room than a plain RPC. */
const SESSION_REQUEST_TIMEOUT_MS = 180_000
/** A prompt may legitimately run for a long time; only the frame write is bounded. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000

export class AcpError extends Error {
  constructor(message, frame) {
    super(message)
    this.name = 'AcpError'
    this.frame = frame
  }
}

export class AcpClient {
  #child = null
  #nextId = 1
  #pending = new Map()
  #buffer = ''
  #closed = false
  #stderrTail = []

  /**
   * @param {object} options
   * @param {string} options.command executable, e.g. `dsh`
   * @param {string[]} [options.args] argv, e.g. `['--profile','acp']`
   * @param {string} options.cwd working directory of the agent process
   * @param {Record<string,string>} [options.env]
   * @param {(line: string) => void} [options.log]
   * @param {(event: {method: string, params: object}) => void} [options.onNotification]
   * @param {(params: object) => {'allow-once'|'reject-once'|'cancelled'}} [options.onPermission]
   * @param {(code: number|null, signal: string|null) => void} [options.onExit]
   */
  constructor(options) {
    this.options = options
    this.log = options.log ?? (() => {})
    this.onNotification = options.onNotification ?? (() => {})
    this.onPermission = options.onPermission ?? (() => 'allow-once')
  }

  get running() {
    return this.#child !== null && !this.#closed
  }

  get stderrTail() {
    return this.#stderrTail.join('\n')
  }

  /** Spawn the agent process and complete the ACP handshake. */
  async start() {
    const { command, args = [], cwd, env } = this.options
    // Windows：`dsh.cmd` / `dsh.ps1` 这类启动器不是 PE 可执行文件，必须过 cmd.exe；
    // 但当命令本身就是存在的可执行文件（例如桌面版用来跑 app.asar 里 CLI 的
    // `D:\DSH Desktop\DeepSeek Harness.exe`）时，绝不能再用 shell —— argv 已经由
    // parseCommandLine 切好，交给 cmd.exe 只会把含空格的路径在空格处切断
    // （现场表现：`'D:\DSH' 不是内部或外部命令`）。POSIX 一律直接 exec。
    const executable = process.platform === 'win32' && /\.exe$/i.test(command) && existsSync(command)
    this.#child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !executable,
      windowsHide: true,
    })
    this.log(`acp: spawned \`${[command, ...args].join(' ')}\` in ${cwd} (pid ${this.#child.pid ?? '?'})`)

    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#consume(chunk))

    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd()
      if (text.length === 0) return
      for (const line of text.split(/\r?\n/)) {
        this.#stderrTail.push(line)
        if (this.#stderrTail.length > 50) this.#stderrTail.shift()
      }
      this.log(`acp[stderr]: ${text}`)
    })

    this.#child.on('exit', (code, signal) => {
      this.#closed = true
      this.log(`acp: agent exited (code=${code} signal=${signal})`)
      for (const [, pending] of this.#pending) {
        pending.reject(new AcpError('ACP agent exited before answering'))
      }
      this.#pending.clear()
      this.options.onExit?.(code, signal)
    })

    const result = await this.request('initialize', {
      // The server is single-version and answers with its own version; the field
      // is only an advertisement, so any integer the schema accepts is fine.
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminals: false,
      },
      clientInfo: { name: 'dsh-qqbot-gateway', title: 'DSH QQ Bot Gateway', version: '1.0.0' },
    })
    this.log(`acp: initialized (protocolVersion=${result?.protocolVersion}, agent=${result?.agentInfo?.name})`)
    return result
  }

  /** 创建会话，返回 `{ sessionId, configOptions }`。 */
  async newSession(cwd, mcpServers = []) {
    return await this.request('session/new', { cwd, mcpServers }, SESSION_REQUEST_TIMEOUT_MS)
  }

  /** 重连到已持久化的会话，返回 `{ sessionId, configOptions? }`。 */
  async resumeSession(sessionId, cwd, mcpServers = []) {
    return await this.request('session/resume', { sessionId, cwd, mcpServers }, SESSION_REQUEST_TIMEOUT_MS)
  }

  async closeSession(sessionId) {
    try {
      await this.request('session/close', { sessionId }, SESSION_REQUEST_TIMEOUT_MS)
    } catch (error) {
      this.log(`acp: session/close failed for ${sessionId}: ${error.message}`)
    }
  }

  /**
   * Send one prompt and resolve when the turn settles.
   * Streaming text arrives through `onNotification` as `session/update` frames.
   */
  async prompt(sessionId, text) {
    return await this.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      PROMPT_TIMEOUT_MS,
    )
  }

  /** Cancel the in-flight prompt (or autonomous work) of one session. */
  async cancel(sessionId) {
    await this.notify('session/cancel', { sessionId })
  }

  /** Switch the advertised model option for one session. */
  async setModel(sessionId, provider, model) {
    return await this.setConfigOption(sessionId, 'model', JSON.stringify([provider, model]))
  }

  /** 修改某个会话的配置项（`model` / `reasoning_effort`），返回完整 configOptions。 */
  async setConfigOption(sessionId, configId, value) {
    const result = await this.request(
      'session/set_config_option',
      { sessionId, configId, value },
      SESSION_REQUEST_TIMEOUT_MS,
    )
    return Array.isArray(result?.configOptions) ? result.configOptions : []
  }

  /** 列出可恢复的持久化会话（新→旧），元素形如 `{ sessionId, cwd }`。 */
  async listSessions() {
    const result = await this.request('session/list', {}, SESSION_REQUEST_TIMEOUT_MS)
    return Array.isArray(result?.sessions) ? result.sessions : []
  }

  dispose() {
    this.#closed = true
    if (this.#child !== null) {
      try {
        this.#child.stdin.end()
      } catch {
        /* already gone */
      }
      const child = this.#child
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 3000).unref?.()
    }
    this.#child = null
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new AcpError('ACP connection is closed'))
    const id = String(this.#nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AcpError(`ACP request timed out: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  async notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  #write(frame) {
    const child = this.#child
    if (child === null || child.stdin.destroyed) throw new AcpError('ACP stdin is not writable')
    child.stdin.write(JSON.stringify(frame) + '\n')
  }

  #consume(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length === 0) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        this.log(`acp: non-JSON stdout line dropped: ${line.slice(0, 200)}`)
        continue
      }
      this.#dispatch(frame)
    }
  }

  #dispatch(frame) {
    if (frame.id !== undefined && frame.method !== undefined) {
      this.#answerRequest(frame)
      return
    }
    if (frame.id !== undefined) {
      const pending = this.#pending.get(String(frame.id))
      if (pending === undefined) {
        this.log(`acp: response for unknown id ${frame.id}`)
        return
      }
      this.#pending.delete(String(frame.id))
      if (frame.error !== undefined) {
        pending.reject(new AcpError(frame.error.message ?? JSON.stringify(frame.error), frame))
      } else {
        pending.resolve(frame.result)
      }
      return
    }
    if (frame.method !== undefined) {
      try {
        this.onNotification({ method: frame.method, params: frame.params ?? {} })
      } catch (error) {
        this.log(`acp: notification handler failed: ${error.message}`)
      }
    }
  }

  #answerRequest(frame) {
    if (frame.method === 'session/request_permission') {
      const selected = this.onPermission(frame.params ?? {})
      const result =
        selected === 'cancelled'
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: selected } }
      this.#write({ jsonrpc: '2.0', id: frame.id, result })
      return
    }
    // Unknown client-side method: answer with a JSON-RPC method-not-found so the
    // agent never waits on a request this client cannot serve.
    this.#write({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32601, message: `client does not implement ${frame.method}` },
    })
  }
}
