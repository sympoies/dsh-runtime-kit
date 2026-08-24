import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

import {
  WORKSPACE_LEASE_PROTOCOL_VERSION,
  WorkspaceLease,
  WorkspaceLeaseError,
  WorkspaceLeaseInvalidRefError,
} from '@sympoies/dsh-runtime-kit/workspace-lease'

const testSignal = new AbortController().signal

function stubAgent(rawId, cwd = '/workspace', parentSession) {
  const id = SessionId(rawId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd,
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  })
  const cancellations = []
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle',
    ctx: new Context(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel(cause) { cancellations.push(cause) },
    cancellations,
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function provider(overrides = {}) {
  const calls = {
    bind: [],
    begin: [],
    complete: [],
    renew: [],
    release: [],
  }
  const selected = {
    protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
    async bind(request, signal) {
      calls.bind.push([request, signal])
      if (overrides.bind !== undefined) return overrides.bind(request, signal)
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: `workspace:${request.cwd ?? 'unmanaged'}`,
        generation: 'generation:1',
        state: 'owned',
      }
    },
    async begin(request, signal) {
      calls.begin.push([request, signal])
      if (overrides.begin !== undefined) return overrides.begin(request, signal)
      return {
        kind: 'granted',
        operationId: `operation:${request.callId}`,
        fence: 'fence:1',
      }
    },
    async complete(request, signal) {
      calls.complete.push([request, signal])
      return overrides.complete?.(request, signal)
    },
    async renew(request, signal) {
      calls.renew.push([request, signal])
      if (overrides.renew !== undefined) return overrides.renew(request, signal)
      return { kind: 'renewed' }
    },
    async release(request, signal) {
      calls.release.push([request, signal])
      return overrides.release?.(request, signal)
    },
  }
  return { selected, calls }
}

async function harness(selected) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(WorkspaceLease)
  if (selected !== undefined) ctx.workspaceLease.registerProvider(selected)
  return ctx
}

function publish(ctx, agent, source = 'startup') {
  const dispose = ctx.agents.register(agent)
  agentEvents(ctx, agent).emit('agent/session-start', { source })
  return dispose
}

function echoTool(sequence) {
  return defineTool({
    name: 'echo',
    description: 'echo',
    parameters: { text: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      sequence?.push('body')
      return args.text ?? ''
    },
  })
}

class AllowedOnceApproval extends Service {
  constructor(ctx) {
    super(ctx, 'approval')
  }

  async request() {
    return 'allowed-once'
  }
}

test('workspace ref is opaque, non-bearer, and bound to one exact live agent', async () => {
  const { selected } = provider()
  const ctx = await harness(selected)
  const owner = stubAgent('owner', '/workspace/project')
  publish(ctx, owner)

  const ref = await ctx.workspaceLease.ref(owner)
  assert.equal(Object.isFrozen(ref), true)
  assert.deepEqual(Object.keys(ref), [])
  assert.equal(JSON.stringify(ref), '{}')
  assert.equal(ctx.workspaceLease.state(owner, ref), 'owned')
  assert.throws(
    () => ctx.workspaceLease.state(owner, structuredClone(ref)),
    WorkspaceLeaseInvalidRefError,
  )

  const other = stubAgent('other', '/workspace/project')
  publish(ctx, other)
  await ctx.workspaceLease.ref(other)
  assert.throws(() => ctx.workspaceLease.state(other, ref), WorkspaceLeaseInvalidRefError)
})

test('workspace binding takes child lineage from the immutable session header', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const child = stubAgent('child', '/workspace/project', 'parent')
  publish(ctx, child, 'resume')

  await ctx.workspaceLease.ref(child)

  assert.equal(calls.bind.length, 1)
  assert.deepEqual(
    {
      version: calls.bind[0][0].version,
      sessionId: calls.bind[0][0].sessionId,
      parentSessionId: calls.bind[0][0].parentSessionId,
      cwd: calls.bind[0][0].cwd,
      source: calls.bind[0][0].source,
    },
    {
      version: WORKSPACE_LEASE_PROTOCOL_VERSION,
      sessionId: SessionId('child'),
      parentSessionId: SessionId('parent'),
      cwd: '/workspace/project',
      source: 'resume',
    },
  )
  assert.equal(calls.bind[0][1] instanceof AbortSignal, true)
})

test('a live same-workspace child lineage shares one native binding with distinct local authority', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const parent = stubAgent('parent', '/workspace/project')
  const child = stubAgent('child', '/workspace/project', 'parent')
  publish(ctx, parent)
  await ctx.workspaceLease.ref(parent)
  publish(ctx, child)

  const parentRef = await ctx.workspaceLease.ref(parent)
  const childRef = await ctx.workspaceLease.ref(child)

  assert.notEqual(childRef, parentRef)
  assert.equal(ctx.workspaceLease.state(parent, parentRef), 'owned')
  assert.equal(ctx.workspaceLease.state(child, childRef), 'owned')
  assert.equal(calls.bind.length, 1, 'one trusted runtime lineage owns one nils binding')
  assert.throws(() => ctx.workspaceLease.state(child, parentRef), WorkspaceLeaseInvalidRefError)

  ctx.tools.register(echoTool())
  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:child'),
    name: 'echo',
    arguments: { text: 'child' },
    agent: child,
  })

  assert.equal(result.isError, false)
  assert.equal(result.value, 'child')
  assert.equal(calls.begin[0][0].sessionId, parent.id)
  assert.equal(calls.begin[0][0].callId, CallId('call:child'))

  await child.ctx.fiber.dispose()
  assert.equal(calls.release.length, 0, 'disposing a child does not release the shared binding')
  assert.equal(ctx.workspaceLease.state(parent, parentRef), 'owned')
  await parent.ctx.fiber.dispose()
  assert.equal(calls.release.length, 1)
})

test('a parent session rebind carries its live child lineage onto the new generation', async () => {
  let generation = 0
  const { selected, calls } = provider({
    async bind(request) {
      generation += 1
      return {
        kind: 'bound',
        bindingId: `binding:${generation}`,
        workspaceId: `workspace:${request.cwd}`,
        generation: `generation:${generation}`,
        state: 'owned',
      }
    },
  })
  const ctx = await harness(selected)
  const parent = stubAgent('parent', '/workspace/project')
  const child = stubAgent('child', '/workspace/project', 'parent')
  publish(ctx, parent)
  publish(ctx, child)
  const firstParentRef = await ctx.workspaceLease.ref(parent)
  const firstChildRef = await ctx.workspaceLease.ref(child)

  agentEvents(ctx, parent).emit('agent/session-start', { source: 'compact' })

  const secondParentRef = await ctx.workspaceLease.ref(parent)
  const secondChildRef = await ctx.workspaceLease.ref(child)
  assert.notEqual(secondParentRef, firstParentRef)
  assert.notEqual(secondChildRef, firstChildRef)
  assert.throws(() => ctx.workspaceLease.state(child, firstChildRef), WorkspaceLeaseInvalidRefError)
  assert.equal(ctx.workspaceLease.state(child, secondChildRef), 'owned')
  assert.equal(calls.bind.length, 2)
  assert.equal(calls.release.length, 1)
  assert.equal(calls.release[0][0].reason, 'session-rebound')
})

test('session-object replacement cannot retarget an existing agent binding', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/project')
  publish(ctx, agent)
  const ref = await ctx.workspaceLease.ref(agent)
  const original = agent.session
  agent.session = Session.create(agent.id, original.events, original.header)
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  assert.throws(() => ctx.workspaceLease.state(agent, ref), WorkspaceLeaseInvalidRefError)
  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:replaced-session'),
    name: 'echo',
    arguments: {},
    agent,
  })

  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_REF_INVALID')
  assert.equal(calls.begin.length, 0)
  assert.equal(ran, false)
})

test('session replacement while admission is pending cannot inherit a granted operation', async () => {
  let finishBegin
  let beginStartedResolve
  const beginStarted = new Promise(resolve => { beginStartedResolve = resolve })
  const beginGate = new Promise(resolve => { finishBegin = resolve })
  const { selected, calls } = provider({
    async begin() {
      beginStartedResolve()
      await beginGate
      return { kind: 'granted', operationId: 'operation:pending', fence: 'fence:1' }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/project')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const execution = ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:pending-session-replacement'),
    name: 'echo',
    arguments: {},
    agent,
  })
  await beginStarted
  agent.session = Session.create(agent.id, agent.session.events, agent.session.header)
  finishBegin()
  const result = await execution

  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.equal(calls.complete.length, 1)
  assert.equal(calls.complete[0][0].operationId, 'operation:pending')
  assert.equal(calls.complete[0][0].outcome, 'failed')
})

test('session rebind fences stale refs and releases the prior generation', async () => {
  let generation = 0
  const { selected, calls } = provider({
    async bind(request) {
      generation += 1
      return {
        kind: 'bound',
        bindingId: `binding:${generation}`,
        workspaceId: `workspace:${request.cwd}`,
        generation: `generation:${generation}`,
        state: 'owned',
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/project')
  publish(ctx, agent)
  const first = await ctx.workspaceLease.ref(agent)

  agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
  const second = await ctx.workspaceLease.ref(agent)

  assert.notEqual(second, first)
  assert.throws(() => ctx.workspaceLease.state(agent, first), WorkspaceLeaseInvalidRefError)
  assert.equal(calls.release.length, 1)
  assert.equal(calls.release[0][0].bindingId, 'binding:1')
  assert.equal(calls.release[0][0].generation, 'generation:1')
  assert.equal(calls.release[0][0].reason, 'session-rebound')
  assert.equal(ctx.workspaceLease.state(agent, second), 'owned')
})

test('workspace lease begins before the tool body and completes the exact execution', async () => {
  const sequence = []
  const { selected, calls } = provider({
    async begin(request) {
      sequence.push('begin')
      assert.equal(Object.isFrozen(request.arguments), true)
      return { kind: 'granted', operationId: 'operation:1', fence: 'fence:1' }
    },
    async complete() { sequence.push('complete') },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/project')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(echoTool(sequence))

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:1'),
    name: 'echo',
    arguments: { text: 'hello', workspaceRef: 'model-forgery' },
    agent,
  })

  assert.equal(result.isError, false)
  assert.equal(result.value, 'hello')
  assert.deepEqual(sequence, ['begin', 'body', 'complete'])
  assert.equal(calls.begin[0][0].sessionId, agent.id)
  assert.equal(calls.begin[0][0].callId, CallId('call:1'))
  assert.equal(calls.begin[0][0].rootCallId, CallId('call:1'))
  assert.equal(calls.begin[0][0].toolName, 'echo')
  assert.deepEqual(calls.begin[0][0].arguments, {
    text: 'hello',
    workspaceRef: 'model-forgery',
  })
  assert.equal(calls.begin[0][1] instanceof AbortSignal, true)
  assert.equal(calls.begin[0][1].aborted, false)
  assert.equal(calls.complete[0][0].operationId, 'operation:1')
  assert.equal(calls.complete[0][0].fence, 'fence:1')
  assert.equal(calls.complete[0][0].outcome, 'succeeded')
})

test('denied or unavailable lease fails before the tool body with a stable code', async () => {
  const deniedProvider = provider({
    async begin() {
      return {
        kind: 'denied',
        state: 'foreign-active',
        code: 'WORKSPACE_FOREIGN_ACTIVE',
        reason: 'another session owns this workspace',
      }
    },
  })
  const ctx = await harness(deniedProvider.selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:denied'),
    name: 'echo',
    arguments: {},
    agent,
  })
  assert.equal(ran, false)
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_FOREIGN_ACTIVE')

  const noProvider = await harness()
  const unbound = stubAgent('unbound')
  publish(noProvider, unbound)
  noProvider.tools.register(echoTool())
  const unavailable = await noProvider.tools.execute({
    signal: testSignal,
    callId: CallId('call:unavailable'),
    name: 'echo',
    arguments: {},
    agent: unbound,
  })
  assert.equal(unavailable.isError, true)
  assert.equal(unavailable.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
})

test('provider not-required decision passes without an operation receipt', async () => {
  const { selected, calls } = provider({
    async begin() { return { kind: 'not-required' } },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('reader')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(echoTool())

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:read'),
    name: 'echo',
    arguments: { text: 'read' },
    agent,
  })
  assert.equal(result.isError, false)
  assert.equal(result.value, 'read')
  assert.equal(calls.complete.length, 0)
})

test('approved downstream ask acquires authority before the tool body', async () => {
  const sequence = []
  const { selected, calls } = provider({
    async begin() {
      sequence.push('begin')
      return { kind: 'granted', operationId: 'operation:ask', fence: 'fence:1' }
    },
    async complete() { sequence.push('complete') },
  })
  const ctx = await harness(selected)
  await ctx.plugin(AllowedOnceApproval)
  const agent = stubAgent('ask-owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'confirm mutation' }))
  ctx.tools.register(echoTool(sequence))

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:ask'),
    name: 'echo',
    arguments: { text: 'approved' },
    agent,
  })

  assert.equal(result.isError, false)
  assert.equal(result.value, 'approved')
  assert.equal(calls.begin.length, 1)
  assert.equal(calls.complete.length, 1)
  assert.deepEqual(sequence, ['begin', 'body', 'complete'])
})

test('final DSH guard rejects post-classification execution replacement', async () => {
  for (const beginResult of [
    { kind: 'not-required' },
    { kind: 'granted', operationId: 'operation:replacement', fence: 'fence:1' },
  ]) {
    const { selected, calls } = provider({ async begin() { return beginResult } })
    const ctx = await harness(selected)
    const agent = stubAgent(`replacement-${beginResult.kind}`)
    publish(ctx, agent)
    await ctx.workspaceLease.ref(agent)
    const bodies = []
    ctx.tools.register(echoTool(bodies))
    ctx.tools.register(defineTool({
      name: 'replacement',
      description: 'must never run',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() { bodies.push('replacement-body'); return 'unexpected' },
    }))
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      exec.name = 'replacement'
      exec.arguments = Object.freeze({ replaced: true })
      return decision
    }, { prepend: true })

    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: CallId(`call:replacement-${beginResult.kind}`),
      name: 'echo',
      arguments: { text: 'original' },
      agent,
    })

    assert.equal(result.isError, true)
    assert.match(result.error.message, /workspace lease authorization changed/)
    assert.deepEqual(bodies, [])
    assert.equal(calls.begin.length, 1)
    assert.equal(calls.begin[0][0].toolName, 'echo')
    assert.deepEqual(calls.begin[0][0].arguments, { text: 'original' })
    assert.equal(calls.complete.length, beginResult.kind === 'granted' ? 1 : 0)
    if (calls.complete.length === 1) {
      assert.equal(calls.complete[0][0].toolName, 'echo')
      assert.equal(calls.complete[0][0].outcome, 'failed')
    }
  }
})

test('renewal loss aborts the active tool and completes it as cancelled', async () => {
  const { selected, calls } = provider({
    async bind(request) {
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
        renewAfterMs: 5,
      }
    },
    async renew() {
      return {
        kind: 'lost',
        state: 'uncertain',
        code: 'WORKSPACE_LEASE_LOST',
        reason: 'lease generation no longer belongs to this session',
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(defineTool({
    name: 'wait',
    description: 'wait for cancellation',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(_args, run) {
      return new Promise(resolve => {
        if (run.signal.aborted) resolve('aborted')
        else run.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
    },
  }))

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:renew'),
    name: 'wait',
    arguments: {},
    agent,
  })
  assert.equal(result.isError, true)
  assert.equal(calls.renew.length, 1)
  assert.equal(calls.complete[0][0].operationId, 'operation:call:renew')
  assert.equal(calls.complete[0][0].outcome, 'cancelled')
  assert.deepEqual(agent.cancellations, [{
    kind: 'hook',
    reason: 'workspace-lease-lost:WORKSPACE_LEASE_LOST',
  }])
})

test('renewal loss during admission preserves the provider loss code', async () => {
  const { selected } = provider({
    async bind(request) {
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
        renewAfterMs: 5,
      }
    },
    async begin(_request, signal) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error('admission aborted'))
        else signal.addEventListener('abort', () => reject(new Error('admission aborted')), {
          once: true,
        })
      })
    },
    async renew() {
      return {
        kind: 'lost',
        state: 'uncertain',
        code: 'WORKSPACE_LEASE_LOST',
        reason: 'lease generation no longer belongs to this session',
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:admission-renewal-loss'),
    name: 'echo',
    arguments: {},
    agent,
  })

  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_LOST')
  assert.equal(ran, false)
})

test('agent disposal releases only the exact owned binding', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const first = stubAgent('first', '/workspace/shared')
  const second = stubAgent('second', '/workspace/shared')
  publish(ctx, first)
  publish(ctx, second)
  await Promise.all([ctx.workspaceLease.ref(first), ctx.workspaceLease.ref(second)])

  await first.ctx.fiber.dispose()

  assert.equal(calls.release.length, 1)
  assert.equal(calls.release[0][0].sessionId, first.id)
  assert.equal(calls.release[0][0].bindingId, 'binding:first')
  assert.equal(calls.release[0][0].generation, 'generation:1')
  assert.equal(calls.release[0][0].reason, 'agent-disposed')
  assert.equal(ctx.workspaceLease.state(second, await ctx.workspaceLease.ref(second)), 'owned')
})

test('provider disposal drains bindings and leaves later mutation fail-closed', async () => {
  const { selected, calls } = provider()
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(echoTool())

  await disposeProvider()

  assert.equal(calls.release.length, 1)
  assert.equal(calls.release[0][0].bindingId, 'binding:owner')
  assert.equal(calls.release[0][0].reason, 'provider-disposed')
  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:after-provider'),
    name: 'echo',
    arguments: { text: 'blocked' },
    agent,
  })
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
})

test('provider replacement cannot race an in-progress provider disposal', async () => {
  let releaseStartedResolve
  const releaseStarted = new Promise(resolve => { releaseStartedResolve = resolve })
  let finishRelease
  const releaseGate = new Promise(resolve => { finishRelease = resolve })
  const firstProvider = provider({
    async release() {
      releaseStartedResolve()
      await releaseGate
    },
  })
  const replacementProvider = provider()
  const ctx = await harness()
  const disposeFirst = ctx.workspaceLease.registerProvider(firstProvider.selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)

  const disposing = disposeFirst()
  await releaseStarted
  let replacementDisposer
  let replacementError
  try {
    replacementDisposer = ctx.workspaceLease.registerProvider(replacementProvider.selected)
  } catch (error) {
    replacementError = error
  }
  finishRelease()
  await disposing
  await replacementDisposer?.()

  assert.equal(replacementError instanceof WorkspaceLeaseError, true)
  const disposeReplacement = ctx.workspaceLease.registerProvider(replacementProvider.selected)
  assert.equal(ctx.workspaceLease.state(agent, await ctx.workspaceLease.ref(agent)), 'owned')
  await disposeReplacement()
})

test('invalid bound states fail closed instead of becoming workspace authority', async () => {
  const invalid = provider({
    async bind(request) {
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'foreign-active',
      }
    },
  })
  const ctx = await harness(invalid.selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)

  await assert.rejects(
    ctx.workspaceLease.ref(agent),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
})

test('downstream policy denial does not acquire a mutation lease', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'policy denied' }))
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:policy-denied'),
    name: 'echo',
    arguments: {},
    agent,
  })

  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.equal(calls.begin.length, 0)
  assert.equal(calls.complete.length, 0)
})

test('a DSH guard denial completes acquired authority without running the body', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.guard(() => 'guard denied after admission')
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:guard-denied'),
    name: 'echo',
    arguments: {},
    agent,
  })

  assert.equal(result.isError, true)
  assert.equal(ran, false)
  assert.equal(calls.begin.length, 1)
  assert.equal(calls.complete.length, 1)
  assert.equal(calls.complete[0][0].operationId, 'operation:call:guard-denied')
  assert.equal(calls.complete[0][0].outcome, 'failed')
})

test('provider protocol mismatch is rejected before it can bind a session', async () => {
  const { selected } = provider()
  selected.protocolVersion = WORKSPACE_LEASE_PROTOCOL_VERSION + 1
  const ctx = await harness()

  assert.throws(
    () => ctx.workspaceLease.registerProvider(selected),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
})

test('provider registration validates the complete protocol surface', async () => {
  const ctx = await harness()
  assert.throws(
    () => ctx.workspaceLease.registerProvider(null),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
  assert.throws(
    () => ctx.workspaceLease.registerProvider({
      protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
      async bind() {},
      async begin() {},
      async complete() {},
      async renew() {},
    }),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE'
      && error.message === 'workspace lease provider is missing release()',
  )
})

test('non-object provider results fail with the stable unavailable state', async () => {
  const invalidBind = provider({ async bind() { return null } })
  const bindContext = await harness(invalidBind.selected)
  const bindAgent = stubAgent('bind-owner')
  publish(bindContext, bindAgent)
  await assert.rejects(
    bindContext.workspaceLease.ref(bindAgent),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )

  const invalidBegin = provider({ async begin() { return null } })
  const beginContext = await harness(invalidBegin.selected)
  const beginAgent = stubAgent('begin-owner')
  publish(beginContext, beginAgent)
  await beginContext.workspaceLease.ref(beginAgent)
  beginContext.tools.register(echoTool())
  const result = await beginContext.tools.execute({
    signal: testSignal,
    callId: CallId('call:null-begin'),
    name: 'echo',
    arguments: {},
    agent: beginAgent,
  })
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
})

test('session rebind stays fail-closed when the prior generation cannot release', async () => {
  let generation = 0
  const { selected, calls } = provider({
    async bind(request) {
      generation += 1
      return {
        kind: 'bound',
        bindingId: `binding:${generation}`,
        workspaceId: `workspace:${request.cwd}`,
        generation: `generation:${generation}`,
        state: 'owned',
      }
    },
    async release() { throw new Error('durable release failed') },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)

  agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })

  await assert.rejects(ctx.workspaceLease.ref(agent))
  assert.equal(calls.bind.length, 1)
})

test('provider disposer drains a bind that was still in flight', async () => {
  let finishBind
  const bindGate = new Promise(resolve => { finishBind = resolve })
  let releaseStartedResolve
  const releaseStarted = new Promise(resolve => { releaseStartedResolve = resolve })
  let finishRelease
  const releaseGate = new Promise(resolve => { finishRelease = resolve })
  const { selected } = provider({
    async bind(request) {
      await bindGate
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
      }
    },
    async release() {
      releaseStartedResolve()
      await releaseGate
    },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  const pendingRef = ctx.workspaceLease.ref(agent)
  let disposed = false
  const disposing = disposeProvider().then(() => { disposed = true })

  await new Promise(resolve => setImmediate(resolve))
  const disposedBeforeBind = disposed
  finishBind()
  await releaseStarted
  const disposedBeforeRelease = disposed
  finishRelease()
  await disposing

  assert.equal(disposedBeforeBind, false)
  assert.equal(disposedBeforeRelease, false)
  await assert.rejects(pendingRef)
})

test('provider disposer reports durable release failure', async () => {
  const { selected } = provider({
    async release() { throw new Error('durable release failed') },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)

  await assert.rejects(disposeProvider(), AggregateError)
  const replacement = provider()
  assert.throws(
    () => ctx.workspaceLease.registerProvider(replacement.selected),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
  assert.equal(replacement.calls.bind.length, 0)
})

test('concurrent agent and provider disposal join one durable release', async () => {
  let releaseStartedResolve
  const releaseStarted = new Promise(resolve => { releaseStartedResolve = resolve })
  let finishRelease
  const releaseGate = new Promise(resolve => { finishRelease = resolve })
  const { selected, calls } = provider({
    async release() {
      releaseStartedResolve()
      await releaseGate
    },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)

  let agentDisposed = false
  let providerDisposed = false
  const disposingAgent = agent.ctx.fiber.dispose().then(() => { agentDisposed = true })
  await releaseStarted
  const disposingProvider = disposeProvider().then(() => { providerDisposed = true })
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeRelease = { agentDisposed, providerDisposed }
  finishRelease()
  await Promise.all([disposingAgent, disposingProvider])

  assert.deepEqual(settledBeforeRelease, { agentDisposed: false, providerDisposed: false })
  assert.equal(calls.release.length, 1)
})

test('provider disposal aborts an in-flight completion request before release', async () => {
  let completeStartedResolve
  const completeStarted = new Promise(resolve => { completeStartedResolve = resolve })
  let finishComplete = () => {}
  let completionSignal
  const { selected } = provider({
    async complete(_request, signal) {
      completionSignal = signal
      completeStartedResolve()
      await new Promise(resolve => {
        finishComplete = resolve
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
    },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(echoTool())

  const toolResult = ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:completion-drain'),
    name: 'echo',
    arguments: { text: 'done' },
    agent,
  })
  await completeStarted
  const disposing = disposeProvider()
  await new Promise(resolve => setImmediate(resolve))
  const lifecycleAbortObserved = completionSignal.aborted
  finishComplete()
  await Promise.allSettled([toolResult, disposing])

  assert.equal(lifecycleAbortObserved, true)
})

test('provider disposal drains an in-flight admission and rejects its late grant', async () => {
  const sequence = []
  let beginStartedResolve
  const beginStarted = new Promise(resolve => { beginStartedResolve = resolve })
  let finishBegin
  const beginGate = new Promise(resolve => { finishBegin = resolve })
  let admissionSignal
  const { selected } = provider({
    async begin(_request, signal) {
      admissionSignal = signal
      sequence.push('begin')
      beginStartedResolve()
      await beginGate
      sequence.push('grant')
      return { kind: 'granted', operationId: 'operation:late', fence: 'fence:late' }
    },
    async release() { sequence.push('release') },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  let ran = false
  ctx.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const toolResult = ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:late-grant'),
    name: 'echo',
    arguments: {},
    agent,
  })
  await beginStarted
  let disposed = false
  const disposing = disposeProvider().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  const abortObserved = admissionSignal.aborted
  const disposedBeforeGrant = disposed
  finishBegin()
  const [result] = await Promise.all([toolResult, disposing])

  assert.equal(abortObserved, true)
  assert.equal(disposedBeforeGrant, false)
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
  assert.equal(ran, false)
  assert.deepEqual(sequence, ['begin', 'grant', 'release'])
})

test('unknown renewal result loses authority instead of being treated as renewed', async () => {
  const { selected } = provider({
    async bind(request) {
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
        renewAfterMs: 5,
      }
    },
    async renew() { return { kind: 'future-version' } },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  const ref = await ctx.workspaceLease.ref(agent)

  await new Promise(resolve => setTimeout(resolve, 15))

  assert.equal(ctx.workspaceLease.state(agent, ref), 'unavailable')
})

test('provider disposal aborts and drains an in-flight renewal before release', async () => {
  const sequence = []
  let renewalStartedResolve
  const renewalStarted = new Promise(resolve => { renewalStartedResolve = resolve })
  const { selected } = provider({
    async bind(request) {
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
        renewAfterMs: 5,
      }
    },
    async renew(_request, signal) {
      sequence.push('renew-start')
      renewalStartedResolve()
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      sequence.push('renew-abort')
      return { kind: 'renewed' }
    },
    async release() { sequence.push('release') },
  })
  const ctx = await harness()
  const disposeProvider = ctx.workspaceLease.registerProvider(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)

  await renewalStarted
  await disposeProvider()

  assert.deepEqual(sequence, ['renew-start', 'renew-abort', 'release'])
})

test('a release failure from an in-flight prior bind blocks the next generation', async () => {
  let finishBind
  const bindGate = new Promise(resolve => { finishBind = resolve })
  const { selected, calls } = provider({
    async bind(request) {
      await bindGate
      return {
        kind: 'bound',
        bindingId: `binding:${request.sessionId}`,
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
      }
    },
    async release() { throw new Error('durable release failed') },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  const first = ctx.workspaceLease.ref(agent)

  agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
  const second = ctx.workspaceLease.ref(agent)
  finishBind()

  await assert.rejects(first)
  await assert.rejects(
    second,
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_RELEASE_FAILED',
  )
  assert.equal(calls.bind.length, 1)
})

test('unknown bind and begin response kinds fail closed', async () => {
  const invalidBind = provider({
    async bind() {
      return {
        kind: 'future-version',
        bindingId: 'binding:owner',
        workspaceId: 'workspace:project',
        generation: 'generation:1',
        state: 'owned',
      }
    },
  })
  const bindContext = await harness(invalidBind.selected)
  const bindAgent = stubAgent('bind-owner')
  publish(bindContext, bindAgent)
  await assert.rejects(
    bindContext.workspaceLease.ref(bindAgent),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )

  const invalidBegin = provider({
    async begin() {
      return { kind: 'future-version', operationId: 'operation:1', fence: 'fence:1' }
    },
  })
  const beginContext = await harness(invalidBegin.selected)
  const beginAgent = stubAgent('begin-owner')
  publish(beginContext, beginAgent)
  await beginContext.workspaceLease.ref(beginAgent)
  let ran = false
  beginContext.tools.register({
    ...echoTool(),
    async execute() { ran = true; return 'unexpected' },
  })

  const result = await beginContext.tools.execute({
    signal: testSignal,
    callId: CallId('call:invalid-begin'),
    name: 'echo',
    arguments: {},
    agent: beginAgent,
  })
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
  assert.equal(ran, false)
})

test('malformed provider denial cannot expose untrusted reason text', async () => {
  const invalid = provider({
    async begin() {
      return {
        kind: 'denied',
        state: 'foreign-active',
        code: 'WORKSPACE_FOREIGN_ACTIVE',
        reason: 'protected-value\nsecond-line',
      }
    },
  })
  const ctx = await harness(invalid.selected)
  const agent = stubAgent('owner')
  publish(ctx, agent)
  await ctx.workspaceLease.ref(agent)
  ctx.tools.register(echoTool())

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:invalid-denial'),
    name: 'echo',
    arguments: {},
    agent,
  })
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
  assert.equal(result.error.message, 'workspace lease provider returned an invalid denial')
  assert.equal(JSON.stringify(result).includes('protected-value'), false)
})
