import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import * as llmModule from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

import { createFinishLineCoordinator } from '../src/finish-line/index.js'
import {
  WORKSPACE_LEASE_PROTOCOL_VERSION,
  WorkspaceLease,
  WorkspaceLeaseError,
} from '../src/workspace-lease/index.js'

const CallId = llmModule.ToolCallId ?? llmModule.CallId
const testSignal = new AbortController().signal
const correlationId = 'correlation:opaque'

const REPO_A = { workspaceKey: 'key:repo-a', root: '/workspace/repo-a' }
const REPO_B = { workspaceKey: 'key:repo-b', root: '/workspace/repo-b' }

function stubAgent(rawId, cwd) {
  const id = SessionId(rawId)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd,
    isSeeded: false,
  })
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
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** The shipped nils contract shape: only structured mutations resolve exactly. */
function leaseProvider(overrides = {}) {
  let generation = 0
  return Object.freeze({
    protocolVersion: WORKSPACE_LEASE_PROTOCOL_VERSION,
    async resolve(request) {
      if (overrides.resolve !== undefined) return overrides.resolve(request)
      if (request.toolName !== 'write') return { kind: 'not-required' }
      const path = request.arguments?.file_path
      const targets = [REPO_A, REPO_B].filter(target => path?.startsWith(target.root))
      return targets.length === 0 ? { kind: 'not-required' } : { kind: 'targets', targets }
    },
    async bind(request) {
      const target = request.target
        ?? [REPO_A, REPO_B].find(candidate => request.cwd?.startsWith(candidate.root))
      if (target === undefined) return { kind: 'not-required' }
      const overridden = await overrides.bind?.(request, target)
      if (overridden !== undefined) return overridden
      generation += 1
      return {
        kind: 'bound',
        bindingId: `binding:${target.workspaceKey}`,
        workspaceId: `workspace:${target.workspaceKey}`,
        generation: `generation:${generation}`,
        state: 'owned',
        target,
      }
    },
    async begin(request) {
      return {
        kind: 'granted',
        operationId: `operation:${request.callId}`,
        fence: `fence:${request.target.workspaceKey}`,
      }
    },
    async complete() {},
    async renew() { return { kind: 'renewed' } },
    async release() {},
  })
}

function finishLineClient({ stopAction = () => 'allow' } = {}) {
  const opens = []
  const edits = []
  const stops = []
  const releases = []
  return {
    opens,
    edits,
    stops,
    releases,
    client: {
      async open(request) {
        opens.push(structuredClone(request))
        return { runnerCapability: 'finish-line-runner:opaque', correlationId }
      },
      async beginEdit(request) {
        edits.push(structuredClone(request))
        return {
          status: 'registered',
          operationId: request.operationId,
          generation: 1,
          correlationId,
        }
      },
      async run() { throw new Error('unexpected validation run') },
      async stop(request) {
        stops.push(structuredClone(request))
        const action = stopAction(request, edits)
        return {
          action,
          generation: 1,
          contractDigest: `sha256:${'0'.repeat(64)}`,
          correlationId,
          reasonCodes: action === 'block' ? ['validation-missing'] : [],
          remediation: [],
        }
      },
      async release(request) {
        releases.push(structuredClone(request))
        return { correlationId }
      },
      abandonOpen() {},
      abandonBegin() {},
      async drain() {},
      async dispose() {},
      get active() { return 0 },
      get degraded() { return false },
    },
  }
}

/**
 * Compose the real WorkspaceLease service and the real finish-line coordinator
 * with the exact wiring the default bundle installs, so the seam under test is
 * the production one rather than an injected double.
 */
async function harness(overrides = {}, { stopAction, onWrite } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(WorkspaceLease)
  ctx.workspaceLease.registerProvider(leaseProvider(overrides))

  const transport = finishLineClient({ stopAction })
  const coordinator = createFinishLineCoordinator(ctx, {
    client: transport.client,
    createOperationId: () => `operation:${transport.edits.length + 1}`,
    resolveEditRoots: async exec => {
      const service = ctx.get('workspaceLease')
      if (service === undefined || typeof service.targets !== 'function') return undefined
      return service.targets(exec)
    },
    createSteeringMessage: text => ({
      source: { kind: 'plugin' },
      content: [{ type: 'text', text }],
    }),
  })

  // Sit exactly where the policy boundary sits: downstream of the lease
  // service's prepended admission listener.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const reservation = await coordinator.begin(exec, {
      sessionId: String(exec.agent?.id ?? ''),
      cwd: exec.agent?.session?.header?.cwd ?? '/',
      turn: 1,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      name: exec.name,
    })
    if (reservation.ok !== true) {
      return { kind: 'deny', reason: `dsh-runtime-kit:${reservation.reason}` }
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const routed = await coordinator.execute(exec)
    return routed.kind === 'result' ? routed.result : next()
  })
  ctx.on('tools/result', (exec, result) => { coordinator.result(exec, result) })

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'write',
    parameters: { file_path: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      await onWrite?.(args)
      return args.file_path
    },
  }))

  return { ctx, coordinator, transport }
}

function publish(ctx, agent) {
  const dispose = ctx.agents.register(agent)
  agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })
  return dispose
}

function write(ctx, agent, path, callId) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(callId),
    name: 'write',
    arguments: { file_path: path },
    agent,
  })
}

test('an edit generation is attributed to the repository the operation targets', async () => {
  const { ctx, transport } = await harness()
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  const result = await write(ctx, agent, `${REPO_B.root}/src/index.js`, 'call:b')

  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(transport.edits.map(edit => edit.cwd), [REPO_B.root])
  assert.deepEqual(transport.opens.map(open => open.cwd), [REPO_B.root])
})

test('stopping a turn requires and releases every repository it modified', async () => {
  const { ctx, coordinator, transport } = await harness()
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  for (const [index, root] of [REPO_A.root, REPO_B.root].entries()) {
    const result = await write(ctx, agent, `${root}/src/index.js`, `call:${index}`)
    assert.equal(result.isError, false, result.error?.message)
  }
  assert.deepEqual(transport.edits.map(edit => edit.cwd), [REPO_A.root, REPO_B.root])

  assert.equal(await coordinator.turnStopping({
    agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)

  assert.deepEqual(transport.stops.map(stop => stop.cwd).sort(), [REPO_A.root, REPO_B.root])
  assert.deepEqual(transport.releases.map(release => release.cwd).sort(), [REPO_A.root, REPO_B.root])
})

test('a write outside every repository creates no Git validation obligation', async () => {
  const { ctx, coordinator, transport } = await harness()
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  const result = await write(ctx, agent, '/srv/notes/todo.md', 'call:plain')

  assert.equal(result.isError, false, result.error?.message)
  // No edit generation is registered anywhere for a write the provider proved
  // touches no repository.
  assert.deepEqual(transport.edits, [])
  assert.deepEqual(transport.opens, [])

  assert.equal(await coordinator.turnStopping({
    agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)

  // The session's own anchor repository still owns the stop boundary; the
  // non-repository write neither adds an obligation nor invents a ledger for a
  // path outside every checkout.
  assert.deepEqual(transport.stops.map(stop => stop.cwd), [REPO_A.root])
  assert.deepEqual([...new Set(transport.opens.map(open => open.cwd))], [REPO_A.root])
})

test('a lease denial reaches the model with its own typed cause', async () => {
  // Issue 172 requires the root cause to survive the policy, workspace-lease
  // and finish-line pipeline. This composes both real services and proves the
  // ledger neither reserves anything nor substitutes a reason of its own.
  const { ctx, transport } = await harness({
    resolve: async () => {
      throw new WorkspaceLeaseError(
        'the workspace has uncommitted state and cannot be reassigned safely',
        'WORKSPACE_DIRTY',
        'dirty',
      )
    },
  })
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  const result = await write(ctx, agent, `${REPO_B.root}/src/index.js`, 'call:dirty')

  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_DIRTY')
  assert.match(result.error.message, /uncommitted state/)
  assert.deepEqual(transport.edits, [])
  assert.deepEqual(transport.opens, [])
})

test('a target the lease denies at bind leaves no finish-line obligation', async () => {
  // The shipped provider denies from `bind` and `begin`, never from `resolve`:
  // resolution succeeds, the edit identity becomes repository B, and only then
  // does the lease refuse the target. Issue 182: by that point the ledger must
  // not have registered an edit generation for B, or the turn is asked to
  // validate a repository it never modified.
  const dirty = {
    kind: 'denied',
    state: 'dirty',
    code: 'WORKSPACE_DIRTY',
    reason: 'the workspace has uncommitted state and cannot be reassigned safely',
  }
  const { ctx, coordinator, transport } = await harness({
    bind: async (_request, target) => target.workspaceKey === REPO_B.workspaceKey ? dirty : undefined,
  }, {
    // Mirror the provider contract: a registered generation with no validation
    // blocks stop for that repository.
    stopAction: (request, edits) => edits.some(edit => edit.cwd === request.cwd) ? 'block' : 'allow',
  })
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  const result = await write(ctx, agent, `${REPO_B.root}/src/index.js`, 'call:denied')

  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'WORKSPACE_DIRTY')
  assert.match(result.error.message, /uncommitted state/)
  assert.deepEqual(transport.edits, [])
  assert.equal(coordinator.activeReservations, 0)

  assert.equal(await coordinator.turnStopping({
    agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
})

test('an admitted edit registers its generation before the tool body runs', async () => {
  // Deferring registration past the lease admission must not defer it past the
  // mutation: the generation still precedes the write it covers.
  let editsAtBody
  const { ctx, transport } = await harness({}, {
    onWrite() { editsAtBody = transport.edits.map(edit => edit.cwd) },
  })
  const agent = stubAgent('session-1', REPO_A.root)
  publish(ctx, agent)

  const result = await write(ctx, agent, `${REPO_B.root}/src/index.js`, 'call:ordered')

  assert.equal(result.isError, false, result.error?.message)
  assert.deepEqual(editsAtBody, [REPO_B.root])
})
