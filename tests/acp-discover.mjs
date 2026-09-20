/**
 * ACP 能力探测：把 session/new 的 configOptions、session/list、set_config_option、
 * usage_update 的真实形状打印出来，供网关按实际字段实现 /model /effort /usage /sessions。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workspace = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'acp-discover-'))
const child = spawn('dsh', ['--profile', 'acp'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], shell: true })

let nextId = 1
const pending = new Map()
let buffer = ''
const updates = []

function send(method, params) {
  const id = String(nextId++)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 120000)
  })
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (line.length === 0) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.id !== undefined && frame.method !== undefined) {
      if (frame.method === 'session/request_permission') {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }) + '\n')
      }
      continue
    }
    if (frame.id !== undefined) {
      const p = pending.get(String(frame.id))
      if (p) { pending.delete(String(frame.id)); frame.error ? p.reject(new Error(JSON.stringify(frame.error))) : p.resolve(frame.result) }
      continue
    }
    if (frame.method === 'session/update') updates.push(frame.params)
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log('[stderr] ' + t.slice(0, 200)) })

const show = (label, value) => console.log(`\n===== ${label} =====\n` + JSON.stringify(value, null, 2))

try {
  await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: 'discover', version: '1' } })

  const created = await send('session/new', { cwd: workspace, mcpServers: [] })
  show('session/new result', created)
  const sessionId = created.sessionId

  const modelOption = created.configOptions?.find((o) => o.id === 'model')
  show('model option (去掉 options 便于阅读)', {
    id: modelOption?.id, name: modelOption?.name, category: modelOption?.category,
    type: modelOption?.type, currentValue: modelOption?.currentValue,
    optionGroups: modelOption?.options?.map((g) => ({ group: g.group, count: g.options?.length, first: g.options?.[0] })),
  })

  const effortOption = created.configOptions?.find((o) => o.id === 'reasoning_effort')
  show('reasoning_effort option', effortOption)

  try {
    show('session/list result', await send('session/list', {}))
  } catch (error) {
    show('session/list FAILED', String(error.message))
  }

  try {
    show('session/set_config_option(model) result', await send('session/set_config_option', {
      sessionId, configId: 'model', value: modelOption?.currentValue,
    }))
  } catch (error) {
    show('set_config_option(model) FAILED', String(error.message))
  }

  if (effortOption !== undefined) {
    const other = effortOption.options?.find((o) => o.value !== effortOption.currentValue) ?? effortOption.options?.[0]
    try {
      show('session/set_config_option(reasoning_effort) result', await send('session/set_config_option', {
        sessionId, configId: 'reasoning_effort', value: other?.value,
      }))
    } catch (error) {
      show('set_config_option(effort) FAILED', String(error.message))
    }
  }

  show('prompt result', await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: '只回复一个字：好' }] }))
  show('update kinds', [...new Set(updates.map((u) => u.update?.sessionUpdate))])
  show('usage_update frames', updates.filter((u) => u.update?.sessionUpdate === 'usage_update'))

  await send('session/close', { sessionId })
} catch (error) {
  console.log('探测失败：' + error.message)
} finally {
  child.kill()
  process.exit(0)
}
