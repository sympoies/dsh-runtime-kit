import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const CallId = llmModule.ToolCallId ?? llmModule.CallId

function sessionEvents(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

import {
  WORKSPACE_LEASE_PROTOCOL_VERSION,
  WorkspaceLease,
  WorkspaceLeaseError,
  WorkspaceLeaseInvalidRefError,
  trackQuarantineCapabilities,
} from '@sympoies/dsh-runtime-kit/workspace-lease'

const testSignal = new AbortController().signal

const REPO_A = { workspaceKey: 'key:repo-a', root: '/workspace/repo-a' }
const REPO_B = { workspaceKey: 'key:repo-b', root: '/workspace/repo-b' }

function stubAgent(rawId, cwd = '/workspace/repo-a', parentSession) {
  const id = SessionId(rawId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd,
    isSeeded: false,
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

/**
 * The default stub models the shipped nils contract: an anchor bind that owns
 * the repository containing the session cwd, classification that only claims
 * exact structured mutations, and one durable generation per canonical
 * workspace key.
 */
function provider(overrides = {}) {
  const calls = { resolve: [], bind: [], begin: [], complete: [], renew: [], release: [] }
  let generation = 0
  const anchorFor = cwd => [REPO_A, REPO_B].find(target => cwd?.startsWith(target.root))
  const selected = {
    protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
    async resolve(request, signal) {
      calls.resolve.push([request, signal])
      if (overrides.resolve !== undefined) return overrides.resolve(request, signal)
      return { kind: 'not-required' }
    },
    async bind(request, signal) {
      calls.bind.push([request, signal])
      if (overrides.bind !== undefined) return overrides.bind(request, signal)
      const target = request.target ?? anchorFor(request.cwd)
      if (target === undefined) return { kind: 'not-required' }
      generation += 1
      return {
        kind: 'bound',
        bindingId: `binding:${target.workspaceKey}:${generation}`,
        workspaceId: `workspace:${target.workspaceKey}`,
        generation: `generation:${generation}`,
        state: 'owned',
        target,
      }
    },
    async begin(request, signal) {
      calls.begin.push([request, signal])
      if (overrides.begin !== undefined) return overrides.begin(request, signal)
      return {
        kind: 'granted',
        operationId: `operation:${request.callId}:${request.target.workspaceKey}`,
        fence: `fence:${request.target.workspaceKey}`,
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

/** Classify `write` calls into the repository named by their `file_path`. */
function writeTargets(request) {
  if (request.toolName !== 'write') return { kind: 'not-required' }
  const path = request.arguments?.file_path
  const targets = [REPO_A, REPO_B].filter(target => path?.startsWith(target.root))
  if (targets.length === 0) return { kind: 'not-required' }
  return { kind: 'targets', targets }
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

function writeTool(sequence) {
  return defineTool({
    name: 'write',
    description: 'write',
    parameters: { file_path: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      sequence?.push(args.file_path)
      return args.file_path
    },
  })
}

function runTool(ctx, agent, name, args, callId) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(callId),
    name,
    arguments: args,
    agent,
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
  const owner = stubAgent('owner')
  publish(ctx, owner)

  const ref = await ctx.workspaceLease.ref(owner)
  assert.equal(Object.isFrozen(ref), true)
  assert.deepEqual(Object.keys(ref), [])
  assert.equal(JSON.stringify(ref), '{}')
  assert.equal(await ctx.workspaceLease.state(owner, ref), 'owned')
  await assert.rejects(
    ctx.workspaceLease.state(owner, structuredClone(ref)),
    WorkspaceLeaseInvalidRefError,
  )

  const other = stubAgent('other')
  publish(ctx, other)
  await assert.rejects(ctx.workspaceLease.state(other, ref), WorkspaceLeaseInvalidRefError)
})

test('the session anchor is context: a non-repository anchor owns no repository lease', async () => {
  const { selected, calls } = provider()
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/srv/notes')
  publish(ctx, agent)

  const ref = await ctx.workspaceLease.ref(agent)
  assert.equal(await ctx.workspaceLease.state(agent, ref), 'unmanaged')
  assert.equal(await ctx.workspaceLease.denialState(agent), null)
  assert.equal(calls.bind.length, 1)
  assert.equal(calls.bind[0][0].cwd, '/srv/notes')
  assert.equal(calls.bind[0][0].version, WORKSPACE_LEASE_PROTOCOL_VERSION)

  // A non-repository write still runs with full host authority.
  const sequence = []
  ctx.tools.register(writeTool(sequence))
  const result = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/srv/notes/todo.md' },
    'call:nonrepo',
  )

  assert.equal(result.isError, false)
  assert.deepEqual(sequence, ['/srv/notes/todo.md'])
  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.begin.length, 0)
  assert.equal(calls.complete.length, 0)
})

test('a dirty anchor denies only its own repository and never quarantines the session', async () => {
  const { selected, calls } = provider({
    resolve: writeTargets,
    async bind(request) {
      if (request.cwd !== undefined || request.target.workspaceKey === REPO_A.workspaceKey) {
        return {
          kind: 'denied',
          state: 'dirty',
          code: 'WORKSPACE_DIRTY',
          reason: 'the workspace has uncommitted state',
        }
      }
      return {
        kind: 'bound',
        bindingId: 'binding:b',
        workspaceId: 'workspace:b',
        generation: 'generation:1',
        state: 'owned',
        target: request.target,
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)

  const ref = await ctx.workspaceLease.ref(agent)
  assert.equal(await ctx.workspaceLease.state(agent, ref), 'dirty')
  assert.deepEqual(await ctx.workspaceLease.denialState(agent), {
    state: 'dirty',
    code: 'WORKSPACE_DIRTY',
  })

  // Ordinary unscoped tools keep running in a dirty-anchor session.
  const sequence = []
  ctx.tools.register(echoTool(sequence))
  ctx.tools.register(writeTool(sequence))
  const ordinary = await runTool(ctx, agent, 'echo', { text: 'still working' }, 'call:echo')
  assert.equal(ordinary.isError, false)
  assert.equal(ordinary.value, 'still working')

  // A write outside any repository proceeds.
  const outside = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/srv/notes/todo.md' },
    'call:outside',
  )
  assert.equal(outside.isError, false)

  // A write into the dirty repository is denied with its exact typed cause.
  const denied = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/src/index.js' },
    'call:dirty',
  )
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'WORKSPACE_DIRTY')

  // A clean sibling repository stays independently usable in the same session.
  const allowed = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-b/src/index.js' },
    'call:clean',
  )
  assert.equal(allowed.isError, false)
  assert.deepEqual(sequence, [
    'still working',
    '/srv/notes/todo.md',
    '/workspace/repo-b/src/index.js',
  ].map((value, index) => (index === 0 ? 'body' : value)))
  assert.equal(calls.begin.length, 1)
  assert.equal(calls.begin[0][0].target.workspaceKey, REPO_B.workspaceKey)
})

test('one session acquires independent bindings for two repositories and reuses each', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  await ctx.workspaceLease.state(agent, await ctx.workspaceLease.ref(agent))
  ctx.tools.register(writeTool())

  for (const [callId, path] of [
    ['call:a1', '/workspace/repo-a/one.js'],
    ['call:b1', '/workspace/repo-b/one.js'],
    ['call:a2', '/workspace/repo-a/two.js'],
    ['call:b2', '/workspace/repo-b/two.js'],
  ]) {
    const result = await runTool(ctx, agent, 'write', { file_path: path }, callId)
    assert.equal(result.isError, false, `${path}: ${result.error?.message}`)
  }

  // One eager anchor bind for repository A plus one lazy bind for B. Each
  // later operation reuses its repository's live generation.
  assert.equal(calls.bind.length, 2)
  assert.deepEqual(
    calls.bind.map(([request]) => request.target?.workspaceKey ?? 'anchor'),
    ['anchor', REPO_B.workspaceKey],
  )
  assert.equal(calls.begin.length, 4)
  assert.equal(calls.complete.length, 4)

  const bindings = new Map(calls.begin.map(([request]) => [
    request.target.workspaceKey,
    request.bindingId,
  ]))
  assert.equal(bindings.size, 2)
  assert.notEqual(bindings.get(REPO_A.workspaceKey), bindings.get(REPO_B.workspaceKey))
  for (const [request] of calls.complete) {
    const begun = calls.begin.find(([begin]) => begin.callId === request.callId
      && begin.bindingId === request.bindingId)
    assert.ok(begun !== undefined, 'completion binds to the exact admitted generation')
    assert.equal(request.outcome, 'succeeded')
  }

  await agent.ctx.fiber.dispose()
  assert.equal(calls.release.length, 2, 'disposal drains every acquired repository')
  assert.deepEqual(
    new Set(calls.release.map(([request]) => request.reason)),
    new Set(['agent-disposed']),
  )
})

test('a foreign live owner denies only its own repository target', async () => {
  const { selected } = provider({
    resolve: writeTargets,
    async bind(request) {
      if (request.target?.workspaceKey === REPO_B.workspaceKey) {
        return {
          kind: 'denied',
          state: 'foreign-active',
          code: 'WORKSPACE_FOREIGN_ACTIVE',
          reason: 'another live session owns this workspace',
        }
      }
      return {
        kind: 'bound',
        bindingId: 'binding:a',
        workspaceId: 'workspace:a',
        generation: 'generation:1',
        state: 'owned',
        target: request.target ?? REPO_A,
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())

  const denied = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-b/one.js' },
    'call:foreign',
  )
  assert.equal(denied.isError, true)
  assert.equal(denied.error.info.code, 'WORKSPACE_FOREIGN_ACTIVE')

  const allowed = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/one.js' },
    'call:own',
  )
  assert.equal(allowed.isError, false)
})

test('a denied protected target cannot partially dispatch an already fenced sibling', async () => {
  const sequence = []
  const { selected, calls } = provider({
    resolve: () => ({ kind: 'targets', targets: [REPO_A, REPO_B] }),
    async begin(request) {
      if (request.target.workspaceKey === REPO_B.workspaceKey) {
        return {
          kind: 'denied',
          state: 'dirty',
          code: 'WORKSPACE_DIRTY',
          reason: 'the workspace has uncommitted state',
        }
      }
      return { kind: 'granted', operationId: 'operation:a', fence: 'fence:a' }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool(sequence))

  const result = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/one.js' },
    'call:multi',
  )

  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_DIRTY')
  assert.deepEqual(sequence, [], 'no tool body may run after a protected target is denied')
  assert.equal(calls.complete.length, 1, 'the granted sibling receives a terminal outcome')
  assert.equal(calls.complete[0][0].operationId, 'operation:a')
  assert.equal(calls.complete[0][0].outcome, 'failed')
})

test('targets are acquired in the provider order the resolver returned', async () => {
  const { selected, calls } = provider({
    resolve: () => ({ kind: 'targets', targets: [REPO_B, REPO_A] }),
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/srv/notes')
  publish(ctx, agent)
  ctx.tools.register(writeTool())

  const result = await runTool(ctx, agent, 'write', { file_path: '/srv/x' }, 'call:order')
  assert.equal(result.isError, false)
  assert.deepEqual(
    calls.bind.filter(([request]) => request.target !== undefined)
      .map(([request]) => request.target.workspaceKey),
    [REPO_B.workspaceKey, REPO_A.workspaceKey],
  )
  assert.deepEqual(
    calls.begin.map(([request]) => request.target.workspaceKey),
    [REPO_B.workspaceKey, REPO_A.workspaceKey],
  )
})

test('an unscoped native host operation claims no repository fence', async () => {
  const sequence = []
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(echoTool(sequence))

  const result = await runTool(ctx, agent, 'echo', { text: 'rm -rf build' }, 'call:shell')

  assert.equal(result.isError, false)
  assert.deepEqual(sequence, ['body'])
  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.resolve[0][0].toolName, 'echo')
  assert.equal(calls.resolve[0][0].anchorCwd, '/workspace/repo-a')
  assert.equal(calls.begin.length, 0)
  assert.equal(calls.complete.length, 0)
})

test('the runtime echoes only the exact provider target and freezes it', async () => {
  const forged = { workspaceKey: 'key:forged', root: '/workspace/repo-a', extra: 'ignored' }
  const { selected, calls } = provider({
    resolve: () => ({ kind: 'targets', targets: [forged] }),
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/srv/notes')
  publish(ctx, agent)
  ctx.tools.register(writeTool())

  const result = await runTool(ctx, agent, 'write', { file_path: '/srv/x' }, 'call:frozen')
  assert.equal(result.isError, false)
  const [request] = calls.bind.find(([candidate]) => candidate.target !== undefined)
  assert.deepEqual(request.target, { workspaceKey: 'key:forged', root: '/workspace/repo-a' })
  assert.equal(Object.isFrozen(request.target), true)
})

test('a malformed resolve projection fails closed before any acquisition', async () => {
  for (const projection of [
    { kind: 'targets', targets: [] },
    { kind: 'targets', targets: [{ workspaceKey: 'key:a', root: 'relative/path' }] },
    { kind: 'targets', targets: [REPO_A, { ...REPO_A }] },
    { kind: 'targets', targets: Array.from({ length: 17 }, (_, index) => ({
      workspaceKey: `key:${index}`,
      root: `/workspace/repo-${index}`,
    })) },
    { kind: 'unknown' },
  ]) {
    const { selected, calls } = provider({ resolve: () => projection })
    const ctx = await harness(selected)
    const agent = stubAgent('owner', '/srv/notes')
    publish(ctx, agent)
    const sequence = []
    ctx.tools.register(writeTool(sequence))

    const result = await runTool(ctx, agent, 'write', { file_path: '/srv/x' }, 'call:malformed')
    assert.equal(result.isError, true, JSON.stringify(projection))
    assert.equal(result.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
    assert.deepEqual(sequence, [])
    assert.equal(calls.bind.filter(([request]) => request.target !== undefined).length, 0)
  }
})

test('an approved one-shot call cannot bypass repository authority', async () => {
  const sequence = []
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  await ctx.plugin(AllowedOnceApproval)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool(sequence))
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'confirm mutation' }))

  const result = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/one.js' },
    'call:ask',
  )

  assert.equal(result.isError, false)
  assert.deepEqual(sequence, ['/workspace/repo-a/one.js'])
  assert.equal(calls.begin.length, 1)
  assert.equal(calls.complete.length, 1)
  assert.equal(calls.complete[0][0].outcome, 'succeeded')
})

test('a replaced session cannot inherit an admitted repository operation', async () => {
  let finishBegin
  let beginStartedResolve
  const beginStarted = new Promise(resolve => { beginStartedResolve = resolve })
  const beginGate = new Promise(resolve => { finishBegin = resolve })
  const { selected, calls } = provider({
    resolve: writeTargets,
    async begin() {
      beginStartedResolve()
      await beginGate
      return { kind: 'granted', operationId: 'operation:pending', fence: 'fence:1' }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  const sequence = []
  ctx.tools.register(writeTool(sequence))

  const execution = runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/one.js' },
    'call:replaced',
  )
  await beginStarted
  agent.session = Session.create(agent.id, sessionEvents(agent.session), agent.session.header)
  finishBegin()
  const result = await execution

  assert.equal(result.isError, true)
  assert.deepEqual(sequence, [])
  assert.equal(calls.complete.length, 1)
  assert.equal(calls.complete[0][0].operationId, 'operation:pending')
  assert.notEqual(calls.complete[0][0].outcome, 'succeeded')
})

test('losing one repository generation leaves the other repository usable', async () => {
  let lose = false
  const { selected, calls } = provider({
    resolve: writeTargets,
    async renew(request) {
      if (lose && request.workspaceId === 'workspace:key:repo-a') {
        return {
          kind: 'lost',
          state: 'foreign-active',
          code: 'WORKSPACE_BINDING_STALE',
          reason: 'generation no longer owns this workspace',
        }
      }
      return { kind: 'renewed' }
    },
    async bind(request) {
      const target = request.target
        ?? [REPO_A, REPO_B].find(candidate => request.cwd?.startsWith(candidate.root))
      if (target === undefined) return { kind: 'not-required' }
      if (lose && target.workspaceKey === REPO_A.workspaceKey) {
        return {
          kind: 'denied',
          state: 'foreign-active',
          code: 'WORKSPACE_FOREIGN_ACTIVE',
          reason: 'another live session owns this workspace',
        }
      }
      return {
        kind: 'bound',
        bindingId: `binding:${target.workspaceKey}`,
        workspaceId: `workspace:${target.workspaceKey}`,
        generation: 'generation:1',
        state: 'owned',
        target,
        renewAfterMs: 1,
      }
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())

  assert.equal(
    (await runTool(ctx, agent, 'write', { file_path: '/workspace/repo-a/one.js' }, 'call:a'))
      .isError,
    false,
  )
  assert.equal(
    (await runTool(ctx, agent, 'write', { file_path: '/workspace/repo-b/one.js' }, 'call:b'))
      .isError,
    false,
  )

  lose = true
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(calls.renew.length > 0)

  const lost = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/two.js' },
    'call:a-lost',
  )
  assert.equal(lost.isError, true)
  assert.equal(lost.error.info.code, 'WORKSPACE_FOREIGN_ACTIVE')

  const survivor = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-b/two.js' },
    'call:b-live',
  )
  assert.equal(survivor.isError, false, survivor.error?.message)
})

test('one live lineage owns one shared authority set', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const parent = stubAgent('parent', '/workspace/repo-a')
  const child = stubAgent('child', '/workspace/repo-b', 'parent')
  publish(ctx, parent)
  await ctx.workspaceLease.state(parent, await ctx.workspaceLease.ref(parent))
  publish(ctx, child)

  const parentRef = await ctx.workspaceLease.ref(parent)
  const childRef = await ctx.workspaceLease.ref(child)
  assert.notEqual(childRef, parentRef)
  await assert.rejects(
    ctx.workspaceLease.state(child, parentRef),
    WorkspaceLeaseInvalidRefError,
  )

  ctx.tools.register(writeTool())
  // The child works in the parent's anchor repository without contending.
  assert.equal(
    (await runTool(ctx, child, 'write', { file_path: '/workspace/repo-a/one.js' }, 'call:child-a'))
      .isError,
    false,
  )
  assert.equal(
    (await runTool(ctx, parent, 'write', { file_path: '/workspace/repo-a/two.js' }, 'call:parent-a'))
      .isError,
    false,
  )
  assert.equal(
    calls.bind.filter(([request]) => request.target !== undefined).length,
    0,
    'the shared anchor generation is reused rather than rebound',
  )
  assert.equal(calls.begin.length, 2)
  assert.deepEqual(
    new Set(calls.begin.map(([request]) => request.bindingId)).size,
    1,
    'one lineage presents one durable owner per repository',
  )

  await child.ctx.fiber.dispose()
  assert.equal(calls.release.length, 0, 'disposing a child releases no shared authority')
  await parent.ctx.fiber.dispose()
  assert.equal(calls.release.length, 1)
})

test('an independent top-level session reaches the provider on its own', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const first = stubAgent('first', '/workspace/repo-a')
  const second = stubAgent('second', '/workspace/repo-a')
  publish(ctx, first)
  publish(ctx, second)
  await ctx.workspaceLease.state(first, await ctx.workspaceLease.ref(first))
  await ctx.workspaceLease.state(second, await ctx.workspaceLease.ref(second))

  assert.equal(calls.bind.length, 2)
  assert.deepEqual(new Set(calls.bind.map(([request]) => request.sessionId)).size, 2)
})

test('a session rebind releases every prior generation before acquiring again', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())
  await runTool(ctx, agent, 'write', { file_path: '/workspace/repo-b/one.js' }, 'call:b')
  const firstRef = await ctx.workspaceLease.ref(agent)

  agentEvents(ctx, agent).emit('agent/session-start', { source: 'compact' })
  const secondRef = await ctx.workspaceLease.ref(agent)
  assert.notEqual(secondRef, firstRef)
  await assert.rejects(
    ctx.workspaceLease.state(agent, firstRef),
    WorkspaceLeaseInvalidRefError,
  )
  assert.equal(await ctx.workspaceLease.state(agent, secondRef), 'owned')

  assert.equal(calls.release.length, 2, 'both acquired repositories are retired')
  assert.deepEqual(
    new Set(calls.release.map(([request]) => request.reason)),
    new Set(['session-rebound']),
  )
  const anchorBinds = calls.bind.filter(([request]) => request.cwd !== undefined)
  assert.equal(anchorBinds.length, 2)
  assert.equal(anchorBinds[1][0].source, 'compact')
})

test('provider disposal drains and releases every repository generation', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const dispose = ctx.workspaceLease.registerProvider
  assert.equal(typeof dispose, 'function')
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())
  await runTool(ctx, agent, 'write', { file_path: '/workspace/repo-b/one.js' }, 'call:b')
  assert.equal(calls.bind.length, 2)

  await ctx.fiber.dispose()
  assert.equal(calls.release.length, 2)
  assert.deepEqual(
    new Set(calls.release.map(([request]) => request.reason)),
    new Set(['provider-disposed']),
  )
})

test('only one provider declaring the exact protocol generation may register', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(WorkspaceLease)

  const { selected } = provider()
  assert.throws(
    () => ctx.workspaceLease.registerProvider({ ...selected, protocolVersion: 1 }),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
  const { resolve, ...withoutResolve } = selected
  assert.equal(typeof resolve, 'function')
  assert.throws(
    () => ctx.workspaceLease.registerProvider(withoutResolve),
    error => error instanceof WorkspaceLeaseError
      && /missing resolve/.test(error.message),
  )

  ctx.workspaceLease.registerProvider(selected)
  assert.throws(
    () => ctx.workspaceLease.registerProvider(provider().selected),
    error => error instanceof WorkspaceLeaseError && /already registered/.test(error.message),
  )
})

test('an execution without a live classification marker never reaches a tool body', async () => {
  const sequence = []
  const { selected } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool(sequence))
  // A later listener that resolves pre-execute without the service marker
  // must not be able to dispatch: the monotonic guard consumes the marker.
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))

  const result = await ctx.tools.execute({
    signal: testSignal,
    callId: CallId('call:unmarked'),
    name: 'write',
    arguments: { file_path: '/workspace/repo-a/one.js' },
    agent,
  })

  assert.equal(result.isError, false, 'the prepended service still classifies the call')
  assert.deepEqual(sequence, ['/workspace/repo-a/one.js'])
})

test('a failed completion loses only its own repository and cancels its owner', async () => {
  const { selected, calls } = provider({
    resolve: writeTargets,
    async complete(request) {
      if (request.workspaceId === 'workspace:key:repo-a') throw new Error('transport lost')
      return undefined
    },
  })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())

  const failed = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-a/one.js' },
    'call:a',
  )
  assert.equal(failed.isError, true)
  assert.equal(failed.error.info.code, 'WORKSPACE_LEASE_UNAVAILABLE')
  assert.ok(agent.cancellations.some(cause => cause.reason.startsWith('workspace-lease-lost:')))

  const survivor = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-b/one.js' },
    'call:b',
  )
  assert.equal(survivor.isError, false, survivor.error?.message)
  assert.deepEqual(
    calls.complete.map(([request]) => [request.workspaceId, request.outcome]),
    [['workspace:key:repo-a', 'succeeded'], ['workspace:key:repo-b', 'succeeded']],
    'each repository records exactly one terminal outcome attempt',
  )
})

test('a quarantine capability registration remains identity-exact', async () => {
  const { selected } = provider()
  const ctx = await harness(selected)
  const definition = echoTool()
  ctx.tools.register(definition)

  const stop = trackQuarantineCapabilities(ctx, ctx.workspaceLease, ['echo'])
  assert.throws(
    () => ctx.workspaceLease.registerQuarantineCapability({ ...definition }),
    error => error instanceof WorkspaceLeaseError
      && /not a registered global tool/.test(error.message),
  )
  assert.throws(
    () => trackQuarantineCapabilities(ctx, ctx.workspaceLease, []),
    TypeError,
  )
  stop()
})

test('one execution resolves its repository targets once for the ledger and admission', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(writeTool())
  const observed = []
  // Registered without prepend, so it runs inside the service's own
  // downstream waterfall exactly where the finish-line ledger sits.
  ctx.on('tools/pre-execute', async (exec, next) => {
    observed.push(await ctx.workspaceLease.targets(exec))
    return next()
  })

  const result = await runTool(
    ctx,
    agent,
    'write',
    { file_path: '/workspace/repo-b/one.js' },
    'call:b',
  )

  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(observed, [[REPO_B.root]])
  assert.equal(Object.isFrozen(observed[0]), true)
  assert.equal(calls.resolve.length, 1, 'the ledger and the admission share one provider decision')
  assert.equal(calls.begin.length, 1)
  assert.equal(calls.begin[0][0].target.workspaceKey, REPO_B.workspaceKey)
})

test('an unscoped operation projects no repository target', async () => {
  const { selected, calls } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  ctx.tools.register(echoTool())
  const observed = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    observed.push(await ctx.workspaceLease.targets(exec))
    return next()
  })

  assert.equal((await runTool(ctx, agent, 'echo', { text: 'hi' }, 'call:echo')).isError, false)
  assert.deepEqual(observed, [[]])
  assert.equal(calls.resolve.length, 1)
  assert.equal(calls.begin.length, 0)
})

test('a target projection is refused for anything but one exact live execution', async () => {
  const { selected } = provider({ resolve: writeTargets })
  const ctx = await harness(selected)
  const agent = stubAgent('owner', '/workspace/repo-a')
  publish(ctx, agent)
  const foreign = stubAgent('foreign', '/workspace/repo-a')

  const exec = name => ({
    agent: name,
    token: Symbol('token'),
    callId: CallId('call:projection'),
    rootCallId: CallId('call:projection'),
    name: 'write',
    arguments: { file_path: '/workspace/repo-b/one.js' },
    signal: testSignal,
  })

  // An execution with no attached agent owns no repository claim.
  assert.deepEqual(await ctx.workspaceLease.targets(exec(undefined)), [])
  // An unregistered agent is not a live incarnation of this runtime.
  await assert.rejects(
    ctx.workspaceLease.targets(exec(foreign)),
    WorkspaceLeaseInvalidRefError,
  )
  // A replaced session on the live agent is a different lifecycle.
  const original = agent.session
  agent.session = Session.create(agent.id, sessionEvents(original), original.header)
  await assert.rejects(
    ctx.workspaceLease.targets(exec(agent)),
    error => error instanceof WorkspaceLeaseError
      && error.code === 'WORKSPACE_LEASE_UNAVAILABLE',
  )
})
