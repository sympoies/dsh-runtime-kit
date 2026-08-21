import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { ENV_OVERRIDES } from '@deepseek-ai/dsh-bash-local'
import { HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'
import { approveEscalation, canonicalPath, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { applyPolicy } from '../policy.js'
import { boundedUtf8Segments } from '../src/policy/index.js'
import {
  createChildPluginStatus,
  observeChildPluginActivation,
  snapshotChildPluginStatus,
} from '../src/runtime-status.js'
import { selectManagedSessionEnvironment } from '../src/policy/nils-transport.js'

const sha256 = `sha256:${'0'.repeat(64)}`
const dshRuntime = Object.freeze({
  ENV_OVERRIDES,
  HarnessError,
  TOOL_ABORTED,
  createUserMessage,
  approveEscalation,
  canonicalPath,
  validateEscalationArgs,
})

test('lifecycle prompt projection stops consuming segments at its UTF-8 budget', () => {
  function *segments() {
    yield '好'.repeat(30_000)
    throw new Error('bounded projection consumed a discarded prompt suffix')
  }
  const projected = boundedUtf8Segments(segments(), 64 * 1024)
  assert.equal(Buffer.byteLength(projected, 'utf8') <= 64 * 1024, true)
  assert.doesNotMatch(projected, /\uFFFD/)
})

test('optional child-plugin activation distinguishes pending active and failed states', async () => {
  const status = createChildPluginStatus()
  assert.deepEqual(snapshotChildPluginStatus(status), {
    main_agent_mode: { state: 'pending' },
    review_specialists: { state: 'pending' },
  })
  const warnings = []
  observeChildPluginActivation(
    status,
    'review_specialists',
    async () => {},
    { warn: (...args) => warnings.push(args) },
  )
  observeChildPluginActivation(
    status,
    'main_agent_mode',
    async () => { throw new TypeError('fixture detail must stay out of status') },
    { warn: (...args) => warnings.push(args) },
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshotChildPluginStatus(status), {
    main_agent_mode: { state: 'failed', reason: 'activation-rejected', error_name: 'TypeError' },
    review_specialists: { state: 'active' },
  })
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(JSON.stringify(snapshotChildPluginStatus(status)), /fixture detail/)
})

test('policy subprocess never restores ambient provider session identity', () => {
  assert.deepEqual(
    selectManagedSessionEnvironment({
      AGENT_SESSION_ID: 'codex-provider-session',
      AGENT_SESSION_RUNTIME_ID: 'claude-runtime-1',
      AGENT_SESSION_BIN: '/provider/agent-session',
      AGENT_SESSION_CAPABILITY_FILE: '/provider/capability',
      AGENT_SESSION_STATE_DIR: '/provider/state',
      AGENT_SESSION_TOKEN: 'must-not-cross',
      AGENT_SESSION_CHECKPOINT_FILE: '/must/not/cross',
      UNRELATED_SECRET: 'must-not-cross',
    }),
    {
      AGENT_SESSION_ID: undefined,
      AGENT_SESSION_RUNTIME_ID: undefined,
      AGENT_SESSION_BIN: undefined,
      AGENT_SESSION_CAPABILITY_FILE: undefined,
      AGENT_SESSION_STATE_DIR: undefined,
      AGENT_SESSION_TOKEN: undefined,
      AGENT_SESSION_CHECKPOINT_FILE: undefined,
    },
  )
  assert.deepEqual(selectManagedSessionEnvironment({}), {})
})

function decision(action = 'allow', overrides = {}) {
  const disposition = action === 'block'
    ? 'block'
    : action === 'context'
      ? 'context'
      : action === 'warn'
        ? 'warn'
        : undefined
  return {
    schema_version: 'cli.agent-hook.dispatch.v1',
    ok: true,
    data: {
      schema_version: 'agent-hook.normalized-decision.v1',
      request_id: '__CURRENT_REQUEST__',
      product: 'dsh',
      event: 'PreToolUse',
      action,
      reasons: disposition === undefined
        ? []
        : [{
            rule_id: `dsh.${action}`,
            code: action === 'block' ? 'blocked' : action,
            disposition,
          }],
      config_digest: sha256,
      policy_digest: sha256,
      recovery_applied: false,
      ...overrides,
    },
  }
}

function harness({
  envelope = decision(),
  pending = false,
  outcome,
  stdout,
  lossy = false,
  missingStdout = false,
  throwOnSpawn = false,
  settleOnAbort = true,
  settleOnTerminate = true,
  quiesceOnSettle = true,
  waitNeverSettles = false,
  config = {},
} = {}) {
  const listeners = new Map()
  const effects = []
  let guard
  let spawnCount = 0
  let terminateCount = 0
  let activeHandles = 0
  let peakActiveHandles = 0
  let signal
  let service
  const registeredTools = new Map()
  const handles = []
  const spawnSpecs = []
  const session = {
    id: 'session-1',
    header: { id: 'session-1', cwd: '/tmp' },
    events: [],
  }
  const steered = []
  const agent = {
    id: 'session-1',
    session,
    steer(message) { steered.push(message) },
  }
  const ctx = {
    agents: {
      list: () => [agent],
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
      guard(candidate) {
        guard = candidate
        return () => {
          if (guard === candidate) guard = undefined
        }
      },
    },
    on(event, candidate) {
      const candidates = listeners.get(event) ?? []
      candidates.push(candidate)
      listeners.set(event, candidates)
      return () => {
        const index = candidates.indexOf(candidate)
        if (index >= 0) candidates.splice(index, 1)
      }
    },
    effect(execute) {
      const yielded = execute()
      const disposers = []
      if (typeof yielded === 'function') {
        disposers.push(yielded)
      } else if (yielded?.next !== undefined) {
        for (let step = yielded.next(); !step.done; step = yielded.next()) {
          if (typeof step.value === 'function') disposers.push(step.value)
        }
      }
      let disposed = false
      const dispose = async () => {
        if (disposed) return
        disposed = true
        for (const candidate of disposers.reverse()) await candidate()
      }
      effects.push(dispose)
      return dispose
    },
    provide(name, value) {
      if (name === 'dshRuntimeKit') service = value
    },
    subprocess: {
      spawn(spec) {
        if (typeof throwOnSpawn === 'function' ? throwOnSpawn(spec) : throwOnSpawn) {
          throw new Error('spawn failed')
        }
        const dispatchIngress = spec.argv.includes('dispatch')
          ? JSON.parse(spec.stdio.stdin.data)
          : undefined
        const implicitLifecycle = typeof envelope !== 'function'
          && dispatchIngress !== undefined
          && dispatchIngress.event !== 'tools/pre-execute'
        if (implicitLifecycle) {
          const event = dispatchIngress.event === 'agent/pre-step'
            ? 'UserPromptSubmit'
            : dispatchIngress.event === 'agent/turn-stopping'
              ? 'Stop'
              : dispatchIngress.result?.is_error === true
                ? 'PostToolUseFailure'
                : 'PostToolUse'
          const response = decision('allow', {
            event,
          })
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            terminate() {},
            collected: {
              stdout: { readFrom: () => ({ text: JSON.stringify(response), lossy: false }) },
            },
            async waitForExit() { return true },
          }
        }
        spawnSpecs.push(spec)
        spawnCount += 1
        activeHandles += 1
        peakActiveHandles = Math.max(peakActiveHandles, activeHandles)
        const selectedEnvelope = typeof envelope === 'function' ? envelope(spec) : envelope
        const response = structuredClone(selectedEnvelope)
        if (response.data?.request_id === '__CURRENT_REQUEST__') {
          const digest = createHash('sha256').update(spec.stdio.stdin.data).digest('hex')
          response.data.request_id = `request:${digest.slice(0, 32)}`
        }
        const output = stdout ?? JSON.stringify(response)
        let settle
        let rejectDone
        let resolveTreeExit
        const treeExit = new Promise(resolve => { resolveTreeExit = resolve })
        const done = pending
          ? new Promise((resolve, reject) => {
            settle = resolve
            rejectDone = reject
          })
          : Promise.resolve(outcome ?? {
            exitCode: response.data?.action === 'block' ? 1 : 0,
            signal: null,
          })
        void done.then(() => {
          activeHandles -= 1
          if (quiesceOnSettle) resolveTreeExit()
        }, () => {
          activeHandles -= 1
          if (quiesceOnSettle) resolveTreeExit()
        })
        signal = spec.signal
        signal?.addEventListener('abort', () => {
          if (settleOnAbort) settle?.({ exitCode: null, signal: 'SIGTERM' })
        }, { once: true })
        const handle = {
          done,
          terminate() {
            terminateCount += 1
            if (settleOnTerminate) settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          collected: {
            stdout: missingStdout
              ? undefined
              : { readFrom: () => ({ text: output, lossy }) },
          },
          async waitForExit(waitSignal) {
            if (waitNeverSettles) return new Promise(() => {})
            if (waitSignal?.aborted) return false
            if (waitSignal !== undefined) {
              return Promise.race([
                treeExit.then(() => true),
                new Promise(resolve => {
                  waitSignal.addEventListener('abort', () => resolve(false), { once: true })
                }),
              ])
            }
            await treeExit
            return true
          },
        }
        handles.push({
          settle: (result = outcome ?? {
            exitCode: response.data?.action === 'block' ? 1 : 0,
            signal: null,
          }) => settle?.(result),
          reject: error => rejectDone?.(error),
          exit: () => resolveTreeExit(),
        })
        return handle
      },
    },
  }
  applyPolicy(ctx, {
    agentHook: '/test/agent-hook',
    agentHookConfig: '/runtime/agent-hook/config.toml',
    agentHookPolicy: '/runtime/agent-hook/dsh-policy.toml',
    agentHookStateDir: '/runtime/agent-hook/state',
    agentDocsHome: '/runtime/docs',
    agentDocsStateHome: '/runtime/state',
    ...config,
  }, undefined, dshRuntime)
  let lifecycleStarted = false
  let nextStep = 1

  async function dispatchWaterfall(event, args, inner) {
    const candidates = [...(listeners.get(event) ?? [])]
    const next = async () => {
      const candidate = candidates.shift()
      return candidate === undefined ? inner() : candidate(...args, next)
    }
    return next()
  }

  async function prepare(arguments_, {
    callId = 'call-1',
    downstreamDecision = { kind: 'allow' },
    signal: callerSignal = new AbortController().signal,
    shortCircuit = false,
    token = Symbol(callId),
    agent: executionAgent = agent,
    withoutAgent = false,
    skipLifecycle = false,
    reversePolicyDenial = false,
  } = {}) {
    if (!skipLifecycle && !lifecycleStarted && (listeners.get('agent/session-start')?.length ?? 0) > 0) {
      lifecycleStarted = true
      for (const observer of listeners.get('agent/session-start') ?? []) {
        observer({ agent, source: 'startup' })
      }
      session.events.push({ type: 'turn/start', data: { turn: 1 } })
    }
    if (!skipLifecycle && (listeners.get('agent/pre-step')?.length ?? 0) > 0) {
      const openStep = session.events.findLast(event => event.type === 'step/start')
      const closedStep = session.events.findLast(event => event.type === 'step/end')
      if (openStep !== undefined && openStep.data.step !== closedStep?.data.step) {
        session.events.push({ type: 'step/end', data: openStep.data })
      }
      const step = nextStep
      nextStep += 1
      const decision = await dispatchWaterfall(
        'agent/pre-step',
        [{ agent, messages: [], turn: 1, step, signal: callerSignal }],
        async () => ({ kind: 'enter', messages: [] }),
      )
      if (decision.kind === 'enter' && !callerSignal.aborted) {
        session.events.push({ type: 'step/start', data: { turn: 1, step } })
      }
    }
    const exec = {
      token,
      callId,
      rootCallId: callId,
      name: 'runtime_kit_plus_one',
      arguments: arguments_,
      signal: callerSignal,
      agent: withoutAgent ? undefined : executionAgent,
    }
    let result = shortCircuit
      ? { kind: 'allow' }
      : await dispatchWaterfall('tools/pre-execute', [exec], async () => downstreamDecision)
    if (reversePolicyDenial && result.kind === 'deny') result = { kind: 'allow' }
    return { exec, result }
  }

  return {
    ctx,
    async invoke(arguments_, options = {}) {
      let delegated = false
      const prepared = await prepare(arguments_, options)
      let result = prepared.result
      if (result.kind === 'ask') {
        result = options.askOutcome === 'approved'
          ? { kind: 'allow' }
          : { kind: 'deny', reason: `approval-${options.askOutcome ?? 'denied'}` }
      }
      if (result.kind === 'allow' && guard !== undefined) {
        const reason = guard(prepared.exec)
        if (reason !== undefined) result = { kind: 'deny', reason }
      }
      if (result.kind === 'allow') {
        delegated = true
      }
      const postDecision = await dispatchWaterfall(
        'tools/post-execute',
        [prepared.exec, { isError: result.kind !== 'allow', content: [] }],
        async () => ({ kind: 'accept' }),
      )
      for (const observer of listeners.get('tools/result') ?? []) {
        observer(prepared.exec, { isError: result.kind !== 'allow', content: [] })
      }
      return { result, delegated, exec: prepared.exec, postDecision }
    },
    prepare,
    guard(exec) { return guard?.(exec) },
    release(index, result) { handles[index]?.settle(result) },
    reject(index, error) { handles[index]?.reject(error) },
    releaseTree(index) { handles[index]?.exit() },
    async dispose() {
      for (const dispose of effects.reverse()) await dispose()
    },
    emit(event, ...args) {
      for (const observer of listeners.get(event) ?? []) observer(...args)
    },
    waterfall(event, args, inner) {
      return dispatchWaterfall(event, args, inner)
    },
    get listenerNames() {
      return [...listeners]
        .filter(([, candidates]) => candidates.length > 0)
        .map(([event]) => event)
        .sort()
    },
    get registeredToolNames() { return [...registeredTools.keys()].sort() },
    tool(name) { return registeredTools.get(name) },
    agent,
    steered,
    get spawnCount() { return spawnCount },
    get peakActiveHandles() { return peakActiveHandles },
    get terminateCount() { return terminateCount },
    get signal() { return signal },
    get service() { return service },
    get spawnSpecs() { return spawnSpecs },
  }
}

test('the policy bundle exposes one explicit selective runtime-context tool', () => {
  const subject = harness()

  assert.deepEqual(subject.registeredToolNames, [
    'runtime_context',
    'runtime_kit_plus_one',
  ])
  assert.deepEqual(subject.tool('runtime_context')?.parameters, {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: ['project-dev'] },
    },
    required: ['intent'],
    additionalProperties: false,
  })
})

test('policy ingress v2 binds the exact DSH session position and agent-docs roots', async () => {
  const subject = harness({
    config: {
      agentHookConfig: '/runtime/agent-hook/config.toml',
      agentHookPolicy: '/runtime/agent-hook/dsh-policy.toml',
      agentHookStateDir: '/runtime/agent-hook/state',
      agentDocsHome: '/runtime/docs',
      agentDocsStateHome: '/runtime/state',
    },
  })

  const { result } = await subject.invoke({ value: 41 }, { callId: 'call-v2' })
  assert.equal(result.kind, 'allow')
  const ingress = JSON.parse(subject.spawnSpecs[0].stdio.stdin.data)
  assert.deepEqual(ingress, {
    schema_version: 'agent-hook.dsh-ingress.v2',
    event: 'tools/pre-execute',
    call_id: 'call-v2',
    cwd: '/tmp',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
    tool: {
      name: 'runtime_kit_plus_one',
      arguments: { value: 41 },
    },
  })
  assert.deepEqual(subject.spawnSpecs[0].argv, [
    '/test/agent-hook',
    '--config', '/runtime/agent-hook/config.toml',
    '--policy', '/runtime/agent-hook/dsh-policy.toml',
    '--state-dir', '/runtime/agent-hook/state',
    'dispatch', '--product', 'dsh', '--format', 'json',
  ])
})

test('post-tool ingress v4 sends only the terminal fact and blocks before downstream on lifecycle denial', async () => {
  const seen = []
  const subject = harness({
    config: {
      agentDocsHome: '/runtime/docs',
      agentDocsStateHome: '/runtime/state',
    },
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      seen.push(ingress)
      return ingress.event === 'tools/post-execute'
        ? decision('block', { event: 'PostToolUse' })
        : decision('allow', { event: 'PreToolUse' })
    },
  })
  const prepared = await subject.prepare({ value: 41 }, { callId: 'call-v4' })
  assert.equal(prepared.result.kind, 'allow')
  let delegated = false
  const post = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, {
      isError: false,
      value: { private: 'must-never-reach-agent-hook' },
      content: [{ type: 'text', text: 'must-never-reach-agent-hook' }],
    }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(post.kind, 'block')
  assert.match(post.feedback[0].text, /agent-hook:blocked/)
  const postIngress = seen.find(ingress => ingress.event === 'tools/post-execute')
  assert.deepEqual(postIngress, {
    schema_version: 'agent-hook.dsh-ingress.v4',
    event: 'tools/post-execute',
    call_id: 'call-v4',
    cwd: '/tmp',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
    tool: {
      name: 'runtime_kit_plus_one',
      arguments: { value: 41 },
    },
    result: { is_error: false },
  })
  assert.doesNotMatch(JSON.stringify(postIngress), /must-never-reach-agent-hook/)
})

test('the first accepted pre-step receives one bounded native lifecycle context', async () => {
  const subject = harness({
    config: { agentDocsStateHome: '/runtime/state' },
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      assert.equal(ingress.event, 'agent/pre-step')
      return decision('context', {
        event: 'UserPromptSubmit',
        context: 'startup health and memory context',
      })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'build a high-impact feature' }],
  }
  const payload = {
    agent: subject.agent,
    messages: [userMessage],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  const first = await subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  const duplicate = await subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )

  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.kind, 'plugin')
  assert.equal(first.messages[1].source.plugin, 'dsh-runtime-kit')
  assert.equal(first.messages[1].content[0].text, 'startup health and memory context')
  assert.deepEqual(duplicate, { kind: 'enter', messages: [userMessage] })
  assert.equal(subject.spawnCount, 1)
  assert.deepEqual(JSON.parse(subject.spawnSpecs[0].stdio.stdin.data), {
    schema_version: 'agent-hook.dsh-ingress.v3',
    event: 'agent/pre-step',
    cwd: '/tmp',
    prompt: 'build a high-impact feature',
    subject: {
      session_id: 'session-1',
      turn: 1,
      step: 1,
      session_start_source: 'startup',
      agent_docs_home: '/runtime/docs',
      agent_docs_state_home: '/runtime/state',
    },
  })
})

test('post-tool transport denial blocks before downstream when completion is unobserved', async () => {
  const subject = harness({
    throwOnSpawn: (spec) => {
      if (!spec.argv.includes('dispatch')) return false
      return JSON.parse(spec.stdio.stdin.data).event === 'tools/post-execute'
    },
  })
  const prepared = await subject.prepare({ value: 41 }, { callId: 'call-v4-transport' })
  assert.equal(prepared.result.kind, 'allow')
  let delegated = false
  const post = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, { isError: false, value: 42, content: [] }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(post.kind, 'block')
  assert.match(post.feedback[0].text, /policy-unavailable/)
})

test('a concurrent duplicate waits for an accepted pre-step instead of bypassing lifecycle context', async () => {
  const subject = harness({
    pending: true,
    envelope: () => decision('context', {
      event: 'UserPromptSubmit',
      context: 'serialized lifecycle context',
    }),
  })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'build it' }],
  }
  const payload = {
    agent: subject.agent,
    messages: [userMessage],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const first = subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  const second = subject.waterfall(
    'agent/pre-step',
    [payload],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 1)

  subject.release(0)
  const accepted = await first
  const duplicate = await second
  assert.equal(accepted.kind, 'enter')
  assert.equal(accepted.messages.length, 2)
  assert.equal(accepted.messages[1].content[0].text, 'serialized lifecycle context')
  assert.deepEqual(duplicate, { kind: 'enter', messages: [userMessage] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 1)
})

test('lifecycle ingress evaluates only the downstream-accepted user messages', async () => {
  for (const [acceptedMessages, expectedPrompt] of [
    [[{
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'accepted replacement' }],
    }], 'accepted replacement'],
    [[], ''],
  ]) {
    const subject = harness({
      envelope: (spec) => {
        const ingress = JSON.parse(spec.stdio.stdin.data)
        assert.equal(ingress.prompt, expectedPrompt)
        assert.notEqual(ingress.prompt, 'superseded prompt canary')
        return decision('allow', { event: 'UserPromptSubmit' })
      },
    })
    subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
    const payload = {
      agent: subject.agent,
      messages: [{
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'superseded prompt canary' }],
      }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    const result = await subject.waterfall(
      'agent/pre-step',
      [payload],
      async () => ({ kind: 'enter', messages: acceptedMessages }),
    )
    assert.deepEqual(result, { kind: 'enter', messages: acceptedMessages })
    assert.equal(subject.spawnCount, 1)
  }
})

test('same-position deduplication binds the accepted prompt digest sequentially and concurrently', async () => {
  const makeMessage = text => ({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
  const payloadFor = subject => ({
    agent: subject.agent,
    messages: [makeMessage('proposal')],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  })

  const sequentialPrompts = []
  const sequential = harness({
    envelope: (spec) => {
      sequentialPrompts.push(JSON.parse(spec.stdio.stdin.data).prompt)
      return decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  sequential.emit('agent/session-start', { agent: sequential.agent, source: 'startup' })
  for (const prompt of ['safe accepted text', 'changed accepted text']) {
    const messages = [makeMessage(prompt)]
    const result = await sequential.waterfall(
      'agent/pre-step',
      [payloadFor(sequential)],
      async () => ({ kind: 'enter', messages }),
    )
    assert.deepEqual(result, { kind: 'enter', messages })
  }
  assert.deepEqual(sequentialPrompts, ['safe accepted text', 'changed accepted text'])
  assert.equal(sequential.spawnCount, 2)

  const concurrentPrompts = []
  const concurrent = harness({
    pending: true,
    envelope: (spec) => {
      concurrentPrompts.push(JSON.parse(spec.stdio.stdin.data).prompt)
      return decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  concurrent.emit('agent/session-start', { agent: concurrent.agent, source: 'startup' })
  const first = concurrent.waterfall(
    'agent/pre-step',
    [payloadFor(concurrent)],
    async () => ({ kind: 'enter', messages: [makeMessage('concurrent safe')] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  const second = concurrent.waterfall(
    'agent/pre-step',
    [payloadFor(concurrent)],
    async () => ({ kind: 'enter', messages: [makeMessage('concurrent changed')] }),
  )
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(concurrent.spawnCount, 1)
  concurrent.release(0)
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(concurrent.spawnCount, 2)
  concurrent.release(1)
  await second
  assert.deepEqual(concurrentPrompts, ['concurrent safe', 'concurrent changed'])
})

test('lifecycle prompt projection is UTF-8 bounded and malformed advisory output fails open', async () => {
  let observedPrompt
  const subject = harness({
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      observedPrompt = ingress.prompt
      return decision('context', {
        event: 'UserPromptSubmit',
        context: 'x'.repeat(16 * 1024 + 1),
      })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  const userMessage = {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '好'.repeat(30_000) }],
  }
  const result = await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [userMessage],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [userMessage] }),
  )

  assert.equal(Buffer.byteLength(observedPrompt, 'utf8') <= 64 * 1024, true)
  assert.doesNotMatch(observedPrompt, /\uFFFD/)
  assert.deepEqual(result, { kind: 'enter', messages: [userMessage] })
})

test('native tool advisory context is delivered after the exact tool result', async () => {
  const subject = harness({
    envelope: (spec) => {
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'tools/pre-execute'
        ? decision('context', {
            event: 'PreToolUse',
            context: 'apply the portable output reminder',
          })
        : decision('allow', {
            event: ingress.event === 'tools/post-execute' ? 'PostToolUse' : 'UserPromptSubmit',
          })
    },
  })
  const invocation = await subject.invoke({ value: 41 })

  assert.equal(invocation.result.kind, 'allow')
  assert.equal(invocation.delegated, true)
  assert.equal(invocation.postDecision.kind, 'accept')
  assert.equal(invocation.postDecision.additionalContexts.length, 1)
  assert.deepEqual(invocation.postDecision.additionalContexts[0].content, [
    { type: 'text', text: 'apply the portable output reminder' },
  ])
  assert.deepEqual(invocation.postDecision.additionalContexts[0].source, {
    kind: 'plugin',
    plugin: 'dsh-runtime-kit',
  })
})

test('stop advisory is steered once only after the authoritative finish-line allows', async () => {
  const subject = harness({
    envelope: (spec) => {
      if (spec.argv.includes('finish-line')) {
        return {
          schema_version: 'cli.agent-hook.finish-line-stop.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.stop-result.v1',
            action: 'allow',
            generation: 0,
            contract_digest: 'contract-1',
            correlation_id: 'correlation-1',
            reason_codes: [],
            remediation: [],
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'agent/turn-stopping'
        ? decision('context', { event: 'Stop', context: 'run the pre-PR check now' })
        : decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  )
  const stopping = {
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)

  assert.equal(subject.steered.length, 1)
  assert.equal(subject.steered[0].content[0].text, 'run the pre-PR check now')
  const stopIngresses = subject.spawnSpecs
    .filter(spec => spec.argv.includes('dispatch'))
    .map(spec => JSON.parse(spec.stdio.stdin.data))
    .filter(ingress => ingress.event === 'agent/turn-stopping')
  assert.equal(stopIngresses.length, 1)
  assert.equal(stopIngresses[0].subject.step, undefined)
  assert.equal(stopIngresses[0].subject.session_start_source, undefined)
})

test('stop policy transport denial steers closed and remains retryable in the same turn', async () => {
  let stopAttempts = 0
  const subject = harness({
    throwOnSpawn: (spec) => {
      if (!spec.argv.includes('dispatch')) return false
      const ingress = JSON.parse(spec.stdio.stdin.data)
      if (ingress.event !== 'agent/turn-stopping') return false
      stopAttempts += 1
      return stopAttempts === 1
    },
    envelope: (spec) => {
      if (spec.argv.includes('finish-line')) {
        return {
          schema_version: 'cli.agent-hook.finish-line-stop.v1',
          ok: true,
          data: {
            schema_version: 'agent-hook.finish-line.stop-result.v1',
            action: 'allow',
            generation: 0,
            contract_digest: 'contract-1',
            correlation_id: 'correlation-1',
            reason_codes: [],
            remediation: [],
          },
        }
      }
      const ingress = JSON.parse(spec.stdio.stdin.data)
      return ingress.event === 'agent/turn-stopping'
        ? decision('context', { event: 'Stop', context: 'retry reached authoritative policy' })
        : decision('allow', { event: 'UserPromptSubmit' })
    },
  })
  subject.emit('agent/session-start', { agent: subject.agent, source: 'startup' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: subject.agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  )
  const stopping = {
    agent: subject.agent,
    turn: 1,
    signal: new AbortController().signal,
  }

  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)
  await subject.waterfall('agent/turn-stopping', [stopping], async () => undefined)

  assert.equal(stopAttempts, 2)
  assert.equal(subject.steered.length, 2)
  assert.match(subject.steered[0].content[0].text, /could not verify the stop boundary/)
  assert.equal(subject.steered[1].content[0].text, 'retry reached authoritative policy')
})

test('malformed normalized decisions fail closed without delegating', async () => {
  const malformed = [
    decision('allow', { schema_version: undefined }),
    decision('allow', { request_id: undefined }),
    decision('allow', { policy_digest: 'not-a-digest' }),
    decision('allow', { reasons: 'not-an-array' }),
    decision('allow', { action: 'context' }),
    decision('allow', {
      reasons: [{ rule_id: 'contradiction', code: 'blocked', disposition: 'block' }],
    }),
    decision('allow', {
      reasons: [{ rule_id: 'unknown', code: 'unknown', disposition: 'permit' }],
    }),
    decision('block', {
      reasons: [{ rule_id: 'contradiction', code: 'allowed', disposition: 'allow' }],
    }),
  ]

  for (const envelope of malformed) {
    const subject = harness({ envelope })
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.equal(delegated, false)
    assert.match(result.reason, /policy-(output-invalid|action-unsupported)/)
  }
})

test('oversized DSH ingress is denied before spawning agent-hook', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke({
    content: '好'.repeat(400_000),
  })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-input-too-large/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('a stalled policy subprocess is terminated and fails closed on deadline', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: { policyTimeoutMs: 20 },
  })
  const started = Date.now()
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setTimeout(resolve, 30))
  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  let settled = false
  void invocation.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  const { result, delegated } = await invocation

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-timeout/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 1)
  assert.equal(subject.signal.aborted, true)
  assert.ok(subject.terminateCount >= 1)
  assert.ok(Date.now() - started < 1_000)
})

test('policy transport and exit failures fail closed without delegating', async () => {
  const cases = [
    [harness({ stdout: '{' }), /policy-output-invalid/],
    [harness({ lossy: true }), /policy-output-invalid/],
    [harness({ missingStdout: true }), /policy-output-invalid/],
    [harness({ outcome: { exitCode: 1, signal: null } }), /policy-exit-mismatch/],
    [harness({ outcome: { exitCode: null, signal: 'SIGTERM' } }), /policy-exit-mismatch/],
    [harness({ throwOnSpawn: true }), /policy-unavailable/],
  ]

  for (const [subject, reason] of cases) {
    const { result, delegated } = await subject.invoke({ value: 41 })
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, reason)
    assert.equal(delegated, false)
  }

  const wrongBlockExit = harness({
    envelope: decision('block'),
    outcome: { exitCode: 0, signal: null },
  })
  const { result, delegated } = await wrongBlockExit.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-exit-mismatch/)
  assert.equal(delegated, false)
})

test('a policy response for another ingress payload cannot be replayed', async () => {
  const subject = harness({
    envelope: decision('allow', {
      request_id: 'request:0123456789abcdef0123456789abcdef',
    }),
  })
  const { result, delegated } = await subject.invoke({ value: 41 })

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-output-invalid/)
  assert.equal(delegated, false)
})

test('a prepended short-circuit allow cannot bypass the exact-token monotonic guard', async () => {
  const subject = harness()
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { shortCircuit: true },
  )

  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
  assert.equal(subject.spawnCount, 0)
})

test('an outer waterfall cannot reverse an authoritative nils denial', async () => {
  const subject = harness({ envelope: decision('block') })
  const { result, delegated } = await subject.invoke(
    { value: 41 },
    { reversePolicyDenial: true },
  )
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /agent-hook:blocked/)
  assert.equal(delegated, false)
})

test('downstream pre-execute exceptions preserve their exact rc.7 failure', async () => {
  const subject = harness()
  const distinctive = new Error('distinctive downstream pre-execute failure')
  subject.ctx.on('tools/pre-execute', async () => { throw distinctive })

  await assert.rejects(
    subject.invoke({ value: 41 }),
    error => error === distinctive,
  )
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('a later pre-execute listener cannot replace the evaluated argument object', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.arguments = { value: 99 }
    return downstream
  })

  const { result, delegated, exec } = await subject.invoke({ value: 41 })
  assert.deepEqual(exec.arguments, { value: 99 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects another attached Agent object at the same durable position', async () => {
  const subject = harness()
  const replacement = {
    id: subject.agent.id,
    session: subject.agent.session,
  }
  subject.emit('agent/session-start', { agent: replacement, source: 'resume' })
  await subject.waterfall(
    'agent/pre-step',
    [{
      agent: replacement,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }],
    async () => ({ kind: 'enter', messages: [] }),
  )
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.agent = replacement
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a replacement Session on the evaluated Agent object', async () => {
  const subject = harness()
  const replacement = {
    id: subject.agent.session.id,
    header: { ...subject.agent.session.header },
    events: [],
  }
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.agent.session = replacement
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a substituted parent execution token', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.parent = Symbol('substituted-parent')
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('authorization rejects a substituted cancellation signal', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.signal = new AbortController().signal
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
})

test('token substitution denies and clears stable authorization and correlation state', async () => {
  const subject = harness()
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    exec.token = Symbol('substituted-token')
    return downstream
  })

  const { result, delegated } = await subject.invoke({ value: 41 })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-marker-missing/)
  assert.equal(delegated, false)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('a second same-step execution cannot replay an authorization leaked by token substitution', async () => {
  const subject = harness()
  const arguments_ = { value: 41 }
  const signal = new AbortController().signal
  let originalToken
  const removeSubstitution = subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    originalToken = exec.token
    exec.token = Symbol('substituted-token')
    return downstream
  })

  const first = await subject.invoke(arguments_, { callId: 'replayed-call', signal })
  assert.equal(first.result.kind, 'deny')
  removeSubstitution()
  assert.equal(typeof originalToken, 'symbol')

  const replay = await subject.invoke(arguments_, {
    callId: 'replayed-call',
    signal,
    token: originalToken,
    shortCircuit: true,
    skipLifecycle: true,
  })
  assert.equal(replay.result.kind, 'deny')
  assert.match(replay.result.reason, /policy-marker-missing/)
  assert.equal(replay.delegated, false)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
  assert.equal(subject.service.pendingCorrelations, 0)
})

test('agentless, pre-step-less, and invalid-cwd calls fail closed without spawning', async () => {
  const agentless = harness()
  const agentlessResult = await agentless.invoke({ value: 41 }, { withoutAgent: true })
  assert.match(agentlessResult.result.reason, /policy-agent-missing/)
  assert.equal(agentless.spawnCount, 0)

  const noStep = harness()
  const noStepResult = await noStep.invoke({ value: 41 }, { skipLifecycle: true })
  assert.match(noStepResult.result.reason, /policy-step-missing/)
  assert.equal(noStep.spawnCount, 0)

  const invalidCwd = harness()
  invalidCwd.agent.session.header.cwd = 'relative/path'
  const invalidCwdResult = await invalidCwd.invoke({ value: 41 })
  assert.match(invalidCwdResult.result.reason, /policy-cwd-invalid/)
  assert.equal(invalidCwd.spawnCount, 0)
})

test('allow markers are bound to one opaque execution token and consumed once', async () => {
  const subject = harness()
  const prepared = await subject.prepare({ value: 41 }, { callId: 'same-call' })
  assert.equal(prepared.result.kind, 'allow')

  const stale = {
    ...prepared.exec,
    token: Symbol('stale-token'),
  }
  assert.match(subject.guard(stale), /policy-marker-missing/)
  assert.equal(subject.guard(prepared.exec), undefined)
  assert.match(subject.guard(prepared.exec), /policy-marker-missing/)
})

test('downstream ask decisions preserve exact-token authorization through approval', async () => {
  const approved = harness()
  const approvedResult = await approved.invoke({ value: 41 }, {
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
    askOutcome: 'approved',
  })
  assert.equal(approvedResult.result.kind, 'allow')
  assert.equal(approvedResult.delegated, true)
  assert.equal(approved.service.pendingPolicyMarkers, 0)

  for (const askOutcome of ['denied', 'cancelled']) {
    const rejected = harness()
    const rejectedResult = await rejected.invoke({ value: 41 }, {
      downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
      askOutcome,
    })
    assert.equal(rejectedResult.result.kind, 'deny')
    assert.equal(rejectedResult.delegated, false)
    assert.equal(rejected.service.pendingPolicyMarkers, 0)
  }
})

test('caller abort joins the policy process tree before returning a terminal denial', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: { maxActivePolicyChecks: 1 },
  })
  const controller = new AbortController()
  const invocation = subject.invoke({ value: 41 }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('caller stopped'))

  let settled = false
  void invocation.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  assert.ok(subject.terminateCount >= 1)

  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  const { result, delegated } = await invocation
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /policy-caller-aborted/)
  assert.equal(delegated, false)
  assert.equal(subject.service.activePolicyChecks, 0)
})

test('the first cancellation cause remains authoritative while quiescence is pending', async () => {
  const callerFirst = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    config: { policyTimeoutMs: 20 },
  })
  const callerController = new AbortController()
  const callerInvocation = callerFirst.invoke(
    { value: 41 },
    { signal: callerController.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  callerController.abort(new Error('caller first'))
  await new Promise(resolve => setTimeout(resolve, 30))
  callerFirst.release(0, { exitCode: null, signal: 'SIGTERM' })
  assert.match((await callerInvocation).result.reason, /policy-caller-aborted/)

  const timeoutFirst = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    config: { policyTimeoutMs: 10 },
  })
  const timeoutController = new AbortController()
  const timeoutInvocation = timeoutFirst.invoke(
    { value: 41 },
    { signal: timeoutController.signal },
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  timeoutController.abort(new Error('caller second'))
  timeoutFirst.release(0, { exitCode: null, signal: 'SIGTERM' })
  assert.match((await timeoutInvocation).result.reason, /policy-timeout/)
})

test('policy disposal stops ingress and waits for every active process tree', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
  })
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setImmediate(resolve))

  let disposed = false
  const disposal = subject.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(subject.terminateCount >= 1)
  assert.equal(disposed, false)
  assert.equal(subject.service.activePolicyChecks, 1)

  subject.release(0, { exitCode: null, signal: 'SIGTERM' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(subject.service.activePolicyChecks, 1)
  subject.releaseTree(0)
  await Promise.all([disposal, invocation])
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('unknown timeout quiescence returns bounded and permanently closes admission', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: { policyTimeoutMs: 10, policyTeardownTimeoutMs: 20 },
  })
  const started = Date.now()
  const invocation = subject.invoke({ value: 41 })
  const bounded = await Promise.race([
    invocation,
    new Promise(resolve => setTimeout(() => resolve(undefined), 150)),
  ])
  assert.notEqual(bounded, undefined)
  assert.ok(Date.now() - started < 150)
  assert.match(bounded.result.reason, /policy-timeout/)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)

  const rejected = await subject.invoke({ value: 42 })
  assert.match(rejected.result.reason, /policy-unavailable/)
  assert.equal(subject.spawnCount, 1)
  subject.reject(0, new Error('late provider rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('disposal is bounded when provider done and waitForExit never settle', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: { policyTimeoutMs: 30_000, policyTeardownTimeoutMs: 20 },
  })
  const invocation = subject.invoke({ value: 41 })
  await new Promise(resolve => setImmediate(resolve))
  const started = Date.now()
  const disposal = subject.dispose()
  const bounded = await Promise.race([
    disposal,
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 150)),
  ])
  assert.notEqual(bounded, 'still-pending')
  assert.ok(Date.now() - started < 150)
  assert.match((await invocation).result.reason, /policy-disposed/)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)
  subject.reject(0, new Error('late disposal rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('unknown quiescence monotonically fails every in-flight sibling', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    waitNeverSettles: true,
    config: {
      policyTimeoutMs: 1_000,
      policyTeardownTimeoutMs: 20,
      maxActivePolicyChecks: 2,
    },
  })
  const firstController = new AbortController()
  const first = subject.invoke(
    { value: 1 },
    { callId: 'degrading', signal: firstController.signal },
  )
  const sibling = subject.invoke({ value: 2 }, { callId: 'sibling' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.spawnCount, 2)
  firstController.abort(new Error('first caller stopped'))

  const [firstResult, siblingResult] = await Promise.all([first, sibling])
  assert.match(firstResult.result.reason, /policy-caller-aborted/)
  assert.equal(firstResult.delegated, false)
  assert.match(siblingResult.result.reason, /policy-unavailable/)
  assert.equal(siblingResult.delegated, false)
  assert.equal(subject.service.activePolicyChecks, 0)
  assert.equal(subject.service.policyTransportDegraded, true)
})

test('transport degradation revokes an allow marker awaiting approval', async () => {
  const subject = harness({
    pending: true,
    settleOnAbort: false,
    settleOnTerminate: false,
    quiesceOnSettle: false,
    config: {
      policyTimeoutMs: 1_000,
      policyTeardownTimeoutMs: 20,
      maxActivePolicyChecks: 2,
    },
  })
  const awaitingApproval = subject.prepare({ value: 41 }, {
    callId: 'awaiting-approval',
    downstreamDecision: { kind: 'ask', reason: 'confirm execution' },
  })
  await new Promise(resolve => setImmediate(resolve))
  subject.release(0)
  subject.releaseTree(0)
  const authorized = await awaitingApproval
  assert.equal(authorized.result.kind, 'ask')
  assert.equal(subject.service.pendingPolicyMarkers, 1)

  const controller = new AbortController()
  const degrading = subject.invoke({ value: 42 }, {
    callId: 'degrading-while-approval-waits',
    signal: controller.signal,
    skipLifecycle: true,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('force unknown process-tree quiescence'))
  assert.match((await degrading).result.reason, /policy-caller-aborted/)
  assert.equal(subject.service.policyTransportDegraded, true)

  let bodyExecutions = 0
  const reason = subject.guard(authorized.exec)
  if (reason === undefined) bodyExecutions += 1
  assert.match(reason, /policy-unavailable/)
  assert.equal(bodyExecutions, 0)
  assert.equal(subject.service.pendingPolicyMarkers, 0)
})

test('the rc.7 compatibility seam wires every required public lifecycle extension', async () => {
  const subject = harness()
  assert.deepEqual(subject.listenerNames, [
    'agent/disposed',
    'agent/pre-step',
    'agent/session-start',
    'agent/turn-stopping',
    'fs/observed',
    'tools/execute',
    'tools/post-execute',
    'tools/pre-execute',
    'tools/result',
  ])

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'secret' }] }]
  const expected = { kind: 'enter', messages }
  const actual = await subject.waterfall(
    'agent/pre-step',
    [{ agent: subject.agent, messages, turn: 1, step: 1, signal: new AbortController().signal }],
    async () => expected,
  )
  assert.equal(actual, expected)

  const prepared = await subject.prepare({ value: 41 }, { callId: 'post' })
  assert.equal(prepared.result.kind, 'allow')
  const post = { kind: 'accept' }
  const postActual = await subject.waterfall(
    'tools/post-execute',
    [prepared.exec, { isError: false, value: 42, content: [] }],
    async () => post,
  )
  assert.equal(postActual, post)
  subject.emit('tools/result', prepared.exec, { isError: false, value: 42, content: [] })
})

test('a stale post-tool identity blocks without delegating the post waterfall', async () => {
  const subject = harness()
  let delegated = false
  const result = await subject.waterfall(
    'tools/post-execute',
    [{ token: Symbol('stale'), callId: 'stale', rootCallId: 'stale', name: 'runtime_kit_plus_one', arguments: {}, signal: new AbortController().signal, agent: subject.agent }, { isError: false, value: 42, content: [] }],
    async () => {
      delegated = true
      return { kind: 'accept' }
    },
  )
  assert.equal(delegated, false)
  assert.equal(result.kind, 'block')
  assert.match(result.feedback[0].text, /policy-correlation-invalid/)
})

test('policy timeout and active subprocess configuration are capped', () => {
  const subject = harness({
    config: {
      policyTimeoutMs: Number.MAX_SAFE_INTEGER,
      policyTeardownTimeoutMs: Number.MAX_SAFE_INTEGER,
      maxActivePolicyChecks: Number.MAX_SAFE_INTEGER,
    },
  })
  assert.equal(subject.service.policyTimeoutMs, 30_000)
  assert.equal(subject.service.policyTeardownTimeoutMs, 10_000)
  assert.equal(subject.service.maxActivePolicyChecks, 16)
  assert.equal(subject.service.policyTransportDegraded, false)
})

test('policy subprocess concurrency rejects overload and releases slots after settlement', async () => {
  const subject = harness({ pending: true, config: { maxActivePolicyChecks: 2 } })
  const controllers = [new AbortController(), new AbortController(), new AbortController()]
  const first = subject.invoke({ value: 1 }, { callId: 'one', signal: controllers[0].signal })
  await new Promise(resolve => setImmediate(resolve))
  const second = subject.invoke(
    { value: 2 },
    { callId: 'two', signal: controllers[1].signal, skipLifecycle: true },
  )
  const overloaded = subject.invoke(
    { value: 3 },
    { callId: 'three', signal: controllers[2].signal, skipLifecycle: true },
  )
  await new Promise(resolve => setImmediate(resolve))

  try {
    assert.equal(subject.spawnCount, 2)
    const rejected = await overloaded
    assert.equal(rejected.result.kind, 'deny')
    assert.match(rejected.result.reason, /policy-overloaded/)

    subject.release(0)
    assert.equal((await first).delegated, true)
    const fourth = subject.invoke({ value: 4 }, { callId: 'four', skipLifecycle: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(subject.spawnCount, 3)
    assert.equal(subject.peakActiveHandles, 2)
    subject.release(2)
    assert.equal((await fourth).delegated, true)
  } finally {
    controllers.forEach(controller => controller.abort())
    subject.release(0)
    subject.release(1)
    subject.release(2)
    await Promise.allSettled([first, second, overloaded])
  }
})

test('high-cardinality and excessive-depth ingress are rejected without recursion or spawn', async () => {
  const broad = harness()
  const broadResult = await broad.invoke({ values: Array.from({ length: 20_000 }, () => 0) })
  assert.equal(broadResult.result.kind, 'deny')
  assert.match(broadResult.result.reason, /policy-input-too-complex/)
  assert.equal(broad.spawnCount, 0)

  let nested = { value: 41 }
  for (let depth = 0; depth < 2_000; depth += 1) nested = { nested }
  const deep = harness()
  const deepResult = await deep.invoke(nested)
  assert.equal(deepResult.result.kind, 'deny')
  assert.match(deepResult.result.reason, /policy-input-too-complex/)
  assert.equal(deep.spawnCount, 0)
})
