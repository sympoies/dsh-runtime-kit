import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WORKSPACE_LEASE_UNAVAILABLE,
  WorkspaceLeaseError,
} from '../src/workspace-lease/index.js'
import {
  applyNilsWorkspaceLease,
  createNilsWorkspaceLeaseProvider,
} from '../src/workspace-lease/nils-provider.js'
import { createSnapshotExecutionOwner } from '../src/health/nils-provider.js'
import { isolatedNilsEnvironment } from '../src/nils/session-environment.js'

function agentHookArgs(...args) {
  return [
    '/test/agent-hook',
    '--config', '/runtime/agent-hook/config.toml',
    '--policy', '/runtime/agent-hook/policy.toml',
    '--state-dir', '/runtime/agent-hook/state',
    ...args,
  ]
}

function responseFor(action, request, overrides = {}) {
  const data = {
    bind: {
      schema_version: 'agent-hook.workspace-lease.bind-result.v1',
      kind: 'bound',
      binding_id: 'wlb1.opaque',
      workspace_id: 'wlw1.opaque',
      generation: 'wlg1.opaque',
      state: 'owned',
      renew_after_ms: 10_000,
    },
    begin: {
      schema_version: 'agent-hook.workspace-lease.begin-result.v1',
      kind: 'granted',
      operation_id: 'wlo1.opaque',
      fence: 'wlf1.opaque',
    },
    complete: {
      schema_version: 'agent-hook.workspace-lease.complete-result.v1',
      kind: 'completed',
    },
    renew: {
      schema_version: 'agent-hook.workspace-lease.renew-result.v1',
      kind: 'renewed',
      renew_after_ms: 10_000,
    },
    release: {
      schema_version: 'agent-hook.workspace-lease.release-result.v1',
      kind: 'released',
    },
  }[action]
  return {
    schema_version: `cli.agent-hook.workspace-lease-${action}.v1`,
    ok: true,
    data: { ...data, ...overrides },
  }
}

function fixture({
  responder = responseFor,
  pending = false,
  waitForExit = true,
  lossy = false,
  exitCode = 0,
  signal = null,
  agentHook = '/test/agent-hook',
  maxActive = 4,
  timeoutMs = 100,
  teardownTimeoutMs = 20,
  authenticatedNilsExecution,
  resolutionPending = false,
} = {}) {
  const effects = []
  const spawns = []
  const resolutions = []
  const settlers = []
  let terminated = 0
  const ctx = {
    effect(execute) { effects.push(execute()) },
    subprocess: {
      async resolveExecutable(command, environment, candidateSignal) {
        resolutions.push({ command, environment, signal: candidateSignal })
        if (resolutionPending) {
          return new Promise((resolve, reject) => {
            if (candidateSignal?.aborted) reject(candidateSignal.reason)
            candidateSignal?.addEventListener(
              'abort',
              () => reject(candidateSignal.reason),
              { once: true },
            )
          })
        }
        return `/resolved/${command}`
      },
      spawn(spec) {
        const commandIndex = spec.argv.indexOf('workspace-lease')
        const action = spec.argv[commandIndex + 1]
        const request = JSON.parse(spec.stdio.stdin.data)
        spawns.push({ spec, request, action })
        let settle
        const done = pending
          ? new Promise(resolve => {
              settle = resolve
              settlers.push(() => resolve({ exitCode, signal }))
            })
          : Promise.resolve({ exitCode, signal })
        return {
          done,
          terminate() {
            terminated += 1
            settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          async waitForExit() {
            return waitForExit === 'pending' ? new Promise(() => {}) : waitForExit
          },
          collected: {
            stdout: {
              readFrom: () => ({
                text: JSON.stringify(responder(action, request)),
                lossy,
              }),
            },
          },
        }
      },
    },
  }
  const provider = createNilsWorkspaceLeaseProvider(ctx, {
    agentHook,
    agentHookConfig: '/runtime/agent-hook/config.toml',
    agentHookPolicy: '/runtime/agent-hook/policy.toml',
    agentHookStateDir: '/runtime/agent-hook/state',
    workspaceLeaseTimeoutMs: timeoutMs,
    workspaceLeaseTeardownTimeoutMs: teardownTimeoutMs,
    maxActiveWorkspaceLeaseRequests: maxActive,
    authenticatedNilsExecution,
  })
  return {
    provider,
    spawns,
    resolutions,
    get terminated() { return terminated },
    settle(index = 0) { settlers[index]?.() },
    async dispose() {
      for (const dispose of effects.reverse()) if (typeof dispose === 'function') await dispose()
    },
  }
}

const binding = {
  version: 1,
  requestId: 'request-1',
  sessionId: 'session-1',
  parentSessionId: 'parent-1',
  bindingId: 'wlb1.opaque',
  workspaceId: 'wlw1.opaque',
  generation: 'wlg1.opaque',
}

test('the nils provider projects every exact WorkspaceLease v1 lifecycle call', async () => {
  const subject = fixture()

  assert.deepEqual(await subject.provider.bind({
    version: 1,
    requestId: 'bind-request',
    sessionId: 'session-1',
    parentSessionId: 'parent-1',
    cwd: '/workspace/project',
    source: 'startup',
  }, new AbortController().signal), {
    kind: 'bound',
    bindingId: 'wlb1.opaque',
    workspaceId: 'wlw1.opaque',
    generation: 'wlg1.opaque',
    state: 'owned',
    renewAfterMs: 10_000,
  })
  assert.deepEqual(await subject.provider.begin({
    ...binding,
    requestId: 'begin-request',
    bindingState: 'owned',
    callId: 'call-1',
    rootCallId: 'root-1',
    toolName: 'edit',
    arguments: { path: '/workspace/project/private.txt', replacement: 'secret' },
    nested: false,
  }, new AbortController().signal), {
    kind: 'granted',
    operationId: 'wlo1.opaque',
    fence: 'wlf1.opaque',
  })
  await subject.provider.complete({
    ...binding,
    requestId: 'complete-request',
    operationId: 'wlo1.opaque',
    fence: 'wlf1.opaque',
    callId: 'call-1',
    rootCallId: 'root-1',
    toolName: 'edit',
    outcome: 'succeeded',
  }, new AbortController().signal)
  assert.deepEqual(await subject.provider.renew({
    ...binding,
    requestId: 'renew-request',
  }, new AbortController().signal), { kind: 'renewed', renewAfterMs: 10_000 })
  await subject.provider.release({
    ...binding,
    requestId: 'release-request',
    reason: 'agent-disposed',
  }, new AbortController().signal)

  assert.deepEqual(subject.spawns.map(call => call.spec.argv), [
    agentHookArgs('workspace-lease', 'bind', '--format', 'json'),
    agentHookArgs('workspace-lease', 'begin', '--format', 'json'),
    agentHookArgs('workspace-lease', 'complete', '--format', 'json'),
    agentHookArgs('workspace-lease', 'renew', '--format', 'json'),
    agentHookArgs('workspace-lease', 'release', '--format', 'json'),
  ])
  assert.deepEqual(subject.spawns[0].request, {
    schema_version: 'agent-hook.workspace-lease.bind.v1',
    version: 1,
    request_id: 'bind-request',
    session_id: 'session-1',
    parent_session_id: 'parent-1',
    cwd: '/workspace/project',
    source: 'startup',
  })
  assert.deepEqual(subject.spawns[1].request, {
    schema_version: 'agent-hook.workspace-lease.begin.v1',
    version: 1,
    request_id: 'begin-request',
    session_id: 'session-1',
    parent_session_id: 'parent-1',
    binding_id: 'wlb1.opaque',
    workspace_id: 'wlw1.opaque',
    generation: 'wlg1.opaque',
    binding_state: 'owned',
    call_id: 'call-1',
    root_call_id: 'root-1',
    tool_name: 'edit',
    arguments: { path: '/workspace/project/private.txt', replacement: 'secret' },
    nested: false,
  })
  assert.equal(subject.spawns.every(call => call.spec.cwd === '/runtime/agent-hook/state'), true)
  assert.deepEqual(subject.spawns[0].spec.env, isolatedNilsEnvironment(undefined))
  assert.doesNotMatch(JSON.stringify(subject.spawns[0].spec.argv), /private\.txt|secret/)
  assert.equal(subject.provider.protocolVersion, 1)
})

test('provider denial and lost responses preserve only stable bounded facts', async () => {
  const subject = fixture({
    responder(action, request) {
      if (action === 'bind') return responseFor(action, request, {
        kind: 'denied',
        state: 'foreign-active',
        code: 'WORKSPACE_FOREIGN_ACTIVE',
        reason: 'another live session owns this workspace',
        binding_id: undefined,
        workspace_id: undefined,
        generation: undefined,
        renew_after_ms: undefined,
      })
      if (action === 'renew') return responseFor(action, request, {
        kind: 'lost',
        state: 'stale-clean',
        code: 'WORKSPACE_LEASE_EXPIRED',
        reason: 'workspace lease generation expired and must be rebound',
        renew_after_ms: undefined,
      })
      return responseFor(action, request)
    },
  })

  assert.deepEqual(await subject.provider.bind({
    version: 1,
    requestId: 'bind-request',
    sessionId: 'session-1',
    cwd: '/workspace/project',
    source: 'resume',
  }, new AbortController().signal), {
    kind: 'denied',
    state: 'foreign-active',
    code: 'WORKSPACE_FOREIGN_ACTIVE',
    reason: 'another live session owns this workspace',
  })
  assert.deepEqual(await subject.provider.renew(binding, new AbortController().signal), {
    kind: 'lost',
    state: 'stale-clean',
    code: 'WORKSPACE_LEASE_EXPIRED',
    reason: 'workspace lease generation expired and must be rebound',
  })
})

test('malformed, lossy, exit-mismatched, and unquiescent children fail closed', async () => {
  const malformed = fixture({ responder: () => ({ ok: true }) })
  await assert.rejects(
    malformed.provider.bind({
      version: 1,
      requestId: 'bind-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError
      && error.code === WORKSPACE_LEASE_UNAVAILABLE,
  )

  const lossy = fixture({ lossy: true })
  await assert.rejects(
    lossy.provider.bind({
      version: 1,
      requestId: 'bind-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )

  const mismatch = fixture({ exitCode: 69 })
  await assert.rejects(
    mismatch.provider.bind({
      version: 1,
      requestId: 'bind-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )

  const unquiescent = fixture({ waitForExit: 'pending', teardownTimeoutMs: 10 })
  await assert.rejects(
    unquiescent.provider.bind({
      version: 1,
      requestId: 'bind-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )
  await assert.rejects(
    unquiescent.provider.bind({
      version: 1,
      requestId: 'second-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )
  assert.equal(unquiescent.spawns.length, 1, 'unknown process-tree state closes admission')
})

test('concurrency, caller cancellation, timeout, and disposal are bounded', async () => {
  const subject = fixture({ pending: true, maxActive: 1, timeoutMs: 20 })
  const first = subject.provider.bind({
    version: 1,
    requestId: 'first-request',
    sessionId: 'session-1',
    source: 'startup',
  }, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))

  await assert.rejects(
    subject.provider.bind({
      version: 1,
      requestId: 'overloaded-request',
      sessionId: 'session-2',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )
  await assert.rejects(first, error => error instanceof WorkspaceLeaseError)
  assert.ok(subject.terminated >= 1)

  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    subject.provider.bind({
      version: 1,
      requestId: 'cancelled-request',
      sessionId: 'session-1',
      source: 'startup',
    }, cancelled.signal),
    error => error instanceof WorkspaceLeaseError,
  )

  await subject.dispose()
  await assert.rejects(
    subject.provider.bind({
      version: 1,
      requestId: 'disposed-request',
      sessionId: 'session-1',
      source: 'startup',
    }, new AbortController().signal),
    error => error instanceof WorkspaceLeaseError,
  )
})

test('workspace lease holds its authenticated descriptor scope across delayed resolution and HMR disposal', async () => {
  let cleaned = false
  const owner = createSnapshotExecutionOwner(async () => { cleaned = true }, 100)
  const subject = fixture({
    agentHook: 'agent-hook',
    authenticatedNilsExecution: owner,
    resolutionPending: true,
  })
  const pending = subject.provider.bind({
    version: 1,
    requestId: 'descriptor-bind-request',
    sessionId: 'session-1',
    source: 'startup',
  }, new AbortController().signal)
  const rejected = assert.rejects(
    pending,
    error => error instanceof WorkspaceLeaseError
      && error.code === WORKSPACE_LEASE_UNAVAILABLE,
  )
  while (subject.resolutions.length === 0) await new Promise(resolve => setImmediate(resolve))

  const ownerDisposal = owner.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cleaned, false, 'snapshot cleanup must wait for the transport scope to drain')
  assert.equal(subject.spawns.length, 0)
  const providerDisposal = subject.dispose()
  await Promise.all([ownerDisposal, providerDisposal])
  await rejected
  assert.equal(subject.spawns.length, 0)
  assert.equal(cleaned, true)
})

test('a portable agent-hook name is resolved without ambient repository selection', async () => {
  const subject = fixture({ agentHook: 'agent-hook' })
  await subject.provider.bind({
    version: 1,
    requestId: 'bind-request',
    sessionId: 'session-1',
    source: 'startup',
  }, new AbortController().signal)

  assert.equal(subject.resolutions.length, 1)
  assert.deepEqual(subject.resolutions[0], {
    command: 'agent-hook',
    environment: undefined,
    signal: subject.resolutions[0].signal,
  })
  assert.equal(subject.spawns[0].spec.argv[0], '/resolved/agent-hook')
})

test('native composition activates WorkspaceLease before registering the nils provider', async () => {
  const order = []
  let registered
  const ctx = {
    async plugin(plugin) { order.push(['plugin', plugin.name]) },
    get(name) {
      assert.equal(name, 'workspaceLease')
      return {
        registerProvider(provider) {
          registered = provider
          order.push(['provider', provider.protocolVersion])
        },
      }
    },
    effect(execute, label) {
      order.push(['effect', label])
      return execute()
    },
    subprocess: {},
  }

  await applyNilsWorkspaceLease(ctx, {
    agentHook: '/test/agent-hook',
    agentHookConfig: '/runtime/agent-hook/config.toml',
    agentHookPolicy: '/runtime/agent-hook/policy.toml',
    agentHookStateDir: '/runtime/agent-hook/state',
  })

  assert.equal(registered?.protocolVersion, 1)
  assert.deepEqual(order, [
    ['plugin', 'WorkspaceLease'],
    ['effect', 'dsh-runtime-kit nils workspace lease provider'],
    ['provider', 1],
  ])
})
