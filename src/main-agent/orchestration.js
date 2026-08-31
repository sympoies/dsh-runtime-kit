// @ts-check

/**
 * Orchestration surfaces that sit on top of the lane transport: the worker
 * checkpoint write, the supervision fold, and the review-loop and closeout
 * payload shapes.
 *
 * Everything here is a pure shape or a bounded filesystem write. The durable
 * decisions — revisions, receipts, classifications — stay in the nils-cli
 * `main-agent` store; this module only builds the inputs it accepts and folds
 * what the lane transport can observe on top of what the store already said.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** The nils-cli checkpoint input contract `main-agent checkpoint --file` reads. */
export const CHECKPOINT_INPUT_SCHEMA = 'main-agent.checkpoint-input.v1'
export const SUPERVISION_SCHEMA = 'dsh-runtime-kit.main-agent-supervision.v2'
export const REVIEW_SCHEMA = 'dsh-runtime-kit.main-agent-review.v2'
export const CLOSEOUT_SCHEMA = 'dsh-runtime-kit.main-agent-closeout.v2'

/**
 * Assignment states a worker may declare on its own checkpoint. The store owns
 * the transition rules; this list only keeps an invented state from reaching
 * the CLI as an opaque string.
 */
const CHECKPOINT_STATES = Object.freeze(['working', 'blocked', 'submitted'])

/** Bounded so one lane cannot write an unbounded private file. */
const MAX_SUMMARY_BYTES = 2000

/** @param {string} code @param {unknown} [details] */
function orchestrationError(code, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  return new Error(`dsh-runtime-kit:${code}${suffix}`)
}

/**
 * One durable summary line. The CLI validates these too, but a multi-line or
 * control-bearing value must never reach a private file this module writes: it
 * would turn a bounded field into a payload the store has to defend against.
 *
 * @param {unknown} value
 */
function validSummary(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_SUMMARY_BYTES
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 0x20 || codePoint === 0x7f
    })
}

/**
 * Build the checkpoint input document a worker's fenced checkpoint writes.
 * Optional fields are omitted rather than nulled, because the CLI validates
 * every present summary and a null fails closed as invalid input.
 *
 * @param {{
 *   summary: string,
 *   nextAction: string,
 *   state?: string,
 *   resultSummary?: string,
 *   blockerSummary?: string,
 * }} fields
 */
export function checkpointDocument(fields) {
  if (fields === null || typeof fields !== 'object') {
    throw orchestrationError('main-agent-checkpoint-invalid')
  }
  if (!validSummary(fields.summary) || !validSummary(fields.nextAction)) {
    throw orchestrationError('main-agent-checkpoint-invalid')
  }
  if (fields.state !== undefined && !CHECKPOINT_STATES.includes(fields.state)) {
    throw orchestrationError('main-agent-checkpoint-invalid', { state: fields.state })
  }
  for (const optional of [fields.resultSummary, fields.blockerSummary]) {
    if (optional !== undefined && !validSummary(optional)) {
      throw orchestrationError('main-agent-checkpoint-invalid')
    }
  }
  return {
    schema_version: CHECKPOINT_INPUT_SCHEMA,
    summary: fields.summary,
    next_action: fields.nextAction,
    ...fields.state === undefined ? {} : { state: fields.state },
    ...fields.resultSummary === undefined ? {} : { result_summary: fields.resultSummary },
    ...fields.blockerSummary === undefined ? {} : { blocker_summary: fields.blockerSummary },
  }
}

/**
 * Write one private JSON document the nils CLI will read as an authenticated
 * input: owner-only mode, atomically renamed inside a directory whose real
 * path is verified, so a symlinked component cannot redirect the write.
 *
 * @param {string} target absolute destination path
 * @param {unknown} document
 */
export async function writePrivateJson(target, document) {
  if (typeof target !== 'string' || !isAbsolute(target)) {
    throw orchestrationError('main-agent-private-write-failed')
  }
  const directory = dirname(target)
  let realDirectory
  try {
    realDirectory = await realpath(directory)
  } catch {
    throw orchestrationError('main-agent-private-write-failed')
  }
  if (realDirectory !== resolve(directory)) {
    throw orchestrationError('main-agent-private-write-failed')
  }
  const temporary = join(realDirectory, `.main-agent-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  } catch {
    await unlink(temporary).catch(() => {})
    throw orchestrationError('main-agent-private-write-failed')
  }
}

/**
 * Fold `subagents.listChildren()` rows into this lane's child activity.
 *
 * The listing's own vocabulary is preserved: `running` means the record is
 * live in the session store, `inactive` means it exists only in persistence.
 * A diagnostic row means the listing could not classify the candidate, and an
 * absent row means the creation window or a drained child — neither is
 * evidence of a live turn, so both report `unknown` with the reason instead of
 * resolving to a liveness claim this module cannot support.
 *
 * @param {readonly Record<string, any>[]} entries
 * @param {string} childId
 */
export function laneChildActivity(entries, childId) {
  const rows = Array.isArray(entries) ? entries : []
  const match = rows.find(entry => entry?.id === childId)
  if (match === undefined) return { activity: 'unknown', diagnostic: 'unlisted' }
  if (match.kind === 'diagnostic') {
    return {
      activity: 'unknown',
      diagnostic: typeof match.reason === 'string' ? match.reason : 'unclassified',
    }
  }
  if (match.kind !== 'child' || (match.activity !== 'running' && match.activity !== 'inactive')) {
    return { activity: 'unknown', diagnostic: 'unclassified' }
  }
  return {
    activity: match.activity,
    mode: match.mode,
    ...typeof match.label === 'string' ? { label: match.label } : {},
  }
}

/**
 * Compose the store's typed supervision result with what the lane transport
 * can observe. The store's classification and next action pass through
 * untouched — this runtime observes lanes, it never re-classifies a run — and
 * lane facts stay in their own object so a consumer can never mistake
 * transport observation for durable store truth.
 *
 * @param {{
 *   assignmentId: string,
 *   store: Record<string, any>,
 *   lane: Record<string, any> | undefined,
 *   childActivity: Record<string, any> | undefined,
 * }} input
 */
export function supervisionEnvelope(input) {
  const lane = input.lane === undefined ? null : {
    worker_session_id: input.lane.workerSessionId,
    launch_id: input.lane.launchId,
    child_session_id: input.lane.childId,
    state: input.lane.state,
    turn_phase: input.lane.turn?.phase ?? null,
    turn_changed_at: input.lane.turn?.phaseChangedAt ?? null,
    last_turn_outcome: input.lane.turn?.lastTurn?.outcome ?? null,
    child_activity: input.childActivity?.activity ?? 'unknown',
    child_activity_diagnostic: input.childActivity?.diagnostic ?? null,
  }
  return {
    schema_version: SUPERVISION_SCHEMA,
    assignment_id: input.assignmentId,
    store: input.store,
    lane,
  }
}
