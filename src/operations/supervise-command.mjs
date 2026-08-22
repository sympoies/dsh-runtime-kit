#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STATUS_FD = 3
const MAX_OUTPUT_BYTES = 1024 * 1024
const COMMAND_GATE = '--command-gate'
const COMMAND_GATE_AUTHORIZATION = 'run\n'
const SELF = fileURLToPath(import.meta.url)

function writeStatus(value) {
  // This descriptor is owned by the supervisor; the executed command never
  // inherits it, so command output cannot forge the control result.
  writeSync(STATUS_FD, Buffer.from(`${JSON.stringify(value)}\n`))
}

function killWindowsChild(pid) {
  if (!Number.isSafeInteger(pid)) return
  try { process.kill(pid, 'SIGKILL') } catch {}
}

async function commandGate(bin, args) {
  let authorization = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    authorization += chunk
    if (authorization.length > COMMAND_GATE_AUTHORIZATION.length) return 70
  }
  if (authorization !== COMMAND_GATE_AUTHORIZATION) return 70

  const child = spawn(bin, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    detached: false,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error }))
    // A signalled gate can leave the governed command holding the captured
    // stdio pipes open. Report the gate loss immediately so the outer owner
    // can kill the already-published process group instead of waiting for the
    // stream-driven `close` event.
    child.once('exit', (status, signal) => {
      if (signal !== null) resolve({ status, signal })
    })
    child.once('close', (status, signal) => resolve({ status, signal }))
  })
  if ('error' in result) return 70
  if (result.signal !== null) {
    try { process.kill(process.pid, result.signal) } catch {}
    return 70
  }
  return result.status ?? 70
}

async function main(bin, args) {
  const timeoutMs = Number(process.env.DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS)
  if (bin === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    writeStatus({ kind: 'supervisor-error', message: 'invalid supervisor request' })
    return 70
  }
  const env = { ...process.env }
  delete env.DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS
  const child = spawn(process.execPath, [SELF, COMMAND_GATE, bin, ...args], {
    cwd: process.cwd(),
    env,
    shell: false,
    // On POSIX Node creates a new session and process group for this gate. The
    // governed command cannot start until the outer owner has received this
    // pgid; if publication fails, stdin closes and the gate exits unopened.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let terminal = false

  child.stdin.on('error', () => {})

  const terminateSupervisor = kind => {
    if (terminal) return
    terminal = true
    writeStatus({ kind, timeout_ms: timeoutMs })
    if (process.platform === 'win32') killWindowsChild(child.pid)
    else process.exit(70)
  }
  const collect = (chunks, stream) => chunk => {
    const next = Buffer.from(chunk)
    if (stream === 'stdout') stdoutBytes += next.byteLength
    else stderrBytes += next.byteLength
    if ((stream === 'stdout' ? stdoutBytes : stderrBytes) > MAX_OUTPUT_BYTES) {
      terminateSupervisor('output-limit')
      return
    }
    chunks.push(next)
  }
  child.stdout.on('data', collect(stdout, 'stdout'))
  child.stderr.on('data', collect(stderr, 'stderr'))

  const resultPromise = new Promise(resolve => {
    child.once('error', error => resolve({ error }))
    child.once('exit', (status, signal) => {
      if (signal !== null) resolve({ status, signal })
    })
    child.once('close', (status, signal) => resolve({ status, signal }))
  })
  const timer = setTimeout(() => terminateSupervisor('timeout'), timeoutMs)
  timer.unref()
  if (Number.isSafeInteger(child.pid)) {
    writeStatus({ kind: 'started', pgid: child.pid })
    child.stdin.end(COMMAND_GATE_AUTHORIZATION)
  }
  const result = await resultPromise
  clearTimeout(timer)
  if (terminal) return 70
  terminal = true
  if ('signal' in result && result.signal !== null) {
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
  process.stdout.write(Buffer.concat(stdout))
  process.stderr.write(Buffer.concat(stderr))
  if ('error' in result) {
    writeStatus({ kind: 'spawn-error', message: result.error.message })
    return 70
  }
  writeStatus({ kind: 'completed', status: result.status, signal: result.signal })
  return 0
}

const [first, ...rest] = process.argv.slice(2)
process.exitCode = first === COMMAND_GATE
  ? await commandGate(rest[0], rest.slice(1))
  : await main(first, rest)
