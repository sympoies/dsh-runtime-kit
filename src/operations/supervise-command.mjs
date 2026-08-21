#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'

const STATUS_FD = 3
const MAX_OUTPUT_BYTES = 1024 * 1024

function writeStatus(value) {
  // This descriptor is owned by the supervisor; the executed command never
  // inherits it, so command output cannot forge the control result.
  writeSync(STATUS_FD, Buffer.from(`${JSON.stringify(value)}\n`))
}

function killWindowsChild(pid) {
  if (!Number.isSafeInteger(pid)) return
  try { process.kill(pid, 'SIGKILL') } catch {}
}

async function main() {
  const [bin, ...args] = process.argv.slice(2)
  const timeoutMs = Number(process.env.DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS)
  if (bin === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    writeStatus({ kind: 'supervisor-error', message: 'invalid supervisor request' })
    return 70
  }
  const env = { ...process.env }
  delete env.DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS
  const child = spawn(bin, args, {
    cwd: process.cwd(),
    env,
    shell: false,
    // On POSIX the outer operations owner starts this supervisor as the
    // process-group leader. The command inherits that group, so the outer
    // owner can settle it even when this supervisor is killed.
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let terminal = false

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

  const timer = setTimeout(() => terminateSupervisor('timeout'), timeoutMs)
  timer.unref()
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ error }))
    child.once('close', (status, signal) => resolve({ status, signal }))
  })
  clearTimeout(timer)
  if (terminal) return 70
  terminal = true
  process.stdout.write(Buffer.concat(stdout))
  process.stderr.write(Buffer.concat(stderr))
  if ('error' in result) {
    writeStatus({ kind: 'spawn-error', message: result.error.message })
    return 70
  }
  writeStatus({ kind: 'completed', status: result.status, signal: result.signal })
  return 0
}

process.exitCode = await main()
