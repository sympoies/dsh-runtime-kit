import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dshHistoryCapabilities,
  listDshHistorySessions,
  projectDshHistorySummary,
  readDshHistorySummarySnapshots,
  readDshHistoryMessages,
  summarizeDshHistorySessions,
  type DshHistoryBackend,
} from '../dist/src/compat/dsh-history-adapter.js'

function backend(): DshHistoryBackend {
  const headers = [
    {
      header: {
        id: 'child',
        createdAt: 30,
        cwd: '/repo',
        parentSession: 'top',
        delegationDepth: 1,
      },
      revision: 'child-revision',
      updatedAt: 35,
    },
    {
      header: {
        id: 'top',
        createdAt: 10,
        delegationDepth: 0,
      },
      revision: 'top-revision',
      updatedAt: 40,
    },
    {
      header: {
        id: 'orphan-worker',
        createdAt: 20,
        delegationDepth: 1,
      },
      revision: 'orphan-worker-revision',
      updatedAt: 45,
    },
    {
      header: {
        id: 'invalid-timestamp',
        createdAt: Number.MAX_SAFE_INTEGER,
        delegationDepth: 0,
      },
      revision: 'invalid-timestamp-revision',
      updatedAt: 50,
    },
  ]
  const events = [
    {
      type: 'user/message', seq: 2, time: 20,
      data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'hidden' }] },
    },
    {
      type: 'user/message', seq: 3, time: 21,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: ' first   prompt ' }] },
    },
    {
      type: 'assistant/message', seq: 8, time: 25,
      data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer\n\nwith spacing' }] } },
    },
    {
      type: 'user/message', seq: 9, time: 28,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'latest prompt' }] },
    },
  ]
  return {
    listSnapshots: async () => headers,
    readSummarySnapshots: async (ids) => ids.map((sessionId) => ({
      sessionId,
      status: 'fulfilled' as const,
      value: projectDshHistorySummary(
        sessionId,
        sessionId === 'top' ? 'Reviewed title' : undefined,
        events,
      ),
    })),
    readSurface: async () => ({ capturedThroughSeq: 9, events }),
  }
}

test('reports the adapter schema and refuses a drifted DSH composition', () => {
  const versions = {
    '@deepseek-ai/dsh-session': '0.1.2-rc.1',
    '@deepseek-ai/dsh-session-persistence-jsonl': '0.1.2-rc.1',
    '@deepseek-ai/dsh-session-query': '0.1.2-rc.1',
    '@deepseek-ai/dsh-session-title': '0.1.2-rc.1',
  }
  assert.deepEqual(dshHistoryCapabilities(versions), {
    adapter_schema: 'dsh-runtime-kit.history.v1',
    session_format: 'dsh-session@0.1.2-rc.1',
    operations: ['list', 'summaries', 'messages'],
  })
  assert.throws(
    () => dshHistoryCapabilities({ ...versions, '@deepseek-ai/dsh-session-query': '0.1.2-rc.2' }),
    /unsupported DSH history package version/,
  )
})

test('lists only top-level sessions without reading transcript bodies', async () => {
  const subject = backend()
  let surfaceReads = 0
  const original = subject.readSurface
  subject.readSurface = async (id) => {
    surfaceReads += 1
    return original(id)
  }

  assert.deepEqual(await listDshHistorySessions(subject), [{
    provider_session_id: 'top',
    cwd: '(unknown)',
    created_at: '1970-01-01T00:00:00.010Z',
    updated_at: '1970-01-01T00:00:00.040Z',
    revision: 'top-revision',
  }])
  assert.equal(surfaceReads, 0)
})

test('summarizes only requested sessions and excludes injected user-role events', async () => {
  assert.deepEqual(await summarizeDshHistorySessions(backend(), ['top']), [{
    provider_session_id: 'top',
    title: 'Reviewed title',
    first_user_prompt_preview: 'first prompt',
    last_user_prompt_preview: 'latest prompt',
    updated_at: '1970-01-01T00:00:00.028Z',
  }])
})

test('isolates a failed surface read from healthy requested summaries', async () => {
  const subject = backend()
  const original = subject.readSummarySnapshots
  subject.readSummarySnapshots = async (ids) => [
    { sessionId: 'broken', status: 'rejected' },
    ...(await original(ids.filter(id => id !== 'broken'))),
  ]

  assert.deepEqual(await summarizeDshHistorySessions(subject, ['broken', 'top']), [{
    provider_session_id: 'top',
    title: 'Reviewed title',
    first_user_prompt_preview: 'first prompt',
    last_user_prompt_preview: 'latest prompt',
    updated_at: '1970-01-01T00:00:00.028Z',
  }])
})

test('summarizes a selected page through one bounded backend projection', async () => {
  const subject = backend()
  let projectionCalls = 0
  subject.readSummarySnapshots = async (ids) => {
    projectionCalls += 1
    const events = (await backend().readSurface('top')).events
    return ids.map(sessionId => ({
      sessionId,
      status: 'fulfilled',
      value: projectDshHistorySummary(
        sessionId,
        sessionId === 'top' ? 'Reviewed title' : undefined,
        events,
      ),
    }))
  }
  subject.readSurface = async () => {
    throw new Error('legacy duplicate surface read should not run')
  }

  const summaries = await summarizeDshHistorySessions(subject, ['top', 'top'])

  assert.equal(projectionCalls, 1)
  assert.deepEqual(summaries, [{
    provider_session_id: 'top',
    title: 'Reviewed title',
    first_user_prompt_preview: 'first prompt',
    last_user_prompt_preview: 'latest prompt',
    updated_at: '1970-01-01T00:00:00.028Z',
  }])
})

test('production summary workers preserve fold order with bounded compact observations', async () => {
  const sessionIds = Array.from({ length: 50 }, (_, index) => `session-${index}`)
  sessionIds.splice(7, 0, 'session-2')
  sessionIds.splice(19, 0, 'broken')
  const calls: string[] = []
  let active = 0
  let maximumActive = 0
  const observations = await readDshHistorySummarySnapshots(sessionIds, {
    inspect: async (sessionId) => {
      calls.push(sessionId)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      if (sessionId === 'broken') throw new Error('corrupt session')
      return {
        events: [
          {
            type: 'user/message', seq: 0, time: 10,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${sessionId} shadowed` }] },
          },
          {
            type: 'user/message', seq: 1, time: 20,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${sessionId} tail` }] },
          },
          {
            type: 'user/message', seq: 2, time: 30,
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: `${sessionId} replacement` }] },
          },
        ],
      }
    },
    foldSurface: () => [2, 1],
    foldTitle: events => `${events.length}-event title`,
  }, AbortSignal.timeout(2_000))

  assert.equal(maximumActive, 4)
  assert.equal(calls.length, 51)
  assert.equal(new Set(calls).size, 51)
  assert.deepEqual(observations.map(result => result.sessionId), [...new Set(sessionIds)])
  assert.deepEqual(observations[0], {
    sessionId: 'session-0',
    status: 'fulfilled',
    value: {
      provider_session_id: 'session-0',
      title: '3-event title',
      first_user_prompt_preview: 'session-0 replacement',
      last_user_prompt_preview: 'session-0 tail',
      updated_at: '1970-01-01T00:00:00.020Z',
    },
  })
  assert.equal(observations.find(result => result.sessionId === 'broken')?.status, 'rejected')
  assert.equal('events' in observations[0].value!, false)
})

test('production summary workers reject the whole operation when aborted', async () => {
  const controller = new AbortController()
  let started = 0
  const summaries = readDshHistorySummarySnapshots(['a', 'b', 'c', 'd', 'e'], {
    inspect: (_sessionId, signal) => new Promise((_resolve, reject) => {
      started += 1
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
    foldSurface: () => [],
    foldTitle: () => undefined,
  }, controller.signal)

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 4)
  controller.abort()
  await assert.rejects(summaries, { name: 'AbortError' })
})

test('pages the visible conversation newest-first and returns an older cursor', async () => {
  const page = await readDshHistoryMessages(backend(), 'top', {
    direction: 'latest',
    limit: 2,
  })
  assert.deepEqual(page, {
    messages: [
      { id: 'dsh:8', role: 'assistant', text: 'answer\n\nwith spacing', timestamp: '1970-01-01T00:00:00.025Z' },
      { id: 'dsh:9', role: 'user', text: 'latest prompt', timestamp: '1970-01-01T00:00:00.028Z' },
    ],
    older_cursor: '8',
  })

  assert.deepEqual(await readDshHistoryMessages(backend(), 'top', {
    direction: 'older',
    cursor: page.older_cursor,
    limit: 2,
  }), {
    messages: [
      { id: 'dsh:3', role: 'user', text: 'first   prompt', timestamp: '1970-01-01T00:00:00.021Z' },
    ],
  })
})

test('bounds normalized message text below the daemon response cap', async () => {
  const subject = backend()
  subject.readSurface = async () => ({
    capturedThroughSeq: 1,
    events: [{
      type: 'assistant/message',
      seq: 1,
      data: { message: { content: [{ type: 'text', text: '界'.repeat(20 * 1024) }] } },
    }],
  })

  const page = await readDshHistoryMessages(subject, 'top', {
    direction: 'latest',
    limit: 100,
  })
  assert.equal([...page.messages[0].text].length, 16 * 1024)
})
