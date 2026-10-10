// Real-binary leg for managed-session authentication. It starts a stub managed
// session with the released agent-session binary, then drives the production
// authentication module with real subprocesses: a correct principal is admitted
// and bound, while a mutated incarnation is refused before any binding.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { createManagedSessionBridge } from '../dist/src/nils/session-bridge.js'
import { applyManagedSessionAuthentication } from '../dist/src/nils/managed-session-authentication.js'

const agentSessionBin = process.env.AGENT_SESSION_BIN
assert.ok(
  agentSessionBin && isAbsolute(agentSessionBin),
  'set AGENT_SESSION_BIN to the absolute released agent-session binary under test',
)

// Start and delete must not inherit a managed principal from the runner.
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_SESSION_')),
)
const root = mkdtempSync(join(tmpdir(), 'managed-readiness-smoke-'))
const stateDir = join(root, 'state')
const project = join(root, 'project')
const provider = join(root, 'provider.sh')
let sessionId
let tmuxSession

function agentSession(args, options = {}) {
  return spawnSync(agentSessionBin, ['--state-dir', stateDir, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: cleanEnvironment,
    ...options,
  })
}

// The real subprocess ctx: the production client only needs spawn, handle.done,
// terminate, waitForExit and bounded stdout.
function realSubprocess() {
  return {
    resolveExecutable: async command => command,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? {},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.resume()
      const done = new Promise(resolve => {
        child.on('error', () => resolve({ exitCode: -1, signal: null }))
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      const terminate = () => { child.kill('SIGTERM') }
      spec.signal?.addEventListener('abort', terminate, { once: true })
      return {
        done,
        terminate,
        collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) } },
        async waitForExit() { await done; return true },
      }
    },
  }
}

function realContext() {
  const listeners = new Map()
  const effects = []
  const ctx = {
    on(event, listener) {
      const candidates = listeners.get(event) ?? []
      candidates.push(listener)
      listeners.set(event, candidates)
      return () => {
        const index = candidates.indexOf(listener)
        if (index >= 0) candidates.splice(index, 1)
      }
    },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    subprocess: realSubprocess(),
  }
  return { ctx, listeners, effects }
}

async function admit(environment) {
  const { ctx, listeners, effects } = realContext()
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(ctx, { agentSessionCli: agentSessionBin }, bridge, environment)
  const agent = { session: { header: { id: 'dsh-controller-smoke', cwd: project } } }
  const verdict = await listeners.get('agent/pre-step')[0](
    { agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const bound = bridge.resolve('dsh-controller-smoke')
  for (const dispose of effects.reverse()) dispose()
  return { verdict, bound }
}

let failure
try {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(project, { recursive: true, mode: 0o700 })
  writeFileSync(provider, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 0.0.0"; exit 0; fi\nexec sleep 3600\n', { mode: 0o700 })
  chmodSync(provider, 0o700)
  spawnSync('git', ['init', '--quiet', '-b', 'main', project], { encoding: 'utf8', timeout: 30_000 })

  const started = agentSession([
    'start', '--agent', 'codex', '--agent-bin', provider,
    '--no-parent', '--no-inherit-work', '--cwd', project,
    '--coordination-mode', 'off', '--format', 'json',
  ])
  assert.equal(started.status, 0, started.stderr || started.stdout)
  const session = JSON.parse(started.stdout).data
  sessionId = session.id
  tmuxSession = session.tmux_session
  const coordination = join(stateDir, 'sessions', sessionId, 'coordination')
  const capability = readdirSync(coordination).find(name => name.startsWith('capability-'))
  const checkpoint = readdirSync(coordination).find(name => name.startsWith('main-agent-checkpoint-') && name.endsWith('.json'))
  assert.ok(capability && checkpoint, 'managed session principal files were not provisioned')

  const principal = Object.freeze({
    AGENT_SESSION_ID: sessionId,
    AGENT_SESSION_RUNTIME_ID: session.session_incarnation,
    AGENT_SESSION_STATE_DIR: stateDir,
    AGENT_SESSION_COORDINATION_MODE: 'off',
    AGENT_SESSION_CAPABILITY_FILE: join(coordination, capability),
    AGENT_SESSION_CHECKPOINT_FILE: join(coordination, checkpoint),
    AGENT_SESSION_BIN: agentSessionBin,
  })

  const admitted = await admit(principal)
  assert.deepEqual(admitted.verdict, { kind: 'enter', messages: [] })
  assert.equal(admitted.bound?.sessionId, sessionId)
  assert.deepEqual(admitted.bound?.environment, principal)

  const mutated = await admit({ ...principal, AGENT_SESSION_RUNTIME_ID: 'mutated-incarnation' })
  assert.deepEqual(mutated.verdict, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(mutated.bound, undefined)

  process.stdout.write('managed-session readiness smoke: admitted principal bound; mutated incarnation refused\n')
} catch (error) {
  failure = error
} finally {
  if (sessionId !== undefined) {
    // Kill only this smoke's named tmux session, then let delete verify the
    // termination and remove the session metadata.
    spawnSync('tmux', ['kill-session', '-t', tmuxSession], { encoding: 'utf8', timeout: 10_000 })
    const deleted = agentSession(['delete', sessionId, '--format', 'json'])
    if (JSON.parse(deleted.stdout || '{}').ok !== true) {
      failure ??= new Error(`managed session cleanup failed: ${deleted.stdout || deleted.stderr}`)
    }
  }
  rmSync(root, { recursive: true, force: true })
}
if (failure !== undefined) throw failure
