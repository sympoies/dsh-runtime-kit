import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createDshRc7Compatibility,
  dshRc7AgentRoute,
  dshRc7RunInfo,
  dshRc7SessionHeader,
} from '../src/compat/dsh-rc7.js'

test('the rc.7 adapter owns session, route, and run-info shape probes', () => {
  const agent = {
    options: { provider: 'deepseek-official', model: 'deepseek-v4' },
    session: {
      requestHeader() {
        return {
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4',
            reasoningEffort: 'high',
          },
        }
      },
      header: {
        id: 'child-one',
        parentSession: 'anchor-one',
        cwd: '/worktrees/child-one',
      },
    },
  }
  assert.deepEqual(dshRc7SessionHeader(agent), {
    id: 'child-one',
    parentSession: 'anchor-one',
    cwd: '/worktrees/child-one',
  })
  assert.deepEqual(dshRc7AgentRoute(agent), {
    provider: 'deepseek-official',
    model: 'deepseek-v4',
    reasoningEffort: 'high',
  })
  assert.deepEqual(dshRc7RunInfo({ id: 'child-one', stopReason: 'completed' }), {
    id: 'child-one',
    stopReason: 'completed',
  })
  assert.deepEqual(dshRc7SessionHeader({}), {})
  assert.deepEqual(dshRc7AgentRoute({}), {})
  assert.deepEqual(dshRc7RunInfo({}), {})
})

function agentFixture({
  id = 'session-1',
  cwd = '/workspace/project',
  events = [],
} = {}) {
  return {
    id,
    session: {
      id,
      header: { id, cwd },
      events,
    },
  }
}

function execution(agent, token, {
  callId = 'call-1',
  rootCallId = callId,
  name = 'runtime_kit_plus_one',
  arguments: arguments_ = { value: 41 },
} = {}) {
  return {
    agent,
    token,
    parent: undefined,
    callId,
    rootCallId,
    name,
    arguments: arguments_,
    signal: new AbortController().signal,
  }
}

test('all rc.7 lifecycle boundaries share content-free session, step, and call correlation', async () => {
  const agent = agentFixture()
  const subject = createDshRc7Compatibility({ agents: { list: () => [] } })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'prompt-secret' }] }]
  subject.sessionStart({ agent, source: 'startup' })

  assert.deepEqual(subject.preStepContext({
    agent,
    messages,
    turn: 2,
    step: 3,
    signal: new AbortController().signal,
  }), {
    ok: true,
    context: {
      sessionId: 'session-1',
      cwd: '/workspace/project',
      turn: 2,
      step: 3,
      sessionStartSource: 'startup',
    },
  })

  const expected = { kind: 'enter', messages }
  const actual = await subject.preStep({
    agent,
    messages,
    turn: 2,
    step: 3,
    signal: new AbortController().signal,
  }, async () => expected)
  assert.equal(actual, expected)
  agent.session.events.push(
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 3 } },
  )

  const token = Symbol('exact-token')
  const exec = execution(agent, token, {
    callId: 'call-shared',
    rootCallId: 'root-call',
    arguments: { secret: 'argument-secret' },
  })
  const started = subject.beginTool(exec)
  assert.equal(started.ok, true)
  assert.deepEqual(started.context, {
    token,
    parent: undefined,
    sessionId: 'session-1',
    cwd: '/workspace/project',
    turn: 2,
    step: 3,
    callId: 'call-shared',
    rootCallId: 'root-call',
    name: 'runtime_kit_plus_one',
  })
  assert.doesNotMatch(JSON.stringify(started.context), /prompt-secret|argument-secret/)

  assert.equal(subject.postTool(exec), true)
  assert.equal(subject.pendingCorrelations, 1)
  assert.equal(subject.result(exec, {
    isError: false,
    value: 'result-secret',
    content: [{ type: 'text', text: 'rendered-secret' }],
  }), true)
  assert.equal(subject.pendingCorrelations, 0)
  assert.equal(subject.turnStopping({
    agent,
    turn: 2,
    signal: new AbortController().signal,
  }), true)
  assert.deepEqual(subject.stopContext({
    agent,
    turn: 2,
    signal: new AbortController().signal,
  }), {
    ok: true,
    context: {
      sessionId: 'session-1',
      cwd: '/workspace/project',
      turn: 2,
    },
  })
})

test('opaque tokens keep parallel calls distinct even when visible call facts match', async () => {
  const agent = agentFixture()
  const subject = createDshRc7Compatibility({ agents: { list: () => [] } })
  subject.sessionStart({ agent, source: 'resume' })
  await subject.preStep({
    agent,
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  agent.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
  )

  const first = execution(agent, Symbol('first'), { callId: 'same-call' })
  const second = execution(agent, Symbol('second'), { callId: 'same-call' })
  assert.equal(subject.beginTool(first).ok, true)
  assert.equal(subject.beginTool(second).ok, true)
  assert.equal(subject.pendingCorrelations, 2)
  assert.equal(subject.result(first), true)
  assert.equal(subject.matchesTool(second), true)
  assert.equal(subject.pendingCorrelations, 1)
  subject.dispose()
  assert.equal(subject.pendingCorrelations, 0)
})

test('rejected, throwing, and aborted pre-step proposals never become executable positions', async () => {
  const cases = [
    {
      label: 'rejected',
      run: subject => subject.preStep,
      next: async () => ({ kind: 'reject' }),
    },
    {
      label: 'throwing',
      next: async () => { throw new Error('distinctive pre-step failure') },
      throws: true,
    },
    {
      label: 'aborted',
      next: async controller => {
        controller.abort(new Error('pre-step aborted'))
        return { kind: 'enter', messages: [] }
      },
    },
  ]

  for (const scenario of cases) {
    const agent = agentFixture({
      id: scenario.label,
      events: [{ type: 'turn/start', data: { turn: 1 } }],
    })
    const subject = createDshRc7Compatibility({ agents: { list: () => [agent] } })
    const controller = new AbortController()
    const invoke = () => subject.preStep({
      agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: controller.signal,
    }, () => scenario.next(controller))
    if (scenario.throws) {
      await assert.rejects(invoke(), /distinctive pre-step failure/)
    } else {
      await invoke()
    }
    assert.deepEqual(subject.beginTool(execution(agent, Symbol(scenario.label))), {
      ok: false,
      reason: 'policy-step-missing',
    }, scenario.label)
  }
})

test('live step-end and turn-end history invalidates cached tool correlation', () => {
  const agent = agentFixture({
    events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ],
  })
  const subject = createDshRc7Compatibility({ agents: { list: () => [agent] } })
  const active = execution(agent, Symbol('active'))
  assert.equal(subject.beginTool(active).ok, true)

  agent.session.events.push({ type: 'step/end', data: { turn: 1, step: 1 } })
  assert.equal(subject.matchesTool(active), false)
  assert.equal(subject.result(active), false)
  assert.equal(subject.pendingCorrelations, 0)
  assert.deepEqual(subject.beginTool(execution(agent, Symbol('after-step'))), {
    ok: false,
    reason: 'policy-step-missing',
  })

  agent.session.events.push({
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.deepEqual(subject.beginTool(execution(agent, Symbol('after-turn'))), {
    ok: false,
    reason: 'policy-step-missing',
  })
})

test('HMR position derivation visits only the recent lifecycle suffix', () => {
  const stored = Array.from(
    { length: 100_000 },
    (_, index) => ({ type: 'user/message', data: { index } }),
  )
  stored.push(
    { type: 'turn/start', data: { turn: 9 } },
    { type: 'step/start', data: { turn: 9, step: 2 } },
  )
  let visits = 0
  const events = new Proxy(stored, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) visits += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const agent = agentFixture({ id: 'large-history', events })
  const subject = createDshRc7Compatibility({ agents: { list: () => [agent] } })
  assert.equal(subject.beginTool(execution(agent, Symbol('large-history'))).ok, true)
  assert.ok(visits <= 6, `expected recent-suffix scan, visited ${visits} events`)
})

test('repeated tool boundaries do not rescan a large unchanged open-step suffix', () => {
  const stored = [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { turn: 3, step: 1 } },
    ...Array.from(
      { length: 100_000 },
      (_, index) => ({ type: 'assistant/chunk', data: { turn: 3, step: 1, index } }),
    ),
  ]
  let visits = 0
  const events = new Proxy(stored, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) visits += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const agent = agentFixture({ id: 'large-open-suffix', events })
  const subject = createDshRc7Compatibility({ agents: { list: () => [agent] } })
  const visitsAfterAttachment = visits
  const exec = execution(agent, Symbol('large-open-suffix'))
  assert.equal(subject.beginTool(exec).ok, true)
  assert.equal(subject.matchesTool(exec), true)
  assert.equal(subject.postTool(exec), true)
  assert.equal(subject.result(exec), true)
  assert.ok(
    visits - visitsAfterAttachment <= 8,
    `expected cached durable position, revisited ${visits - visitsAfterAttachment} events`,
  )
})

test('history replacement or truncation stays invalid until the session is reattached', () => {
  for (const mode of ['replacement', 'truncation']) {
    const events = [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'step/start', data: { turn: 3, step: 1 } },
    ]
    const agent = agentFixture({ id: `history-${mode}`, events })
    const subject = createDshRc7Compatibility({ agents: { list: () => [agent] } })
    const initial = execution(agent, Symbol(`${mode}-initial`))
    assert.equal(subject.beginTool(initial).ok, true)
    assert.equal(subject.result(initial), true)

    if (mode === 'replacement') {
      agent.session.events = structuredClone(events)
    } else {
      agent.session.events.length = 1
    }
    assert.deepEqual(subject.beginTool(execution(agent, Symbol(`${mode}-invalidated`))), {
      ok: false,
      reason: 'policy-step-missing',
    })

    if (mode === 'truncation') {
      agent.session.events.push({ type: 'step/start', data: { turn: 3, step: 1 } })
    }
    assert.deepEqual(subject.beginTool(execution(agent, Symbol(`${mode}-sticky`))), {
      ok: false,
      reason: 'policy-step-missing',
    })

    subject.sessionStart({ agent, source: 'resume' })
    const reset = execution(agent, Symbol(`${mode}-reset`))
    assert.equal(subject.beginTool(reset).ok, true)
    assert.equal(subject.result(reset), true)
  }
})

test('HMR attachment accepts only the currently open durable step', () => {
  const histories = [
    {
      label: 'closed step',
      events: [
        { type: 'turn/start', data: { turn: 4 } },
        { type: 'step/start', data: { turn: 4, step: 2 } },
        { type: 'step/end', data: { turn: 4, step: 2 } },
      ],
      allowed: false,
    },
    {
      label: 'closed turn',
      events: [
        { type: 'turn/start', data: { turn: 4 } },
        { type: 'step/start', data: { turn: 4, step: 2 } },
        { type: 'step/end', data: { turn: 4, step: 2 } },
        { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
      ],
      allowed: false,
    },
    {
      label: 'open step',
      events: [
        { type: 'turn/start', data: { turn: 4 } },
        { type: 'step/start', data: { turn: 4, step: 2 } },
      ],
      allowed: true,
    },
    {
      label: 'reopened step',
      events: [
        { type: 'turn/start', data: { turn: 4 } },
        { type: 'step/start', data: { turn: 4, step: 2 } },
        { type: 'step/end', data: { turn: 4, step: 2 } },
        { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
        { type: 'turn/start', data: { turn: 5 } },
        { type: 'step/start', data: { turn: 5, step: 1 } },
      ],
      allowed: true,
    },
  ]

  for (const history of histories) {
    const attached = agentFixture({ id: history.label, events: history.events })
    const subject = createDshRc7Compatibility({ agents: { list: () => [attached] } })
    const actual = subject.beginTool(execution(attached, Symbol(history.label)))
    if (history.allowed) {
      assert.equal(actual.ok, true, history.label)
    } else {
      assert.deepEqual(actual, {
        ok: false,
        reason: 'policy-step-missing',
      }, history.label)
    }
  }
})

test('invalid HMR identities fail closed', () => {
  const subject = createDshRc7Compatibility({ agents: { list: () => [] } })

  const missingCwd = agentFixture({ id: 'missing-cwd' })
  delete missingCwd.session.header.cwd
  subject.sessionStart({ agent: missingCwd, source: 'startup' })
  assert.deepEqual(subject.beginTool(execution(missingCwd, Symbol('missing-cwd'))), {
    ok: false,
    reason: 'policy-cwd-invalid',
  })

  const unknown = agentFixture({ id: 'unknown' })
  assert.deepEqual(subject.beginTool(execution(unknown, Symbol('unknown'))), {
    ok: false,
    reason: 'policy-session-missing',
  })
})
