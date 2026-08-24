// @ts-check

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  dshRc7AgentRoute,
  dshRc7RunInfo,
  dshRc7SessionHeader,
} from '../compat/dsh-rc7.js'
import { createCliClient } from './cli-client.js'
import { LIVENESS_SCHEMA, createLaneRegistry, publishLivenessSidecar } from './lanes.js'
import {
  CLOSEOUT_SCHEMA,
  REVIEW_SCHEMA,
  checkpointDocument,
  laneChildActivity,
  supervisionEnvelope,
  writePrivateJson,
} from './orchestration.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-subagent').SubagentRuntime} SubagentRuntime */
/** @typedef {import('./lanes.js').Lane} Lane */

const WORKER_START_RESULT_SCHEMA = 'main-agent.worker-start-result.v1'
const EXTERNAL_LAUNCH_SCHEMA = 'main-agent.external-launch.v1'
const CAPABILITIES_SCHEMA = 'main-agent.capabilities.v1'
const READINESS_SCHEMA = 'main-agent.runtime-readiness.v1'
const EXTERNAL_RUNTIME_CAPABILITY = 'main-agent.external-runtime.v1'
const DEFAULT_WORKER_SUBAGENT_PROVIDER = 'spawn'
const LANE_SECTION_ORDER = 118
const DEFAULT_MAX_LANES = 8
const HARD_MAX_LANES = 64
const DEFAULT_BROKER_READY_TIMEOUT_MS = 15_000
const HARD_BROKER_READY_TIMEOUT_MS = 60_000
const BROKER_READY_POLL_MS = 100
const BROKER_STATUS_SCHEMA = 'agent-session.coordination-broker.v1'

/**
 * Bundle-owned global tools hidden from a managed worker lane. rc.7 validates
 * visibility filters against the exact global registry, so this list contains
 * only tools this bundle guarantees it registered before launch.
 */
const DEFAULT_LANE_VISIBILITY_DENIED_TOOLS = Object.freeze([
  'main_agent_run_initialize',
  'main_agent_worker_launch',
  'main_agent_worker_interrupt',
  'main_agent_lane_close',
  'main_agent_worker_supervise',
  'main_agent_worker_request_changes',
  'main_agent_worker_accept',
  'main_agent_run_closeout',
])

/**
 * Tools a managed worker lane must never execute. The monotonic child guard
 * retains legacy and cross-product names even when they are absent from the
 * current global registry, so a later registration cannot grant authority.
 */
const DEFAULT_LANE_DENIED_TOOLS = Object.freeze([
  'subagent',
  'send_message',
  'list_agents',
  'workflow',
  ...DEFAULT_LANE_VISIBILITY_DENIED_TOOLS,
])

/**
 * The one orchestration tool a lane child owns: its own fenced checkpoint. It
 * is registered per child inside that child's context, never globally, so no
 * other session can reach another lane's checkpoint authority.
 */
const LANE_CHECKPOINT_TOOL = 'main_agent_checkpoint'
const LANE_BOOTSTRAP_TOOL = 'main_agent_bootstrap'
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/
const CONTROLLER_PRINCIPAL_ENV_KEYS = Object.freeze([
  'AGENT_SESSION_ID',
  'AGENT_SESSION_RUNTIME_ID',
  'AGENT_SESSION_STATE_DIR',
  'AGENT_SESSION_CAPABILITY_FILE',
  'AGENT_SESSION_CHECKPOINT_FILE',
  'AGENT_SESSION_BIN',
])

/** @param {string} code @param {unknown} [details] */
function laneError(code, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  return new Error(`dsh-runtime-kit:${code}${suffix}`)
}

/** @param {unknown} value @param {string} code */
function requireNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) throw laneError(code)
  return value
}

const LIVENESS_FILE_NAME = 'dsh-runtime-liveness.json'
const AGENT_SESSION_BASENAME = 'agent-session'
const WORKER_ENV_KEY = /^[A-Z][A-Z0-9_]*$/
/**
 * A session id names one path segment. Rejecting separators and dots here is
 * what makes the sidecar containment check a containment check: without it the
 * declared id can carry `..` and both sides of a derived-path comparison
 * normalize identically.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** @param {string} candidate @param {string} root */
function isProperDescendant(candidate, root) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate !== resolvedRoot
    && resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
}

/**
 * The sidecar must be the conventional file inside the session state
 * directory the payload declares, so a malformed or hostile envelope cannot
 * redirect the rename-publish onto an unrelated file. The declared session id
 * must be a single safe path segment, and the resolved target must be a proper
 * descendant of the resolved state directory — a derived-path equality alone
 * would accept a traversing id on both sides.
 *
 * @param {Record<string, any>} externalLaunch
 */
function containedLivenessFile(externalLaunch) {
  const stateDir = externalLaunch.worker_env?.AGENT_SESSION_STATE_DIR
  const sessionId = externalLaunch.worker_env?.AGENT_SESSION_ID
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return false
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false
  const expected = resolve(stateDir, 'sessions', sessionId, LIVENESS_FILE_NAME)
  return resolve(externalLaunch.liveness_file) === expected
    && isProperDescendant(expected, resolve(stateDir, 'sessions'))
}

/**
 * Worker environment values are replayed by the lane worker as a shell command
 * prefix, so they must be shell-safe as well as single-line: a space alone
 * breaks a legitimate path, and a metacharacter would inject a command. The
 * rendered section quotes every value too, but validation refuses rather than
 * relying on the renderer alone.
 *
 * @param {unknown} workerEnv
 */
function validWorkerEnv(workerEnv) {
  if (workerEnv === null || typeof workerEnv !== 'object' || Array.isArray(workerEnv)) return false
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (workerEnv))
  return entries.length > 0 && entries.every(([key, value]) => WORKER_ENV_KEY.test(key)
    && typeof value === 'string'
    && value.length > 0
    && [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      // Control characters, DEL, unicode line and bidi separators, and every
      // shell metacharacter (quotes, whitespace, expansion, redirection,
      // separators) are refused.
      if (codePoint < 0x20 || codePoint === 0x7f) return false
      if ([0x85, 0x2028, 0x2029].includes(codePoint)) return false
      if (codePoint >= 0x202a && codePoint <= 0x202e) return false
      if (codePoint >= 0x2066 && codePoint <= 0x2069) return false
      return /^[A-Za-z0-9_@%+=:,./~-]$/.test(character)
    }))
}

/** @param {unknown} prompt */
function bootstrapKeyFromPrompt(prompt) {
  if (typeof prompt !== 'string') return undefined
  const matches = [...prompt.matchAll(/--idempotency-key ([A-Za-z0-9._:-]{8,128}) --format json/g)]
  return matches.length === 1 ? matches[0][1] : undefined
}

/** @param {string} bootstrapKey */
function nativeBootstrapPrompt(bootstrapKey) {
  return 'Main Agent Mode is explicitly active for this managed worker assignment. '
    + `Call the native \`${LANE_BOOTSTRAP_TOOL}\` tool now with \`idempotency_key\` `
    + `set to \`${bootstrapKey}\`. Do not run the shell bootstrap command and do not `
    + 'perform any other action before the native tool succeeds; then follow the returned '
    + '`worker_instructions` and private assignment.'
}

/**
 * Map an rc.7 subagent stop reason onto the sidecar contract's documented
 * `completed | failed | interrupted` vocabulary. An unknown or absent reason
 * is never vouched as success.
 *
 * @param {unknown} stopReason
 */
function laneTurnOutcome(stopReason) {
  switch (stopReason) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return 'interrupted'
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return 'failed'
    default:
      return 'failed'
  }
}

/**
 * argv[0] is executed verbatim, so a basename match is not enough: any
 * writable directory could hold a file called `agent-session`, including a
 * lane's own worktree. Require the exact trusted binary path and the `broker`
 * verb.
 *
 * The verb is not at a fixed index: the producer emits global options first
 * (`--state-dir <path>`, and `--host <name>` where a host label applies), so
 * this walks past option/value pairs instead of indexing. Assuming index 1 is
 * what made a real payload look hostile.
 *
 * @param {readonly string[]} argv
 * @param {string} agentSessionCli
 */
function brokerArgvIsTrusted(argv, agentSessionCli) {
  const [command] = argv
  if (typeof command !== 'string' || command.length === 0) return false
  try {
    // Release managers commonly expose the configured executable through a
    // stable symlink while the sibling producer reports its canonical target.
    // Compare existing filesystem identities, not lexical spellings; the
    // producer path is what is executed after this check.
    if (realpathSync(command) !== realpathSync(agentSessionCli)) return false
  } catch {
    return false
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string' || token.length === 0) return false
    // Every global option this CLI accepts before a verb takes one value, so a
    // flag consumes the next token; the first bare token must be the verb.
    if (token.startsWith('-')) {
      if (token.includes('=')) continue
      index += 1
      continue
    }
    return token === 'broker'
  }
  return false
}

/** @param {Record<string, any>} externalLaunch @param {string} agentSessionCli */
function validExternalLaunch(externalLaunch, agentSessionCli) {
  return externalLaunch !== null
    && typeof externalLaunch === 'object'
    && externalLaunch.schema_version === EXTERNAL_LAUNCH_SCHEMA
    && typeof externalLaunch.launch_id === 'string'
    && externalLaunch.launch_id.length > 0
    && typeof externalLaunch.prompt === 'string'
    && externalLaunch.prompt.length > 0
    && bootstrapKeyFromPrompt(externalLaunch.prompt) !== undefined
    && externalLaunch.worker_env !== null
    && typeof externalLaunch.worker_env === 'object'
    && typeof externalLaunch.liveness_file === 'string'
    && isAbsolute(externalLaunch.liveness_file)
    // The sidecar is published by renaming over this path, so it must be the
    // conventional file inside the payload's own session state directory: an
    // envelope must never be able to name an arbitrary write target.
    && containedLivenessFile(externalLaunch)
    // The producer declares which sidecar schema it will read; refuse rather
    // than publish a document the CLI would reject as invalid evidence.
    && (externalLaunch.liveness_schema === undefined
      || externalLaunch.liveness_schema === LIVENESS_SCHEMA)
    && validWorkerEnv(externalLaunch.worker_env)
    && Array.isArray(externalLaunch.broker_heartbeat_argv)
    && externalLaunch.broker_heartbeat_argv.length > 0
    && externalLaunch.broker_heartbeat_argv.every(
      (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0,
    )
    && Array.isArray(externalLaunch.broker_stop_argv)
    && externalLaunch.broker_stop_argv.every(
      (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0,
    )
    // argv[0] is executed verbatim, so it must be the exact coordination
    // binary this module is contracted to run.
    && brokerArgvIsTrusted(externalLaunch.broker_heartbeat_argv, agentSessionCli)
    && (externalLaunch.broker_stop_argv.length === 0
      || brokerArgvIsTrusted(externalLaunch.broker_stop_argv, agentSessionCli))
}

/** @param {Lane} lane */
function laneEnvironmentSection(lane) {
  // Every value is shell-quoted and rendered on its own line inside a fenced
  // block: a value is a path, so an unquoted single-line prefix would break on
  // whitespace and would make any metacharacter executable.
  const rows = Object.entries(lane.workerEnv)
    .map(([key, value]) => `${key}='${value.replaceAll("'", `'\\''`)}'`)
    .join('\n')
  return [
    `You are the managed worker lane for assignment ${lane.assignmentId}.`,
    'The native lane tools already apply this authenticated session environment.',
    'For any other `main-agent` or `agent-session` shell command, prefix that',
    'same command with every assignment below (copy verbatim, no substitutions).',
    'A standalone export tool call does not persist into the next shell process:',
    '',
    '```sh',
    rows,
    '```',
    '',
    'Without this same-process environment the coordination CLI cannot authenticate you.',
    'Never invent, reorder, or omit any of these values.',
  ].join('\n')
}

/** @param {Lane} lane */
function laneSummary(lane) {
  return {
    schema_version: 'dsh-runtime-kit.main-agent-lane.v1',
    assignment_id: lane.assignmentId,
    worker_session_id: lane.workerSessionId,
    launch_id: lane.launchId,
    child_session_id: lane.childId,
    anchor_session_id: lane.anchorId,
    lane_state: lane.state,
  }
}

/** @param {Lane} lane @param {'launched' | 'reattached'} disposition */
function launchSummary(lane, disposition) {
  return { ...laneSummary(lane), disposition }
}

/**
 * Main Agent Mode orchestration for DSH: executes the external-launch
 * contract that `main-agent worker start --launch.agent dsh` returns, spawns
 * each lane as an in-process continuable child anchored to its own worktree
 * cwd, maintains the per-lane broker heartbeat and liveness sidecar, and
 * installs the per-child authority guard plus environment instructions.
 *
 * Contract: nils-cli `main-agent-dsh-external-runtime-v1.md`; tracking
 * sympoies/dsh-runtime-kit#6 (M2).
 *
 * @param {Context} ctx
 * @param {{
 *   mainAgentCli?: string,
 *   agentSessionCli?: string,
 *   laneWorktreeRoot?: string,
 *   workerSubagentProvider?: string,
 *   workerProvider?: string,
 *   workerModel?: string,
 *   laneDeniedTools?: readonly string[],
 *   maxLanes?: number,
 *   cliTimeoutMs?: number,
 *   cliTeardownTimeoutMs?: number,
 *   maxActiveCliCalls?: number,
 *   brokerReadyTimeoutMs?: number,
 *   managedSessionBridge?: {
 *     register?: (resolver:(id:string) => unknown) => (() => void),
 *     resolve?: (id:string) => unknown,
 *   },
 * }} [config]
 */
export function applyMainAgentMode(ctx, config = {}) {
  const mainAgentCli = typeof config.mainAgentCli === 'string' && config.mainAgentCli.length > 0
    ? config.mainAgentCli
    : 'main-agent'
  // The trusted coordination binary. Defaults to the sibling of an absolute
  // `mainAgentCli` (the released package ships them together) so the argv the
  // envelope proposes can be compared against a path this module chose.
  const agentSessionCli = typeof config.agentSessionCli === 'string'
    && config.agentSessionCli.length > 0
    ? config.agentSessionCli
    : isAbsolute(mainAgentCli)
      ? resolve(dirname(mainAgentCli), AGENT_SESSION_BASENAME)
      : AGENT_SESSION_BASENAME
  /**
   * Portable bundle configuration names the released CLI instead of pinning
   * one host path. Resolve that name through DSH's trusted host executable
   * seam before comparing it with producer-owned absolute argv/env values.
   *
   * @param {AbortSignal | undefined} signal
   */
  const resolveTrustedAgentSessionCli = async (signal) => {
    if (isAbsolute(agentSessionCli)) return agentSessionCli
    try {
      const executable = await ctx.subprocess.resolveExecutable(agentSessionCli, undefined, signal)
      return isAbsolute(executable) ? executable : undefined
    } catch {
      return undefined
    }
  }
  // When configured, every lane worktree must live under this root; the
  // worktree becomes the lane worker's shell workdir and sandbox root, so an
  // unconstrained value is a lane-isolation hole.
  const laneWorktreeRoot = typeof config.laneWorktreeRoot === 'string'
    && isAbsolute(config.laneWorktreeRoot)
    ? resolve(config.laneWorktreeRoot)
    : undefined
  const workerSubagentProvider = typeof config.workerSubagentProvider === 'string'
    && config.workerSubagentProvider.length > 0
    ? config.workerSubagentProvider
    : DEFAULT_WORKER_SUBAGENT_PROVIDER
  // Deny sets are monotonic: configuration extends the mandatory core, it can
  // never remove a tool a managed lane must not reach.
  const laneDeniedTools = new Set([
    ...DEFAULT_LANE_DENIED_TOOLS,
    ...Array.isArray(config.laneDeniedTools)
      ? config.laneDeniedTools.filter(name => typeof name === 'string' && name.length > 0)
      : [],
  ])
  const maxLanes = typeof config.maxLanes === 'number'
    && Number.isInteger(config.maxLanes)
    && config.maxLanes > 0
    ? Math.min(config.maxLanes, HARD_MAX_LANES)
    : DEFAULT_MAX_LANES
  const brokerReadyTimeoutMs = typeof config.brokerReadyTimeoutMs === 'number'
    && Number.isInteger(config.brokerReadyTimeoutMs)
    && config.brokerReadyTimeoutMs > 0
    ? Math.min(config.brokerReadyTimeoutMs, HARD_BROKER_READY_TIMEOUT_MS)
    : DEFAULT_BROKER_READY_TIMEOUT_MS
  const client = createCliClient(ctx, config)
  const lanes = createLaneRegistry()
  /** @type {Map<string, Readonly<{sessionId: string, environment: Readonly<Record<string, string>>}>>} */
  const controllers = new Map()
  /** @type {Map<string, Promise<Readonly<{sessionId: string, environment: Readonly<Record<string, string>>}>>>} */
  const authenticatingControllers = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const launching = new Map()
  // Run boundaries published before `startContinuable` resolves cannot be
  // matched yet (rc.7 emits the first start edge during materialization), so
  // they are buffered and replayed once the lane binds its child id.
  /** @type {Array<{ kind: 'start' | 'end', payload: Record<string, any> }>} */
  const pendingRunEvents = []
  const MAX_PENDING_RUN_EVENTS = 64
  // Capacity is reserved across the launch awaits so concurrent launches of
  // distinct assignments cannot all pass a stale registry-size check.
  let reservedLanes = 0
  let closing = false

  /** @param {string} sessionId */
  const resolveSessionPrincipal = sessionId => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const controller = controllers.get(sessionId)
    if (controller !== undefined) return controller
    const lane = lanes.byMember(sessionId) ?? lanes.byChild(sessionId)
    if (lane === undefined || lane.state !== 'open') return undefined
    return Object.freeze({
      sessionId: lane.workerSessionId,
      environment: Object.freeze({ ...lane.workerEnv }),
    })
  }
  const disposeSessionBridge = config.managedSessionBridge?.register?.(resolveSessionPrincipal)

  /**
   * Agent Console injects one capability-bearing managed-session principal
   * into the top-level DSH process. Authenticate it before the first policy
   * lifecycle request so an ordinary single-agent session is not forced to
   * initialize an unrelated Main Agent run merely to use shell, context, and
   * finish-line capabilities. No ambient field is restored until the
   * producer-owned self-readiness command proves the exact id, incarnation,
   * checkpoint, and trusted helper path.
   *
   * @param {string} controllerSessionId
   * @param {any} exec
   */
  const authenticateManagedController = async (controllerSessionId, exec) => {
    const bound = controllers.get(controllerSessionId)
    if (bound !== undefined) return bound
    const pending = authenticatingControllers.get(controllerSessionId)
    if (pending !== undefined) return pending
    const authentication = (async () => {
      const readiness = await runEnvelope([
        mainAgentCli,
        'self',
        'readiness',
        '--format',
        'json',
      ], exec, controllerCwd(exec))
      if (readiness?.schema_version !== READINESS_SCHEMA || readiness.ready !== true) {
        throw laneError('main-agent-controller-not-ready')
      }
      const principal = await controllerPrincipal(readiness, exec.signal)
      const existing = controllers.get(controllerSessionId)
      if (existing !== undefined && !sameControllerPrincipal(existing, principal)) {
        throw laneError('main-agent-controller-binding-conflict')
      }
      controllers.set(controllerSessionId, principal)
      return principal
    })()
    authenticatingControllers.set(controllerSessionId, authentication)
    try {
      return await authentication
    } finally {
      if (authenticatingControllers.get(controllerSessionId) === authentication) {
        authenticatingControllers.delete(controllerSessionId)
      }
    }
  }

  ctx.effect(() => () => {
    closing = true
    // A fiber teardown or plugin reload leaves the process alive, so the
    // pinned harness identity would keep vouching for every `open` lane and
    // the CLI could never classify a stop. Mark each lane terminated and
    // publish best effort before dropping the bookkeeping, and release the
    // heartbeats explicitly rather than relying on ctx ownership alone.
    for (const lane of lanes.list()) {
      lane.state = 'terminated'
      lane.turn = undefined
      void publishLivenessSidecar(lane).catch(() => {})
      lane.stopHeartbeat?.()
      lane.disposeAnchor?.()
    }
    pendingRunEvents.length = 0
    authenticatingControllers.clear()
    controllers.clear()
    lanes.clear()
    if (typeof disposeSessionBridge === 'function') disposeSessionBridge()
  }, 'dsh-runtime-kit main-agent lanes')

  /**
   * Serialize the launch critical section per assignment: concurrent
   * launches of the same assignment (parallel tool calls, retries) queue
   * behind one another instead of racing the registry check, so at most one
   * anchor, heartbeat, and child ever exist per lane.
   *
   * @template T
   * @param {string} assignmentId
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  const withLaunchLock = (assignmentId, run) => {
    const previous = launching.get(assignmentId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    const tail = next.then(() => {}, () => {})
    launching.set(assignmentId, tail)
    void tail.then(() => {
      if (launching.get(assignmentId) === tail) launching.delete(assignmentId)
    })
    return next
  }

  // Anchor agents exist only to carry a lane's worktree cwd and lineage; they
  // must never spend model turns on settlement notices.
  ctx.on('agent/pre-step', async (payload, next) => {
    const { id: sessionId, parentSession } = dshRc7SessionHeader(payload?.agent)
    if (typeof sessionId === 'string' && lanes.byAnchor(sessionId) !== undefined) {
      return {
        kind: /** @type {const} */ ('reject'),
        reason: 'dsh-runtime-kit:main-agent-anchor-parked',
      }
    }
    const hasManagedSessionCandidate = CONTROLLER_PRINCIPAL_ENV_KEYS.some(
      name => typeof process.env[name] === 'string' && process.env[name].length > 0,
    )
    if (typeof sessionId === 'string'
      && sessionId.length > 0
      && (typeof parentSession !== 'string' || parentSession.length === 0)
      && hasManagedSessionCandidate
      && config.managedSessionBridge?.resolve?.(sessionId) === undefined) {
      try {
        await authenticateManagedController(sessionId, payload)
      } catch {
        return {
          kind: /** @type {const} */ ('reject'),
          reason: 'dsh-runtime-kit:managed-controller-authentication-failed',
        }
      }
    }
    return next()
  })

  // Lane turn evidence: fold child run boundaries into the sidecar. The
  // evidence is optional in the CLI contract, so unknown payload shapes stay
  // silent rather than guessing.
  /**
   * rc.7 publishes the child session id as `id` on SubagentRunInfo and
   * SubagentRunEndInfo; that is the contract field, not a defensive guess.
   *
   * @param {unknown} payload
   */
  const laneForRunPayload = (payload) => {
    const candidate = dshRc7RunInfo(payload).id
    return typeof candidate === 'string' ? lanes.byChild(candidate) : undefined
  }
  const nowEpoch = () => String(Math.floor(Date.now() / 1000))

  /** @param {unknown} payload @returns {Record<string, any> | undefined} */
  const runEventRecord = (payload) => {
    const info = dshRc7RunInfo(payload)
    return info.id === undefined ? undefined : info
  }

  /** @param {Lane} lane */
  const applyRunStart = (lane) => {
    if (lane.state !== 'open') return
    lane.turn = {
      phase: 'working',
      phaseChangedAt: nowEpoch(),
      currentTurn: { startedAt: nowEpoch() },
      lastTurn: lane.turn?.lastTurn,
    }
    void publishLivenessSidecar(lane).catch(() => {})
  }

  /** @param {Lane} lane @param {Record<string, any>} record */
  const applyRunEnd = (lane, record) => {
    if (lane.state !== 'open') return
    lane.turn = {
      phase: 'waiting',
      phaseChangedAt: nowEpoch(),
      currentTurn: undefined,
      lastTurn: {
        completedAt: nowEpoch(),
        outcome: laneTurnOutcome(dshRc7RunInfo(record).stopReason),
      },
    }
    void publishLivenessSidecar(lane).catch(() => {})
  }

  /**
   * Replay the run boundaries that arrived while this lane was still binding
   * its child id, so a lane whose first turn settled before `startContinuable`
   * resolved never advertises a turn that is already over.
   *
   * @param {Lane} lane
   */
  const replayPendingRunEvents = (lane) => {
    const mine = pendingRunEvents.filter(event => event.payload.id === lane.childId)
    if (mine.length === 0) return
    for (let index = pendingRunEvents.length - 1; index >= 0; index -= 1) {
      if (pendingRunEvents[index].payload.id === lane.childId) pendingRunEvents.splice(index, 1)
    }
    for (const event of mine) {
      if (event.kind === 'start') applyRunStart(lane)
      else applyRunEnd(lane, event.payload)
    }
  }

  /** @param {'start' | 'end'} kind @param {Record<string, any>} record */
  const bufferRunEvent = (kind, record) => {
    if (typeof record.id !== 'string' || record.id.length === 0) return
    if (pendingRunEvents.length >= MAX_PENDING_RUN_EVENTS) pendingRunEvents.shift()
    pendingRunEvents.push({ kind, payload: record })
  }

  ctx.on('subagent/start', (payload) => {
    const record = runEventRecord(payload)
    if (record === undefined) return
    const lane = laneForRunPayload(payload)
    if (lane === undefined) {
      bufferRunEvent('start', record)
      return
    }
    applyRunStart(lane)
  })
  ctx.on('subagent/end', (payload) => {
    const record = runEventRecord(payload)
    if (record === undefined) return
    const lane = laneForRunPayload(payload)
    if (lane === undefined) {
      bufferRunEvent('end', record)
      return
    }
    applyRunEnd(lane, record)
  })

  // Per-child lane hardening: a monotonic deny-only guard (authority) plus the
  // environment instruction section (guidance). Applies only to children whose
  // parent is one of this registry's anchors.
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const agent = /** @type {any} */ (childCtx).agent
    const childHeader = dshRc7SessionHeader(agent)
    const parentSession = childHeader.parentSession
    // Lane membership is transitive: a child of an anchor, of a lane child, or
    // of any deeper lane descendant is inside that lane and gets the same
    // authority guard. Anything else is outside every lane.
    const lane = typeof parentSession === 'string'
      ? lanes.byAnchor(parentSession) ?? lanes.byMember(parentSession)
      : undefined
    if (lane === undefined) return () => {}
    const childSession = childHeader.id
    if (typeof childSession === 'string' && childSession.length > 0) {
      lanes.bindMember(childSession, lane)
    }
    /** @type {Array<() => void>} */
    const disposers = []
    if (typeof childSession === 'string' && childSession.length > 0) {
      disposers.push(() => { lanes.unbindMember(childSession) })
    }
    disposers.push(childCtx.tools.guard(
      (/** @type {{ name: string }} */ exec) => (laneDeniedTools.has(exec.name)
        ? 'dsh-runtime-kit:main-agent-lane-tool-denied'
        : undefined),
    ))
    // The checkpoint tool is scoped to this child's context, so a lane can only
    // ever checkpoint its own assignment: there is no argument through which it
    // could name another lane.
    const checkpointFile = laneCheckpointFile(lane)
    if (typeof childCtx.tools.register === 'function') {
      const disposeBootstrap = childCtx.tools.register(
        Object.freeze(laneBootstrapTool(lane)),
      )
      if (typeof disposeBootstrap === 'function') disposers.push(disposeBootstrap)
    }
    if (checkpointFile !== undefined && typeof childCtx.tools.register === 'function') {
      const disposeCheckpoint = childCtx.tools.register(
        Object.freeze(laneCheckpointTool(lane, checkpointFile)),
      )
      if (typeof disposeCheckpoint === 'function') disposers.push(disposeCheckpoint)
    }
    const systemPrompt = /** @type {any} */ (childCtx).systemPrompt
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      const disposeSection = systemPrompt.section({
        name: 'dsh-runtime-kit:main-agent-lane',
        order: LANE_SECTION_ORDER,
        text: laneEnvironmentSection(lane),
      })
      if (typeof disposeSection === 'function') disposers.push(disposeSection)
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })

  /** @param {any} exec */
  const controllerCwd = (exec) => {
    const cwd = dshRc7SessionHeader(exec?.agent).cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw laneError('main-agent-controller-cwd-unavailable')
    }
    return cwd
  }

  /**
   * Resolve the route a new lane anchor inherits from its controller. Keeping
   * this as the service's read-only route observation and the launch path's
   * single source prevents compatibility evidence from reimplementing the
   * worker-provider/model fallback.
   *
   * @param {any} controllerAgent
   */
  const workerRoute = (controllerAgent) => {
    const controllerRoute = dshRc7AgentRoute(controllerAgent)
    const provider = config.workerProvider ?? controllerRoute.provider
    const model = config.workerModel ?? controllerRoute.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw laneError('main-agent-worker-route-unavailable')
    }
    const inheritsControllerRoute = provider === controllerRoute.provider
      && model === controllerRoute.model
    return Object.freeze({
      provider,
      model,
      ...inheritsControllerRoute && typeof controllerRoute.reasoningEffort === 'string'
        ? { reasoningEffort: controllerRoute.reasoningEffort }
        : {},
    })
  }

  /**
   * Lane management is a controller-only surface. Tool visibility is not
   * authority, so refuse any caller that is one of this registry's anchors or
   * lane children rather than relying on the per-child deny filter alone.
   *
   * @param {any} exec
   */
  const requireControllerCaller = (exec) => {
    const header = dshRc7SessionHeader(exec?.agent)
    const sessionId = header.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw laneError('main-agent-controller-identity-unavailable')
    }
    const parentSession = header.parentSession
    const insideALane = lanes.byAnchor(sessionId) !== undefined
      || lanes.byMember(sessionId) !== undefined
      || lanes.byChild(sessionId) !== undefined
      || (typeof parentSession === 'string'
        && (lanes.byAnchor(parentSession) !== undefined
          || lanes.byMember(parentSession) !== undefined
          || lanes.byChild(parentSession) !== undefined))
    if (insideALane) {
      throw laneError('main-agent-lane-caller-denied', { session_id: sessionId })
    }
  }

  /**
   * Run initialization authenticates the one top-level DSH controller. A
   * foreign subagent outside a managed lane must not be able to bind the
   * process-wide controller principal merely because it is not in the lane
   * registry yet.
   *
   * @param {any} exec
   * @returns {string}
   */
  const requireTopLevelControllerCaller = (exec) => {
    requireControllerCaller(exec)
    const header = dshRc7SessionHeader(exec?.agent)
    if (typeof header.parentSession === 'string' && header.parentSession.length > 0) {
      throw laneError('main-agent-controller-top-level-required')
    }
    return /** @type {string} */ (header.id)
  }

  /**
   * Rehydrate only the private session fields the hook admission layer owns.
   * Readiness independently authenticates the session id, incarnation, and
   * checkpoint; no provider tokens or arbitrary process environment cross the
   * bridge.
   *
   * @param {Record<string, any>} readiness
   * @param {AbortSignal | undefined} signal
   */
  const controllerPrincipal = async (readiness, signal) => {
    /** @type {Record<string, string>} */
    const environment = {}
    for (const name of CONTROLLER_PRINCIPAL_ENV_KEYS) {
      const value = process.env[name]
      if (typeof value !== 'string' || value.length === 0) {
        throw laneError('main-agent-controller-principal-unavailable')
      }
      environment[name] = value
    }
    let helperMatches = false
    try {
      const trustedAgentSessionCli = await resolveTrustedAgentSessionCli(signal)
      helperMatches = trustedAgentSessionCli !== undefined
        && realpathSync(environment.AGENT_SESSION_BIN) === realpathSync(trustedAgentSessionCli)
    } catch {
      helperMatches = false
    }
    if (readiness.session_id !== environment.AGENT_SESSION_ID
      || readiness.session_incarnation !== environment.AGENT_SESSION_RUNTIME_ID
      || readiness.checkpoint_file !== environment.AGENT_SESSION_CHECKPOINT_FILE) {
      throw laneError('main-agent-controller-principal-mismatch')
    }
    if (!SESSION_ID.test(environment.AGENT_SESSION_ID)
      || !isAbsolute(environment.AGENT_SESSION_STATE_DIR)
      || !isAbsolute(environment.AGENT_SESSION_CAPABILITY_FILE)
      || !isAbsolute(environment.AGENT_SESSION_CHECKPOINT_FILE)
      || !isAbsolute(environment.AGENT_SESSION_BIN)
      || !helperMatches) {
      throw laneError('main-agent-controller-principal-invalid')
    }
    return Object.freeze({
      sessionId: environment.AGENT_SESSION_ID,
      environment: Object.freeze(environment),
    })
  }

  /**
   * @param {Readonly<{sessionId: string, environment: Readonly<Record<string, string>>}>} left
   * @param {Readonly<{sessionId: string, environment: Readonly<Record<string, string>>}>} right
   */
  const sameControllerPrincipal = (left, right) => left.sessionId === right.sessionId
    && CONTROLLER_PRINCIPAL_ENV_KEYS.every(name => left.environment[name] === right.environment[name])

  /**
   * The lane's declared checkpoint file, or undefined when the launch payload
   * did not name one inside this lane's own coordination directory. A lane
   * without a contained checkpoint path gets no checkpoint tool at all: it is
   * better for the worker to fall back to its documented CLI call than for
   * this runtime to write to a path it cannot prove belongs to the lane.
   *
   * @param {Lane} lane
   */
  const laneCheckpointFile = (lane) => {
    const declared = lane.workerEnv.AGENT_SESSION_CHECKPOINT_FILE
    const stateDir = lane.workerEnv.AGENT_SESSION_STATE_DIR
    const sessionId = lane.workerEnv.AGENT_SESSION_ID
    if (typeof declared !== 'string' || !isAbsolute(declared)) return undefined
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return undefined
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined
    const coordination = resolve(stateDir, 'sessions', sessionId, 'coordination')
    return isProperDescendant(resolve(declared), coordination) ? resolve(declared) : undefined
  }

  /**
   * The lane child's own fenced checkpoint, as a native tool.
   *
   * The worker used to write this private file itself — through a file tool in
   * one composition and a shell `printf` in another — and a hook had to admit
   * exactly one path to keep that write honest. Registering the write here
   * removes both: the tool owns the path, the mode, and the CLI invocation,
   * and the worker only supplies the fields the store validates.
   *
   * @param {Lane} lane
   * @param {string} checkpointFile
   * @returns {ToolDefinition}
   */
  const laneCheckpointTool = (lane, checkpointFile) => ({
    name: LANE_CHECKPOINT_TOOL,
    description: 'Record this worker lane\'s revision-fenced Main Agent checkpoint. '
      + 'Supply the current assignment revision; a stale revision fails closed and '
      + 'reports the current one.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line durable summary of what changed.' },
        next_action: { type: 'string', description: 'One-line next action for this assignment.' },
        state: {
          type: 'string',
          enum: ['working', 'blocked', 'submitted'],
          description: 'Assignment state this checkpoint declares.',
        },
        result_summary: { type: 'string', description: 'One-line result summary when submitting.' },
        blocker_summary: { type: 'string', description: 'One-line blocker summary when blocked.' },
        if_revision: { type: 'integer', minimum: 0, description: 'Expected current assignment revision.' },
        idempotency_key: { type: 'string', description: 'Stable key for this checkpoint write.' },
      },
      required: ['summary', 'next_action', 'if_revision', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      const record = /** @type {Record<string, unknown>} */ (args)
      if (lane.state !== 'open') {
        throw laneError('main-agent-lane-closed', { assignment_id: lane.assignmentId })
      }
      const ifRevision = record.if_revision
      if (typeof ifRevision !== 'number' || !Number.isInteger(ifRevision) || ifRevision < 0) {
        throw laneError('main-agent-revision-invalid')
      }
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      const document = checkpointDocument({
        summary: /** @type {string} */ (record.summary),
        nextAction: /** @type {string} */ (record.next_action),
        state: /** @type {string | undefined} */ (record.state),
        resultSummary: /** @type {string | undefined} */ (record.result_summary),
        blockerSummary: /** @type {string | undefined} */ (record.blocker_summary),
      })
      await writePrivateJson(checkpointFile, document)
      // The worker principal is established by its own environment, so the
      // call carries the lane's env and runs in the lane's worktree rather
      // than inheriting whatever the controller process happens to hold.
      return await runEnvelope([
        mainAgentCli,
        'checkpoint',
        '--file',
        checkpointFile,
        '--if-revision',
        String(ifRevision),
        '--idempotency-key',
        idempotencyKey,
        '--format',
        'json',
      ], exec, lane.worktree, lane.workerEnv)
    },
  })

  /**
   * Authenticate a DSH lane without asking a model shell subprocess to retain
   * process-local environment from an earlier export. The launch envelope is
   * the sole source of the worker principal and this tool is installed only in
   * descendants of that lane's anchor.
   *
   * @param {Lane} lane
   * @returns {ToolDefinition}
   */
  const laneBootstrapTool = lane => ({
    name: LANE_BOOTSTRAP_TOOL,
    description: 'Authenticate this managed worker lane and acquire its assignment claim. '
      + 'Use the exact idempotency key from the startup prompt.',
    parameters: {
      type: 'object',
      properties: {
        idempotency_key: {
          type: 'string',
          description: 'Exact runtime-issued bootstrap key from this lane startup prompt.',
        },
      },
      required: ['idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      if (lane.state !== 'open') {
        throw laneError('main-agent-lane-closed', { assignment_id: lane.assignmentId })
      }
      const key = requireNonEmptyString(
        /** @type {Record<string, unknown>} */ (args).idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      if (!IDEMPOTENCY_KEY.test(key)) throw laneError('main-agent-idempotency-key-invalid')
      return runEnvelope([
        mainAgentCli,
        'bootstrap',
        '--idempotency-key',
        key,
        '--format',
        'json',
      ], exec, lane.worktree, lane.workerEnv)
    },
  })

  /**
   * @param {readonly string[]} argv
   * @param {any} exec
   * @param {string} cwd
   * @param {Readonly<Record<string, string>>} [env]
   */
  const runEnvelope = async (argv, exec, cwd, env) => {
    const result = await client.run(argv, { cwd, signal: exec.signal, env })
    if (!result.ok) throw laneError('main-agent-cli-failed', { code: result.code })
    if (result.envelope.ok !== true) {
      throw laneError('main-agent-cli-refused', {
        code: result.envelope?.error?.code,
        message: result.envelope?.error?.message,
      })
    }
    return result.envelope.data
  }

  /** @type {ToolDefinition} */
  const initializeTool = {
    name: 'main_agent_run_initialize',
    description: 'Run the fixed DSH compatibility and authenticated controller-readiness '
      + 'gates, then initialize this controller\'s durable Main Agent run from one '
      + 'private objective packet. Use this native tool instead of a shell command.',
    parameters: {
      type: 'object',
      properties: {
        objective_file: {
          type: 'string',
          description: 'Absolute path to the private main-agent.objective-packet.v1 file.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Stable idempotency key for this run initialization.',
        },
      },
      required: ['objective_file', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      const controllerSessionId = requireTopLevelControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const objectiveFile = requireNonEmptyString(
        record.objective_file,
        'main-agent-objective-file-invalid',
      )
      if (!isAbsolute(objectiveFile)) throw laneError('main-agent-objective-file-invalid')
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw laneError('main-agent-idempotency-key-invalid')
      }
      const cwd = controllerCwd(exec)
      const capabilities = await runEnvelope([
        mainAgentCli,
        'capabilities',
        '--provider',
        'dsh',
        '--format',
        'json',
      ], exec, cwd)
      if (capabilities?.schema_version !== CAPABILITIES_SCHEMA
        || capabilities.compatible !== true
        || capabilities.capabilities?.external_runtime !== EXTERNAL_RUNTIME_CAPABILITY) {
        throw laneError('main-agent-capabilities-incompatible')
      }
      const readiness = await runEnvelope([
        mainAgentCli,
        'self',
        'readiness',
        '--format',
        'json',
      ], exec, cwd)
      if (readiness?.schema_version !== READINESS_SCHEMA || readiness.ready !== true) {
        throw laneError('main-agent-controller-not-ready')
      }
      const principal = await controllerPrincipal(readiness, exec.signal)
      const existingPrincipal = controllers.get(controllerSessionId)
      if (existingPrincipal !== undefined
        && !sameControllerPrincipal(existingPrincipal, principal)) {
        throw laneError('main-agent-controller-binding-conflict')
      }
      const initialized = await runEnvelope([
        mainAgentCli,
        'init',
        '--packet-file',
        objectiveFile,
        '--if-absent',
        '--idempotency-key',
        idempotencyKey,
        '--format',
        'json',
      ], exec, cwd)
      controllers.set(controllerSessionId, principal)
      return {
        ...initialized,
        readiness: {
          provider: 'dsh',
          compatible: true,
          controller_ready: true,
          external_runtime: EXTERNAL_RUNTIME_CAPABILITY,
        },
      }
    },
  }

  /**
   * A DSH worker start is intentionally launch-only store-side, so the lane
   * heartbeat owns the transition from a provisioned `starting` broker to an
   * authenticated `ready` broker. Do not expose the child until that exact
   * incarnation is usable: otherwise its first bootstrap/checkpoint can race
   * the heartbeat and fail `coordination-unauthorized` after launch reported
   * success.
   *
   * @param {Record<string, any>} externalLaunch
   * @param {any} exec
   * @param {string} cwd
   * @param {string} assignmentId
   */
  const waitForBrokerReady = async (externalLaunch, exec, cwd, assignmentId) => {
    const workerEnv = /** @type {Readonly<Record<string, string>>} */ (
      externalLaunch.worker_env
    )
    const stateDir = workerEnv.AGENT_SESSION_STATE_DIR
    const sessionId = workerEnv.AGENT_SESSION_ID
    const capabilityFile = workerEnv.AGENT_SESSION_CAPABILITY_FILE
    const statusArgv = [
      externalLaunch.broker_heartbeat_argv[0],
      '--state-dir',
      stateDir,
      'broker',
      'status',
      '--session',
      sessionId,
      '--capability-file',
      capabilityFile,
      '--authenticated',
      '--format',
      'json',
    ]
    const deadline = Date.now() + brokerReadyTimeoutMs
    let observedState = 'unavailable'
    for (;;) {
      const result = await client.run(statusArgv, {
        cwd,
        signal: exec.signal,
        env: workerEnv,
      })
      if (result.ok && result.envelope.ok === true) {
        const status = result.envelope.data
        observedState = typeof status?.state === 'string' ? status.state : 'invalid'
        if (status?.schema_version === BROKER_STATUS_SCHEMA
          && status.session_id === sessionId
          && status.state === 'ready'
          && status.capability_available === true
          && status.heartbeat_fresh === true) {
          return
        }
      }
      if (Date.now() >= deadline) {
        throw laneError('main-agent-broker-readiness-timeout', {
          assignment_id: assignmentId,
          observed_state: observedState,
        })
      }
      await delay(Math.min(BROKER_READY_POLL_MS, Math.max(1, deadline - Date.now())), undefined, {
        signal: exec.signal,
      })
    }
  }

  /** @type {ToolDefinition} */
  const launchTool = {
    name: 'main_agent_worker_launch',
    description: 'Start one managed Main Agent Mode worker lane: run the fenced '
      + 'main-agent worker start bookkeeping, spawn the lane child in its own '
      + 'worktree, start its broker heartbeat, and publish its liveness sidecar. '
      + 'Idempotent per assignment and idempotency key.',
    parameters: {
      type: 'object',
      properties: {
        assignment_file: {
          type: 'string',
          description: 'Absolute path of the private assignment-input JSON packet.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Stable idempotency key for this worker start.',
        },
      },
      required: ['assignment_file', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentFile = requireNonEmptyString(
        record.assignment_file,
        'main-agent-assignment-file-invalid',
      )
      if (!isAbsolute(assignmentFile)) throw laneError('main-agent-assignment-file-invalid')
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      const cwd = controllerCwd(exec)
      // The CLI call itself allocates a store-side worker incarnation and its
      // broker, so it belongs inside the lock: two concurrent launches of one
      // assignment would otherwise allocate two incarnations and abandon the
      // loser. The assignment file is the stable pre-call identity.
      return withLaunchLock(assignmentFile, async () => {
        if (closing) throw laneError('main-agent-mode-disposed')
        const data = await runEnvelope([
          mainAgentCli,
          'worker',
          'start',
          '--assignment-file',
          assignmentFile,
          '--await-ready',
          '0',
          '--idempotency-key',
          idempotencyKey,
          '--format',
          'json',
        ], exec, cwd)
        const trustedAgentSessionCli = await resolveTrustedAgentSessionCli(exec.signal)
        if (data?.schema_version !== WORKER_START_RESULT_SCHEMA
          || trustedAgentSessionCli === undefined
          || !validExternalLaunch(data.external_launch, trustedAgentSessionCli)) {
          throw laneError('main-agent-external-launch-invalid')
        }
        const externalLaunch = data.external_launch
        const assignmentId = requireNonEmptyString(
          data.assignment?.assignment_id,
          'main-agent-assignment-id-invalid',
        )
        const workerSessionId = requireNonEmptyString(
          data.worker?.session_id,
          'main-agent-worker-session-invalid',
        )

        /**
         * Release a store-side incarnation this runtime is refusing to adopt,
         * so a refused envelope never leaves a broker with no heartbeat, no
         * stop, and no lane.
         */
        const releaseRefusedIncarnation = async () => {
          const stopArgv = externalLaunch.broker_stop_argv
          if (!Array.isArray(stopArgv) || stopArgv.length === 0) return
          await client.run(stopArgv, { cwd, signal: exec.signal }).catch(() => undefined)
        }

        const existing = lanes.byAssignment(assignmentId)
        if (existing !== undefined) {
          if (existing.launchId !== externalLaunch.launch_id) {
            await releaseRefusedIncarnation()
            throw laneError('main-agent-lane-incarnation-conflict', {
              assignment_id: assignmentId,
            })
          }
          await publishLivenessSidecar(existing)
          return launchSummary(existing, 'reattached')
        }
        // One sidecar path and one worker session belong to exactly one lane:
        // sharing either would let one lane erase the other's evidence.
        const collision = lanes.byLivenessFile(externalLaunch.liveness_file)
          ?? lanes.byWorkerSession(workerSessionId)
        if (collision !== undefined) {
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-identity-conflict', {
            assignment_id: assignmentId,
            conflicting_assignment_id: collision.assignmentId,
          })
        }
        if (lanes.size + reservedLanes >= maxLanes) {
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-capacity', {
            assignment_id: assignmentId,
            max_lanes: maxLanes,
          })
        }
        // Hold the slot across every await below; the registry only counts it
        // once the lane is fully launched.
        reservedLanes += 1
        try {
          return await launchLane()
        } finally {
          reservedLanes -= 1
        }

        async function launchLane() {
        // The worktree becomes the lane worker's shell workdir and sandbox
        // root, so it is validated like every other envelope-supplied path:
        // it must be a real existing directory, and when a lane worktree root
        // is configured it must live under it. Never silently fall back to the
        // controller checkout — that would hand the lane the controller's own
        // tree.
        const worktree = data.assignment?.worktree
        if (typeof worktree !== 'string' || !isAbsolute(worktree)) {
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-worktree-invalid', { assignment_id: assignmentId })
        }
        let anchorCwd
        try {
          anchorCwd = await realpath(worktree)
        } catch {
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-worktree-unavailable', { assignment_id: assignmentId })
        }
        if (laneWorktreeRoot !== undefined && !isProperDescendant(anchorCwd, laneWorktreeRoot)) {
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-worktree-uncontained', {
            assignment_id: assignmentId,
          })
        }
        if (resolve(anchorCwd) === resolve(anchorCwd, '..')) {
          // The filesystem root is never an isolated lane worktree.
          await releaseRefusedIncarnation()
          throw laneError('main-agent-lane-worktree-uncontained', {
            assignment_id: assignmentId,
          })
        }
        /** @type {Awaited<ReturnType<typeof ctx.agents.create>> | undefined} */
        let anchorHandle
        /** @type {Lane | undefined} */
        let lane
        try {
          const route = workerRoute(exec?.agent)
          anchorHandle = await ctx.agents.create({
            sessionId: /** @type {any} */ (randomUUID()),
            meta: { cwd: anchorCwd },
            agentOptions: route,
          })
          const anchor = anchorHandle.agent
          const anchorId = dshRc7SessionHeader(anchor).id
          if (typeof anchorId !== 'string' || anchorId.length === 0) {
            throw laneError('main-agent-anchor-unavailable')
          }

          lane = {
            assignmentId,
            workerSessionId,
            launchId: externalLaunch.launch_id,
            livenessFile: externalLaunch.liveness_file,
            childId: '',
            anchorId,
            anchor,
            worktree: anchorCwd,
            state: 'open',
            // The bootstrap prompt is submitted as the child's first turn and
            // rc.7 publishes that turn's start edge before startContinuable
            // resolves, so the lane would otherwise advertise `waiting` for the
            // whole bootstrap turn. Seed `working` at launch instead.
            turn: {
              phase: 'working',
              phaseChangedAt: nowEpoch(),
              currentTurn: { startedAt: nowEpoch() },
              lastTurn: undefined,
            },
            workerEnv: Object.freeze({ ...externalLaunch.worker_env }),
            bootstrapKey: /** @type {string} */ (bootstrapKeyFromPrompt(externalLaunch.prompt)),
            brokerStopArgv: Object.freeze([...externalLaunch.broker_stop_argv]),
            disposeAnchor: () => {
              try { anchorHandle?.dispose() } catch {}
            },
            sidecarChain: Promise.resolve(),
            stopHeartbeat: undefined,
          }
          lanes.bindAnchor(lane)
          // Publish the sidecar before the heartbeat starts. The heartbeat's
          // first act is to read this lane's runtime evidence, and it is what
          // establishes the lane's broker readiness — so the evidence must
          // already be there rather than arriving inside the heartbeat's
          // startup retry window.
          await publishLivenessSidecar(lane)
          // The heartbeat must then be live before the child bootstraps: the
          // worker's authenticated CLI calls require a ready broker.
          const heartbeat = ctx.subprocess.spawn({
            argv: [...externalLaunch.broker_heartbeat_argv],
            cwd,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 16 * 1024 },
              stderr: { maxBytes: 8 * 1024 },
            },
            graceMs: 1_000,
          })
          lane.stopHeartbeat = () => {
            try { heartbeat.terminate() } catch {}
          }
          await waitForBrokerReady(externalLaunch, exec, cwd, assignmentId)
          const started = await ctx.subagents.startContinuable({
            provider: workerSubagentProvider,
            label: `main-agent:${assignmentId}`,
            request: {
              prompt: [{ type: 'text', text: nativeBootstrapPrompt(lane.bootstrapKey) }],
              parent: anchor,
              toolFilter: { deny: [...DEFAULT_LANE_VISIBILITY_DENIED_TOOLS] },
            },
            signal: exec.signal,
          })
          lane.childId = started.childId
          lanes.add(lane)
          // Run boundaries published during materialization arrive before the
          // child id exists, so replay them now: a first turn that already
          // settled must not leave the lane advertising `working` forever.
          replayPendingRunEvents(lane)
          return launchSummary(lane, 'launched')
        } catch (error) {
          // Roll every unadopted incarnation back, including failures before
          // the lane object exists. Otherwise a missing route or rejected
          // anchor would leave the nils-owned broker alive with no DSH lane.
          if (lane !== undefined) {
            lanes.remove(lane)
            lane.state = 'terminated'
            lane.turn = undefined
            await publishLivenessSidecar(lane).catch(() => {})
            lane.stopHeartbeat?.()
          }
          try { anchorHandle?.dispose() } catch {}
          await releaseRefusedIncarnation()
          throw error
        }
        }
      })
    },
  }

  /** @type {ToolDefinition} */
  const interruptTool = {
    name: 'main_agent_worker_interrupt',
    description: 'Interrupt one managed worker lane: stop its current turn while '
      + 'keeping the lane, its inbox, and its durable session intact.',
    parameters: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Assignment whose lane to interrupt.' },
      },
      required: ['assignment_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const lane = lanes.byAssignment(assignmentId)
      if (lane === undefined) throw laneError('main-agent-lane-not-found', { assignment_id: assignmentId })
      // Same policy as lane close: a settled or already-drained child has
      // nothing to interrupt, and that is a lane state, not a transport error.
      let interrupted = true
      try {
        ctx.subagents.interrupt(/** @type {any} */ (lane.childId), { kind: 'user', parentSessionId: /** @type {any} */ (lane.anchorId) })
      } catch {
        interrupted = false
      }
      // Only a verified interrupt writes a terminal turn record. Recording an
      // `interrupted` turn for a child that was never stopped would let the CLI
      // conclude the turn ended and reassign the lane while the original child
      // keeps writing to the same worktree.
      if (interrupted) {
        lane.turn = {
          phase: 'waiting',
          phaseChangedAt: nowEpoch(),
          currentTurn: undefined,
          lastTurn: {
            completedAt: nowEpoch(),
            outcome: 'interrupted',
          },
        }
        await publishLivenessSidecar(lane)
      }
      return { ...laneSummary(lane), operation: 'interrupt', interrupted }
    },
  }

  /** @type {ToolDefinition} */
  const closeTool = {
    name: 'main_agent_lane_close',
    description: 'Permanently close one managed worker lane after its assignment '
      + 'reached a terminal state: interrupt the child, stop the broker '
      + 'heartbeat, and mark the liveness sidecar terminated so reconcile and '
      + 'deletion can proceed store-side.',
    parameters: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Assignment whose lane to close.' },
      },
      required: ['assignment_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const lane = requireLane(assignmentId)
      // Resolve every exec-derived input before mutating lane state: a throw
      // after the mutation would strand the lane in the registry with its
      // capacity slot held and no retry able to get past the same point.
      const brokerCwd = controllerCwd(exec)
      const closed = await closeLane(lane, exec, brokerCwd)
      return closed.summary
    },
  }

  /**
   * Terminate one lane completely: interrupt the child, publish the terminated
   * sidecar, release the heartbeat and broker, dispose the anchor, and drop the
   * registry entry. Shared by explicit lane close and run closeout so both
   * release in exactly the same order.
   *
   * `disposeAnchor: false` keeps the anchor Agent alive for a caller that still
   * needs it as a drain authority; that caller owns disposing it afterwards.
   *
   * @param {Lane} lane
   * @param {any} exec
   * @param {string} brokerCwd
   * @param {{ disposeAnchor?: boolean }} [options]
   */
  const closeLane = async (lane, exec, brokerCwd, options = {}) => {
    const anchor = lane.anchor
    const disposeAnchor = lane.disposeAnchor
    let published = false
    try {
      try {
        ctx.subagents.interrupt(/** @type {any} */ (lane.childId), { kind: 'user', parentSessionId: /** @type {any} */ (lane.anchorId) })
      } catch {
        // A settled or already-drained child has nothing to interrupt; close
        // must still release the heartbeat, sidecar, and anchor.
      }
      lane.state = 'terminated'
      lane.turn = undefined
      // Publishing the terminated sidecar is best effort: releasing the
      // heartbeat, broker, and anchor must not depend on a filesystem write,
      // or a failed publish would leave a half-closed lane no retry can fix.
      published = await publishLivenessSidecar(lane).then(() => true, () => false)
      lane.stopHeartbeat?.()
      if (lane.brokerStopArgv.length > 0) {
        // Best-effort broker release; the heartbeat's own shutdown also stops
        // the broker, and stale broker state reconciles CLI-side.
        await client.run(lane.brokerStopArgv, {
          cwd: brokerCwd,
          signal: exec.signal,
        }).catch(() => undefined)
      }
    } finally {
      // Release is unconditional once close starts: the lane is terminated,
      // so leaving it registered would report it as live to the controller.
      lane.stopHeartbeat?.()
      if (options.disposeAnchor !== false) disposeAnchor?.()
      lanes.remove(lane)
    }
    return {
      anchor,
      disposeAnchor,
      summary: {
        ...laneSummary(lane),
        operation: 'close',
        closed: true,
        sidecar_published: published,
      },
    }
  }

  /**
   * Resolve the lane a controller verb names, or refuse. Store-side verbs stay
   * available through the CLI for assignments this runtime never launched; the
   * lane-bound verbs below deliberately require the lane, because their whole
   * purpose is the transport half.
   *
   * @param {string} assignmentId
   */
  const requireLane = (assignmentId) => {
    const lane = lanes.byAssignment(assignmentId)
    if (lane === undefined) {
      throw laneError('main-agent-lane-not-found', { assignment_id: assignmentId })
    }
    return lane
  }

  /** @param {Record<string, unknown>} record */
  const requireRevision = (record) => {
    const value = record.if_revision
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw laneError('main-agent-revision-invalid')
    }
    return value
  }

  /** @type {ToolDefinition} */
  const superviseTool = {
    name: 'main_agent_worker_supervise',
    description: 'Supervise one managed worker lane: run the store-side bounded '
      + 'supervision macro and fold this runtime\'s lane transport facts (child '
      + 'activity, turn phase, lane state) onto its typed classification.',
    parameters: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Assignment to supervise.' },
      },
      required: ['assignment_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      const cwd = controllerCwd(exec)
      const store = await runEnvelope([
        mainAgentCli,
        'worker',
        'supervise',
        assignmentId,
        '--format',
        'json',
      ], exec, cwd)
      const lane = lanes.byAssignment(assignmentId)
      // Enumeration is read-only and never resumes a child. A listing failure
      // is reported as unknown activity rather than failing supervision: the
      // store's classification is the authoritative half of this envelope.
      let childActivity
      if (lane !== undefined) {
        try {
          const entries = await ctx.subagents.listChildren(
            /** @type {any} */ (lane.anchorId),
            exec.signal,
          )
          childActivity = laneChildActivity(entries, lane.childId)
        } catch {
          childActivity = { activity: 'unknown', diagnostic: 'listing-unavailable' }
        }
      }
      return supervisionEnvelope({ assignmentId, store, lane, childActivity })
    },
  }

  /** @type {ToolDefinition} */
  const requestChangesTool = {
    name: 'main_agent_worker_request_changes',
    description: 'Return one submitted assignment to its exact worker lane for bounded '
      + 'revisions: record the fenced store-side request-changes decision, then deliver '
      + 'it into that lane\'s inbox. Never sends raw terminal input.',
    parameters: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Submitted assignment to return.' },
        if_revision: { type: 'integer', minimum: 0, description: 'Expected current assignment revision.' },
        reason: { type: 'string', description: 'Bounded durable reason recorded for the worker.' },
        idempotency_key: { type: 'string', description: 'Stable key for this decision.' },
      },
      required: ['assignment_id', 'if_revision', 'reason', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      const reason = requireNonEmptyString(record.reason, 'main-agent-reason-invalid')
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      const ifRevision = requireRevision(record)
      const lane = requireLane(assignmentId)
      const cwd = controllerCwd(exec)
      // The store decision comes first: delivering a revision request the store
      // refused would tell the lane to redo work under a fence that never moved.
      const store = await runEnvelope([
        mainAgentCli,
        'worker',
        'request-changes',
        assignmentId,
        '--if-revision',
        String(ifRevision),
        '--reason',
        reason,
        '--idempotency-key',
        idempotencyKey,
        '--format',
        'json',
      ], exec, cwd)
      let delivered = false
      let deliveryError
      try {
        await ctx.subagents.followup(
          /** @type {any} */ (lane.anchor),
          /** @type {any} */ (lane.childId),
          [{
            type: 'text',
            text: [
              `Main Agent requested changes for assignment ${assignmentId}.`,
              `Reason: ${reason}`,
              'Address it in this worktree, then record a fenced checkpoint with'
              + ` \`${LANE_CHECKPOINT_TOOL}\` using the assignment's current revision.`,
            ].join('\n'),
          }],
          {
            source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
            signal: exec.signal,
          },
        )
        delivered = true
      } catch (error) {
        // The durable decision already landed, so a delivery failure is a
        // reportable transport fact, not a reason to unwind the store. The
        // worker also reads the decision from its own rehydrate path.
        deliveryError = error instanceof Error ? error.message : String(error)
      }
      return {
        schema_version: REVIEW_SCHEMA,
        assignment_id: assignmentId,
        decision: 'request-changes',
        store,
        delivered,
        ...deliveryError === undefined ? {} : { delivery_error: deliveryError },
        lane: laneSummary(lane),
      }
    },
  }

  /** @type {ToolDefinition} */
  const acceptTool = {
    name: 'main_agent_worker_accept',
    description: 'Accept one submitted worker result after Main Agent review, recording '
      + 'the fenced store-side acceptance. The lane stays live until it is closed '
      + 'explicitly, so its worktree and inbox remain inspectable.',
    parameters: {
      type: 'object',
      properties: {
        assignment_id: { type: 'string', description: 'Submitted assignment to accept.' },
        if_revision: { type: 'integer', minimum: 0, description: 'Expected current assignment revision.' },
        idempotency_key: { type: 'string', description: 'Stable key for this decision.' },
      },
      required: ['assignment_id', 'if_revision', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      const ifRevision = requireRevision(record)
      const cwd = controllerCwd(exec)
      const store = await runEnvelope([
        mainAgentCli,
        'worker',
        'accept',
        assignmentId,
        '--if-revision',
        String(ifRevision),
        '--idempotency-key',
        idempotencyKey,
        '--format',
        'json',
      ], exec, cwd)
      const lane = lanes.byAssignment(assignmentId)
      return {
        schema_version: REVIEW_SCHEMA,
        assignment_id: assignmentId,
        decision: 'accept',
        store,
        delivered: false,
        lane: lane === undefined ? null : laneSummary(lane),
      }
    },
  }

  /** @type {ToolDefinition} */
  const closeoutTool = {
    name: 'main_agent_run_closeout',
    description: 'Close out the run: terminate every remaining lane, record the fenced '
      + 'final run checkpoint through the store closeout macro, then drain this '
      + 'runtime\'s lane descendants. The controller session survives to deliver the '
      + 'final answer.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line durable summary of the run.' },
        next_action: { type: 'string', description: 'One-line next action after closeout.' },
        result_summary: { type: 'string', description: 'One-line result summary for the run.' },
        if_run_revision: { type: 'integer', minimum: 0, description: 'Expected current run revision.' },
        idempotency_key: { type: 'string', description: 'Stable key for this closeout.' },
      },
      required: ['summary', 'next_action', 'if_run_revision', 'idempotency_key'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (closing) throw laneError('main-agent-mode-disposed')
      requireControllerCaller(exec)
      const record = /** @type {Record<string, unknown>} */ (args)
      const ifRunRevision = record.if_run_revision
      if (typeof ifRunRevision !== 'number'
        || !Number.isInteger(ifRunRevision)
        || ifRunRevision < 0) {
        throw laneError('main-agent-revision-invalid')
      }
      const idempotencyKey = requireNonEmptyString(
        record.idempotency_key,
        'main-agent-idempotency-key-invalid',
      )
      const document = checkpointDocument({
        summary: /** @type {string} */ (record.summary),
        nextAction: /** @type {string} */ (record.next_action),
        resultSummary: /** @type {string | undefined} */ (record.result_summary),
      })
      const cwd = controllerCwd(exec)
      // Every lane must be terminal before the store retires its worker: a lane
      // left `open` would keep the pinned harness identity vouching for a
      // runtime the store already considers retired.
      // Anchors stay alive through the drain: they are the parent authority
      // `drainContinuableDescendants` needs, so each one is disposed only after
      // its forest is released.
      const closedLanes = []
      for (const lane of lanes.list()) {
        closedLanes.push(await closeLane(lane, exec, cwd, { disposeAnchor: false }))
      }
      const anchors = closedLanes
        .map(entry => entry.anchor)
        .filter(anchor => anchor !== undefined)
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-main-agent-')),
      )
      const checkpointFile = join(directory, 'closeout.json')
      try {
        await writePrivateJson(checkpointFile, document)
        const store = await runEnvelope([
          mainAgentCli,
          'closeout',
          '--if-run-revision',
          String(ifRunRevision),
          '--checkpoint-file',
          checkpointFile,
          '--idempotency-key',
          idempotencyKey,
          '--format',
          'json',
        ], exec, cwd)
        // Drain after the store closed the run: admission below these anchors
        // is closed and every descendant Activation is released child-first.
        let drained = true
        try {
          await ctx.subagents.drainContinuableDescendants(/** @type {any} */ (anchors))
        } catch {
          drained = false
        } finally {
          // The anchors have no purpose once their forests are released, and a
          // failed drain must not leak them either.
          for (const entry of closedLanes) entry.disposeAnchor?.()
        }
        return {
          schema_version: CLOSEOUT_SCHEMA,
          store,
          lanes_closed: closedLanes.map(entry => entry.summary),
          drained,
        }
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    },
  }

  ctx.tools.register(Object.freeze(initializeTool))
  ctx.tools.register(Object.freeze(launchTool))
  ctx.tools.register(Object.freeze(interruptTool))
  ctx.tools.register(Object.freeze(closeTool))
  ctx.tools.register(Object.freeze(superviseTool))
  ctx.tools.register(Object.freeze(requestChangesTool))
  ctx.tools.register(Object.freeze(acceptTool))
  ctx.tools.register(Object.freeze(closeoutTool))

  /**
   * The versioned orchestration service. It is deliberately read-only: every
   * mutation is a tool, so each one carries a model-visible call, an argument
   * record, and the store's fenced receipt. A service method that mutated the
   * run would be an unlogged second write path onto the same durable state.
   */
  const orchestrationService = Object.freeze({
    apiVersion: 1,
    get laneCount() { return lanes.size },
    get cliDegraded() { return client.degraded },
    get maxLanes() { return maxLanes },
    lanes() {
      return lanes.list().map(laneSummary)
    },
    /** @param {string} assignmentId */
    lane(assignmentId) {
      const lane = lanes.byAssignment(assignmentId)
      return lane === undefined ? undefined : laneSummary(lane)
    },
    workerRoute,
    /** The tool names this runtime owns, so a composition can audit its surface. */
    tools: Object.freeze({
      controller: Object.freeze([
        initializeTool.name,
        launchTool.name,
        interruptTool.name,
        closeTool.name,
        superviseTool.name,
        requestChangesTool.name,
        acceptTool.name,
        closeoutTool.name,
      ]),
      lane: Object.freeze([LANE_BOOTSTRAP_TOOL, LANE_CHECKPOINT_TOOL]),
    }),
  })
  ctx.provide('mainAgentOrchestration', orchestrationService)
  // The pre-service name stays bound to the same object: it shipped in the
  // lane-runtime milestone and renaming a provided service is a breaking
  // change for any composition that already injects it.
  ctx.provide('dshRuntimeKitMainAgent', orchestrationService)
}

/**
 * Child-fiber plugin: mounting through `ctx.plugin` gates Main Agent Mode on
 * the subagent runtime without gating the rest of the bundle.
 */
export const mainAgentMode = Object.freeze({
  name: 'dsh-runtime-kit-main-agent',
  inject: ['agents', 'subagents', 'subprocess', 'tools'],
  apply: applyMainAgentMode,
})
