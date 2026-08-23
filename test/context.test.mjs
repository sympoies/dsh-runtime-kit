import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRuntimeContextTool } from '../src/context/index.js'
import { createNilsContextClient } from '../src/context/nils-context.js'
import { isolatedNilsEnvironment } from '../src/nils/session-environment.js'

function execution(overrides = {}) {
  const signal = new AbortController().signal
  const session = {
    id: 'session-current',
    header: { id: 'session-current', cwd: '/workspace/current' },
    events: [],
  }
  return {
    token: Symbol('context-call'),
    callId: 'context-call',
    rootCallId: 'context-call',
    name: 'runtime_context',
    arguments: { intent: 'project-dev' },
    signal,
    agent: { id: 'session-current', session },
    deferContext() {},
    concludeTurn() {},
    ...overrides,
  }
}

function contextDecision(overrides = {}) {
  const content = '# Project development\n\nRun the focused tests.'
  return {
    schema_version: 'decision.context.v1',
    request_id: 'context:current-request',
    product: 'dsh',
    intent: 'project-dev',
    reason: 'prepared',
    verified: true,
    documents: [{ source: 'project', scope: 'project', content }],
    document_count: 1,
    total_bytes: Buffer.byteLength(content),
    ...overrides,
  }
}

function requestId(spec) {
  const index = spec.argv.indexOf('--request-id')
  assert.notEqual(index, -1)
  return spec.argv[index + 1]
}

function contextEnvelope(spec, overrides = {}) {
  const content = '# Project development\n\nRun the focused tests.'
  return {
    schema_version: 'cli.agent-docs.session.context.v1',
    ok: true,
    data: {
      decision: {
        schema_version: 'decision.context.v1',
        request_id: requestId(spec),
        product: 'dsh',
        intent: 'project-dev',
        phase: 'edit',
        reason: 'prepared',
        verified: true,
        documents: [{ source: 'project', scope: 'project', content }],
        document_count: 1,
        total_bytes: Buffer.byteLength(content),
        ...overrides,
      },
    },
  }
}

function contextTransportHarness({
  response = spec => contextEnvelope(spec),
  outcome = { exitCode: 0, signal: null },
  lossy = false,
  pending = false,
  quiescent = true,
  requireResolved = false,
  resolutionPending = false,
} = {}) {
  const specs = []
  const resolutions = []
  const disposers = []
  let terminateCount = 0
  let settle
  let resolveTree
  const treeExit = new Promise(resolve => { resolveTree = resolve })
  const ctx = {
    effect(execute) {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    subprocess: {
      async resolveExecutable(command, env, signal) {
        resolutions.push({ command, env, signal })
        if (resolutionPending) {
          return new Promise((resolve, reject) => {
            if (signal?.aborted) reject(signal.reason)
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }
        return `/resolved/${command}`
      },
      spawn(spec) {
        if (requireResolved && !spec.argv[0].startsWith('/')) {
          throw new Error('subprocess contract requires a resolved executable')
        }
        specs.push(spec)
        const output = JSON.stringify(response(spec))
        const done = pending
          ? new Promise(resolve => { settle = resolve })
          : Promise.resolve(outcome)
        if (!pending && quiescent) resolveTree()
        return {
          done,
          terminate() {
            terminateCount += 1
            settle?.({ exitCode: null, signal: 'SIGTERM' })
            if (quiescent) resolveTree()
          },
          collected: {
            stdout: { readFrom: () => ({ text: output, lossy }) },
          },
          async waitForExit(signal) {
            if (signal?.aborted) return false
            return Promise.race([
              treeExit.then(() => true),
              new Promise(resolve => signal?.addEventListener('abort', () => resolve(false), { once: true })),
            ])
          },
        }
      },
    },
  }
  return {
    ctx,
    specs,
    resolutions,
    get terminateCount() { return terminateCount },
    settle(result = outcome) { settle?.(result) },
    releaseTree() { resolveTree() },
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer()
    },
  }
}

test('the context client resolves a bare agent-docs command before spawning', async () => {
  const subject = contextTransportHarness({ requireResolved: true })
  const client = createNilsContextClient(subject.ctx, {
    agentDocs: 'agent-docs',
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
  })

  const result = await client.prepare(execution(), 'project-dev')
  assert.equal(result.intent, 'project-dev')
  assert.equal(subject.resolutions.length, 1)
  assert.equal(subject.resolutions[0].command, 'agent-docs')
  assert.equal(
    subject.resolutions[0].env,
    undefined,
    'portable helper lookup must use the DSH host execution PATH, not the isolated child PATH',
  )
  assert.equal(subject.specs[0].argv[0], '/resolved/agent-docs')
})

test('the context deadline covers executable resolution before spawn', async () => {
  const subject = contextTransportHarness({ resolutionPending: true })
  const client = createNilsContextClient(subject.ctx, {
    agentDocs: 'agent-docs',
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
    contextTimeoutMs: 20,
  })

  await assert.rejects(client.prepare(execution(), 'project-dev'), /runtime-context-timeout/)
  assert.equal(subject.specs.length, 0)
  assert.equal(client.active, 0)
})

test('runtime_context returns one sanitized bounded intent result on demand', async () => {
  const calls = []
  const tool = createRuntimeContextTool({
    async prepare(exec, intent) {
      calls.push({ exec, intent })
      return contextDecision()
    },
  })
  const exec = execution()

  assert.equal(calls.length, 0, 'registration/session start must not load the corpus')
  const result = await tool.execute({ intent: 'project-dev' }, exec)
  assert.deepEqual(calls, [{ exec, intent: 'project-dev' }])
  assert.deepEqual(result, {
    schema_version: 'dsh-runtime-context.result.v1',
    intent: 'project-dev',
    status: 'prepared',
    documents: [{ source: 'project', scope: 'project', content: '# Project development\n\nRun the focused tests.' }],
    document_count: 1,
    total_bytes: 45,
  })

  const rendered = tool.output.render({ intent: 'project-dev' }, result)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Project development/)
  assert.doesNotMatch(rendered[0].text, /context:current-request|session-current|workspace\/current/)

  const oldInjectedBaseline = 'x'.repeat(76_667)
  assert.ok(Buffer.byteLength(rendered[0].text) < Buffer.byteLength(oldInjectedBaseline) / 100)
})

test('the context client invokes one bounded atomic agent-docs command for the exact DSH scope', async () => {
  const subject = contextTransportHarness()
  const client = createNilsContextClient(subject.ctx, {
    agentDocs: '/tools/agent-docs',
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
  })

  const result = await client.prepare(execution(), 'project-dev')
  assert.equal(result.intent, 'project-dev')
  assert.equal(result.phase, 'edit')
  assert.equal(subject.specs.length, 1)
  const spec = subject.specs[0]
  assert.deepEqual(spec.argv, [
    '/tools/agent-docs',
    '--docs-home', '/runtime/policies',
    '--project-path', '/workspace/current',
    'session', 'context',
    '--session-id', 'session-current',
    '--product', 'dsh',
    '--state-home', '/runtime/state',
    '--intent', 'project-dev',
    '--phase', 'edit',
    '--request-id', requestId(spec),
    '--max-bytes', '20480',
    '--format', 'json',
  ])
  assert.match(requestId(spec), /^context:[0-9a-f-]{36}$/)
  assert.equal(spec.cwd, '/workspace/current')
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.deepEqual(spec.stdio.stdout, { maxBytes: 155_648 })
  assert.deepEqual(spec.stdio.stderr, { maxBytes: 8_192 })
  assert.deepEqual(spec.env, isolatedNilsEnvironment(undefined))
})

test('the context client rejects ambient Codex or Claude agent-docs fallback', () => {
  const subject = contextTransportHarness()

  assert.throws(
    () => createNilsContextClient(subject.ctx, {
      agentDocsStateHome: '/runtime/state',
    }),
    /agentDocsHome is required/,
  )
})

test('context output from another repo, session, request, or intent cannot be replayed', async () => {
  let captured
  const subject = contextTransportHarness({
    response(spec) {
      captured ??= contextEnvelope(spec)
      return captured
    },
  })
  const client = createNilsContextClient(subject.ctx, {
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
  })
  await client.prepare(execution(), 'project-dev')
  const other = execution({
    agent: {
      id: 'session-other',
      session: {
        id: 'session-other',
        header: { id: 'session-other', cwd: '/workspace/other' },
        events: [],
      },
    },
  })

  await assert.rejects(
    client.prepare(other, 'project-dev'),
    /runtime-context-output-invalid/,
  )
  assert.notEqual(requestId(subject.specs[0]), requestId(subject.specs[1]))
  assert.equal(subject.specs[1].cwd, '/workspace/other')
  assert.ok(subject.specs[1].argv.includes('session-other'))
})

test('context transport rejects malformed, lossy, and exit-mismatched results without leaking output', async () => {
  const cases = [
    {
      response: spec => contextEnvelope(spec, { extra_private_field: '/secret/path' }),
      error: /runtime-context-output-invalid/,
    },
    {
      response: spec => contextEnvelope(spec, { total_bytes: 1 }),
      error: /runtime-context-output-invalid/,
    },
    {
      lossy: true,
      error: /runtime-context-output-invalid/,
    },
    {
      outcome: { exitCode: 1, signal: null },
      error: /runtime-context-output-invalid/,
    },
  ]
  for (const candidate of cases) {
    const subject = contextTransportHarness(candidate)
    const client = createNilsContextClient(subject.ctx, {
      agentDocsHome: '/runtime/policies',
      agentDocsStateHome: '/runtime/state',
    })
    await assert.rejects(client.prepare(execution(), 'project-dev'), candidate.error)
  }
})

test('caller cancellation joins the context process tree before rejecting', async () => {
  const subject = contextTransportHarness({ pending: true, quiescent: false })
  const client = createNilsContextClient(subject.ctx, {
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
    contextTeardownTimeoutMs: 1_000,
  })
  const controller = new AbortController()
  const pending = client.prepare(execution({ signal: controller.signal }), 'project-dev')
  while (subject.specs.length === 0) await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('stop'))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(subject.terminateCount >= 1)
  let settled = false
  void pending.finally(() => { settled = true }).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'the tool must wait for whole-tree quiescence')
  subject.releaseTree()
  await assert.rejects(pending, /runtime-context-caller-aborted/)
  assert.equal(client.active, 0)
})

test('runtime_context rejects ambiguous args and invalid execution identity before agent-docs', async () => {
  let calls = 0
  const tool = createRuntimeContextTool({
    async prepare() {
      calls += 1
      return contextDecision()
    },
  })
  for (const args of [
    null,
    {},
    { intent: 'project-dev', phase: 'edit' },
    { intent: 'invalid intent' },
    { intent: 'review' },
    { intent: 'delivery' },
    { intent: 'future-declared-intent' },
  ]) {
    await assert.rejects(tool.execute(args, execution()))
  }
  assert.equal(calls, 0)

  assert.deepEqual(tool.parameters.properties.intent, {
    type: 'string',
    enum: ['project-dev'],
  })

  const subject = contextTransportHarness()
  const client = createNilsContextClient(subject.ctx, {
    agentDocsHome: '/runtime/policies',
    agentDocsStateHome: '/runtime/state',
  })
  await assert.rejects(
    client.prepare(execution({ agent: undefined }), 'project-dev'),
    /runtime-context-identity-invalid/,
  )
  for (const intent of ['review', 'delivery', 'future-declared-intent']) {
    await assert.rejects(
      client.prepare(execution(), intent),
      /runtime-context-intent-not-allowed/,
    )
  }
  assert.equal(subject.specs.length, 0)
})
