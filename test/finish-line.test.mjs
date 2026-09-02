import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFinishLineCoordinator } from '../src/finish-line/index.js'

const correlationId = 'correlation:opaque'

function fixture({
  maxSameTurnSteers = 2,
  runtime = {
    timeoutMs: 5_000,
    execution: {
      kind: 'bash-v1',
      workdir: '/workspace/project',
      outputMaxBytes: 64 * 1024,
      runner: { kind: 'danger-full-access' },
    },
  },
  now = Date.now,
  requiresFinishLine,
  allowsNonRepositoryDelegation,
  authenticatePrincipal,
  resolveEditRoots,
  sessionCwd = '/workspace/project',
} = {}) {
  const effects = []
  const opens = []
  const edits = []
  const runs = []
  const stops = []
  const releases = []
  const abandonedOpens = []
  const abandonedBegins = []
  const runtimePreparations = []
  let runResult
  let stopResult = {
    action: 'allow',
    generation: 1,
    contractDigest: `sha256:${'0'.repeat(64)}`,
    correlationId,
    reasonCodes: [],
    remediation: [],
  }
  const client = {
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
    async run(request) {
      runs.push(structuredClone(request))
      if (request.execution === undefined && runResult === undefined) {
        return {
          status: 'ready',
          operationId: request.operationId,
          correlationId,
        }
      }
      return runResult ?? {
        status: 'applied',
        operationId: request.operationId,
        generation: 1,
        correlationId,
        execution: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: request.timeoutMs,
          stdout: { text: 'validated\n', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: request.execution?.runner?.kind === 'unsandboxed'
            ? undefined
            : {
              mode: request.execution?.runner?.kind === 'confined'
                ? request.execution.runner.mode
                : 'danger-full-access',
              denied: false,
              ...(request.execution?.runner?.kind === 'confined'
                ? { enforcement: request.execution.runner.enforcement }
                : {}),
            },
        },
      }
    },
    async stop(request) {
      stops.push(structuredClone(request))
      return stopResult
    },
    async release(request) {
      releases.push(structuredClone(request))
      return { correlationId }
    },
    abandonOpen(request) {
      abandonedOpens.push(structuredClone(request))
    },
    abandonBegin(request) {
      abandonedBegins.push(structuredClone(request))
    },
    async drain() {},
    async dispose() {},
    get active() { return 0 },
    get degraded() { return false },
  }
  let agent
  const ctx = {
    effect(execute) { effects.push(execute()) },
    agents: {
      get(id) { return agent?.id === id ? agent : undefined },
    },
  }
  let operation = 0
  const coordinator = createFinishLineCoordinator(ctx, {
    client,
    maxSameTurnSteers,
    now,
    requiresFinishLine,
    allowsNonRepositoryDelegation,
    authenticatePrincipal,
    resolveEditRoots,
    createOperationId: () => `operation:${++operation}`,
    prepareValidationRuntime: async (_exec, operation) => {
      runtimePreparations.push(structuredClone(operation))
      return typeof runtime === 'function' ? runtime(operation) : runtime
    },
    createSteeringMessage: text => ({ source: { kind: 'plugin' }, content: [{ type: 'text', text }] }),
  })
  const session = { header: { id: 'session-1', cwd: sessionCwd }, events: [] }
  const steered = []
  agent = {
    id: 'session-1',
    session,
    steer(message) { steered.push(message) },
  }
  return {
    coordinator,
    client,
    opens,
    edits,
    runs,
    stops,
    releases,
    abandonedOpens,
    abandonedBegins,
    runtimePreparations,
    steered,
    agent,
    setRunResult(value) { runResult = value },
    setStopResult(value) { stopResult = value },
    async dispose() {
      for (const effect of effects.reverse()) if (typeof effect === 'function') await effect()
    },
  }
}

test('acceptance authority authenticates the managed principal before opening its ledger', async () => {
  const order = []
  const subject = fixture({
    async authenticatePrincipal(agent, signal) {
      assert.equal(agent.id, 'session-1')
      assert.equal(signal.aborted, false)
      order.push('authenticated')
    },
    requiresFinishLine() {
      order.push('classified')
      return true
    },
  })
  subject.client.open = async request => {
    order.push('opened')
    subject.opens.push(structuredClone(request))
    return { runnerCapability: 'finish-line-runner:opaque', correlationId }
  }

  await subject.coordinator.withAuthority(
    subject.agent,
    '1',
    new AbortController().signal,
    async () => {},
  )

  assert.deepEqual(order, ['authenticated', 'classified', 'opened'])
})

test('an authenticated advisory session bypasses Linux-only finish-line without opening state', async () => {
  const subject = fixture({ requiresFinishLine: () => false })
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: 'git rev-parse HEAD', description: 'Read current commit' },
  })

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  assert.deepEqual(await subject.coordinator.execute(exec), { kind: 'delegate' })
  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.deepEqual(subject.opens, [])
  assert.deepEqual(subject.runs, [])
  assert.deepEqual(subject.stops, [])
  assert.deepEqual(subject.releases, [])
  assert.equal(subject.coordinator.activeReservations, 0)
  assert.equal(subject.coordinator.degraded, false)
  await subject.dispose()
})

test('a typed non-repository result returns pwd for only the matching Bash workdir', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  const originalOpen = subject.client.open
  subject.client.open = async request => {
    if (request.cwd !== '/workspace/home') return originalOpen(request)
    if (request.command !== undefined) assert.equal(request.command, '/usr/bin/pwd')
    return { kind: 'not-in-repository' }
  }

  const home = execution(subject, {
    name: 'bash',
    arguments: Object.freeze({ command: 'pwd', description: 'Show home directory' }),
    callId: 'home-pwd',
  })
  assert.deepEqual(await subject.coordinator.begin(home, context(home, {
    cwd: '/workspace/home',
  })), { ok: true })
  const homeResult = await subject.coordinator.execute(home)
  assert.equal(homeResult.kind, 'result')
  assert.deepEqual(homeResult.result.value, {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30 * 60 * 1_000,
    stdout: { text: '/workspace/home\n', truncated: false },
    stderr: { text: '', truncated: false },
  })
  assert.equal(home.arguments.command, 'pwd')

  const repository = execution(subject, {
    name: 'bash',
    arguments: {
      command: 'npm test',
      description: 'Run repository validation',
      workdir: '/workspace/project',
    },
    callId: 'repo-test',
  })
  assert.deepEqual(await subject.coordinator.begin(repository, context(repository, {
    cwd: '/workspace/home',
  })), { ok: true })
  assert.equal((await subject.coordinator.execute(repository)).kind, 'result')
  assert.deepEqual(subject.opens.map(open => open.cwd), ['/workspace/project'])
  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.deepEqual(subject.stops.map(stop => stop.cwd), ['/workspace/project'])
})

test('a prepared non-repository pwd rejects in-place argument mutation before delegation', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  subject.client.open = async () => ({ kind: 'not-in-repository' })
  const arguments_ = { command: 'pwd', description: 'Show home directory' }
  const exec = execution(subject, {
    name: 'bash',
    arguments: arguments_,
    callId: 'mutable-home-pwd',
  })

  assert.deepEqual(await subject.coordinator.probe(exec, context(exec, {
    cwd: '/workspace/home',
  })), { ok: true, kind: 'ordinary' })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec, {
    cwd: '/workspace/home',
  })), { ok: true })
  arguments_.command = 'printf compromised > /workspace/project/tracked.txt'
  arguments_.run_in_background = true

  await assert.rejects(
    subject.coordinator.execute(exec),
    /non-repository correlation invalid/,
  )
  assert.equal(subject.runs.length, 0)
})

test('repository and non-repository workdirs retain independent ledgers across one turn', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
    runtime: operation => ({
      timeoutMs: 5_000,
      execution: {
        kind: 'bash-v1',
        workdir: operation.workdir,
        outputMaxBytes: 64 * 1024,
        runner: { kind: 'danger-full-access' },
      },
    }),
  })
  const originalOpen = subject.client.open
  subject.client.open = async request => request.cwd === '/workspace/home'
    ? { kind: 'not-in-repository' }
    : originalOpen(request)

  for (const [callId, command, workdir] of [
    ['repo-first', 'npm test', '/workspace/project'],
    ['home-middle', 'pwd', '/workspace/home'],
    ['repo-last', 'npm run lint', '/workspace/project'],
  ]) {
    const exec = execution(subject, {
      name: 'bash',
      arguments: { command, description: callId, workdir },
      callId,
    })
    assert.deepEqual(await subject.coordinator.begin(exec, context(exec, {
      cwd: '/workspace/home',
    })), { ok: true })
    const routed = await subject.coordinator.execute(exec)
    assert.equal(routed.kind, 'result')
    subject.coordinator.result(exec, routed.result)
  }

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.deepEqual(subject.stops.map(stop => stop.cwd), ['/workspace/project'])
  assert.deepEqual(subject.releases.map(release => release.cwd), ['/workspace/project'])
})

test('stop checks the header repository and every concurrent operation repository', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/header',
    runtime: operation => ({
      timeoutMs: 5_000,
      execution: {
        kind: 'bash-v1',
        workdir: operation.workdir,
        outputMaxBytes: 64 * 1024,
        runner: { kind: 'danger-full-access' },
      },
    }),
  })
  const first = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Validate A', workdir: '/workspace/a' },
    callId: 'repo-a',
  })
  const second = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Validate B', workdir: '/workspace/b' },
    callId: 'repo-b',
  })

  await Promise.all([
    subject.coordinator.begin(first, context(first, { cwd: '/workspace/header' })),
    subject.coordinator.begin(second, context(second, { cwd: '/workspace/header' })),
  ])
  const results = await Promise.all([
    subject.coordinator.execute(first),
    subject.coordinator.execute(second),
  ])
  subject.coordinator.result(first, results[0].result)
  subject.coordinator.result(second, results[1].result)

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.deepEqual(subject.stops.map(stop => stop.cwd), [
    '/workspace/header',
    '/workspace/a',
    '/workspace/b',
  ])
  assert.deepEqual(subject.releases.map(release => release.cwd).sort(), [
    '/workspace/a',
    '/workspace/b',
    '/workspace/header',
  ])
})

test('an unsatisfied header repository blocks stop after work in another repository', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/header',
    runtime: operation => ({
      timeoutMs: 5_000,
      execution: {
        kind: 'bash-v1',
        workdir: operation.workdir,
        outputMaxBytes: 64 * 1024,
        runner: { kind: 'danger-full-access' },
      },
    }),
  })
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Validate B', workdir: '/workspace/b' },
    callId: 'repo-b-before-header-stop',
  })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec, {
    cwd: '/workspace/header',
  })), { ok: true })
  const routed = await subject.coordinator.execute(exec)
  subject.coordinator.result(exec, routed.result)
  subject.client.stop = async request => {
    subject.stops.push(structuredClone(request))
    return {
      action: request.cwd === '/workspace/header' ? 'block' : 'allow',
      generation: 1,
      contractDigest: `sha256:${'0'.repeat(64)}`,
      correlationId,
      reasonCodes: request.cwd === '/workspace/header' ? ['validation-required'] : [],
      remediation: [],
    }
  }

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), false)
  assert.deepEqual(subject.stops.map(stop => stop.cwd), ['/workspace/header'])
  assert.equal(subject.releases.length, 0)
  assert.match(subject.steered[0].content[0].text, /validation-required/)
})

test('a non-repository workdir cannot delegate an absolute repository write', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  const commands = []
  subject.client.open = async request => {
    commands.push(request.command)
    throw new Error('finish-line non-repository operation unauthorized')
  }
  const exec = execution(subject, {
    name: 'bash',
    arguments: {
      command: 'printf x > /workspace/project/tracked.txt',
      description: 'Write through an absolute repository path',
    },
    callId: 'absolute-repository-write',
  })

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec, {
    cwd: '/workspace/home',
  })), { ok: true })
  await assert.rejects(
    subject.coordinator.execute(exec),
    /finish-line non-repository operation unauthorized/,
  )
  assert.deepEqual(commands, [
    'printf x > /workspace/project/tracked.txt',
    'printf x > /workspace/project/tracked.txt',
  ])
})

test('concurrent non-repository opens cannot reuse another command classification', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  let releasePwd
  const pwdGate = new Promise(resolve => { releasePwd = resolve })
  const commands = []
  subject.client.open = async request => {
    commands.push(request.command)
    if (request.command === '/usr/bin/pwd') {
      await pwdGate
      return { kind: 'not-in-repository' }
    }
    throw new Error('finish-line non-repository operation unauthorized')
  }
  const pwd = execution(subject, {
    name: 'bash',
    arguments: { command: 'pwd', description: 'Show cwd' },
    callId: 'concurrent-pwd',
  })
  const write = execution(subject, {
    name: 'bash',
    arguments: {
      command: 'printf x > /workspace/project/tracked.txt',
      description: 'Write through an absolute repository path',
    },
    callId: 'concurrent-write',
  })
  await Promise.all([
    subject.coordinator.begin(pwd, context(pwd, { cwd: '/workspace/home' })),
    subject.coordinator.begin(write, context(write, { cwd: '/workspace/home' })),
  ])
  const pwdResult = subject.coordinator.execute(pwd)
  await new Promise(resolve => setImmediate(resolve))
  const writeResult = subject.coordinator.execute(write)
  await new Promise(resolve => setImmediate(resolve))
  releasePwd()

  const pwdRouted = await pwdResult
  assert.equal(pwdRouted.kind, 'result')
  assert.equal(pwdRouted.result.value.stdout.text, '/workspace/home\n')
  assert.equal(pwd.arguments.command, 'pwd')
  await assert.rejects(writeResult, /finish-line non-repository operation unauthorized/)
  assert.deepEqual(commands, [
    '/usr/bin/pwd',
    'printf x > /workspace/project/tracked.txt',
    'printf x > /workspace/project/tracked.txt',
  ])
})

test('a non-repository session keeps editor mutations fail-closed', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  subject.client.open = async () => ({ kind: 'not-in-repository' })
  const exec = execution(subject, {
    name: 'edit',
    arguments: {
      file_path: '/workspace/project/a.txt',
      old_string: 'old',
      new_string: 'new',
    },
  })

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec, {
    cwd: '/workspace/home',
  })), { ok: false, reason: 'finish-line-unavailable' })
  assert.equal(subject.edits.length, 0)
})

test('a no-tool non-repository turn classifies its stop through exact open', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/home',
    allowsNonRepositoryDelegation: () => true,
  })
  subject.client.open = async request => {
    assert.equal(request.cwd, '/workspace/home')
    return { kind: 'not-in-repository' }
  }

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.equal(subject.stops.length, 0)
})

function execution(subject, {
  name = 'edit',
  arguments: arguments_ = { file_path: '/workspace/project/a.txt', old_string: 'secret-old', new_string: 'secret-new' },
  callId = 'call-1',
  rootCallId = callId,
  token = Symbol(callId),
  parent,
  signal = new AbortController().signal,
} = {}) {
  return {
    agent: subject.agent,
    token,
    callId,
    rootCallId,
    name,
    arguments: arguments_,
    signal,
    ...(parent === undefined ? {} : { parent }),
  }
}

function context(exec, overrides = {}) {
  return {
    token: exec.token,
    parent: exec.parent,
    sessionId: 'session-1',
    cwd: '/workspace/project',
    turn: 1,
    step: 1,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    name: exec.name,
    ...overrides,
  }
}

function configureOrdinaryShell(subject) {
  const originalRun = subject.client.run
  subject.client.run = async request => {
    const result = await originalRun(request)
    return request.execution === undefined
      ? {
          ...result,
          status: 'ordinary-ready',
          generation: undefined,
          execution: undefined,
        }
      : { ...result, status: 'ordinary-applied' }
  }
}

test('edit generation is durably advanced before delegation without retaining file payload', async () => {
  const subject = fixture()
  const exec = execution(subject)
  const order = []
  let release
  const durable = new Promise(resolve => { release = resolve })
  subject.client.beginEdit = async request => {
    order.push('begin')
    await durable
    order.push('durable')
    subject.edits.push(structuredClone(request))
    return { status: 'registered', operationId: request.operationId, generation: 1, correlationId }
  }
  const pending = subject.coordinator.begin(exec, context(exec)).then(result => {
    order.push('delegate')
    return result
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['begin'])
  release()
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(order, ['begin', 'durable', 'delegate'])
  assert.doesNotMatch(JSON.stringify(subject.edits), /a\.txt|secret-old|secret-new/)
})

test('an exact validation transparently runs through nils and becomes a Bash foreground value', async () => {
  const subject = fixture()
  const command = 'npm test && printf "literal $HOME"'
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command, description: 'Run exact validation', timeoutMs: 5_000 },
  })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  assert.equal(subject.opens.length, 0)
  const routed = await subject.coordinator.execute(exec)
  assert.equal(routed.kind, 'result')
  assert.deepEqual(subject.opens, [{
    product: 'dsh',
    sessionId: 'session-1',
    turnId: '1',
    cwd: '/workspace/project',
    command,
  }])
  assert.equal(subject.runs[1].command, command)
  assert.equal(subject.runs[1].runnerCapability, 'finish-line-runner:opaque')
  assert.deepEqual(subject.runs[1].execution.runner, { kind: 'danger-full-access' })
  assert.equal('outcome' in subject.runs[1], false)
  assert.deepEqual(routed.result.value, {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 5_000,
    stdout: { text: 'validated\n', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'danger-full-access', denied: false },
  })
  subject.coordinator.result(exec, routed.result)
  assert.equal(subject.coordinator.degraded, false)
})

test('parallel validations share one session capability opening', async () => {
  const subject = fixture()
  const originalOpen = subject.client.open
  let releaseOpen
  const openGate = new Promise(resolve => { releaseOpen = resolve })
  let openCalls = 0
  subject.client.open = async request => {
    openCalls += 1
    await openGate
    return originalOpen(request)
  }
  const first = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run first validation' },
    callId: 'validation-1',
  })
  const second = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run second validation' },
    callId: 'validation-2',
  })
  await subject.coordinator.begin(first, context(first))
  await subject.coordinator.begin(second, context(second))

  const firstRun = subject.coordinator.execute(first)
  const secondRun = subject.coordinator.execute(second)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(openCalls, 1)
  releaseOpen()
  assert.equal((await firstRun).kind, 'result')
  assert.equal((await secondRun).kind, 'result')
  assert.equal(subject.opens.length, 1)
  assert.equal(subject.runs.length, 4)
})

test('an active session renews its runner capability lease without rotating the bearer', async () => {
  let clock = 1_000
  const subject = fixture({ now: () => clock })
  const first = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run first validation' },
    callId: 'lease-first',
  })
  await subject.coordinator.begin(first, context(first))
  const firstResult = await subject.coordinator.execute(first)
  subject.coordinator.result(first, firstResult.result)
  assert.equal(subject.opens.length, 1)

  clock += 60 * 60 * 1_000 + 1
  const second = execution(subject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run second validation' },
    callId: 'lease-second',
  })
  await subject.coordinator.begin(second, context(second))
  const secondResult = await subject.coordinator.execute(second)
  subject.coordinator.result(second, secondResult.result)

  assert.equal(subject.opens.length, 2)
  assert.equal(subject.runs[1].runnerCapability, subject.runs[3].runnerCapability)
})

test('a non-contract foreground Bash command is executed once by nils and invalidates evidence', async () => {
  const subject = fixture()
  configureOrdinaryShell(subject)
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: 'pwd', description: 'Show current directory' },
  })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  const routed = await subject.coordinator.execute(exec)
  assert.equal(routed.kind, 'result')
  assert.equal(subject.edits.length, 0)
  assert.equal(subject.runs.length, 2)
  assert.equal(subject.runs[1].command, '/usr/bin/pwd')
  assert.equal(subject.runs[1].execution.kind, 'bash-v1')
  assert.deepEqual(subject.runs[1].execution.runner, { kind: 'danger-full-access' })
  subject.coordinator.result(exec, routed.result)
  assert.equal(subject.coordinator.degraded, false)
})

test('background Bash is denied while ordinary workdir and escalation inputs stay nils-supervised', async () => {
  {
    const subject = fixture()
    const exec = execution(subject, {
      name: 'bash',
      arguments: { command: ':', description: 'Run background', run_in_background: true },
    })
    assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), {
      ok: false,
      reason: 'finish-line-background-unsupported',
    })
    assert.equal(subject.runs.length, 0)
    assert.equal(subject.edits.length, 0)
  }
  for (const arguments_ of [
    { command: ':', description: 'Run elsewhere', workdir: '/tmp' },
    { command: ':', description: 'Escalate command', sandbox_permissions: 'danger-full-access', justification: 'test' },
  ]) {
    const subject = fixture({
      runtime: {
        timeoutMs: 5_000,
        execution: {
          kind: 'bash-v1',
          workdir: arguments_.workdir ?? '/workspace/project',
          outputMaxBytes: 64 * 1024,
          runner: { kind: 'danger-full-access' },
        },
      },
    })
    configureOrdinaryShell(subject)
    const exec = execution(subject, { name: 'bash', arguments: arguments_ })
    assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
    assert.equal((await subject.coordinator.execute(exec)).kind, 'result')
    assert.equal(subject.runs.length, 2)
    assert.equal(subject.edits.length, 0)
    assert.equal(subject.runtimePreparations.length, 1)
    assert.equal(subject.runtimePreparations[0].kind, 'ordinary')
    assert.equal(subject.runtimePreparations[0].workdir, arguments_.workdir)
    assert.equal(subject.runtimePreparations[0].sandboxPermissions, arguments_.sandbox_permissions)
  }
})

test('legacy nils not-applicable probes fail closed instead of delegating Bash', async () => {
  const subject = fixture()
  subject.setRunResult({
    status: 'not-applicable',
    operationId: 'operation:1',
    correlationId,
  })
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: 'pwd', description: 'Show current directory' },
  })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  await assert.rejects(subject.coordinator.execute(exec), /probe response invalid/)
  assert.equal(subject.coordinator.degraded, true)
})

test('a confined validation runs through the exact provider argv and retains sandbox facts', async () => {
  const command = 'npm test'
  const providerArgv = ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', command]
  const subject = fixture({
    runtime: {
      timeoutMs: 4_321,
      execution: {
        kind: 'bash-v1',
        workdir: '/workspace/project',
        outputMaxBytes: 64 * 1024,
        runner: {
          kind: 'confined',
          providerArgv,
          mode: 'workspace-write',
          enforcement: 'full',
          denialSignatures: ['read-only file system'],
          runnerFailureRules: [],
        },
      },
      environment: { DSH_SHELL: '1', TERM: 'dumb' },
    },
  })
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command, description: 'Run validation' },
  })
  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  const routed = await subject.coordinator.execute(exec)
  assert.equal(routed.kind, 'result')
  assert.deepEqual(subject.runs[1].execution.runner.providerArgv, providerArgv)
  assert.deepEqual(subject.runs[1].environment, { DSH_SHELL: '1', TERM: 'dumb' })
  assert.equal(subject.runs[1].timeoutMs, 4_321)
  assert.deepEqual(routed.result.value.sandbox, {
    mode: 'workspace-write',
    denied: false,
    enforcement: 'full',
  })
})

test('an exact contract preserves workdir and escalation inputs for public DSH runtime preparation', async () => {
  const subject = fixture()
  const command = 'npm test'
  const exec = execution(subject, {
    name: 'bash',
    arguments: {
      command,
      description: 'Run exact validation with approved escalation',
      timeoutMs: 4_321,
      workdir: '.',
      sandbox_permissions: 'danger-full-access',
      justification: 'validation requires the approved runtime boundary',
    },
  })

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  assert.equal((await subject.coordinator.execute(exec)).kind, 'result')
  assert.deepEqual(subject.runtimePreparations, [{
    kind: 'validation',
    intent: 'project-dev',
    command,
    timeoutMs: 4_321,
    workdir: '.',
    sandboxPermissions: 'danger-full-access',
    justification: 'validation requires the approved runtime boundary',
  }])
})

test('substituted execution identity cannot replay a prepared validation', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Run validation' },
  })
  await subject.coordinator.begin(exec, context(exec))
  const replacement = { ...exec, token: Symbol('replacement') }
  await assert.rejects(subject.coordinator.execute(replacement), /correlation invalid/)
  assert.equal(subject.runs.length, 0)
})

test('the same prepared validation accepts a composed execution cancellation signal', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Run validation' },
  })
  await subject.coordinator.begin(exec, context(exec))

  exec.signal = new AbortController().signal

  assert.equal((await subject.coordinator.execute(exec)).kind, 'result')
  assert.equal(subject.runs.length, 2)
})

test('one session correlation is pinned across begin, probe, execution, and stop responses', async () => {
  const beginSubject = fixture()
  const firstEdit = execution(beginSubject, { callId: 'edit-1' })
  assert.deepEqual(await beginSubject.coordinator.begin(firstEdit, context(firstEdit)), { ok: true })
  beginSubject.client.beginEdit = async request => ({
    status: 'registered',
    operationId: request.operationId,
    generation: 2,
    correlationId: 'correlation:replacement',
  })
  const secondEdit = execution(beginSubject, { callId: 'edit-2' })
  assert.deepEqual(await beginSubject.coordinator.begin(secondEdit, context(secondEdit)), {
    ok: false,
    reason: 'finish-line-unavailable',
  })
  assert.equal(beginSubject.coordinator.degraded, true)

  const probeSubject = fixture()
  probeSubject.setRunResult({
    status: 'ready',
    operationId: 'operation:1',
    correlationId: 'correlation:replacement',
  })
  const probeExec = execution(probeSubject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run validation' },
  })
  await probeSubject.coordinator.begin(probeExec, context(probeExec))
  await assert.rejects(
    probeSubject.coordinator.execute(probeExec),
    /response correlation invalid/,
  )
  assert.equal(probeSubject.coordinator.degraded, true)

  const executionSubject = fixture()
  const originalRun = executionSubject.client.run
  let runs = 0
  executionSubject.client.run = async request => {
    runs += 1
    const result = await originalRun(request)
    return runs === 2 ? { ...result, correlationId: 'correlation:replacement' } : result
  }
  const validationExec = execution(executionSubject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run validation' },
  })
  await executionSubject.coordinator.begin(validationExec, context(validationExec))
  await assert.rejects(
    executionSubject.coordinator.execute(validationExec),
    /response correlation invalid/,
  )
  assert.equal(executionSubject.coordinator.degraded, true)

  const stopSubject = fixture()
  const stopExec = execution(stopSubject, {
    name: 'bash',
    arguments: { command: 'npm test', description: 'Run validation' },
  })
  await stopSubject.coordinator.begin(stopExec, context(stopExec))
  assert.equal((await stopSubject.coordinator.execute(stopExec)).kind, 'result')
  stopSubject.setStopResult({
    action: 'allow',
    generation: 1,
    contractDigest: `sha256:${'0'.repeat(64)}`,
    correlationId: 'correlation:replacement',
    reasonCodes: [],
    remediation: [],
  })
  await stopSubject.coordinator.turnStopping({
    agent: stopSubject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true)
  assert.equal(stopSubject.steered.length, 1)
  assert.match(stopSubject.steered[0].content[0].text, /identity changed/)
  assert.equal(stopSubject.coordinator.degraded, true)
})

test('runner failure poisons the session and stop steers instead of accepting partial evidence', async () => {
  const subject = fixture()
  subject.client.run = async () => { throw new Error('private subprocess detail') }
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Run validation' },
  })
  await subject.coordinator.begin(exec, context(exec))
  await assert.rejects(subject.coordinator.execute(exec), /private subprocess detail/)
  await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true)
  assert.equal(subject.stops.length, 0)
  assert.equal(subject.steered.length, 1)
  assert.doesNotMatch(subject.steered[0].content[0].text, /private subprocess detail/)
})

test('typed stop blocks with bounded remediation and enforces the same-turn steering limit', async () => {
  const subject = fixture({ maxSameTurnSteers: 2 })
  subject.setStopResult({
    action: 'block',
    generation: 3,
    contractDigest: `sha256:${'1'.repeat(64)}`,
    correlationId,
    reasonCodes: ['validation-failed'],
    remediation: ['rerun the required validation'],
  })
  const payload = { agent: subject.agent, turn: 1, signal: new AbortController().signal }
  await subject.coordinator.turnStopping(payload, true)
  await subject.coordinator.turnStopping(payload, true)
  assert.equal(subject.steered.length, 2)
  assert.match(subject.steered[0].content[0].text, /validation-failed/)
  await assert.rejects(subject.coordinator.turnStopping(payload, true), /same-turn steering limit/)
})

test('typed stop truncates multibyte steering at one valid UTF-8 boundary', async () => {
  const subject = fixture()
  subject.setStopResult({
    action: 'block',
    generation: 3,
    contractDigest: `sha256:${'1'.repeat(64)}`,
    correlationId,
    reasonCodes: ['validation-failed'],
    remediation: ['🧪'.repeat(2_000)],
  })

  await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true)
  const text = subject.steered[0].content[0].text
  assert.equal(Buffer.byteLength(text, 'utf8') <= 4 * 1024, true)
  assert.equal(text.includes('\uFFFD'), false)
})

test('dispose clears pending correlations and closes the nils client', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Run validation' },
  })
  await subject.coordinator.begin(exec, context(exec))
  assert.equal(subject.coordinator.activeReservations, 1)
  await subject.dispose()
  assert.equal(subject.coordinator.activeReservations, 0)
})

test('agent disposal releases its capability and removes the exact session ledger', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open a runner capability' },
  })
  await subject.coordinator.begin(exec, context(exec))
  const routed = await subject.coordinator.execute(exec)
  subject.coordinator.result(exec, routed.result)
  assert.equal(subject.coordinator.trackedSessions, 1)

  await subject.coordinator.agentDisposed(subject.agent)

  assert.deepEqual(subject.releases, [{
    product: 'dsh',
    sessionId: 'session-1',
    turnId: '1',
    cwd: '/workspace/project',
    runnerCapability: 'finish-line-runner:opaque',
  }])
  assert.equal(subject.coordinator.trackedSessions, 0)
})

test('an allowed turn releases its capability before the agent becomes idle', async () => {
  const subject = fixture()
  const first = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Validate the first turn' },
  })
  await subject.coordinator.begin(first, context(first))
  const firstResult = await subject.coordinator.execute(first)
  subject.coordinator.result(first, firstResult.result)

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)
  assert.equal(subject.coordinator.trackedSessions, 0)
  assert.deepEqual(subject.releases, [{
    product: 'dsh',
    sessionId: 'session-1',
    turnId: '1',
    cwd: '/workspace/project',
    runnerCapability: 'finish-line-runner:opaque',
  }])

  const second = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Validate the second turn' },
    callId: 'call-turn-2',
  })
  await subject.coordinator.begin(second, { ...context(second), turn: 2 })
  const secondResult = await subject.coordinator.execute(second)
  subject.coordinator.result(second, secondResult.result)
  assert.equal(subject.opens.length, 2)
  assert.equal(subject.opens[1].turnId, '2')
})

test('same-ID resume waits for the prior capability incarnation to release', async () => {
  const subject = fixture()
  let openCount = 0
  subject.client.open = async request => {
    subject.opens.push(structuredClone(request))
    openCount += 1
    return { runnerCapability: `finish-line-runner:incarnation-${openCount}`, correlationId }
  }
  const first = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open the first runner capability' },
  })
  await subject.coordinator.begin(first, context(first))
  const firstRouted = await subject.coordinator.execute(first)
  subject.coordinator.result(first, firstRouted.result)

  let finishRelease
  const releaseGate = new Promise(resolve => { finishRelease = resolve })
  subject.client.release = async request => {
    subject.releases.push(structuredClone(request))
    await releaseGate
    return { correlationId }
  }
  void subject.coordinator.agentDisposed(subject.agent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.releases.length, 1)

  const resumedSession = { header: { id: 'session-1', cwd: '/workspace/project' }, events: [] }
  const resumedAgent = {
    id: 'session-1',
    session: resumedSession,
    steer() {},
  }
  const resumed = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open the resumed runner capability' },
    callId: 'call-resumed',
  })
  resumed.agent = resumedAgent
  const resumedBegin = subject.coordinator.begin(resumed, context(resumed))
  let resumedAdmitted = false
  void resumedBegin.then(() => { resumedAdmitted = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumedAdmitted, false)
  assert.equal(subject.opens.length, 1)

  finishRelease()
  assert.deepEqual(await resumedBegin, { ok: true })
  const resumedRouted = await subject.coordinator.execute(resumed)
  subject.coordinator.result(resumed, resumedRouted.result)

  assert.equal(subject.opens.length, 2)
  assert.equal(subject.runs.at(-1).runnerCapability, 'finish-line-runner:incarnation-2')
  assert.equal(subject.coordinator.degraded, false)
})

test('coordinator disposal drains a fire-and-forget agent release before closing the client', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open a runner capability' },
  })
  await subject.coordinator.begin(exec, context(exec))
  const routed = await subject.coordinator.execute(exec)
  subject.coordinator.result(exec, routed.result)

  let finishRelease
  const releaseGate = new Promise(resolve => { finishRelease = resolve })
  subject.client.release = async request => {
    subject.releases.push(structuredClone(request))
    await releaseGate
    return { correlationId }
  }
  void subject.coordinator.agentDisposed(subject.agent)

  let disposed = false
  const disposal = subject.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.releases.length, 1)
  assert.equal(disposed, false)

  finishRelease()
  await disposal
  assert.equal(subject.coordinator.trackedSessions, 0)
})

test('coordinator disposal releases a remaining quiescent session without an agent event', async () => {
  const subject = fixture()
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open a runner capability' },
  })
  await subject.coordinator.begin(exec, context(exec))
  const routed = await subject.coordinator.execute(exec)
  subject.coordinator.result(exec, routed.result)

  await subject.dispose()

  assert.equal(subject.releases.length, 1)
  assert.equal(subject.coordinator.trackedSessions, 0)
})

test('coordinator disposal quiesces an in-flight run before releasing its session', async () => {
  const subject = fixture()
  const originalRun = subject.client.run
  const order = []
  let runCalls = 0
  let rejectRun
  subject.client.run = async request => {
    runCalls += 1
    if (runCalls === 1) return originalRun(request)
    return new Promise((_resolve, reject) => { rejectRun = reject })
  }
  subject.client.drain = async () => {
    order.push('drain')
    rejectRun(new Error('disposed authoritative run'))
    await executing
  }
  subject.client.release = async request => {
    order.push('release')
    subject.releases.push(structuredClone(request))
    return { correlationId }
  }
  subject.client.dispose = async () => { order.push('client-dispose') }

  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Run until disposal' },
  })
  await subject.coordinator.begin(exec, context(exec))
  const executing = subject.coordinator.execute(exec).catch(error => {
    order.push('quiesced')
    return error
  })
  while (rejectRun === undefined) await new Promise(resolve => setImmediate(resolve))

  await subject.dispose()

  assert.deepEqual(order, ['drain', 'quiesced', 'release', 'client-dispose'])
  assert.equal(subject.releases.length, 1)
  assert.equal(subject.coordinator.trackedSessions, 0)
})

test('a definitively abandoned edit drops its retry token before poisoning the session', async () => {
  const subject = fixture()
  subject.client.beginEdit = async () => { throw new Error('ambiguous transport failure') }
  const exec = execution(subject)

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), {
    ok: false,
    reason: 'finish-line-unavailable',
  })
  assert.equal(subject.abandonedBegins.length, 1)
  assert.equal(subject.abandonedBegins[0].operationId, 'operation:1')
})

test('a definitively abandoned capability open drops its retry token after one exact retry', async () => {
  const subject = fixture()
  let openCalls = 0
  subject.client.open = async () => {
    openCalls += 1
    throw new Error('ambiguous open transport failure')
  }
  const exec = execution(subject, {
    name: 'bash',
    arguments: { command: ':', description: 'Open a runner capability' },
  })
  await subject.coordinator.begin(exec, context(exec))

  await assert.rejects(subject.coordinator.execute(exec), /ambiguous open transport failure/)

  assert.equal(openCalls, 2)
  assert.equal(subject.abandonedOpens.length, 1)
  assert.equal(subject.abandonedOpens[0].sessionId, 'session-1')
})

test('an edit reserves its generation against the repository it targets', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/repo-a',
    resolveEditRoots: async () => ['/workspace/repo-b'],
  })
  const exec = execution(subject, {
    arguments: { file_path: '/workspace/repo-b/src/index.js', old_string: 'a', new_string: 'b' },
  })

  assert.deepEqual(
    await subject.coordinator.begin(exec, context(exec, { cwd: '/workspace/repo-a' })),
    { ok: true },
  )

  // The edited repository owns the generation, not the session anchor.
  assert.equal(subject.edits.length, 1)
  assert.equal(subject.edits[0].cwd, '/workspace/repo-b')
  assert.equal(subject.opens.length, 1)
  assert.equal(subject.opens[0].cwd, '/workspace/repo-b')
})

test('an edit with no repository target creates no Git validation obligation', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/repo-a',
    resolveEditRoots: async () => [],
  })
  const exec = execution(subject, {
    arguments: { file_path: '/srv/notes/todo.md', old_string: 'a', new_string: 'b' },
  })

  assert.deepEqual(
    await subject.coordinator.begin(exec, context(exec, { cwd: '/workspace/repo-a' })),
    { ok: true },
  )
  assert.deepEqual(subject.edits, [])
  assert.deepEqual(subject.opens, [])
})

test('an ambiguous edit target set fails closed before reserving anything', async () => {
  const subject = fixture({
    sessionCwd: '/workspace/repo-a',
    resolveEditRoots: async () => ['/workspace/repo-a', '/workspace/repo-b'],
  })
  const exec = execution(subject)

  assert.deepEqual(
    await subject.coordinator.begin(exec, context(exec, { cwd: '/workspace/repo-a' })),
    { ok: false, reason: 'finish-line-edit-target-ambiguous' },
  )
  assert.deepEqual(subject.edits, [])
})

test('stop requires validation for every repository the turn modified', async () => {
  const roots = ['/workspace/repo-a', '/workspace/repo-b']
  let call = 0
  const subject = fixture({
    sessionCwd: '/workspace/repo-a',
    resolveEditRoots: async () => [roots[call++]],
  })

  for (const [index, root] of roots.entries()) {
    const exec = execution(subject, {
      callId: `call-${index}`,
      arguments: { file_path: `${root}/src/index.js`, old_string: 'a', new_string: 'b' },
    })
    assert.deepEqual(
      await subject.coordinator.begin(exec, context(exec, { cwd: '/workspace/repo-a' })),
      { ok: true },
      root,
    )
    assert.deepEqual(await subject.coordinator.execute(exec), { kind: 'delegate' })
    subject.coordinator.result(exec, { isError: false, content: [] })
  }
  assert.deepEqual(subject.edits.map(edit => edit.cwd), roots)

  assert.equal(await subject.coordinator.turnStopping({
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }, true), true)

  // Both modified repositories must be asked to validate and released, not
  // just the session anchor.
  assert.deepEqual(subject.stops.map(stop => stop.cwd).sort(), roots)
  assert.deepEqual(subject.releases.map(release => release.cwd).sort(), roots)
})

test('without a lease projection an edit keeps the session anchor', async () => {
  const subject = fixture()
  const exec = execution(subject)

  assert.deepEqual(await subject.coordinator.begin(exec, context(exec)), { ok: true })
  assert.equal(subject.edits.length, 1)
  assert.equal(subject.edits[0].cwd, '/workspace/project')
})

test('a failed target projection preserves the lease cause it came from', async () => {
  // The workspace-lease service denies this same execution with this exact
  // typed cause moments later. The ledger must not replace it with a
  // finish-line reason: issue 172 requires the root cause to survive.
  const cause = Object.assign(
    new Error('the workspace has uncommitted state and cannot be reassigned safely'),
    { code: 'WORKSPACE_DIRTY' },
  )
  const subject = fixture({
    sessionCwd: '/workspace/repo-a',
    resolveEditRoots: async () => { throw cause },
  })
  const exec = execution(subject)

  // The ledger reserves nothing and reports no reason of its own; the lease
  // service denies this same execution with `cause` right after this
  // boundary returns. test/finish-line-repository-scope.test.mjs pins that
  // composed behaviour so this is verified rather than assumed.
  assert.deepEqual(
    await subject.coordinator.begin(exec, context(exec, { cwd: '/workspace/repo-a' })),
    { ok: true },
  )
  assert.deepEqual(subject.edits, [])
  assert.deepEqual(subject.opens, [])
})
