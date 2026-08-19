import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { applyMainAgentMode } from '../src/main-agent/index.js'

const projectRoot = dirname(fileURLToPath(new URL('.', import.meta.url)))

test('the main-agent external-runtime compatibility rows are pinned', () => {
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'),
  )
  const mainAgent = manifest.commands.find(
    command => command.id === 'main-agent.dsh-external-runtime',
  )
  assert.deepEqual(mainAgent, {
    id: 'main-agent.dsh-external-runtime',
    binary: 'main-agent',
    status: 'pending-release',
    validation: 'source-validated',
    contracts: [
      'main-agent.capabilities.v1',
      'main-agent.worker-start-result.v1',
      'main-agent.external-launch.v1',
      'main-agent.dsh-runtime-liveness.v1',
    ],
    source_task: 'sympoies/dsh-runtime-kit#6 M1 (sympoies/nils-cli#1467)',
  })
  const broker = manifest.commands.find(
    command => command.id === 'agent-session.broker-heartbeat',
  )
  assert.equal(broker?.binary, 'agent-session')
  assert.equal(broker?.status, 'pending-release')
})

function workerStartEnvelope(livenessFile, overrides = {}) {
  return {
    schema_version: 'cli.main-agent.worker-start.v1',
    ok: true,
    data: {
      schema_version: 'main-agent.worker-start-result.v1',
      assignment: {
        assignment_id: 'assignment-one',
        worktree: '/lane/worktree',
      },
      worker: {
        session_id: 'worker-one',
        session_incarnation: 'launch-1',
        status: 'external',
      },
      delivery: { state: 'external-launch-pending', proof: 'external-runtime-transfer' },
      external_launch: {
        schema_version: 'main-agent.external-launch.v1',
        launch_id: 'launch-1',
        prompt: 'Main Agent Mode is explicitly active for this managed worker assignment.',
        worker_env: {
          AGENT_SESSION_ID: 'worker-one',
          AGENT_SESSION_STATE_DIR: '/state',
          AGENT_SESSION_RUNTIME_ID: 'launch-1',
          AGENT_SESSION_CAPABILITY_FILE: '/state/sessions/worker-one/coordination/capability-x',
          AGENT_SESSION_CHECKPOINT_FILE: '/state/sessions/worker-one/coordination/main-agent-checkpoint-x.json',
        },
        broker_heartbeat_argv: ['/bin/agent-session', 'broker', 'heartbeat'],
        broker_stop_argv: ['/bin/agent-session', 'broker', 'stop'],
        liveness_file: livenessFile,
        liveness_schema: 'main-agent.dsh-runtime-liveness.v1',
        ...overrides.external_launch,
      },
      ...overrides.data,
    },
  }
}

function createContext({ envelope, spawnFailure = false } = {}) {
  const listeners = new Map()
  const effects = []
  const provided = new Map()
  const registeredTools = new Map()
  const spawned = []
  const anchors = []
  const continuations = []
  const interrupts = []
  let setupContribution
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback, label) {
      effects.push({ callback, label })
    },
    provide(name, value) {
      provided.set(name, value)
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
      guard() {
        return () => {}
      },
    },
    subprocess: {
      spawn(spec) {
        if (spawnFailure) throw new Error('spawn failed')
        const record = { spec, terminated: false }
        spawned.push(record)
        const isCli = spec.stdio.stdout?.maxBytes === 256 * 1024
        const done = isCli
          ? Promise.resolve({ exitCode: envelope.ok === false ? 1 : 0, signal: null })
          : new Promise(() => {})
        return {
          done,
          terminate() { record.terminated = true },
          async waitForExit() { return true },
          collected: {
            stdout: {
              readFrom() {
                return { text: JSON.stringify(envelope), lossy: false }
              },
            },
          },
        }
      },
    },
    agents: {
      async create(options) {
        const agent = {
          id: options.sessionId,
          options: options.agentOptions,
          session: { header: { id: options.sessionId, cwd: options.meta?.cwd } },
        }
        const handle = { agent, dispose() { anchors.pop() } }
        anchors.push(agent)
        return handle
      },
    },
    subagents: {
      async startContinuable(spec) {
        continuations.push(spec)
        return { childId: `child-${continuations.length}`, messageId: 'message-1' }
      },
      interrupt(target, authority) {
        interrupts.push({ target, authority })
      },
      registerContinuableSetup(contribution) {
        setupContribution = contribution
        return () => { setupContribution = undefined }
      },
    },
  }
  return {
    ctx,
    listeners,
    effects,
    provided,
    registeredTools,
    spawned,
    anchors,
    continuations,
    interrupts,
    setup: () => setupContribution,
  }
}

function controllerExec() {
  return {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'deepseek-official', model: 'deepseek-v4' },
      session: { header: { id: 'controller-one', cwd: '/controller/checkout' } },
    },
  }
}

test('worker launch executes the external-launch contract without duplicating lanes', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-main-agent-test-'))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  const livenessFile = join(scratch, 'dsh-runtime-liveness.json')
  const harness = createContext({ envelope: workerStartEnvelope(livenessFile) })
  applyMainAgentMode(harness.ctx, { mainAgentCli: '/bin/main-agent' })

  const launch = harness.registeredTools.get('main_agent_worker_launch')
  assert.ok(launch, 'launch tool is registered')
  const result = await launch.execute(
    { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
    controllerExec(),
  )
  assert.equal(result.disposition, 'launched')
  assert.equal(result.assignment_id, 'assignment-one')
  assert.equal(result.launch_id, 'launch-1')
  assert.equal(result.child_session_id, 'child-1')

  const cliSpawn = harness.spawned[0]
  assert.deepEqual(cliSpawn.spec.argv, [
    '/bin/main-agent',
    'worker',
    'start',
    '--assignment-file',
    '/private/assignment.json',
    '--await-ready',
    '0',
    '--idempotency-key',
    'key-1',
    '--format',
    'json',
  ])
  assert.equal(cliSpawn.spec.cwd, '/controller/checkout')

  const heartbeat = harness.spawned[1]
  assert.deepEqual(heartbeat.spec.argv, ['/bin/agent-session', 'broker', 'heartbeat'])

  assert.equal(harness.anchors.length, 1, 'one anchor per lane')
  assert.equal(harness.anchors[0].session.header.cwd, '/lane/worktree')
  assert.equal(harness.continuations.length, 1)
  const continuation = harness.continuations[0]
  assert.equal(continuation.label, 'main-agent:assignment-one')
  assert.equal(continuation.provider, 'spawn')
  assert.equal(continuation.request.parent, harness.anchors[0])
  assert.deepEqual(continuation.request.prompt, [{
    type: 'text',
    text: 'Main Agent Mode is explicitly active for this managed worker assignment.',
  }])
  assert.ok(continuation.request.toolFilter.deny.includes('subagent'))

  const sidecar = JSON.parse(await readFile(livenessFile, 'utf8'))
  assert.equal(sidecar.schema_version, 'main-agent.dsh-runtime-liveness.v1')
  assert.equal(sidecar.launch_id, 'launch-1')
  assert.equal(sidecar.lane.state, 'open')
  assert.equal(sidecar.harness.pid, process.pid)
  assert.equal(sidecar.turn.phase, 'waiting')

  const replay = await launch.execute(
    { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
    controllerExec(),
  )
  assert.equal(replay.disposition, 'reattached')
  assert.equal(harness.continuations.length, 1, 'replay never spawns a second child')
  assert.equal(harness.anchors.length, 1, 'replay never creates a second anchor')

  const service = harness.provided.get('dshRuntimeKitMainAgent')
  assert.equal(service.laneCount, 1)
})

test('worker launch fails closed on refusals, invalid contracts, and incarnation conflicts', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-main-agent-test-'))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  const livenessFile = join(scratch, 'dsh-runtime-liveness.json')

  const refused = createContext({
    envelope: { schema_version: 'cli.main-agent.worker-start.v1', ok: false, error: { code: 'claim-not-active', message: 'no claim' } },
  })
  applyMainAgentMode(refused.ctx, {})
  await assert.rejects(
    refused.registeredTools.get('main_agent_worker_launch').execute(
      { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
      controllerExec(),
    ),
    /main-agent-cli-refused.*claim-not-active/,
  )
  assert.equal(refused.continuations.length, 0)

  const invalid = createContext({
    envelope: workerStartEnvelope(livenessFile, { external_launch: { schema_version: 'main-agent.external-launch.v999' } }),
  })
  applyMainAgentMode(invalid.ctx, {})
  await assert.rejects(
    invalid.registeredTools.get('main_agent_worker_launch').execute(
      { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
      controllerExec(),
    ),
    /main-agent-external-launch-invalid/,
  )

  const relative = createContext({ envelope: workerStartEnvelope(livenessFile) })
  applyMainAgentMode(relative.ctx, {})
  await assert.rejects(
    relative.registeredTools.get('main_agent_worker_launch').execute(
      { assignment_file: 'relative/path.json', idempotency_key: 'key-1' },
      controllerExec(),
    ),
    /main-agent-assignment-file-invalid/,
  )
})

test('lane children get the deny guard and environment section; foreign children stay untouched', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-main-agent-test-'))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  const livenessFile = join(scratch, 'dsh-runtime-liveness.json')
  const harness = createContext({ envelope: workerStartEnvelope(livenessFile) })
  applyMainAgentMode(harness.ctx, {})
  await harness.registeredTools.get('main_agent_worker_launch').execute(
    { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
    controllerExec(),
  )
  const anchorId = harness.anchors[0].session.header.id

  const guards = []
  const sections = []
  const laneChildCtx = {
    agent: { session: { header: { parentSession: anchorId } } },
    tools: {
      guard(callback) {
        guards.push(callback)
        return () => guards.pop()
      },
    },
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => sections.pop()
      },
    },
  }
  const dispose = harness.setup()(laneChildCtx)
  assert.equal(guards.length, 1, 'lane child gets the authority guard')
  assert.equal(
    guards[0]({ name: 'subagent' }),
    'dsh-runtime-kit:main-agent-lane-tool-denied',
  )
  assert.equal(guards[0]({ name: 'bash' }), undefined)
  assert.equal(sections.length, 1, 'lane child gets the environment section')
  assert.match(sections[0].text, /AGENT_SESSION_ID=worker-one/)
  assert.match(sections[0].text, /AGENT_SESSION_CAPABILITY_FILE=/)
  dispose()
  assert.equal(guards.length, 0)
  assert.equal(sections.length, 0)

  const foreignChildCtx = {
    agent: { session: { header: { parentSession: 'someone-else' } } },
    tools: {
      guard() {
        throw new Error('foreign children must not be guarded')
      },
    },
  }
  harness.setup()(foreignChildCtx)()
})

test('anchors are parked, lanes interrupt and close, and run boundaries update the sidecar', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-main-agent-test-'))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  const livenessFile = join(scratch, 'dsh-runtime-liveness.json')
  const harness = createContext({ envelope: workerStartEnvelope(livenessFile) })
  applyMainAgentMode(harness.ctx, {})
  const launched = await harness.registeredTools.get('main_agent_worker_launch').execute(
    { assignment_file: '/private/assignment.json', idempotency_key: 'key-1' },
    controllerExec(),
  )
  const anchorId = harness.anchors[0].session.header.id

  const preStep = harness.listeners.get('agent/pre-step')
  const parked = await preStep(
    { agent: { session: { header: { id: anchorId } } } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(parked, {
    kind: 'reject',
    reason: 'dsh-runtime-kit:main-agent-anchor-parked',
  })
  const passedThrough = await preStep(
    { agent: { session: { header: { id: 'controller-one' } } } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(passedThrough.kind, 'enter')

  harness.listeners.get('subagent/start')({ sessionId: launched.child_session_id })
  await new Promise(resolve => setTimeout(resolve, 20))
  let sidecar = JSON.parse(await readFile(livenessFile, 'utf8'))
  assert.equal(sidecar.turn.phase, 'working')

  harness.listeners.get('subagent/end')({
    sessionId: launched.child_session_id,
    stopReason: 'completed',
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  sidecar = JSON.parse(await readFile(livenessFile, 'utf8'))
  assert.equal(sidecar.turn.phase, 'waiting')
  assert.equal(sidecar.turn.last_turn.outcome, 'completed')

  const interrupted = await harness.registeredTools.get('main_agent_worker_interrupt').execute(
    { assignment_id: 'assignment-one' },
    controllerExec(),
  )
  assert.equal(interrupted.interrupted, true)
  assert.equal(harness.interrupts.length, 1)
  assert.equal(harness.interrupts[0].target, launched.child_session_id)
  assert.deepEqual(harness.interrupts[0].authority, {
    kind: 'user',
    parentSessionId: anchorId,
  })

  const closed = await harness.registeredTools.get('main_agent_lane_close').execute(
    { assignment_id: 'assignment-one' },
    controllerExec(),
  )
  assert.equal(closed.closed, true)
  sidecar = JSON.parse(await readFile(livenessFile, 'utf8'))
  assert.equal(sidecar.lane.state, 'terminated')
  assert.equal(sidecar.turn, undefined)
  const heartbeat = harness.spawned[1]
  assert.equal(heartbeat.terminated, true, 'lane close stops the broker heartbeat')
  const service = harness.provided.get('dshRuntimeKitMainAgent')
  assert.equal(service.laneCount, 0)
  await assert.rejects(
    harness.registeredTools.get('main_agent_worker_interrupt').execute(
      { assignment_id: 'assignment-one' },
      controllerExec(),
    ),
    /main-agent-lane-not-found/,
  )
})
