// @ts-check

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export const LIVENESS_SCHEMA = 'main-agent.dsh-runtime-liveness.v1'

/**
 * @typedef LaneTurnEvidence
 * @property {'working' | 'waiting'} phase
 * @property {string} phaseChangedAt
 * @property {{ startedAt: string, lastProgressAt?: string } | undefined} currentTurn
 * @property {{ completedAt: string, outcome: string } | undefined} lastTurn
 */

/**
 * @typedef Lane
 * @property {string} assignmentId
 * @property {string} workerSessionId
 * @property {string} launchId
 * @property {string} livenessFile
 * @property {string} childId
 * @property {string} anchorId
 * @property {'open' | 'terminated'} state
 * @property {LaneTurnEvidence | undefined} turn
 * @property {Readonly<Record<string, string>>} workerEnv
 * @property {readonly string[]} brokerStopArgv
 * @property {(() => void) | undefined} stopHeartbeat
 */

/**
 * The DSH harness process identity written into every lane sidecar. The
 * `start_time` starttime-ticks pin lets the nils CLI prove pid reuse; it is
 * Linux-only and omitted where `/proc` is unavailable.
 */
export function harnessIdentity() {
  /** @type {{ pid: number, start_time?: number }} */
  const identity = { pid: process.pid }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
      const afterComm = stat.slice(stat.lastIndexOf(')') + 1)
      const startTime = Number(afterComm.trim().split(/\s+/)[19])
      if (Number.isSafeInteger(startTime) && startTime > 0) identity.start_time = startTime
    } catch {
      // The pid-only identity still proves liveness; reuse detection degrades.
    }
  }
  return identity
}

/**
 * Durable-enough per-lane bookkeeping for one harness process lifetime. The
 * nils-cli orchestration store remains the source of truth for run state;
 * this registry only binds live children, anchors, heartbeats, and sidecars.
 */
export function createLaneRegistry() {
  /** @type {Map<string, Lane>} */
  const byAssignment = new Map()
  /** @type {Map<string, Lane>} */
  const byChild = new Map()
  return Object.freeze({
    /** @param {Lane} lane */
    add(lane) {
      byAssignment.set(lane.assignmentId, lane)
      byChild.set(lane.childId, lane)
    },
    /** @param {string} assignmentId */
    byAssignment(assignmentId) {
      return byAssignment.get(assignmentId)
    },
    /** @param {string} childId */
    byChild(childId) {
      return byChild.get(childId)
    },
    /** @param {Lane} lane */
    remove(lane) {
      byAssignment.delete(lane.assignmentId)
      byChild.delete(lane.childId)
    },
    list() {
      return [...byAssignment.values()]
    },
    get size() {
      return byAssignment.size
    },
  })
}

/**
 * Atomically publish the lane's liveness sidecar. The nils CLI reads this
 * file to answer `session_status` and durable runtime evidence for the lane,
 * so a torn write must never be observable: write a same-directory temp file
 * first and rename it into place.
 *
 * @param {Lane} lane
 */
export async function writeLivenessSidecar(lane) {
  if (!isAbsolute(lane.livenessFile)) {
    throw new Error('dsh-runtime-kit: lane liveness path must be absolute')
  }
  const document = {
    schema_version: LIVENESS_SCHEMA,
    launch_id: lane.launchId,
    harness: harnessIdentity(),
    lane: { state: lane.state },
    ...lane.turn === undefined ? {} : {
      turn: {
        phase: lane.turn.phase,
        phase_changed_at: lane.turn.phaseChangedAt,
        ...lane.turn.currentTurn === undefined ? {} : {
          current_turn: {
            started_at: lane.turn.currentTurn.startedAt,
            ...lane.turn.currentTurn.lastProgressAt === undefined ? {} : {
              last_progress_at: lane.turn.currentTurn.lastProgressAt,
            },
          },
        },
        ...lane.turn.lastTurn === undefined ? {} : {
          last_turn: {
            completed_at: lane.turn.lastTurn.completedAt,
            outcome: lane.turn.lastTurn.outcome,
          },
        },
      },
    },
    updated_at: String(Math.floor(Date.now() / 1000)),
  }
  const directory = dirname(lane.livenessFile)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.dsh-runtime-liveness-${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  await rename(temporary, lane.livenessFile)
}
