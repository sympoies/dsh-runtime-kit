import assert from 'node:assert/strict'
import { mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CHECKPOINT_INPUT_SCHEMA,
  SUPERVISION_SCHEMA,
  checkpointDocument,
  laneChildActivity,
  supervisionEnvelope,
  writePrivateJson,
} from '../src/main-agent/orchestration.js'

test('the checkpoint document is the nils-cli input contract, not a free-form object', () => {
  const minimal = checkpointDocument({
    summary: 'wired the lane runtime',
    nextAction: 'run the gates',
  })
  assert.deepEqual(minimal, {
    schema_version: CHECKPOINT_INPUT_SCHEMA,
    summary: 'wired the lane runtime',
    next_action: 'run the gates',
  })

  // Optional fields are omitted rather than sent as null: the CLI validates
  // each present summary, and a null would fail closed as an invalid input.
  const full = checkpointDocument({
    summary: 'submitted the diff',
    nextAction: 'await review',
    state: 'submitted',
    resultSummary: 'three files changed',
    blockerSummary: undefined,
  })
  assert.deepEqual(full, {
    schema_version: CHECKPOINT_INPUT_SCHEMA,
    summary: 'submitted the diff',
    next_action: 'await review',
    state: 'submitted',
    result_summary: 'three files changed',
  })

  for (const invalid of [
    { summary: '', nextAction: 'x' },
    { summary: 'x', nextAction: '' },
    { summary: 'x', nextAction: 'y', state: 'invented-state' },
    { summary: 'x\nsecond line', nextAction: 'y' },
  ]) {
    assert.throws(
      () => checkpointDocument(/** @type {any} */ (invalid)),
      /dsh-runtime-kit:main-agent-checkpoint-invalid/,
      `refuses ${JSON.stringify(invalid)}`,
    )
  }
})

test('private JSON is written owner-only through a verified real directory', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-orchestration-'))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  const directory = join(scratch, 'coordination')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, 'checkpoint.json')

  await writePrivateJson(target, { schema_version: 'x', summary: 'y' })
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), {
    schema_version: 'x',
    summary: 'y',
  })
  // The CLI refuses a checkpoint file any other principal could read.
  assert.equal(statSync(target).mode & 0o077, 0)

  await assert.rejects(
    writePrivateJson(join(scratch, 'missing-directory', 'checkpoint.json'), {}),
    /dsh-runtime-kit:main-agent-private-write-failed/,
  )
})

test('lane child activity folds the listing contract without inventing liveness', () => {
  const running = laneChildActivity(
    [
      { kind: 'child', id: 'child-1', activity: 'running', mode: 'continuable', label: 'main-agent:a', hasChildren: false },
      { kind: 'child', id: 'child-2', activity: 'inactive', mode: 'continuable', label: 'main-agent:b', hasChildren: false },
    ],
    'child-1',
  )
  assert.deepEqual(running, { activity: 'running', mode: 'continuable', label: 'main-agent:a' })

  const cold = laneChildActivity(
    [{ kind: 'child', id: 'child-2', activity: 'inactive', mode: 'continuable', label: 'l', hasChildren: false }],
    'child-2',
  )
  assert.equal(cold.activity, 'inactive')

  // A diagnostic row is not a live child: the listing could not classify it,
  // so the fold reports the diagnostic instead of guessing either way.
  const diagnosed = laneChildActivity(
    [{ kind: 'diagnostic', id: 'child-3', reason: 'corrupt' }],
    'child-3',
  )
  assert.deepEqual(diagnosed, { activity: 'unknown', diagnostic: 'corrupt' })

  // An absent row is the creation window or a drained child; never `running`.
  assert.deepEqual(laneChildActivity([], 'child-4'), { activity: 'unknown', diagnostic: 'unlisted' })
})

test('the supervision envelope keeps store truth and lane transport facts distinguishable', () => {
  const envelope = supervisionEnvelope({
    assignmentId: 'assignment-one',
    store: {
      schema_version: 'main-agent.worker-supervise-result.v2',
      classification: 'healthy_progress',
      next_action: 'continue bounded supervision',
      assignment_revision: 4,
    },
    lane: {
      assignmentId: 'assignment-one',
      workerSessionId: 'worker-one',
      launchId: 'launch-1',
      childId: 'child-1',
      anchorId: 'anchor-1',
      state: 'open',
      turn: {
        phase: 'working',
        phaseChangedAt: '1700000000',
        currentTurn: { startedAt: '1700000000' },
        lastTurn: undefined,
      },
    },
    childActivity: { activity: 'running', mode: 'continuable', label: 'main-agent:assignment-one' },
  })
  assert.equal(envelope.schema_version, SUPERVISION_SCHEMA)
  assert.equal(envelope.assignment_id, 'assignment-one')
  // The store's typed classification is passed through untouched: this module
  // observes the lane, it never re-classifies the run.
  assert.equal(envelope.store.classification, 'healthy_progress')
  assert.equal(envelope.lane.state, 'open')
  assert.equal(envelope.lane.turn_phase, 'working')
  assert.equal(envelope.lane.child_activity, 'running')
  assert.equal(envelope.lane.child_session_id, 'child-1')

  const lost = supervisionEnvelope({
    assignmentId: 'assignment-one',
    store: { schema_version: 'main-agent.worker-supervise-result.v2', classification: 'evidence_unavailable' },
    lane: undefined,
    childActivity: undefined,
  })
  assert.equal(lost.lane, null, 'a lane this runtime never launched is absent, not fabricated')
})
