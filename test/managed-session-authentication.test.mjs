import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createManagedSessionBridge } from '../src/main-agent/session-bridge.js'
import { applyManagedSessionAuthentication } from '../src/nils/managed-session-authentication.js'

const principalEnvironment = Object.freeze({
  AGENT_SESSION_ID: 'console-session-one',
  AGENT_SESSION_RUNTIME_ID: 'runtime-one',
  AGENT_SESSION_STATE_DIR: '/private/agent-session',
  AGENT_SESSION_COORDINATION_MODE: 'advisory',
  AGENT_SESSION_CAPABILITY_FILE: '/private/agent-session/capability',
  AGENT_SESSION_CHECKPOINT_FILE: '/private/agent-session/checkpoint',
  AGENT_SESSION_BIN: '/bin/true',
})

function readiness(environment = principalEnvironment) {
  return {
    schema_version: 'cli.main-agent.self-readiness.v1',
    ok: true,
    data: {
      schema_version: 'main-agent.runtime-readiness.v1',
      ready: true,
      session_id: environment.AGENT_SESSION_ID,
      session_incarnation: environment.AGENT_SESSION_RUNTIME_ID,
      checkpoint_file: environment.AGENT_SESSION_CHECKPOINT_FILE,
    },
  }
}

function harness({
  environment = principalEnvironment,
  envelope = readiness(environment),
  pending = false,
} = {}) {
  const listeners = new Map()
  const effects = []
  const spawned = []
  let settle
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
    subprocess: {
      async resolveExecutable(command) { return command },
      spawn(spec) {
        spawned.push(spec)
        const done = pending
          ? new Promise(resolve => { settle = resolve })
          : Promise.resolve({ exitCode: 0, signal: null })
        return {
          done,
          terminate() {},
          collected: {
            stdout: {
              readFrom: () => ({ text: JSON.stringify(envelope), lossy: false }),
            },
          },
          async waitForExit() { return true },
        }
      },
    },
  }
  return {
    ctx,
    effects,
    listeners,
    spawned,
    settle: () => settle?.({ exitCode: 0, signal: null }),
  }
}

function topLevelAgent(id = 'dsh-controller-one') {
  return { session: { header: { id, cwd: '/workspace/project' } } }
}

test('always-on managed-session authentication binds before an optional child plugin activates', async () => {
  const subject = harness()
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.deepEqual(subject.spawned.map(record => record.argv), [[
    '/bin/true', 'self', 'readiness', '--format', 'json',
  ]])
  assert.deepEqual(subject.spawned[0].env, principalEnvironment)
  assert.deepEqual(bridge.resolve('dsh-controller-one'), {
    sessionId: 'console-session-one',
    environment: principalEnvironment,
  })
})

test('managed-session authentication forwards the authenticated coordination mode to policy children', async () => {
  const subject = harness()
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const entered = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.deepEqual(entered, { kind: 'enter', messages: [] })
  assert.equal(
    subject.spawned[0].env.AGENT_SESSION_COORDINATION_MODE,
    principalEnvironment.AGENT_SESSION_COORDINATION_MODE,
  )
  assert.equal(
    bridge.resolve('dsh-controller-one').environment.AGENT_SESSION_COORDINATION_MODE,
    principalEnvironment.AGENT_SESSION_COORDINATION_MODE,
  )
})

test('managed-session authentication stays fail-closed for unmanaged sessions and foreign children', async () => {
  const unmanaged = harness({ environment: {} })
  const unmanagedBridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(unmanaged.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, unmanagedBridge, {})
  const unmanagedResult = await unmanaged.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent('unmanaged'), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(unmanagedResult, { kind: 'enter', messages: [] })
  assert.equal(unmanaged.spawned.length, 0)
  assert.equal(unmanagedBridge.resolve('unmanaged'), undefined)

  const foreign = harness()
  const foreignBridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(foreign.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, foreignBridge, principalEnvironment)
  const foreignResult = await foreign.listeners.get('agent/pre-step')[0](
    {
      agent: { session: { header: { id: 'foreign', parentSession: 'parent', cwd: '/workspace/project' } } },
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(foreignResult, { kind: 'enter', messages: [] })
  assert.equal(foreign.spawned.length, 0)
  assert.equal(foreignBridge.resolve('foreign'), undefined)
})

test('managed-session authentication rejects invalid producer readiness before policy', async () => {
  const invalid = readiness()
  invalid.data.session_incarnation = 'different-runtime'
  const subject = harness({ envelope: invalid })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)

  const rejected = await subject.listeners.get('agent/pre-step')[0](
    { agent: topLevelAgent(), signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(rejected, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})

test('agent disposal during readiness cannot publish a stale principal', async () => {
  const subject = harness({ pending: true })
  const bridge = createManagedSessionBridge()
  applyManagedSessionAuthentication(subject.ctx, {
    mainAgentCli: '/bin/true',
    agentSessionCli: '/bin/true',
  }, bridge, principalEnvironment)
  const agent = topLevelAgent()

  const entering = subject.listeners.get('agent/pre-step')[0](
    { agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.listeners.get('agent/disposed')[0]({ agent })
  subject.settle()

  assert.deepEqual(await entering, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:managed-session-authentication-failed',
  })
  assert.equal(bridge.resolve('dsh-controller-one'), undefined)
})
