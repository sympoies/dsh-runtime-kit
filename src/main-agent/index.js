// @ts-check

import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, resolve } from 'node:path'

import { createCliClient } from './cli-client.js'
import { LIVENESS_SCHEMA, createLaneRegistry, publishLivenessSidecar } from './lanes.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-subagent').SubagentRuntime} SubagentRuntime */
/** @typedef {import('./lanes.js').Lane} Lane */

const WORKER_START_RESULT_SCHEMA = 'main-agent.worker-start-result.v1'
const EXTERNAL_LAUNCH_SCHEMA = 'main-agent.external-launch.v1'
const DEFAULT_WORKER_SUBAGENT_PROVIDER = 'spawn'
const LANE_SECTION_ORDER = 118
const DEFAULT_MAX_LANES = 8
const HARD_MAX_LANES = 64

/**
 * Tools a managed worker lane must never reach: delegation and the
 * controller-side lane management surface. Visibility filtering alone is not
 * authority, so the same set is also denied by a per-child monotonic guard.
 */
const DEFAULT_LANE_DENIED_TOOLS = Object.freeze([
  'subagent',
  'send_message',
  'list_agents',
  'workflow',
  'main_agent_worker_launch',
  'main_agent_worker_interrupt',
  'main_agent_lane_close',
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
 * The sidecar must be the conventional file inside the session state
 * directory the payload itself declares, so a malformed or hostile envelope
 * cannot redirect the rename-publish onto an unrelated file.
 *
 * @param {Record<string, any>} externalLaunch
 */
function containedLivenessFile(externalLaunch) {
  const stateDir = externalLaunch.worker_env?.AGENT_SESSION_STATE_DIR
  const sessionId = externalLaunch.worker_env?.AGENT_SESSION_ID
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return false
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  return resolve(externalLaunch.liveness_file)
    === resolve(stateDir, 'sessions', sessionId, LIVENESS_FILE_NAME)
}

/**
 * Worker environment values are replayed verbatim by the lane worker and
 * interpolated into its instruction section, so every entry must be a plain
 * single-line string under a conventional key.
 *
 * @param {unknown} workerEnv
 */
function validWorkerEnv(workerEnv) {
  if (workerEnv === null || typeof workerEnv !== 'object' || Array.isArray(workerEnv)) return false
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (workerEnv))
  return entries.length > 0 && entries.every(([key, value]) => WORKER_ENV_KEY.test(key)
    && typeof value === 'string'
    && value.length > 0
    // No control characters and no backtick: the value is rendered inside a
    // single-line code span in the lane instruction section, so either would
    // break out of it and inject directive text into the worker prompt.
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return character === '`' || codePoint < 0x20 || codePoint === 0x7f
    }))
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

/** @param {readonly string[]} argv */
function brokerArgvIsAgentSession(argv) {
  const [command] = argv
  if (typeof command !== 'string' || command.length === 0) return false
  return basename(command) === AGENT_SESSION_BASENAME
}

/** @param {Record<string, any>} externalLaunch */
function validExternalLaunch(externalLaunch) {
  return externalLaunch !== null
    && typeof externalLaunch === 'object'
    && externalLaunch.schema_version === EXTERNAL_LAUNCH_SCHEMA
    && typeof externalLaunch.launch_id === 'string'
    && externalLaunch.launch_id.length > 0
    && typeof externalLaunch.prompt === 'string'
    && externalLaunch.prompt.length > 0
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
    // argv[0] is executed verbatim, so it must be the coordination binary this
    // module is contracted to run, not an arbitrary payload-named program.
    && brokerArgvIsAgentSession(externalLaunch.broker_heartbeat_argv)
    && (externalLaunch.broker_stop_argv.length === 0
      || brokerArgvIsAgentSession(externalLaunch.broker_stop_argv))
}

/** @param {Lane} lane */
function laneEnvironmentSection(lane) {
  const rows = Object.entries(lane.workerEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return [
    `You are the managed worker lane for assignment ${lane.assignmentId}.`,
    'For every `main-agent` or `agent-session` command you run, prefix the',
    'exact session environment (single command line, no substitutions):',
    '',
    `\`${rows}\``,
    '',
    'Without this environment the coordination CLI cannot authenticate you.',
    'Never invent, reorder, or omit any of these values.',
  ].join('\n')
}

/** @param {Lane} lane @param {'launched' | 'reattached'} disposition */
function launchSummary(lane, disposition) {
  return {
    schema_version: 'dsh-runtime-kit.main-agent-lane.v1',
    disposition,
    assignment_id: lane.assignmentId,
    worker_session_id: lane.workerSessionId,
    launch_id: lane.launchId,
    child_session_id: lane.childId,
    anchor_session_id: lane.anchorId,
    lane_state: lane.state,
  }
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
 *   workerSubagentProvider?: string,
 *   workerProvider?: string,
 *   workerModel?: string,
 *   laneDeniedTools?: readonly string[],
 *   maxLanes?: number,
 *   cliTimeoutMs?: number,
 *   cliTeardownTimeoutMs?: number,
 *   maxActiveCliCalls?: number,
 * }} [config]
 */
export function applyMainAgentMode(ctx, config = {}) {
  const mainAgentCli = typeof config.mainAgentCli === 'string' && config.mainAgentCli.length > 0
    ? config.mainAgentCli
    : 'main-agent'
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
  const client = createCliClient(ctx, config)
  const lanes = createLaneRegistry()
  /** @type {Map<string, Lane>} */
  const lanesByAnchor = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const launching = new Map()
  // Capacity is reserved across the launch awaits so concurrent launches of
  // distinct assignments cannot all pass a stale registry-size check.
  let reservedLanes = 0
  let closing = false

  ctx.effect(() => () => {
    // Heartbeat subprocesses are ctx-owned and die with the fiber; lane
    // sidecars intentionally stay `open` so the nils CLI proves harness
    // death through the pinned process identity, not through a claim this
    // teardown could not verify.
    closing = true
    lanesByAnchor.clear()
    lanes.clear()
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
    const sessionId = payload?.agent?.session?.header?.id
    if (typeof sessionId === 'string' && lanesByAnchor.has(sessionId)) {
      return {
        kind: /** @type {const} */ ('reject'),
        reason: 'dsh-runtime-kit:main-agent-anchor-parked',
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
    if (payload === null || typeof payload !== 'object') return undefined
    const candidate = /** @type {Record<string, any>} */ (payload).id
    return typeof candidate === 'string' ? lanes.byChild(candidate) : undefined
  }
  const nowEpoch = () => String(Math.floor(Date.now() / 1000))
  ctx.on('subagent/start', (payload) => {
    const lane = laneForRunPayload(payload)
    if (lane === undefined || lane.state !== 'open') return
    lane.turn = {
      phase: 'working',
      phaseChangedAt: nowEpoch(),
      currentTurn: { startedAt: nowEpoch() },
      lastTurn: lane.turn?.lastTurn,
    }
    void publishLivenessSidecar(lane).catch(() => {})
  })
  ctx.on('subagent/end', (payload) => {
    const lane = laneForRunPayload(payload)
    if (lane === undefined || lane.state !== 'open') return
    const record = /** @type {Record<string, any>} */ (payload ?? {})
    lane.turn = {
      phase: 'waiting',
      phaseChangedAt: nowEpoch(),
      currentTurn: undefined,
      lastTurn: {
        completedAt: nowEpoch(),
        outcome: laneTurnOutcome(record.stopReason),
      },
    }
    void publishLivenessSidecar(lane).catch(() => {})
  })

  // Per-child lane hardening: a monotonic deny-only guard (authority) plus the
  // environment instruction section (guidance). Applies only to children whose
  // parent is one of this registry's anchors.
  ctx.subagents.registerContinuableSetup((childCtx) => {
    const agent = /** @type {any} */ (childCtx).agent
    const parentSession = agent?.session?.header?.parentSession
    const lane = typeof parentSession === 'string' ? lanesByAnchor.get(parentSession) : undefined
    if (lane === undefined) return () => {}
    /** @type {Array<() => void>} */
    const disposers = []
    disposers.push(childCtx.tools.guard(
      (/** @type {{ name: string }} */ exec) => (laneDeniedTools.has(exec.name)
        ? 'dsh-runtime-kit:main-agent-lane-tool-denied'
        : undefined),
    ))
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
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw laneError('main-agent-controller-cwd-unavailable')
    }
    return cwd
  }

  /**
   * Lane management is a controller-only surface. Tool visibility is not
   * authority, so refuse any caller that is one of this registry's anchors or
   * lane children rather than relying on the per-child deny filter alone.
   *
   * @param {any} exec
   */
  const requireControllerCaller = (exec) => {
    const sessionId = exec?.agent?.session?.header?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw laneError('main-agent-controller-identity-unavailable')
    }
    if (lanesByAnchor.has(sessionId) || lanes.byChild(sessionId) !== undefined) {
      throw laneError('main-agent-lane-caller-denied', { session_id: sessionId })
    }
    const parentSession = exec?.agent?.session?.header?.parentSession
    if (typeof parentSession === 'string' && lanesByAnchor.has(parentSession)) {
      throw laneError('main-agent-lane-caller-denied', { session_id: sessionId })
    }
  }

  /** @param {readonly string[]} argv @param {any} exec @param {string} cwd */
  const runEnvelope = async (argv, exec, cwd) => {
    const result = await client.run(argv, { cwd, signal: exec.signal })
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
      if (data?.schema_version !== WORKER_START_RESULT_SCHEMA
        || !validExternalLaunch(data.external_launch)) {
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

      return withLaunchLock(assignmentId, async () => {
        if (closing) throw laneError('main-agent-mode-disposed')
        const existing = lanes.byAssignment(assignmentId)
        if (existing !== undefined) {
          if (existing.launchId !== externalLaunch.launch_id) {
            throw laneError('main-agent-lane-incarnation-conflict', {
              assignment_id: assignmentId,
            })
          }
          await publishLivenessSidecar(existing)
          return launchSummary(existing, 'reattached')
        }
        if (lanes.size + reservedLanes >= maxLanes) {
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
        const worktree = data.assignment?.worktree
        const anchorCwd = typeof worktree === 'string' && isAbsolute(worktree) ? worktree : cwd
        const provider = config.workerProvider ?? exec?.agent?.options?.provider
        const model = config.workerModel ?? exec?.agent?.options?.model
        if (typeof provider !== 'string' || typeof model !== 'string') {
          throw laneError('main-agent-worker-route-unavailable')
        }
        const anchorHandle = await ctx.agents.create({
          sessionId: /** @type {any} */ (randomUUID()),
          meta: { cwd: anchorCwd },
          agentOptions: { provider, model },
        })
        const anchor = anchorHandle.agent
        const anchorId = String(anchor.session.header.id)
        if (anchorId.length === 0) {
          throw laneError('main-agent-anchor-unavailable')
        }

        /** @type {Lane} */
        const lane = {
          assignmentId,
          workerSessionId,
          launchId: externalLaunch.launch_id,
          livenessFile: externalLaunch.liveness_file,
          childId: '',
          anchorId,
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
          brokerStopArgv: Object.freeze([...externalLaunch.broker_stop_argv]),
          disposeAnchor: () => {
            try { anchorHandle.dispose() } catch {}
          },
          sidecarChain: Promise.resolve(),
          stopHeartbeat: undefined,
        }
        lanesByAnchor.set(anchorId, lane)
        try {
          // The heartbeat must be live before the child bootstraps: worker
          // authentication reads the capability file the heartbeat maintains.
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
          await publishLivenessSidecar(lane)
          const started = await ctx.subagents.startContinuable({
            provider: workerSubagentProvider,
            label: `main-agent:${assignmentId}`,
            request: {
              prompt: [{ type: 'text', text: externalLaunch.prompt }],
              parent: anchor,
              toolFilter: { deny: [...laneDeniedTools] },
            },
            signal: exec.signal,
          })
          lane.childId = started.childId
          lanes.add(lane)
          return launchSummary(lane, 'launched')
        } catch (error) {
          // Roll the half-launched lane back completely: without a child the
          // `open` sidecar would make the pinned live harness identity vouch
          // for a lane that does not exist.
          lanesByAnchor.delete(anchorId)
          lane.state = 'terminated'
          lane.turn = undefined
          await publishLivenessSidecar(lane).catch(() => {})
          lane.stopHeartbeat?.()
          lane.disposeAnchor?.()
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
      return { ...launchSummary(lane, 'reattached'), interrupted }
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
      const lane = lanes.byAssignment(assignmentId)
      if (lane === undefined) throw laneError('main-agent-lane-not-found', { assignment_id: assignmentId })
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
      const published = await publishLivenessSidecar(lane).then(() => true, () => false)
      lane.stopHeartbeat?.()
      if (lane.brokerStopArgv.length > 0) {
        // Best-effort broker release; the heartbeat's own shutdown also stops
        // the broker, and stale broker state reconciles CLI-side.
        await client.run(lane.brokerStopArgv, {
          cwd: controllerCwd(exec),
          signal: exec.signal,
        }).catch(() => undefined)
      }
      lane.disposeAnchor?.()
      lanes.remove(lane)
      lanesByAnchor.delete(lane.anchorId)
      return { ...launchSummary(lane, 'reattached'), closed: true, sidecar_published: published }
    },
  }

  ctx.tools.register(Object.freeze(launchTool))
  ctx.tools.register(Object.freeze(interruptTool))
  ctx.tools.register(Object.freeze(closeTool))

  ctx.provide('dshRuntimeKitMainAgent', Object.freeze({
    apiVersion: 1,
    get laneCount() { return lanes.size },
    get cliDegraded() { return client.degraded },
    lanes() {
      return lanes.list().map(lane => launchSummary(
        lane,
        /** @type {const} */ ('reattached'),
      ))
    },
  }))
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
