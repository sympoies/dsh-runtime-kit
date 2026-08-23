import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createNilsFinishLineClient } from '../src/finish-line/nils-client.js'
import { isolatedNilsEnvironment } from '../src/nils/session-environment.js'

const digest = `sha256:${'0'.repeat(64)}`
const correlationId = 'correlation:opaque'

function agentHookArgs(...args) {
  return [
    '/test/agent-hook',
    '--config', '/runtime/agent-hook/config.toml',
    '--policy', '/runtime/agent-hook/dsh-policy.toml',
    '--state-dir', '/runtime/agent-hook/state',
    ...args,
  ]
}

function responseFor(action, request, overrides = {}) {
  const data = {
    open: {
      schema_version: 'agent-hook.finish-line.open-result.v1',
      status: 'opened',
      runner_capability: 'finish-line-runner:opaque',
      correlation_id: correlationId,
    },
    begin: {
      schema_version: 'agent-hook.finish-line.begin-result.v1',
      status: 'registered',
      operation_id: request.operation_id,
      generation: 4,
      operation_kind: 'edit',
      correlation_id: correlationId,
    },
    run: {
      schema_version: 'agent-hook.finish-line.run-result.v1',
      status: 'applied',
      operation_id: request.operation_id,
      generation: 4,
      intent: request.intent,
      contract_digest: digest,
      target_digest: digest,
      correlation_id: correlationId,
      output_replayed: true,
      execution: {
        exit_code: 17,
        signal: null,
        timed_out: false,
        aborted: false,
        timeout_ms: request.timeout_ms,
        stdout: { text: 'out\n', truncated: false },
        stderr: { text: 'err\n', truncated: false },
      },
    },
    stop: {
      schema_version: 'agent-hook.finish-line.stop-result.v1',
      action: 'allow',
      generation: 4,
      contract_digest: digest,
      correlation_id: correlationId,
      reason_codes: [],
      remediation: [],
    },
    release: {
      schema_version: 'agent-hook.finish-line.release-result.v1',
      status: 'released',
      correlation_id: correlationId,
    },
    quiesce: {
      schema_version: 'agent-hook.finish-line.quiesce-result.v1',
      status: 'quiescent',
      operation_id: request.operation_id,
      correlation_id: correlationId,
    },
  }[action]
  return {
    schema_version: `cli.agent-hook.finish-line-${action}.v1`,
    ok: true,
    data: { ...data, ...overrides },
  }
}

function fixture({
  responder = responseFor,
  pending = false,
  pendingQuiesce = false,
  doneDelayMs = 0,
  waitForExit = true,
  quiesceWaitForExit = true,
} = {}) {
  const effects = []
  const spawns = []
  let terminateCount = 0
  let settleQuiesce
  const ctx = {
    effect(execute) { effects.push(execute()) },
    subprocess: {
      spawn(spec) {
        const finishLineIndex = spec.argv.indexOf('finish-line')
        const action = spec.argv[finishLineIndex + 1]
        const request = JSON.parse(spec.stdio.stdin.data)
        spawns.push({ spec, request })
        let settle
        const response = () => responder(action, request)
        const exitCode = action === 'stop' && response().data.action === 'block' ? 1 : 0
        const shouldPend = (pending && action !== 'quiesce')
          || (pendingQuiesce && action === 'quiesce')
        const done = shouldPend
          ? new Promise(resolve => {
              settle = resolve
              if (action === 'quiesce') {
                settleQuiesce = () => resolve({ exitCode, signal: null })
              }
            })
          : doneDelayMs > 0
            ? new Promise(resolve => setTimeout(
              () => resolve({ exitCode, signal: null }),
              doneDelayMs,
            ))
            : Promise.resolve({ exitCode, signal: null })
        return {
          done,
          terminate() {
            terminateCount += 1
            settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          async waitForExit() {
            const observation = action === 'quiesce' ? quiesceWaitForExit : waitForExit
            return observation === 'pending' ? new Promise(() => {}) : observation
          },
          collected: {
            stdout: {
              readFrom: () => ({ text: JSON.stringify(response()), lossy: false }),
            },
          },
        }
      },
    },
  }
  const client = createNilsFinishLineClient(ctx, {
    agentHook: '/test/agent-hook',
    agentHookConfig: '/runtime/agent-hook/config.toml',
    agentHookPolicy: '/runtime/agent-hook/dsh-policy.toml',
    agentHookStateDir: '/runtime/agent-hook/state',
    finishLineTimeoutMs: 100,
    finishLineTeardownTimeoutMs: 20,
    maxActiveFinishLineRequests: 4,
  })
  return {
    client,
    spawns,
    get terminateCount() { return terminateCount },
    settleQuiesce() { settleQuiesce?.() },
    async dispose() {
      for (const effect of effects.reverse()) if (typeof effect === 'function') await effect()
    },
  }
}

const identity = {
  product: 'dsh',
  sessionId: 'session-1',
  turnId: '7',
  cwd: '/workspace/project',
}

const dangerFullAccessExecution = {
  kind: 'bash-v1',
  workdir: '/workspace/project',
  outputMaxBytes: 64 * 1024,
  runner: { kind: 'danger-full-access' },
}

test('open carries one private retry token without exposing it in the result', async () => {
  const subject = fixture()
  const result = await subject.client.open(identity)
  assert.deepEqual(result, {
    runnerCapability: 'finish-line-runner:opaque',
    correlationId,
  })
  assert.deepEqual(
    subject.spawns[0].spec.argv,
    agentHookArgs('finish-line', 'open', '--format', 'json'),
  )
  assert.deepEqual(subject.spawns[0].request, {
    schema_version: 'agent-hook.finish-line.open.v1',
    product: 'dsh',
    session_id: 'session-1',
    turn_id: '7',
    cwd: '/workspace/project',
    attempt_token: subject.spawns[0].request.attempt_token,
  })
  assert.match(subject.spawns[0].request.attempt_token, /^finish-line-open:/)
  assert.doesNotMatch(JSON.stringify(result), /attempt_token|finish-line-open:/)
})

test('open retains its private token across an ambiguous committed response', async () => {
  let call = 0
  const subject = fixture({
    responder(action, request) {
      call += 1
      return responseFor(action, request, call === 1
        ? { runner_capability: '' }
        : { status: 'duplicate' })
    },
  })

  await assert.rejects(subject.client.open(identity), /finish-line response invalid/)
  assert.deepEqual(await subject.client.open({ ...identity, turnId: '8' }), {
    runnerCapability: 'finish-line-runner:opaque',
    correlationId,
  })
  assert.equal(subject.spawns.length, 2)
  assert.equal(subject.spawns[0].request.attempt_token, subject.spawns[1].request.attempt_token)
})

test('released or abandoned opens do not permanently consume the retry-token bound', async () => {
  const subject = fixture()
  for (let index = 0; index < 80; index += 1) {
    const request = { ...identity, sessionId: `session-release-${index}` }
    const opened = await subject.client.open(request)
    await subject.client.release({ ...request, runnerCapability: opened.runnerCapability })
  }
  for (let index = 0; index < 80; index += 1) {
    const request = { ...identity, sessionId: `session-abandon-${index}` }
    await subject.client.open(request)
    subject.client.abandonOpen(request)
  }
})

test('begin-edit advances generation without exposing its retry token', async () => {
  const subject = fixture()
  const result = await subject.client.beginEdit({ ...identity, operationId: 'operation:edit' })
  assert.equal(subject.spawns[0].request.operation.kind, 'edit')
  assert.match(subject.spawns[0].request.attempt_token, /^finish-line-edit:/)
  assert.doesNotMatch(JSON.stringify(result), /attempt_token|finish-line-edit/)
  assert.deepEqual(result, {
    status: 'registered',
    operationId: 'operation:edit',
    generation: 4,
    correlationId,
  })
})

test('begin-edit retains its private token across an ambiguous lost response', async () => {
  let call = 0
  const subject = fixture({
    responder(action, request) {
      call += 1
      return responseFor(action, request, call === 1
        ? { operation_id: 'lost-response' }
        : { status: 'duplicate' })
    },
  })
  const request = { ...identity, operationId: 'operation:retry-edit' }

  await assert.rejects(subject.client.beginEdit(request), /finish-line response invalid/)
  assert.equal((await subject.client.beginEdit(request)).status, 'duplicate')
  assert.equal(subject.spawns.length, 2)
  assert.equal(subject.spawns[0].request.attempt_token, subject.spawns[1].request.attempt_token)
})

test('abandoned begin retries do not permanently consume the bounded token budget', async () => {
  const subject = fixture({
    responder(action, request) {
      return responseFor(action, request, action === 'begin'
        ? { operation_id: 'ambiguous-lost-response' }
        : {})
    },
  })
  for (let index = 0; index < 129; index += 1) {
    const request = { ...identity, operationId: `operation:abandoned-${index}` }
    await assert.rejects(subject.client.beginEdit(request), /finish-line response invalid/)
    subject.client.abandonBegin(request)
  }
  assert.equal(subject.spawns.length, 129)
})

test('release authenticates and retires one exact session capability', async () => {
  const subject = fixture()
  assert.deepEqual(await subject.client.release({
    ...identity,
    runnerCapability: 'finish-line-runner:opaque',
  }), { correlationId })
  assert.deepEqual(
    subject.spawns[0].spec.argv,
    agentHookArgs('finish-line', 'release', '--format', 'json'),
  )
  assert.deepEqual(subject.spawns[0].request, {
    schema_version: 'agent-hook.finish-line.release.v1',
    product: 'dsh',
    session_id: 'session-1',
    turn_id: '7',
    cwd: '/workspace/project',
    runner_capability: 'finish-line-runner:opaque',
  })
})

test('drain closes ordinary admission but leaves authenticated release available', async () => {
  const subject = fixture()

  await subject.client.drain()

  await assert.rejects(subject.client.open(identity), /finish-line unavailable/)
  assert.deepEqual(await subject.client.release({
    ...identity,
    runnerCapability: 'finish-line-runner:opaque',
  }), { correlationId })
  assert.deepEqual(
    subject.spawns.map(spawn => spawn.spec.argv[spawn.spec.argv.indexOf('finish-line') + 1]),
    ['release'],
  )

  await subject.client.dispose()
  await assert.rejects(subject.client.release({
    ...identity,
    runnerCapability: 'finish-line-runner:opaque',
  }), /finish-line unavailable/)
})

test('run sends no outcome and preserves exact command bytes and observed execution facts', async () => {
  const subject = fixture()
  const command = 'npm test && printf "literal $HOME"'
  const providerArgv = ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', command]
  const environment = { DSH_SHELL: '1', TERM: 'dumb' }
  const result = await subject.client.run({
    ...identity,
    operationId: 'operation:run',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command,
    timeoutMs: 5_000,
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
    environment,
  })
  assert.deepEqual(
    subject.spawns[0].spec.argv,
    agentHookArgs('finish-line', 'run', '--format', 'json'),
  )
  assert.deepEqual(subject.spawns[0].request, {
    schema_version: 'agent-hook.finish-line.run.v1',
    product: 'dsh',
    session_id: 'session-1',
    turn_id: '7',
    cwd: '/workspace/project',
    operation_id: 'operation:run',
    runner_capability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command,
    timeout_ms: 5_000,
    execution: {
      kind: 'bash-v1',
      workdir: '/workspace/project',
      output_max_bytes: 64 * 1024,
      runner: {
        kind: 'confined',
        argv: providerArgv,
        mode: 'workspace-write',
        enforcement: 'full',
        denial_signatures: ['read-only file system'],
        runner_failure_rules: [],
      },
    },
  })
  assert.deepEqual(subject.spawns[0].spec.env, isolatedNilsEnvironment(environment))
  assert.equal(
    Object.entries(subject.spawns[0].spec.env)
      .filter(([, value]) => value === undefined)
      .every(([name]) => name.startsWith('AGENT_SESSION_')),
    true,
  )
  assert.equal('outcome' in subject.spawns[0].request, false)
  assert.deepEqual(result.execution, {
    exitCode: 17,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 5_000,
    stdout: { text: 'out\n', truncated: false },
    stderr: { text: 'err\n', truncated: false },
  })
})

test('run probes an exact contract without execution metadata or child environment', async () => {
  const subject = fixture({
    responder(action, request) {
      return responseFor(action, request, action === 'run'
        ? {
          status: 'ready',
          generation: undefined,
          execution: undefined,
        }
        : {})
    },
  })
  const result = await subject.client.run({
    ...identity,
    operationId: 'operation:probe',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: 'npm test',
    timeoutMs: 1,
  })

  assert.deepEqual(result, {
    status: 'ready',
    operationId: 'operation:probe',
    correlationId,
  })
  assert.equal('execution' in subject.spawns[0].request, false)
  assert.equal('env' in subject.spawns[0].spec, true)
  assert.deepEqual(subject.spawns[0].spec.env, isolatedNilsEnvironment(undefined))
})

test('ordinary foreground run is typed across probe and nils-observed execution', async () => {
  const subject = fixture({
    responder(action, request) {
      if (action !== 'run') return responseFor(action, request)
      return responseFor(action, request, request.execution === undefined
        ? {
            status: 'ordinary-ready',
            generation: undefined,
            contract_digest: undefined,
            target_digest: undefined,
            execution: undefined,
          }
        : {
            status: 'ordinary-applied',
            contract_digest: undefined,
          })
    },
  })
  const request = {
    ...identity,
    operationId: 'operation:ordinary',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: 'pwd',
    timeoutMs: 5_000,
  }

  assert.deepEqual(await subject.client.run(request), {
    status: 'ordinary-ready',
    operationId: 'operation:ordinary',
    correlationId,
  })
  const applied = await subject.client.run({ ...request, execution: dangerFullAccessExecution })
  assert.equal(applied.status, 'ordinary-applied')
  assert.equal(applied.generation, 4)
  assert.equal(applied.execution.exitCode, 17)
})

test('execution-bearing run uses the command deadline while probe keeps the short transport deadline', async () => {
  const execution = fixture({ doneDelayMs: 150 })
  const executed = await execution.client.run({
    ...identity,
    operationId: 'operation:slow-execution',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: 'sleep 0.15',
    timeoutMs: 500,
    execution: dangerFullAccessExecution,
  })
  assert.equal(executed.status, 'applied')
  assert.equal(execution.terminateCount, 0)

  const probe = fixture({ doneDelayMs: 150 })
  await assert.rejects(probe.client.run({
    ...identity,
    operationId: 'operation:slow-probe',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: 'sleep 0.15',
    timeoutMs: 500,
  }), /finish-line request cancelled/)
  assert.equal(probe.terminateCount, 1)
})

test('legacy not-applicable run is typed and stop accepts only a matching block exit', async () => {
  const subject = fixture({
    responder(action, request) {
      if (action === 'run') {
        return responseFor(action, request, {
          status: 'not-applicable',
          generation: undefined,
          execution: undefined,
        })
      }
      if (action === 'stop') {
        return responseFor(action, request, {
          action: 'block',
          reason_codes: ['validation-failed'],
          remediation: ['rerun validation'],
        })
      }
      return responseFor(action, request)
    },
  })
  const run = await subject.client.run({
    ...identity,
    operationId: 'operation:ordinary',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: 'pwd',
    timeoutMs: 5_000,
    execution: dangerFullAccessExecution,
  })
  assert.deepEqual(run, {
    status: 'not-applicable',
    operationId: 'operation:ordinary',
    correlationId,
  })
  assert.deepEqual(await subject.client.stop(identity), {
    action: 'block',
    generation: 4,
    contractDigest: digest,
    correlationId,
    reasonCodes: ['validation-failed'],
    remediation: ['rerun validation'],
  })
})

test('malformed, replayed, and exit-mismatched responses fail closed', async () => {
  for (const override of [
    { operation_id: 'operation:replayed' },
    { schema_version: 'unknown.version' },
    { status: 'unknown' },
    { execution: { exit_code: 0 } },
    {
      execution: {
        exit_code: null,
        signal: 'SIGNAL_999',
        timed_out: false,
        aborted: false,
        timeout_ms: 5_000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      },
    },
    {
      execution: {
        exit_code: 1,
        signal: 'SIGTERM',
        timed_out: false,
        aborted: false,
        timeout_ms: 5_000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      },
    },
    {
      execution: {
        exit_code: null,
        signal: null,
        timed_out: false,
        aborted: false,
        timeout_ms: 5_000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      },
    },
    {
      execution: {
        exit_code: 1,
        signal: null,
        timed_out: true,
        aborted: true,
        timeout_ms: 5_000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      },
    },
  ]) {
    const subject = fixture({
      responder(action, request) { return responseFor(action, request, action === 'run' ? override : {}) },
    })
    await assert.rejects(subject.client.run({
      ...identity,
      operationId: 'operation:run',
      runnerCapability: 'finish-line-runner:opaque',
      intent: 'project-dev',
      command: ':',
      timeoutMs: 5_000,
      execution: dangerFullAccessExecution,
    }), /finish-line response invalid/)
  }
})

test('an invalid execution response is quiesced before the client returns failure', async () => {
  const subject = fixture({
    responder(action, request) {
      return responseFor(action, request, action === 'run'
        ? { operation_id: 'operation:replayed' }
        : {})
    },
  })
  await assert.rejects(subject.client.run({
    ...identity,
    operationId: 'operation:failed-run',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: ':',
    timeoutMs: 5_000,
    execution: dangerFullAccessExecution,
  }), /finish-line response invalid/)
  assert.equal(subject.spawns.length, 2)
  assert.deepEqual(
    subject.spawns[1].spec.argv,
    agentHookArgs('finish-line', 'quiesce', '--format', 'json'),
  )
  assert.equal(subject.spawns[1].request.operation_id, 'operation:failed-run')
})

test('disposal waits for authenticated failed-run quiescence to settle', async () => {
  const subject = fixture({
    pending: true,
    pendingQuiesce: true,
  })
  const running = subject.client.run({
    ...identity,
    operationId: 'operation:dispose-quiesce',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: ':',
    timeoutMs: 5_000,
    execution: dangerFullAccessExecution,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawns.length, 1)
  let disposed = false
  const disposing = subject.dispose().then(() => { disposed = true })
  while (subject.spawns.length < 2) await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(subject.client.active, 1)

  subject.settleQuiesce()
  await assert.rejects(running, /finish-line request cancelled/)
  await disposing
  assert.equal(disposed, true)
  assert.equal(subject.client.active, 0)
})

test('failed-run quiescence failures permanently close admission', async () => {
  for (const subject of [
    fixture({
      responder(action, request) {
        if (action === 'run') {
          return responseFor(action, request, { operation_id: 'operation:replayed' })
        }
        return responseFor(action, request, action === 'quiesce' ? { status: 'unknown' } : {})
      },
    }),
    fixture({
      responder(action, request) {
        const response = responseFor(action, request, action === 'run'
          ? { operation_id: 'operation:replayed' }
          : {})
        return action === 'quiesce'
          ? { ...response, schema_version: 'cli.agent-hook.wrong.v1' }
          : response
      },
    }),
    fixture({
      quiesceWaitForExit: 'pending',
      responder(action, request) {
        return responseFor(action, request, action === 'run'
          ? { operation_id: 'operation:replayed' }
          : {})
      },
    }),
  ]) {
    await assert.rejects(subject.client.run({
      ...identity,
      operationId: 'operation:failed-quiesce',
      runnerCapability: 'finish-line-runner:opaque',
      intent: 'project-dev',
      command: ':',
      timeoutMs: 5_000,
      execution: dangerFullAccessExecution,
    }), /finish-line response invalid/)
    assert.equal(subject.client.degraded, true)
    assert.equal(subject.client.active, 0)
    await assert.rejects(subject.client.open(identity), /finish-line unavailable/)
  }
})

test('caller cancellation and disposal terminate plugin-owned subprocess work', async () => {
  const cancelled = fixture({ pending: true })
  const controller = new AbortController()
  const opening = cancelled.client.open(identity, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller secret'))
  await assert.rejects(opening, /finish-line request cancelled/)
  assert.equal(cancelled.terminateCount, 1)

  const disposed = fixture({ pending: true })
  const running = disposed.client.run({
    ...identity,
    operationId: 'operation:dispose',
    runnerCapability: 'finish-line-runner:opaque',
    intent: 'project-dev',
    command: ':',
    timeoutMs: 5_000,
    execution: dangerFullAccessExecution,
  })
  await new Promise(resolve => setImmediate(resolve))
  await disposed.dispose()
  await assert.rejects(running, /finish-line request cancelled/)
  assert.equal(disposed.terminateCount, 1)
  assert.deepEqual(
    disposed.spawns[1].spec.argv,
    agentHookArgs('finish-line', 'quiesce', '--format', 'json'),
  )
  assert.deepEqual(disposed.spawns[1].request, {
    schema_version: 'agent-hook.finish-line.quiesce.v1',
    product: 'dsh',
    session_id: 'session-1',
    turn_id: '7',
    cwd: '/workspace/project',
    operation_id: 'operation:dispose',
    runner_capability: 'finish-line-runner:opaque',
  })
  assert.equal(disposed.client.active, 0)
})
