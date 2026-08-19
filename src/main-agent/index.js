// @ts-check

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { createCliClient } from './cli-client.js'
import { createLaneRegistry, writeLivenessSidecar } from './lanes.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {import('@deepseek-ai/dsh-subagent').SubagentRuntime} SubagentRuntime */
/** @typedef {import('./lanes.js').Lane} Lane */

const WORKER_START_RESULT_SCHEMA = 'main-agent.worker-start-result.v1'
const EXTERNAL_LAUNCH_SCHEMA = 'main-agent.external-launch.v1'
const DEFAULT_WORKER_SUBAGENT_PROVIDER = 'spawn'
const LANE_SECTION_ORDER = 118

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
    && Array.isArray(externalLaunch.broker_heartbeat_argv)
    && externalLaunch.broker_heartbeat_argv.length > 0
    && externalLaunch.broker_heartbeat_argv.every(
      (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0,
    )
    && Array.isArray(externalLaunch.broker_stop_argv)
    && externalLaunch.broker_stop_argv.every(
      (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0,
    )
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
  const laneDeniedTools = new Set(
    Array.isArray(config.laneDeniedTools) && config.laneDeniedTools.length > 0
      ? config.laneDeniedTools
      : DEFAULT_LANE_DENIED_TOOLS,
  )
  const client = createCliClient(ctx, config)
  const lanes = createLaneRegistry()
  /** @type {Map<string, Lane>} */
  const lanesByAnchor = new Map()
  let closing = false

  ctx.effect(() => () => {
    // Heartbeat subprocesses are ctx-owned and die with the fiber; lane
    // sidecars intentionally stay `open` so the nils CLI proves harness
    // death through the pinned process identity, not through a claim this
    // teardown could not verify.
    closing = true
    lanesByAnchor.clear()
  }, 'dsh-runtime-kit main-agent lanes')

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
  /** @param {unknown} payload */
  const laneForRunPayload = (payload) => {
    if (payload === null || typeof payload !== 'object') return undefined
    const record = /** @type {Record<string, any>} */ (payload)
    for (const candidate of [record.childSessionId, record.sessionId, record.id]) {
      if (typeof candidate === 'string') {
        const lane = lanes.byChild(candidate)
        if (lane !== undefined) return lane
      }
    }
    return undefined
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
    void writeLivenessSidecar(lane).catch(() => {})
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
        outcome: typeof record.stopReason === 'string' && record.stopReason.length > 0
          ? record.stopReason
          : 'completed',
      },
    }
    void writeLivenessSidecar(lane).catch(() => {})
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

      const existing = lanes.byAssignment(assignmentId)
      if (existing !== undefined) {
        if (existing.launchId !== externalLaunch.launch_id) {
          throw laneError('main-agent-lane-incarnation-conflict', {
            assignment_id: assignmentId,
          })
        }
        await writeLivenessSidecar(existing)
        return launchSummary(existing, 'reattached')
      }

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
        turn: {
          phase: 'waiting',
          phaseChangedAt: nowEpoch(),
          currentTurn: undefined,
          lastTurn: undefined,
        },
        workerEnv: Object.freeze({ ...externalLaunch.worker_env }),
        brokerStopArgv: Object.freeze([...externalLaunch.broker_stop_argv]),
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
        await writeLivenessSidecar(lane)
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
        lanesByAnchor.delete(anchorId)
        lane.stopHeartbeat?.()
        try { anchorHandle.dispose() } catch {}
        throw error
      }
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
    async execute(args) {
      const record = /** @type {Record<string, unknown>} */ (args)
      const assignmentId = requireNonEmptyString(
        record.assignment_id,
        'main-agent-assignment-id-invalid',
      )
      const lane = lanes.byAssignment(assignmentId)
      if (lane === undefined) throw laneError('main-agent-lane-not-found', { assignment_id: assignmentId })
      ctx.subagents.interrupt(/** @type {any} */ (lane.childId), { kind: 'user', parentSessionId: /** @type {any} */ (lane.anchorId) })
      lane.turn = {
        phase: 'waiting',
        phaseChangedAt: nowEpoch(),
        currentTurn: undefined,
        lastTurn: {
          completedAt: nowEpoch(),
          outcome: 'interrupted',
        },
      }
      await writeLivenessSidecar(lane)
      return { ...launchSummary(lane, 'reattached'), interrupted: true }
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
      const lane = lanes.byAssignment(assignmentId)
      if (lane === undefined) throw laneError('main-agent-lane-not-found', { assignment_id: assignmentId })
      ctx.subagents.interrupt(/** @type {any} */ (lane.childId), { kind: 'user', parentSessionId: /** @type {any} */ (lane.anchorId) })
      lane.state = 'terminated'
      lane.turn = undefined
      await writeLivenessSidecar(lane)
      lane.stopHeartbeat?.()
      if (lane.brokerStopArgv.length > 0) {
        // Best-effort broker release; the heartbeat's own shutdown also stops
        // the broker, and stale broker state reconciles CLI-side.
        await client.run(lane.brokerStopArgv, {
          cwd: controllerCwd(exec),
          signal: exec.signal,
        }).catch(() => undefined)
      }
      lanes.remove(lane)
      lanesByAnchor.delete(lane.anchorId)
      return { ...launchSummary(lane, 'reattached'), closed: true }
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
