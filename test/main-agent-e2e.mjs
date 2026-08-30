/**
 * Main Agent Mode acceptance scenarios against the real nils-cli store.
 *
 * This driver exercises the lane runtime's own tools — launch, the per-lane
 * checkpoint tool, supervise, request-changes, accept, lane close, and run
 * closeout — against real `main-agent` and `agent-session` binaries, a real git
 * project with one worktree per lane, and a real durable run. Every transition
 * is asserted from the store, not from this runtime's own return values, so a
 * tool that reported success without moving the fence fails here.
 *
 * What is real: the store, the controller identity, the worker sessions and
 * their capability/checkpoint files, the coordination brokers, the worktrees,
 * the liveness sidecars, and every CLI invocation the tools make.
 *
 * What is substituted: DSH's subagent seam. The workspace-provider handshake
 * and lane child are doubles, because a model-driven lane child inside a live
 * DSH session needs the packed-profile acceptance harness. Patch lifecycle and
 * promotion evidence cover that real-DSH half; this driver remains focused on
 * durable store and broker behavior.
 *
 * Usage:
 *   NILS_BIN_DIR=/path/to/nils-cli/target/debug node test/main-agent-e2e.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { applyMainAgentMode } from '../src/main-agent/index.js'

const binDir = process.env.NILS_BIN_DIR
assert.ok(
  typeof binDir === 'string' && binDir.length > 0,
  'set NILS_BIN_DIR to a nils-cli build containing main-agent and agent-session',
)
const mainAgentCli = join(binDir, 'main-agent')
const agentSessionCli = join(binDir, 'agent-session')
for (const binary of [mainAgentCli, agentSessionCli]) {
  assert.ok(existsSync(binary), `missing binary: ${binary}`)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-main-agent-e2e-'))
const stateDir = join(root, 'state')
const project = join(root, 'project')
const laneRoot = join(root, 'lanes')
mkdirSync(stateDir, { recursive: true })
mkdirSync(laneRoot, { recursive: true })

let failure
try {
  await run()
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.main-agent-e2e.v1',
    ok: true,
    scenarios: [
      { id: 'two-lane-lifecycle', status: 'passed' },
      { id: 'overlapping-scope-refused', status: 'passed' },
      { id: 'stopped-lane-reconciled', status: 'passed' },
    ],
  })}\n`)
} catch (error) {
  failure = error
} finally {
  // The lane runtime spawns real heartbeat processes; releasing them before the
  // temp tree disappears keeps a failed run from leaving brokers behind.
  rmSync(root, { recursive: true, force: true })
}
if (failure !== undefined) {
  process.stderr.write(`${String(failure?.stack ?? failure)}\n`)
  process.exitCode = 1
}

async function run() {
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', project])
  writeFileSync(join(project, 'README.md'), '# e2e\n')
  writeFileSync(join(project, 'lane-one.txt'), 'one\n')
  writeFileSync(join(project, 'lane-two.txt'), 'two\n')
  git('add', '-A')
  git('-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', 'commit', '-qm', 'e2e: seed')
  git('remote', 'add', 'origin', 'https://example.invalid/example/e2e.git')

  const lanes = {
    one: join(laneRoot, 'lane-one'),
    two: join(laneRoot, 'lane-two'),
    overlap: join(laneRoot, 'lane-overlap'),
  }
  git('worktree', 'add', '--quiet', '-b', 'feat/lane-one', lanes.one, 'HEAD')
  git('worktree', 'add', '--quiet', '-b', 'feat/lane-two', lanes.two, 'HEAD')
  git('worktree', 'add', '--quiet', '-b', 'feat/lane-overlap', lanes.overlap, 'HEAD')

  // The controller identity. A DSH controller has no session record of its own
  // (`agent-session start --agent dsh` is refused by design), so the harness
  // mints an ordinary enforce-mode session and hands its capability to the
  // runtime — the same trust model a tmux-hosted controller uses.
  const controller = json(execFileSync(agentSessionCli, [
    '--state-dir', stateDir, 'start',
    '--agent', 'hermes',
    '--cwd', project,
    '--coordination-mode', 'enforce',
    '--format', 'json',
  ], { encoding: 'utf8' })).data
  const coordination = join(stateDir, 'sessions', controller.id, 'coordination')
  const controllerEnv = {
    ...process.env,
    AGENT_SESSION_STATE_DIR: stateDir,
    AGENT_SESSION_ID: controller.id,
    AGENT_SESSION_RUNTIME_ID: controller.session_incarnation,
    AGENT_SESSION_CAPABILITY_FILE: pick(coordination, 'capability-'),
    AGENT_SESSION_CHECKPOINT_FILE: pick(coordination, 'main-agent-checkpoint-'),
  }

  const objective = privateJson(join(root, 'objective.json'), {
    schema_version: 'main-agent.objective-packet.v1',
    tier: 'L0',
    objective_summary: 'exercise the dsh lane orchestration acceptance scenarios',
    objective: { goal: 'two isolated lanes, one review round, one closeout' },
    done_criteria: ['both lanes accepted', 'run closed'],
    constraints: ['no delivery', 'no commits'],
    durable_refs: [],
    next_action: null,
    work_context: {
      schema_version: 'agent-session.work-context-input.v1',
      intent: 'implementation',
      tier: 'L0',
      repositories: ['example/e2e'],
      summary: 'acceptance run for the dsh lane orchestration scenarios',
    },
  })
  const initialized = store(['init', '--packet-file', objective, '--if-absent', '--idempotency-key', 'e2e-init-0001'])
  assert.equal(initialized.run.state, 'active')

  const assignments = {
    one: assignmentPacket('lane-one', lanes.one, ['lane-one.txt']),
    two: assignmentPacket('lane-two', lanes.two, ['lane-two.txt']),
    // Lane two's scope in a distinct worktree: the store's work-context claim
    // must refuse the second claim on the same path.
    overlap: assignmentPacket('lane-overlap', lanes.overlap, ['lane-two.txt']),
  }

  const harness = createRuntime(controllerEnv)
  const exec = harness.controllerExec(project)

  // ---- Scenario: two-lane lifecycle -------------------------------------
  const launchedOne = await harness.tool('main_agent_worker_launch').execute(
    { assignment_file: assignments.one, idempotency_key: 'e2e-launch-one-0001' },
    exec,
  )
  assert.equal(launchedOne.disposition, 'launched')
  const launchedTwo = await harness.tool('main_agent_worker_launch').execute(
    { assignment_file: assignments.two, idempotency_key: 'e2e-launch-two-0001' },
    exec,
  )
  assert.equal(launchedTwo.disposition, 'launched')
  assert.equal(harness.service().laneCount, 2)

  for (const [name, launched] of [['lane-one', launchedOne], ['lane-two', launchedTwo]]) {
    const record = json(readFileSync(join(stateDir, 'sessions', launched.worker_session_id, 'session.json'), 'utf8'))
    assert.equal(record.runtime.kind, 'dsh_external', `${name} is an external-runtime record`)
    const sidecar = json(readFileSync(join(stateDir, 'sessions', launched.worker_session_id, 'dsh-runtime-liveness.json'), 'utf8'))
    assert.equal(sidecar.lane.state, 'open', `${name} publishes an open lane`)
    assert.equal(sidecar.launch_id, launched.launch_id)
    assert.equal(status(launched.worker_session_id), 'running', `${name} reads as running`)
  }

  // A lane's broker becomes ready when its heartbeat writes the first beat, a
  // moment after launch returns. Every authenticated worker call depends on it,
  // so the wait is explicit here rather than implied by test ordering.
  for (const lane of [launchedOne, launchedTwo]) {
    assertBrokerReady(lane)
  }

  // The lane worker bootstraps itself exactly as its prompt instructs, using
  // the environment the launch payload delivered.
  for (const lane of [launchedOne, launchedTwo]) {
    const bootstrapped = worker(lane, ['bootstrap', '--idempotency-key', `e2e-bootstrap-${lane.assignment_id}`])
    if (process.env.E2E_DEBUG === "1") console.error(JSON.stringify(bootstrapped).slice(0, 900))
    assert.equal(
      assignmentState(lane.assignment_id),
      'working',
      `${lane.assignment_id} reached working: ${JSON.stringify(bootstrapped).slice(0, 300)}`,
    )
  }

  // Lane one submits through its own registered checkpoint tool.
  const laneOneChild = harness.laneChild(launchedOne)
  const submitted = await laneOneChild.tool('main_agent_checkpoint').execute({
    summary: 'edited lane-one.txt only',
    next_action: 'await controller review',
    state: 'submitted',
    result_summary: 'one file changed inside the declared scope',
    if_revision: revision('lane-one'),
    idempotency_key: 'e2e-checkpoint-one-0001',
  }, laneChildExec())
  assert.equal(submitted.assignment.state, 'submitted')
  assert.equal(assignmentState('lane-one'), 'submitted', 'the store, not the tool, is the proof')

  const supervised = await harness.tool('main_agent_worker_supervise').execute(
    { assignment_id: 'lane-one' },
    exec,
  )
  assert.equal(supervised.schema_version, 'dsh-runtime-kit.main-agent-supervision.v1')
  assert.equal(typeof supervised.store.classification, 'string')
  assert.equal(supervised.lane.state, 'open')
  assert.equal(supervised.lane.worker_session_id, launchedOne.worker_session_id)

  const returned = await harness.tool('main_agent_worker_request_changes').execute({
    assignment_id: 'lane-one',
    if_revision: revision('lane-one'),
    reason: 'add the regression test that proves the scope boundary',
    idempotency_key: 'e2e-changes-one-0001',
  }, exec)
  assert.equal(returned.decision, 'request-changes')
  assert.equal(returned.delivered, true, 'the decision reached the lane inbox')
  assert.equal(assignmentState('lane-one'), 'working', 'request-changes returns the lane to working')

  const resubmitted = await laneOneChild.tool('main_agent_checkpoint').execute({
    summary: 'added the scope regression test',
    next_action: 'await controller acceptance',
    state: 'submitted',
    result_summary: 'regression test added',
    if_revision: revision('lane-one'),
    idempotency_key: 'e2e-checkpoint-one-0002',
  }, laneChildExec())
  assert.equal(resubmitted.assignment.state, 'submitted')

  const accepted = await harness.tool('main_agent_worker_accept').execute({
    assignment_id: 'lane-one',
    if_revision: revision('lane-one'),
    idempotency_key: 'e2e-accept-one-0001',
  }, exec)
  assert.equal(accepted.decision, 'accept')
  assert.equal(assignmentState('lane-one'), 'accepted')

  // ---- Scenario: overlapping scope refused ------------------------------
  // The claim is acquired at bootstrap, not at start, so this is where an
  // overlapping path scope must be refused: lane two still holds `lane-two.txt`
  // while this third lane declares the same file in its own worktree.
  const launchedOverlap = await harness.tool('main_agent_worker_launch').execute(
    { assignment_file: assignments.overlap, idempotency_key: 'e2e-launch-overlap-0001' },
    exec,
  )
  assert.equal(launchedOverlap.disposition, 'launched')
  assertBrokerReady(launchedOverlap)
  const overlapBootstrap = workerAttempt(
    launchedOverlap,
    ['bootstrap', '--idempotency-key', 'e2e-bootstrap-overlap'],
  )
  assert.notEqual(overlapBootstrap.status, 0, 'an overlapping scope must not acquire a claim')
  const overlapError = json(overlapBootstrap.stdout).error
  assert.match(
    String(overlapError.code),
    /work-context|claim|scope|conflict/,
    `unexpected overlap refusal: ${overlapBootstrap.stdout}`,
  )
  assert.notEqual(
    assignmentState('lane-overlap'),
    'working',
    'the refused lane never reached working',
  )
  // The refused lane is still this runtime's to release.
  await harness.tool('main_agent_lane_close').execute({ assignment_id: 'lane-overlap' }, exec)

  // ---- Scenario: stopped lane reconciled --------------------------------
  // Lane two is still `working`; closing its runtime is the proven-stopped
  // state `worker reconcile-stopped` exists for.
  const closedTwo = await harness.tool('main_agent_lane_close').execute(
    { assignment_id: 'lane-two' },
    exec,
  )
  assert.equal(closedTwo.closed, true)
  const twoSidecar = json(readFileSync(join(stateDir, 'sessions', launchedTwo.worker_session_id, 'dsh-runtime-liveness.json'), 'utf8'))
  assert.equal(twoSidecar.lane.state, 'terminated')
  // The corroboration rule, observed end to end. A plugin-asserted termination
  // needs a second witness, and this harness is still alive — so the witness has
  // to be the lane's own coordination heartbeat, which close just released. The
  // last beat it wrote stays fresh for its freshness window, and until that
  // lapses the lane still holds authority: it reads `unknown` and the store-side
  // reconcile path stays closed. A forged sidecar therefore cannot terminalize a
  // lane that is still beating.
  assert.equal(
    status(launchedTwo.worker_session_id),
    'unknown',
    'a lane whose last beat is still fresh holds authority and is not proven stopped',
  )
  const refusedReconcile = storeAttempt([
    'worker', 'reconcile-stopped', 'lane-two',
    '--if-revision', String(revision('lane-two')),
    '--reason', 'the lane runtime was closed by its plugin',
    '--idempotency-key', 'e2e-reconcile-two-0001',
  ])
  assert.notEqual(refusedReconcile.status, 0, 'unproven evidence must not terminalize the lane')
  assert.match(
    String(json(refusedReconcile.stdout).error?.code),
    /unverified|runtime|coordination/,
    `unexpected reconcile refusal: ${refusedReconcile.stdout}`,
  )
  // Once the released heartbeat goes stale the assertion is corroborated, and
  // this is the behaviour the store side gained: the lane reads `stopped` and
  // reconciles while the harness keeps serving its other lanes, instead of
  // waiting for the whole harness to exit. The wait is the CLI's own freshness
  // window, so poll for the transition rather than assuming its length.
  const stopProven = await waitFor(
    () => status(launchedTwo.worker_session_id) === 'stopped',
    90_000,
    () => `lane two never became provably stopped: status=${status(launchedTwo.worker_session_id)}`,
  )
  assert.equal(stopProven, true)
  store([
    'worker', 'reconcile-stopped', 'lane-two',
    '--if-revision', String(revision('lane-two')),
    '--reason', 'the lane runtime was closed by its plugin',
    '--idempotency-key', 'e2e-reconcile-two-0002',
  ])
  assert.notEqual(
    assignmentState('lane-two'),
    'working',
    'a reconciled lane leaves working',
  )

  // ---- Closeout ---------------------------------------------------------
  const closed = await harness.tool('main_agent_run_closeout').execute({
    summary: 'both acceptance lanes settled',
    next_action: 'report the acceptance evidence',
    result_summary: 'lane one accepted, lane two reconciled',
    if_run_revision: runRevision(),
    idempotency_key: 'e2e-closeout-0001',
  }, exec)
  assert.equal(closed.schema_version, 'dsh-runtime-kit.main-agent-closeout.v1')
  assert.equal(harness.service().laneCount, 0, 'closeout leaves no live lane')
  assert.equal(closed.drained, true)
  harness.dispose()

  // ---- Helpers that read the store -------------------------------------
  function revision(assignmentId) {
    return assignment(assignmentId).revision
  }

  function assignmentState(assignmentId) {
    return assignment(assignmentId)?.state
  }

  function assignment(assignmentId) {
    const listed = store(['worker', 'list'])
    return listed.workers.find(entry => entry.assignment_id === assignmentId)
  }

  function runRevision() {
    return store(['status']).run.revision
  }

  function status(sessionId) {
    // `agent-session list` returns the session array as `data` itself.
    const sessions = json(execFileSync(agentSessionCli, [
      '--state-dir', stateDir, 'list', '--format', 'json',
    ], { encoding: 'utf8' })).data
    return sessions.find(session => session.id === sessionId)?.status
  }

  /** Run one controller-principal CLI call without asserting its outcome. */
  function storeAttempt(args, options = {}) {
    return spawnSync(mainAgentCli, ['--state-dir', stateDir, ...args, '--format', 'json'], {
      encoding: 'utf8',
      env: controllerEnv,
      cwd: project,
      timeout: 120_000,
      ...options,
    })
  }

  function store(args, options = {}) {
    const result = storeAttempt(args, options)
    assert.equal(
      result.status,
      0,
      `main-agent ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    )
    return json(result.stdout).data
  }

  function worker(lane, args) {
    const result = workerAttempt(lane, args)
    assert.equal(
      result.status,
      0,
      `worker ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    )
    return json(result.stdout).data
  }

  /**
   * Launch owns the bounded wait, so its successful return must make this
   * single authenticated status probe immediately usable.
   */
  function assertBrokerReady(lane) {
    const laneEnv = { ...process.env, ...harness.workerEnv(lane) }
    const result = spawnSync(agentSessionCli, [
      '--state-dir', stateDir, 'broker', 'status',
      '--session', lane.worker_session_id,
      '--capability-file', laneEnv.AGENT_SESSION_CAPABILITY_FILE,
      '--authenticated',
      '--format', 'json',
    ], { encoding: 'utf8', env: laneEnv, timeout: 30_000 })
    assert.equal(
      result.status,
      0,
      `lane ${lane.assignment_id} broker was not ready when launch returned: ${result.stderr}`,
    )
    const status = json(result.stdout).data
    assert.equal(status.state, 'ready')
    assert.equal(status.heartbeat_fresh, true)
    assert.equal(status.capability_available, true)
    return status
  }

  /** Run one worker-principal CLI call without asserting its outcome. */
  function workerAttempt(lane, args) {
    const laneEnv = { ...process.env, ...harness.workerEnv(lane) }
    return spawnSync(mainAgentCli, ['--state-dir', stateDir, ...args, '--format', 'json'], {
      encoding: 'utf8',
      env: laneEnv,
      cwd: harness.laneWorktree(lane),
      timeout: 120_000,
    })
  }

  function assignmentPacket(assignmentId, worktree, scopes) {
    return privateJson(join(root, `${assignmentId}.json`), {
      schema_version: 'main-agent.assignment-input.v1',
      assignment_id: assignmentId,
      task_summary: `acceptance lane ${assignmentId}`,
      task: { objective: `edit ${scopes.join(', ')} only` },
      launch: {
        agent: 'dsh',
        cwd: worktree,
        title: null,
        session_id: `worker-${assignmentId}`,
        coordination_mode: 'enforce',
        agent_args: [],
      },
      repository: 'example/e2e',
      worktree,
      base_ref: 'main',
      scopes,
      durable_refs: [],
    })
  }
}

function pick(directory, prefix) {
  const name = readdirSync(directory).find(entry => entry.startsWith(prefix))
  assert.ok(name, `no ${prefix}* file in ${directory}`)
  return join(directory, name)
}

function privateJson(path, document) {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  return path
}

function json(text) {
  return JSON.parse(text)
}

/**
 * Poll until `probe` holds. Used for transitions this runtime does not drive —
 * a coordination heartbeat lapsing, for instance — so the scenario waits on the
 * CLI's own window instead of hard-coding its length.
 *
 * @param {() => boolean} probe
 * @param {number} timeoutMs
 * @param {() => string} describe failure message, evaluated only on timeout
 */
async function waitFor(probe, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.fail(describe())
}

function laneChildExec() {
  return { signal: new AbortController().signal }
}

/**
 * Mount the lane runtime on a context whose subprocess seam is real and whose
 * subagent seam is a double: the point of this driver is the store contract, so
 * every CLI call, heartbeat, and sidecar write is real while the host-issued
 * child workspace lifecycle is simulated in-process.
 */
function createRuntime(controllerEnv) {
  const registered = new Map()
  const provided = new Map()
  const disposers = []
  const children = new Map()
  const laneSetups = []
  const workspaceProviders = new Map()
  let childSequence = 0
  const spawned = []
  const heartbeats = []

  const ctx = {
    on() { return () => {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    provide(name, value) { provided.set(name, value) },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
      guard() { return () => {} },
    },
    subprocess: {
      spawn(spec) {
        // A heartbeat is a long-lived broker process: it must run concurrently
        // with everything that follows, so it is spawned asynchronously and
        // terminated on lane close. Running it synchronously would block the
        // very lane state it waits for.
        if (spec.argv.includes('heartbeat')) {
          const child = spawn(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd,
            env: { ...controllerEnv, ...spec.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', chunk => { stdout += chunk })
          child.stderr.on('data', chunk => { stderr += chunk })
          heartbeats.push(child)
          spawned.push({ argv: spec.argv, kind: 'heartbeat' })
          return {
            done: new Promise(resolve => child.on('exit', (code, signal) => {
              resolve({ exitCode: code ?? 0, signal })
            })),
            terminate() { child.kill('SIGTERM') },
            async waitForExit() { return true },
            collected: {
              stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
              stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
            },
          }
        }
        const child = spawnSync(spec.argv[0], spec.argv.slice(1), {
          encoding: 'utf8',
          cwd: spec.cwd,
          env: { ...controllerEnv, ...spec.env },
          timeout: 120_000,
        })
        if (process.env.E2E_DEBUG === '1'
          && spec.argv.includes('worker')
          && spec.argv.includes('start')) {
          const envelope = json(child.stdout ?? '{}')
          const launch = envelope?.data?.external_launch
          process.stderr.write(`${JSON.stringify({
            envelope_schema: envelope?.schema_version,
            ok: envelope?.ok,
            data_schema: envelope?.data?.schema_version,
            launch_keys: launch === null || typeof launch !== 'object'
              ? []
              : Object.keys(launch).sort(),
            launch_schema: launch?.schema_version,
            liveness_absolute: isAbsolute(String(launch?.liveness_file ?? '')),
            liveness_contained: resolve(String(launch?.liveness_file ?? '')) === resolve(
              String(launch?.worker_env?.AGENT_SESSION_STATE_DIR ?? ''),
              'sessions',
              String(launch?.worker_env?.AGENT_SESSION_ID ?? ''),
              'dsh-runtime-liveness.json',
            ),
            liveness_schema: launch?.liveness_schema,
            heartbeat_executable_matches: resolve(String(launch?.broker_heartbeat_argv?.[0] ?? ''))
              === resolve(agentSessionCli),
            stop_executable_matches: resolve(String(launch?.broker_stop_argv?.[0] ?? ''))
              === resolve(agentSessionCli),
            worker_env_safe: Object.entries(launch?.worker_env ?? {}).every(([key, value]) =>
              /^[A-Z][A-Z0-9_]*$/.test(key)
              && typeof value === 'string'
              && value.length > 0
              && [...value].every(character => /^[A-Za-z0-9_@%+=:,./~-]$/.test(character))),
            worker_env_keys: launch?.worker_env === null || typeof launch?.worker_env !== 'object'
              ? []
              : Object.keys(launch.worker_env).sort(),
            heartbeat_shape: Array.isArray(launch?.broker_heartbeat_argv)
              ? launch.broker_heartbeat_argv.map((value, index) => index === 0
                ? { kind: 'executable', basename: String(value).split('/').at(-1) }
                : { kind: String(value).startsWith('-') ? 'option' : 'value', value: String(value).startsWith('-') ? value : '<redacted>' })
              : [],
            stop_shape: Array.isArray(launch?.broker_stop_argv)
              ? launch.broker_stop_argv.map((value, index) => index === 0
                ? { kind: 'executable', basename: String(value).split('/').at(-1) }
                : { kind: String(value).startsWith('-') ? 'option' : 'value', value: String(value).startsWith('-') ? value : '<redacted>' })
              : [],
          })}\n`)
        }
        spawned.push({ argv: spec.argv, status: child.status })
        const outcome = { exitCode: child.status ?? 0, signal: null }
        return {
          done: Promise.resolve(outcome),
          terminate() {},
          async waitForExit() { return true },
          collected: {
            stdout: { readFrom: () => ({ text: child.stdout ?? '', lossy: false }) },
            stderr: { readFrom: () => ({ text: child.stderr ?? '', lossy: false }) },
          },
        }
      },
    },
    workspaceLease: {
      async ref() { return Object.freeze(Object.create(null)) },
    },
    subagents: {
      async startContinuable(spec) {
        childSequence += 1
        const childId = `e2e-child-${childSequence}`
        const provider = workspaceProviders.get(spec.workspace.provider)
        assert.ok(provider, `workspace provider ${spec.workspace.provider} is registered`)
        provider.validate(spec.workspace.ref, spec.request.parent)
        const descriptor = { provider: provider.name, version: provider.version }
        const prepared = await provider.prepare({
          sessionId: childId,
          parent: spec.request.parent,
          signal: spec.signal,
          descriptor,
          ref: spec.workspace.ref,
        })
        const agent = {
          session: {
            header: {
              id: childId,
              parentSession: spec.request.parent.session.header.id,
              cwd: prepared.cwd,
            },
          },
        }
        await provider.activate({ agent, descriptor, signal: spec.signal })
        children.set(childId, { spec, agent })
        return { childId, messageId: `e2e-message-${childSequence}` }
      },
      registerContinuableWorkspaceProvider(provider) {
        workspaceProviders.set(provider.name, provider)
        return () => workspaceProviders.delete(provider.name)
      },
      async closeContinuable(_parent, childId) {
        children.delete(childId)
      },
      interrupt() {},
      registerContinuableSetup(contribution) {
        laneSetups.push(contribution)
        return () => {}
      },
      async listChildren() {
        return [...children.keys()].map(id => ({
          kind: 'child',
          id,
          activity: 'running',
          mode: 'continuable',
          label: 'e2e',
          hasChildren: false,
        }))
      },
      async followup() { return 'e2e-followup' },
      async drainContinuableDescendants() {},
    },
  }

  applyMainAgentMode(ctx, {
    mainAgentCli,
    agentSessionCli,
    laneWorktreeRoot: laneRoot,
    workerProvider: 'e2e-provider',
    workerModel: 'e2e-model',
  })

  return {
    tool(name) {
      const definition = registered.get(name)
      assert.ok(definition, `tool ${name} is not registered`)
      return definition
    },
    service() {
      const service = provided.get('mainAgentOrchestration')
      assert.ok(service, 'the orchestration service is not provided')
      return service
    },
    controllerExec(cwd) {
      return {
        signal: new AbortController().signal,
        agent: {
          options: { provider: 'e2e-provider', model: 'e2e-model' },
          session: { header: { id: 'e2e-controller', cwd } },
        },
      }
    },
    /** Install the per-child contribution for one lane and expose its tools. */
    laneChild(lane) {
      const laneTools = new Map()
      const child = children.get(lane.child_session_id)
      assert.ok(child, `lane child ${lane.child_session_id} is active`)
      const childCtx = {
        agent: child.agent,
        tools: {
          guard() { return () => {} },
          register(definition) {
            laneTools.set(definition.name, definition)
            return () => laneTools.delete(definition.name)
          },
        },
        systemPrompt: { section: () => () => {} },
      }
      for (const contribution of laneSetups) contribution(childCtx)
      return {
        tool(name) {
          const definition = laneTools.get(name)
          assert.ok(definition, `lane tool ${name} is not registered`)
          return definition
        },
      }
    },
    workerEnv(lane) {
      const service = provided.get('mainAgentOrchestration')
      assert.ok(service.lane(lane.assignment_id), `lane ${lane.assignment_id} is not registered`)
      const record = json(readFileSync(
        join(stateDir, 'sessions', lane.worker_session_id, 'session.json'),
        'utf8',
      ))
      const laneCoordination = join(stateDir, 'sessions', lane.worker_session_id, 'coordination')
      if (process.env.E2E_DEBUG === '1') {
        process.stderr.write(`${JSON.stringify({
          lane_coordination_entries: existsSync(laneCoordination)
            ? readdirSync(laneCoordination).map(name => name.replace(/[a-f0-9]{24,}/g, '<digest>')).sort()
            : [],
        })}\n`)
      }
      return {
        AGENT_SESSION_STATE_DIR: stateDir,
        AGENT_SESSION_ID: lane.worker_session_id,
        AGENT_SESSION_RUNTIME_ID: record.runtime.launch_id,
        AGENT_SESSION_CAPABILITY_FILE: pick(laneCoordination, 'capability-'),
        AGENT_SESSION_CHECKPOINT_FILE: pick(laneCoordination, 'main-agent-checkpoint-'),
      }
    },
    laneWorktree(lane) {
      const child = children.get(lane.child_session_id)
      assert.ok(child, `no lane child for ${lane.assignment_id}`)
      return child.agent.session.header.cwd
    },
    dispose() {
      for (const child of heartbeats) child.kill('SIGKILL')
      for (const dispose of disposers.reverse()) dispose()
    },
    spawned,
  }
}
