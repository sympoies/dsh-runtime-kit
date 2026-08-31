// @ts-check

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { createAuthoritativeAcceptanceCoordinator } from '../authoritative-acceptance/index.js'
import { createDshRc7Compatibility } from '../compat/dsh-rc7.js'
import { createRuntimeContextTool } from '../context/index.js'
import { createNilsContextClient } from '../context/nils-context.js'
import { createFinishLineCoordinator, resolveFinishLineShellTimeout } from '../finish-line/index.js'
import { createPrerequisiteCoordinator } from '../prerequisite/index.js'
import { createNilsFinishLineClient } from '../finish-line/nils-client.js'
import { resolveManagedSessionPrincipal } from '../nils/session-environment.js'
import { createNilsTransport } from './nils-transport.js'
import { createChildPluginStatus, snapshotChildPluginStatus } from '../runtime-status.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-fs').FsObservation} FsObservation */
/** @typedef {import('@deepseek-ai/dsh-fs').FsTarget} FsTarget */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionToken} ToolExecutionToken */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */
/** @typedef {{callId:string, name:string, arguments:unknown, agent?:import('@deepseek-ai/dsh-agent').Agent, parent?:ToolExecutionToken, signal:AbortSignal, turn:number, step:number}} ToolPersistenceCall */
/** @typedef {{kind:'keep'} | {kind:'replace', arguments:unknown}} ToolPersistenceDecision */

const MAX_LIFECYCLE_PROMPT_BYTES = 64 * 1024
/** Same-turn steering bound shared with the finish-line and acceptance coordinators. */
const MAX_SAME_TURN_STOP_STEERS = 2
const DATA_POLICY_CANDIDATE = 'typed-data-policy-protected-roots'

/**
 * Resolve the exact finish-line command through the active DSH shell provider.
 * The provider remains authoritative for its default and maximum timeout.
 *
 * @param {{resolve(request: Record<string, unknown>): Record<string, unknown>}} shell
 * @param {{kind: 'validation' | 'ordinary', command: string, timeoutMs: number | undefined}} operation
 * @param {{workdir: string, signal: AbortSignal, dshEnv: Record<string, string>, policy?: unknown}} input
 */
export function resolveFinishLineShellSpec(shell, operation, input) {
  const timeoutMs = resolveFinishLineShellTimeout(operation.kind, operation.timeoutMs)
  return shell.resolve({
    command: operation.command,
    workdir: input.workdir,
    ...timeoutMs === undefined ? {} : { timeoutMs },
    signal: input.signal,
    dshEnv: input.dshEnv,
    ...input.policy === undefined ? {} : { sandboxPolicy: input.policy },
  })
}

/**
 * Linux remains the only authoritative finish-line execution host. A non-Linux
 * runtime may delegate only for an authenticated managed session whose durable
 * coordination mode explicitly accepts advisory failure. Missing, malformed,
 * unmanaged, and enforce identities remain fail-closed.
 *
 * @param {NodeJS.Platform} platform
 * @param {{environment?: Readonly<Record<string, string>>} | undefined} principal
 */
export function requiresAuthoritativeFinishLine(platform, principal) {
  if (platform === 'linux') return true
  const mode = principal?.environment?.AGENT_SESSION_COORDINATION_MODE
  return mode !== 'advisory' && mode !== 'off'
}

/**
 * Serialize asynchronous Agent cleanup against the next acceptance startup in
 * the same workspace. DSH disposal events deliberately do not await returned
 * promises, so the barrier must be recorded synchronously by the listener and
 * joined by the later session-start path.
 */
export function createWorkspaceDisposalBarrier() {
  /** @type {Map<string, Promise<void>>} */
  const pending = new Map()
  /** @param {{session?: {header?: {cwd?: unknown}}}} agent */
  const workspace = (agent) => {
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('dsh-runtime-kit: agent workspace unavailable')
    }
    return cwd
  }
  return Object.freeze({
    /**
     * @param {{session?: {header?: {cwd?: unknown}}}} agent
     * @param {() => Promise<unknown>} cleanup
     */
    track(agent, cleanup) {
      const key = workspace(agent)
      const previous = pending.get(key) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(cleanup).then(() => {})
      pending.set(key, current)
      void current.finally(() => {
        if (pending.get(key) === current) pending.delete(key)
      }).catch(() => {})
      return current
    },
    /** @param {{session?: {header?: {cwd?: unknown}}}} agent */
    async wait(agent) {
      const key = workspace(agent)
      for (;;) {
        const current = pending.get(key)
        if (current === undefined) return
        await current
        if (pending.get(key) === current) {
          pending.delete(key)
          return
        }
      }
    },
    /** @param {{session?: {header?: {cwd?: unknown}}}} agent */
    ready(agent) {
      return !pending.has(workspace(agent))
    },
  })
}

/**
 * @typedef Authorization
 * @property {'allow' | 'deny'} kind
 * @property {string | undefined} reason
 * @property {string} callId
 * @property {string} rootCallId
 * @property {string} name
 * @property {unknown} evaluatedArguments
 * @property {ToolExecution['agent']} agent
 * @property {import('@deepseek-ai/dsh-agent').Agent['session'] | undefined} session
 * @property {ToolExecution['parent']} parent
 * @property {AbortSignal} signal
 * @property {ToolExecutionToken} token
 * @property {number} admissionEpoch
 */

/** @param {() => void} onExecute @returns {ToolDefinition} */
function createPlusOneTool(onExecute = () => {}) {
  /** @type {ToolDefinition} */
  const definition = {
    name: 'runtime_kit_plus_one',
    description: 'Add exactly one to an integer.',
    parameters: {
      type: 'object',
      properties: {
        value: {
          type: 'integer',
          description: 'The integer to increment.',
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'integer' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new TypeError('runtime_kit_plus_one expects an argument object')
      }
      const record = /** @type {Record<string, unknown>} */ (args)
      const keys = Object.keys(record)
      if (keys.length !== 1 || keys[0] !== 'value' || !Number.isSafeInteger(record.value)) {
        throw new TypeError('runtime_kit_plus_one expects exactly one safe integer named value')
      }
      onExecute()
      return /** @type {number} */ (record.value) + 1
    },
  }
  return Object.freeze(definition)
}

export const plusOneTool = createPlusOneTool()

/** @param {string} reason */
function denial(reason) {
  return { kind: /** @type {const} */ ('deny'), reason: `dsh-runtime-kit:${reason}` }
}

/** @param {Iterable<string>} segments @param {number} maxBytes */
export function boundedUtf8Segments(segments, maxBytes) {
  let result = ''
  let remaining = maxBytes
  for (const segment of segments) {
    if (result.length > 0) {
      if (remaining < 1) break
      result += '\n'
      remaining -= 1
    }
    const candidate = segment.length > remaining ? segment.slice(0, remaining) : segment
    const bytes = Buffer.from(candidate, 'utf8')
    if (bytes.length <= remaining) {
      result += candidate
      remaining -= bytes.length
      if (candidate.length !== segment.length) break
      continue
    }
    let bounded = bytes.subarray(0, remaining).toString('utf8')
    while (bounded.endsWith('\uFFFD')) bounded = bounded.slice(0, -1)
    result += bounded
    break
  }
  return result
}

/** @param {unknown[]} messages */
function lifecyclePrompt(messages) {
  function *textSegments() {
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      const candidate = /** @type {Record<string, any>} */ (message)
      if (candidate.source?.kind !== 'user' || !Array.isArray(candidate.content)) continue
      for (const block of candidate.content) {
        if (block?.type === 'text' && typeof block.text === 'string') yield block.text
      }
    }
  }
  return boundedUtf8Segments(textSegments(), MAX_LIFECYCLE_PROMPT_BYTES)
}

/** @param {(input: any) => any} createUserMessage @param {string} text */
function policyContextMessage(createUserMessage, text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
  })
}

/** @param {{kind: string, reason?: string} | undefined} decision */
function explicitPolicyDenial(decision) {
  return decision?.kind === 'deny'
    && typeof decision.reason === 'string'
    && decision.reason.startsWith('agent-hook:')
}

/**
 * Collapse a fail-closed lifecycle denial into a content-free operational
 * class. The public runtime service never exposes provider reasons, rule IDs,
 * policy context, or subprocess output.
 *
 * @param {{kind: string, reason?: string} | undefined} decision
 */
function stopPolicyFailureOutcome(decision) {
  if (explicitPolicyDenial(decision)) return 'policy-denied'
  if (decision?.reason === 'dsh-runtime-kit:policy-caller-aborted') return 'cancelled'
  if (decision?.reason === 'dsh-runtime-kit:policy-unavailable'
      || decision?.reason === 'dsh-runtime-kit:policy-overloaded'
      || decision?.reason === 'dsh-runtime-kit:policy-disposed') {
    return 'capability-unavailable'
  }
  if (decision?.reason === 'dsh-runtime-kit:policy-output-invalid'
      || decision?.reason === 'dsh-runtime-kit:policy-exit-mismatch'
      || decision?.reason === 'dsh-runtime-kit:policy-input-too-complex'
      || decision?.reason === 'dsh-runtime-kit:policy-input-too-large') {
    return 'provider-failed'
  }
  return 'transport-failed'
}

/** @param {ToolExecution} exec @param {number} admissionEpoch */
function authorizationIdentity(exec, admissionEpoch) {
  return {
    token: exec.token,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    name: exec.name,
    evaluatedArguments: exec.arguments,
    agent: exec.agent,
    session: exec.agent?.session,
    parent: exec.parent,
    signal: exec.signal,
    admissionEpoch,
  }
}

/** @param {Authorization} authorization @param {Readonly<ToolExecution>} exec */
function matchesAuthorization(authorization, exec) {
  return authorization.token === exec.token
    && authorization.callId === exec.callId
    && authorization.rootCallId === exec.rootCallId
    && authorization.name === exec.name
    && authorization.evaluatedArguments === exec.arguments
    && authorization.agent === exec.agent
    && authorization.session === exec.agent?.session
    && authorization.parent === exec.parent
    && authorization.signal === exec.signal
}

/**
 * DSH may preserve the effective sandbox mode, or its workspace-write schema
 * default under danger-full-access, together with a blank optional
 * justification in a Bash call. Treat only those known non-escalating echoes
 * as no-ops; every other shape stays under the native escalation validator.
 *
 * @param {{permissions: string | undefined, justification: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access', isNonWideningEcho(permissions: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access'): boolean, validate(permissions: any, justification: any): void}} input
 * @returns {{permissions: string, justification: string} | undefined}
 */
export function normalizeSandboxEscalationRequest({
  permissions,
  justification,
  effectiveMode,
  isNonWideningEcho,
  validate,
}) {
  if (isNonWideningEcho(permissions, effectiveMode)
    && (justification === undefined || justification.trim().length === 0)) {
    return undefined
  }
  validate(permissions, justification)
  if (permissions === undefined || justification === undefined) return undefined
  return { permissions, justification }
}

/**
 * Compose the rc.7 lifecycle adapter, nils transport, and the DSH denial-only
 * guard. The transport effect is registered first so reverse disposal removes
 * every ingress listener and guard before process-tree draining begins.
 *
 * @param {Context} ctx
 * @param {{ agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number, policyTimeoutMs?: number, policyTeardownTimeoutMs?: number, maxActivePolicyChecks?: number, finishLineTimeoutMs?: number, finishLineTeardownTimeoutMs?: number, maxActiveFinishLineRequests?: number, maxSameTurnFinishLineSteers?: number, nilsCompatibilityCandidate?: string, protectedRoots?: string[], dataPolicyOpaqueTools?: string[], managedSessionBridge?: {resolve?: (id:string) => unknown, authenticate?: (id:string, execution:unknown) => Promise<unknown>} }} config
 * @param {{roleOf(agent: import('@deepseek-ai/dsh-agent').Agent): string | undefined}} [reviewers]
 * @param {{ENV_OVERRIDES: Record<string, string>, HarnessError: new (...args: any[]) => Error, TOOL_ABORTED: string, createUserMessage(input: any): any, approveEscalation(input: any, context: any): Promise<any>, canonicalPath(path: string): string, isNonWideningSandboxEcho(permissions: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access'): boolean, validateEscalationArgs(permissions: any, justification: any): void}} [dshRuntime]
 * @param {ReturnType<typeof createChildPluginStatus>} [childPlugins]
 */
export function applyPolicy(ctx, config = {}, reviewers, dshRuntime, childPlugins = createChildPluginStatus()) {
  if (dshRuntime === undefined) {
    throw new TypeError('dsh-runtime-kit: validated DSH runtime dependencies are required')
  }
  const {
    ENV_OVERRIDES,
    HarnessError,
    TOOL_ABORTED,
    createUserMessage,
    approveEscalation,
    canonicalPath,
    isNonWideningSandboxEcho,
    validateEscalationArgs,
  } = dshRuntime
  if (typeof isNonWideningSandboxEcho !== 'function') {
    throw new TypeError('dsh-runtime-kit: authenticated DSH sandbox echo classifier is required')
  }
  const dataPolicyEnabled = config.nilsCompatibilityCandidate === DATA_POLICY_CANDIDATE
  if (dataPolicyEnabled
    && typeof /** @type {{registerTerminalPolicy?: unknown}} */ (ctx.tools).registerTerminalPolicy !== 'function') {
    throw new TypeError('dsh-runtime-kit: authenticated DSH terminal data-policy boundary is required')
  }
  const transport = createNilsTransport(ctx, config)
  const protectedRootConfig = config.protectedRoots ?? []
  if (!Array.isArray(protectedRootConfig)
    || protectedRootConfig.some(root => typeof root !== 'string' || root.length === 0)) {
    throw new TypeError('dsh-runtime-kit: protectedRoots must be an array of non-empty path strings')
  }
  if (protectedRootConfig.length > 0) {
    const sandboxPolicy = /** @type {{protect?: (roots: readonly string[]) => () => void} | undefined} */ (ctx.get('sandboxPolicy'))
    if (typeof sandboxPolicy?.protect !== 'function') {
      throw new Error('dsh-runtime-kit: authenticated protected-root registration is unavailable')
    }
    const protect = sandboxPolicy.protect.bind(sandboxPolicy)
    ctx.effect(() => protect(protectedRootConfig), 'dsh-runtime-kit protected roots')
  }
  const opaqueToolConfig = config.dataPolicyOpaqueTools ?? []
  if (!Array.isArray(opaqueToolConfig)
    || opaqueToolConfig.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new TypeError('dsh-runtime-kit: dataPolicyOpaqueTools must be an array of non-empty tool names')
  }
  const opaqueTools = new Set(opaqueToolConfig)
  const contextClient = createNilsContextClient(ctx, config)
  const finishLineClient = createNilsFinishLineClient(ctx, config)
  const finishLine = createFinishLineCoordinator(ctx, {
    client: finishLineClient,
    HarnessError,
    TOOL_ABORTED,
    maxSameTurnSteers: config.maxSameTurnFinishLineSteers,
    authenticatePrincipal: async (agent, signal) => {
      await config.managedSessionBridge?.authenticate?.(String(agent.id), { agent, signal })
    },
    requiresFinishLine: identity => requiresAuthoritativeFinishLine(
      process.platform,
      resolveManagedSessionPrincipal(ctx, identity.sessionId, config.managedSessionBridge),
    ),
    prepareValidationRuntime: async (exec, operation) => {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('dsh-runtime-kit: finish-line-session-missing')
      if (!await ctx.sessions.flush(session)) {
        throw new Error('dsh-runtime-kit: finish-line-session-persistence-unavailable')
      }
      const shell = /** @type {{sandboxMode?: string, resolve(request: Record<string, unknown>): Record<string, unknown>} | undefined} */ (ctx.get('shell'))
      const shellEnv = /** @type {{collect(execution: ToolExecution): Record<string, string>} | undefined} */ (ctx.get('shellEnv'))
      if (shell === undefined || shellEnv === undefined) {
        throw new Error('dsh-runtime-kit: finish-line-shell-unavailable')
      }

      /** @type {{mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot: string, sessionId?: unknown} | undefined} */
      let policy
      if (shell.sandboxMode !== undefined) {
        const service = /** @type {{resolve(input: {session: typeof session}): {mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot: string, sessionId?: unknown}} | undefined} */ (ctx.get('sandboxPolicy'))
        if (service === undefined) {
          throw new Error('dsh-runtime-kit: finish-line-sandbox-policy-unavailable')
        }
        policy = service.resolve({ session })
        if (policy === undefined) throw new Error('dsh-runtime-kit: finish-line-sandbox-policy-unavailable')
        const escalation = normalizeSandboxEscalationRequest({
          permissions: operation.sandboxPermissions,
          justification: operation.justification,
          effectiveMode: policy.mode,
          isNonWideningEcho: isNonWideningSandboxEcho,
          validate: validateEscalationArgs,
        })
        if (escalation !== undefined) {
          const approvedMode = await approveEscalation({
            requestedMode: escalation.permissions,
            justification: escalation.justification,
            effectiveMode: policy.mode,
            subject: 'command',
          }, {
            approver: ctx.get('approval'),
            agent: exec.agent,
            callId: exec.callId,
            toolName: 'bash',
            signal: exec.signal,
          })
          policy = { ...policy, mode: approvedMode }
        }
      } else {
        validateEscalationArgs(operation.sandboxPermissions, operation.justification)
        if (operation.sandboxPermissions !== undefined || operation.justification !== undefined) {
          throw new Error('dsh-runtime-kit: sandbox escalation is unavailable without a confining shell')
        }
      }

      const headerCwd = session.header.cwd
      if (typeof headerCwd !== 'string') throw new Error('dsh-runtime-kit: finish-line-workdir-unavailable')
      const sessionRoot = policy?.workspaceRoot ?? canonicalPath(headerCwd)
      const workdir = operation.workdir === undefined
        ? sessionRoot
        : isAbsolute(operation.workdir)
          ? operation.workdir
          : resolvePath(sessionRoot, operation.workdir)
      const dshEnv = shellEnv.collect(exec)
      const spec = resolveFinishLineShellSpec(shell, operation, {
        workdir,
        signal: exec.signal,
        dshEnv,
        policy,
      })
      if (spec.command !== operation.command
        || typeof spec.workdir !== 'string'
        || (operation.kind === 'validation'
          && canonicalPath(spec.workdir) !== canonicalPath(headerCwd))
        || typeof spec.timeoutMs !== 'number'
        || !Number.isFinite(spec.timeoutMs)
        || spec.timeoutMs <= 0
        || typeof spec.stdoutMaxBytes !== 'number'
        || !Number.isFinite(spec.stdoutMaxBytes)
        || spec.stdoutMaxBytes <= 0) {
        throw new Error('dsh-runtime-kit: finish-line-shell-resolution-invalid')
      }
      const resolvedTimeoutMs = Math.ceil(spec.timeoutMs)
      const outputMaxBytes = Math.min(64 * 1024, Math.floor(spec.stdoutMaxBytes))
      if (resolvedTimeoutMs > 60 * 60 * 1_000 || outputMaxBytes <= 0) {
        throw new Error('dsh-runtime-kit: finish-line-shell-resolution-invalid')
      }

      let runner
      if (policy === undefined) {
        runner = { kind: /** @type {const} */ ('unsandboxed') }
      } else if (policy.mode === 'danger-full-access') {
        // This strict runner kind is the native full-host authority profile.
        // Nils may supervise its lifecycle, but must not add a second OS-level
        // permission sandbox around the already selected DSH mode.
        runner = { kind: /** @type {const} */ ('danger-full-access') }
      } else {
        const sandbox = /** @type {{confine(argv: string[], policy: {mode: 'read-only' | 'workspace-write', workspaceRoot: string, sessionId?: unknown}): {argv: string[], enforcement: 'full' | 'partial', denialSignatures: string[], runnerFailureRules: Array<{allowedExitCodes?: number[], fatalSignatures: string[], informationalLines?: string[]}>}} | undefined} */ (ctx.get('sandbox'))
        if (sandbox === undefined) throw new Error('dsh-runtime-kit: finish-line-sandbox-unavailable')
        const confinedPolicy = /** @type {{mode: 'read-only' | 'workspace-write', workspaceRoot: string, sessionId?: unknown}} */ (policy)
        const confined = sandbox.confine(['bash', '-c', operation.command], confinedPolicy)
        runner = {
          kind: /** @type {const} */ ('confined'),
          providerArgv: confined.argv,
          mode: policy.mode,
          enforcement: confined.enforcement,
          denialSignatures: confined.denialSignatures,
          runnerFailureRules: confined.runnerFailureRules,
        }
      }
      return {
        timeoutMs: resolvedTimeoutMs,
        execution: {
          kind: 'bash-v1',
          workdir: spec.workdir,
          outputMaxBytes,
          runner,
        },
        environment: { ...ENV_OVERRIDES, ...dshEnv },
      }
    },
    createSteeringMessage: text => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
    }),
  })
  const workspaceDisposals = createWorkspaceDisposalBarrier()
  const acceptance = createAuthoritativeAcceptanceCoordinator(ctx, {
    client: finishLineClient,
    authority: finishLine,
    controlTimeoutMs: finishLineClient.teardownTimeoutMs,
    abortedCode: TOOL_ABORTED,
    workspaceReadiness: workspaceDisposals,
    createSteeringMessage: text => createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
    }),
  })
  const compatibility = createDshRc7Compatibility(ctx)
  /** @type {Map<Readonly<ToolExecution>, Authorization>} */
  const authorizations = new Map()
  /** @type {Map<Readonly<ToolExecution>, import('@deepseek-ai/dsh-llm').UserMessage[]>} */
  const toolContexts = new Map()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], string>} */
  let dataPolicyGenerations = new WeakMap()
  let dataPolicyAuditCount = 0
  const prerequisites = createPrerequisiteCoordinator(
    ctx,
    contextClient,
    createUserMessage,
    async (exec, correlation, proof) => {
      // The authoritative finish-line probe already classified this exact
      // execution as the declared validation. Re-running generic opaque-shell
      // policy during native prerequisite verification would contradict that
      // typed classification and poison the still-reserved validation.
      if (finishLine.isDeclaredValidation(exec)) return undefined
      // A last-mile decision supersedes the earlier pre-approval advisory.
      // Publish it only after transport succeeds so a repeated native check is
      // transactional: uncertainty retains the last verified bounded context.
      const decision = await transport.evaluate(exec, correlation, proof)
      if (decision?.kind === 'context') {
        toolContexts.set(exec, [policyContextMessage(createUserMessage, decision.context)])
      } else {
        toolContexts.delete(exec)
      }
      return decision
    },
  )
  /** @type {WeakSet<Readonly<ToolExecution>>} */
  const authorizedTools = new WeakSet()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], { position: string, promptDigest: string, status: 'pending' | 'accepted', context?: string, settled: Promise<boolean>, resolve: (accepted: boolean) => void }>} */
  let acceptedLifecycleSteps = new WeakMap()
  /** @type {WeakSet<import('@deepseek-ai/dsh-agent').Agent['session']>} */
  let startupEvaluated = new WeakSet()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], number>} */
  let evaluatedStops = new WeakMap()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, outcome: 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'}>} */
  let stopPolicyOutcomes = new WeakMap()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, count: number}>} */
  let stopSteers = new WeakMap()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, outcome: 'acceptance-denied' | 'finish-line-denied' | 'context-invalid' | 'already-evaluated' | 'reservation-unterminalized' | 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'}>} */
  let stopPipelineOutcomes = new WeakMap()
  let closing = false

  /** @param {import('@deepseek-ai/dsh-agent').Agent | undefined} agent */
  const isReviewer = agent => agent !== undefined && reviewers?.roleOf(agent) !== undefined

  /** @param {string} name */
  const dataPolicySource = (name) => {
    if (opaqueTools.has(name)) {
      return 'provider.opaque-reference'
    }
    if (name === 'bash' || name === 'pwsh') return 'tool.shell'
    if (name === 'run_code') return 'tool.code'
    if (name.startsWith('mcp_')) return 'tool.mcp'
    if (name === 'web' || name.startsWith('web_') || name.startsWith('web.')) return 'tool.web'
    return 'tool.native'
  }

  /** @param {Readonly<ToolExecution> | Readonly<ToolPersistenceCall>} exec @param {{sessionId:string, cwd:string, turn:number, step:number, callId:string, rootCallId:string}} correlation @param {'pre-call' | 'final-result'} phase @param {unknown} payload @param {'tool.execute' | 'session.persist'} [sinkId] */
  const evaluateDataPolicy = async (exec, correlation, phase, payload, sinkId) => {
    const session = exec.agent?.session
    if (session === undefined) return denial('data-policy-identity-unavailable')
    const generation = dataPolicyGenerations.get(session)
    if (generation === undefined) return denial('data-policy-generation-unavailable')
    const parent = exec.parent === undefined ? undefined : compatibility.correlation(exec.parent)
    if (exec.parent !== undefined && parent === undefined) {
      return denial('data-policy-parent-unavailable')
    }
    const request = {
      schema_version: 'agent-hook.data-policy.evaluate.v1',
      phase,
      source_id: dataPolicySource(exec.name),
      sink_id: sinkId ?? (phase === 'pre-call' ? 'tool.execute' : 'session.persist'),
      identity: {
        session_id: correlation.sessionId,
        workspace_digest: `sha256:${createHash('sha256').update(correlation.cwd).digest('hex')}`,
        workspace_generation: generation,
        call_id: correlation.callId,
        root_call_id: correlation.rootCallId,
        ...parent === undefined ? {} : { parent_call_id: parent.callId },
        turn: correlation.turn,
        step: correlation.step,
      },
      rules: phase === 'pre-call'
        ? [
            { rule_id: 'runtime.data-policy.pre.sensitive-deny', class_id: 'sensitive', action: 'deny' },
            { rule_id: 'runtime.data-policy.pre.machine-path-allow', class_id: 'machine-local-path', action: 'allow' },
          ]
        : [
            { rule_id: 'runtime.data-policy.final.sensitive-deny', class_id: 'sensitive', action: 'deny' },
            { rule_id: 'runtime.data-policy.final.machine-path-quarantine', class_id: 'machine-local-path', action: 'quarantine' },
          ],
      payload,
    }
    const signal = phase === 'pre-call' ? exec.signal : new AbortController().signal
    const outcome = await transport.evaluateData(request, signal, correlation)
    if (outcome?.kind !== 'data-policy') return outcome ?? denial('data-policy-unavailable')
    dataPolicyAuditCount += 1
    ctx.emit('dsh-runtime-kit/data-policy-audit', outcome.decision.audit)
    return outcome
  }

  /** @param {Readonly<ToolExecution>} exec @param {import('@deepseek-ai/dsh-llm').UserMessage} message */
  const appendToolContext = (exec, message) => {
    const retained = toolContexts.get(exec)
    if (retained === undefined) toolContexts.set(exec, [message])
    else retained.push(message)
  }

  /** @param {Readonly<ToolExecution>} exec */
  const contextsFor = (exec) => {
    if (!authorizedTools.has(exec)) return []
    return toolContexts.get(exec) ?? []
  }

  /** @param {string} reason @param {import('@deepseek-ai/dsh-llm').UserMessage[]} contexts */
  const postBlock = (reason, contexts) => ({
    kind: /** @type {const} */ ('block'),
    feedback: [{
      type: /** @type {const} */ ('text'),
      text: `Error: ${reason}`,
    }],
    ...contexts.length === 0 ? {} : { additionalContexts: contexts },
  })

  if (dataPolicyEnabled) {
    /** @type {import('@deepseek-ai/dsh-tools').ToolRuntime} */ (ctx.tools).registerTerminalPolicy({
      async projectPersistence(call) {
        const session = call.agent?.session
        const cwd = session?.header.cwd
        const generation = session === undefined ? undefined : dataPolicyGenerations.get(session)
        if (session === undefined || typeof cwd !== 'string' || cwd.length === 0
          || generation === undefined || closing || call.signal.aborted) {
          throw new Error('dsh-runtime-kit:data-policy-persistence-unavailable')
        }
        const correlation = {
          sessionId: session.id,
          cwd,
          turn: call.turn,
          step: call.step,
          callId: call.callId,
          rootCallId: call.callId,
        }
        let outcome
        try {
          outcome = await evaluateDataPolicy(
            call,
            correlation,
            'pre-call',
            call.arguments,
            'session.persist',
          )
        } catch {
          throw new Error('dsh-runtime-kit:data-policy-persistence-unavailable')
        }
        if (outcome?.kind !== 'data-policy') {
          throw new Error('dsh-runtime-kit:data-policy-persistence-unavailable')
        }
        return outcome.decision.action === 'allow'
          ? { kind: /** @type {const} */ ('keep') }
          : {
              kind: /** @type {const} */ ('replace'),
              arguments: outcome.decision.replacement ?? {
                redacted: true,
                code: outcome.decision.code,
              },
            }
      },
      async projectResult(exec, result) {
        if (!compatibility.matchesTool(exec)) {
          return postBlock(denial('data-policy-correlation-invalid').reason, [])
        }
        const correlation = compatibility.correlation(exec.token)
        if (correlation === undefined) {
          return postBlock(denial('data-policy-correlation-invalid').reason, [])
        }
        let dataDecision
        try {
          dataDecision = await evaluateDataPolicy(exec, correlation, 'final-result', result)
        } catch {
          return postBlock(denial('data-policy-unavailable').reason, [])
        }
        if (dataDecision?.kind === 'data-policy'
          && dataDecision.decision.action === 'allow') {
          return { kind: /** @type {const} */ ('accept') }
        }
        const decision = dataDecision?.kind === 'data-policy' ? dataDecision.decision : undefined
        const locator = decision?.action === 'quarantine'
          && typeof decision.replacement?.locator === 'string'
          && /^sha256:[0-9a-f]{64}$/u.test(decision.replacement.locator)
          ? ` (${decision.replacement.locator})`
          : ''
        const code = decision?.code
          ?? (dataDecision?.kind === 'deny' ? dataDecision.reason : undefined)
          ?? 'dsh-runtime-kit:data-policy-unavailable'
        const reason = code.startsWith('dsh-runtime-kit:') ? code : `dsh-runtime-kit:${code}`
        return postBlock(`${reason}${locator}`, [])
      },
    })
  }

  /**
   * Steer a failed stop boundary at most `MAX_SAME_TURN_STOP_STEERS` times per
   * turn. The accepting paths record `evaluatedStops`, so only the fail-closed
   * paths can repeat; a fault that persists cannot converge by being steered
   * again, and the bound terminalizes the turn with the classified outcome
   * instead of leaving the harness deadline as the only limit.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {number} turn
   * @param {string} outcome
   * @param {string} text
   */
  const steerStop = (agent, turn, outcome, text) => {
    const tracked = stopSteers.get(agent.session)
    const steered = tracked !== undefined && tracked.turn === turn ? tracked.count : 0
    if (steered >= MAX_SAME_TURN_STOP_STEERS) {
      throw new Error(`dsh-runtime-kit: stop policy same-turn steering limit reached (${outcome})`)
    }
    stopSteers.set(agent.session, { turn, count: steered + 1 })
    agent.steer(policyContextMessage(createUserMessage, text))
  }

  ctx.effect(() => () => {
    closing = true
    authorizations.clear()
    toolContexts.clear()
    acceptedLifecycleSteps = new WeakMap()
    startupEvaluated = new WeakSet()
    evaluatedStops = new WeakMap()
    stopPolicyOutcomes = new WeakMap()
    stopSteers = new WeakMap()
    stopPipelineOutcomes = new WeakMap()
    dataPolicyGenerations = new WeakMap()
    compatibility.dispose()
    prerequisites.dispose()
  }, 'dsh-runtime-kit policy state')

  let plusOneExecutions = 0
  ctx.tools.register(createRuntimeContextTool(contextClient))
  ctx.tools.register(createPlusOneTool(() => { plusOneExecutions += 1 }))

  /** @param {import('@deepseek-ai/dsh-agent').Agent} agent */
  const attachDataPolicyGeneration = (agent) => {
    if (!dataPolicyGenerations.has(agent.session)) {
      dataPolicyGenerations.set(agent.session, `generation:${randomUUID()}`)
    }
  }
  for (const agent of ctx.agents.list()) attachDataPolicyGeneration(agent)

  ctx.on('agent/session-start', payload => {
    attachDataPolicyGeneration(payload.agent)
    if (!isReviewer(payload.agent)) prerequisites.attachAgent(payload.agent)
    compatibility.sessionStart(payload)
    if (!isReviewer(payload.agent)) {
      void acceptance.sessionStarted(payload).catch(() => {})
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    dataPolicyGenerations.delete(agent.session)
    if (isReviewer(agent)) return
    prerequisites.detachAgent(agent)
    void workspaceDisposals.track(agent, async () => {
      try {
        await acceptance.agentDisposed(agent)
      } finally {
        await finishLine.agentDisposed(agent)
      }
    }).catch(() => {})
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    if (isReviewer(payload.agent)) return next()
    const proposal = compatibility.preStepContext(payload)
    if (!proposal.ok) return compatibility.preStep(payload, next)
    const session = payload.agent.session
    const position = `${proposal.context.turn}:${proposal.context.step}`
    let downstream
    try {
      downstream = await compatibility.preStep(payload, next)
    } catch (error) {
      throw error
    }
    if (downstream.kind !== 'enter' || payload.signal.aborted || closing) return downstream
    const prompt = lifecyclePrompt(downstream.messages)
    const promptDigest = createHash('sha256').update(prompt).digest('hex')
    /** @param {string | undefined} context */
    const withPolicyContext = context => context === undefined
      ? downstream
      : {
          ...downstream,
          messages: [...downstream.messages, policyContextMessage(createUserMessage, context)],
        }
    /** @type {{ position: string, promptDigest: string, status: 'pending' | 'accepted', context?: string, settled: Promise<boolean>, resolve: (accepted: boolean) => void } | undefined} */
    let claim
    while (claim === undefined) {
      const current = acceptedLifecycleSteps.get(session)
      if (current?.status === 'pending') {
        const accepted = await current.settled
        if (accepted && current.position === position && current.promptDigest === promptDigest) {
          return withPolicyContext(current.context)
        }
        continue
      }
      if (current?.status === 'accepted'
          && current.position === position
          && current.promptDigest === promptDigest) {
        return withPolicyContext(current.context)
      }
      /** @type {(accepted: boolean) => void} */
      let resolve = () => {}
      const settled = new Promise(resolvePromise => { resolve = resolvePromise })
      claim = { position, promptDigest, status: 'pending', settled, resolve }
      acceptedLifecycleSteps.set(session, claim)
    }
    /** @param {boolean} accepted */
    const settleClaim = (accepted) => {
      if (acceptedLifecycleSteps.get(session) === claim) {
        if (accepted) claim.status = 'accepted'
        else acceptedLifecycleSteps.delete(session)
      }
      claim.resolve(accepted)
    }
    const includeStartup = !startupEvaluated.has(session)
    let policyDecision
    try {
      policyDecision = await transport.evaluateLifecycle({
        event: 'agent/pre-step',
        prompt,
        ...includeStartup
          ? { sessionStartSource: proposal.context.sessionStartSource }
          : {},
        signal: payload.signal,
        context: proposal.context,
      })
    } catch {
      policyDecision = undefined
    }
    if (closing || payload.signal.aborted) {
      settleClaim(false)
      return downstream
    }
    if (explicitPolicyDenial(policyDecision)) {
      settleClaim(false)
      return { kind: /** @type {const} */ ('reject') }
    }
    if (includeStartup) startupEvaluated.add(session)
    const policyContext = policyDecision?.kind === 'context' ? policyDecision.context : undefined
    claim.context = policyContext
    const accepted = withPolicyContext(policyContext)
    settleClaim(true)
    return accepted
  })
  ctx.on('agent/turn-stopping', async payload => {
    if (isReviewer(payload.agent)) return
    /** @param {'acceptance-denied' | 'finish-line-denied' | 'context-invalid' | 'already-evaluated' | 'reservation-unterminalized' | 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'} outcome */
    const recordPipelineOutcome = outcome => {
      stopPipelineOutcomes.set(payload.agent.session, { turn: payload.turn, outcome })
    }
    /** @param {'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'} outcome */
    const recordPolicyOutcome = outcome => {
      stopPolicyOutcomes.set(payload.agent.session, { turn: payload.turn, outcome })
      recordPipelineOutcome(outcome)
    }
    const correlated = compatibility.turnStopping(payload)
    const acceptanceAllowed = await acceptance.turnStopping(payload)
    if (!acceptanceAllowed) {
      recordPipelineOutcome('acceptance-denied')
      return
    }
    const governed = acceptance.governs(payload.agent)
    const cancelReservedStop = async () => {
      if (!governed) return true
      try {
        await acceptance.cancelCompletion(payload.agent, String(payload.turn))
        return true
      } catch {
        recordPipelineOutcome('reservation-unterminalized')
        if (!closing && !payload.signal.aborted) {
          steerStop(payload.agent, payload.turn, 'reservation-unterminalized',
            'The acceptance reservation could not be terminalized. Restore the runtime boundary and retry.',
          )
        }
        return false
      }
    }
    if (closing || payload.signal.aborted) {
      recordPipelineOutcome('cancelled')
      await cancelReservedStop()
      return
    }
    const finishAllowed = governed
      ? true
      : await finishLine.turnStopping(payload, correlated)
    if (!finishAllowed) {
      recordPipelineOutcome('finish-line-denied')
      return
    }
    if (closing || payload.signal.aborted) {
      recordPipelineOutcome('cancelled')
      await cancelReservedStop()
      return
    }
    const stop = compatibility.stopContext(payload)
    if (!stop.ok) {
      recordPipelineOutcome('context-invalid')
      await cancelReservedStop()
      return
    }
    if (evaluatedStops.get(payload.agent.session) === payload.turn) {
      recordPipelineOutcome('already-evaluated')
      return
    }
    let policyDecision
    try {
      policyDecision = await transport.evaluateLifecycle({
        event: 'agent/turn-stopping',
        signal: payload.signal,
        context: stop.context,
      })
    } catch {
      recordPolicyOutcome('transport-failed')
      await cancelReservedStop()
      if (!closing && !payload.signal.aborted) {
        steerStop(payload.agent, payload.turn, 'transport-failed',
          'The lifecycle policy could not verify the stop boundary. Retry after policy availability is restored.',
        )
      }
      return
    }
    if (closing || payload.signal.aborted) {
      recordPolicyOutcome('cancelled')
      await cancelReservedStop()
      return
    }
    if (policyDecision?.kind === 'context') {
      recordPolicyOutcome('context')
      if (!await cancelReservedStop()) return
      payload.agent.steer(policyContextMessage(createUserMessage, policyDecision.context))
      evaluatedStops.set(payload.agent.session, payload.turn)
    } else if (policyDecision === undefined) {
      recordPolicyOutcome('allow')
      evaluatedStops.set(payload.agent.session, payload.turn)
    } else {
      const outcome = stopPolicyFailureOutcome(policyDecision)
      recordPolicyOutcome(outcome)
      if (!await cancelReservedStop()) return
      steerStop(payload.agent, payload.turn, outcome,
        explicitPolicyDenial(policyDecision)
          ? 'The lifecycle policy blocked this stop boundary. Resolve the reported policy state and retry.'
          : 'The lifecycle policy could not verify the stop boundary. Retry after policy availability is restored.',
      )
    }
  })

  ctx.on('fs/observed', (
    /** @type {FsTarget} */ target,
    /** @type {FsObservation} */ observation,
    /** @type {object | undefined} */ actor,
  ) => {
    finishLine.observeFs(target, observation, actor)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (isReviewer(exec.agent)) {
      if (!dataPolicyEnabled) return next()
      const correlation = compatibility.beginTool(exec)
      if (!correlation.ok) return { kind: /** @type {const} */ ('deny'), reason: denial(correlation.reason).reason }
      let dataDecision
      try {
        dataDecision = await evaluateDataPolicy(exec, correlation.context, 'pre-call', exec.arguments)
      } catch {
        return { kind: /** @type {const} */ ('deny'), reason: denial('data-policy-unavailable').reason }
      }
      if (dataDecision?.kind !== 'data-policy' || dataDecision.decision.action !== 'allow') {
        const code = dataDecision?.kind === 'data-policy'
          ? dataDecision.decision.code
          : dataDecision?.kind === 'deny'
            ? dataDecision.reason
            : 'dsh-runtime-kit:data-policy-unavailable'
        return {
          kind: /** @type {const} */ ('deny'),
          reason: code.startsWith('dsh-runtime-kit:') ? code : `dsh-runtime-kit:${code}`,
        }
      }
      return next()
    }
    const identity = authorizationIdentity(exec, transport.admissionEpoch)
    /** @param {string} reason */
    const rememberDenial = (reason) => {
      finishLine.reject(exec)
      acceptance.reject(exec)
      prerequisites.reject(exec)
      toolContexts.delete(exec)
      authorizations.set(exec, { kind: 'deny', reason, ...identity })
      return { kind: /** @type {const} */ ('deny'), reason }
    }

    try {
      prerequisites.prepare(exec)
    } catch {
      return rememberDenial(denial('prerequisite-unavailable').reason)
    }
    const correlation = compatibility.beginTool(exec)
    if (!correlation.ok) {
      return rememberDenial(denial(correlation.reason).reason)
    }
    let prerequisiteProof
    try {
      prerequisiteProof = await prerequisites.begin(exec, correlation.context)
    } catch {
      return rememberDenial(denial('prerequisite-unavailable').reason)
    }
    if (closing || exec.signal.aborted) {
      return rememberDenial(denial(closing
        ? 'policy-disposed'
        : 'policy-caller-aborted').reason)
    }
    let finishProbe
    try {
      finishProbe = await finishLine.probe(exec, correlation.context)
    } catch {
      return rememberDenial(denial('finish-line-unavailable').reason)
    }
    if (!finishProbe.ok) {
      return rememberDenial(denial(finishProbe.reason ?? 'finish-line-unavailable').reason)
    }

    if (finishProbe.kind !== 'validation'
      && (prerequisiteProof === undefined || finishProbe.kind === 'ordinary')) {
      let decision
      try {
        decision = await transport.evaluate(exec, correlation.context, prerequisiteProof)
      } catch {
        if (closing) return rememberDenial(denial('policy-disposed').reason)
        return rememberDenial(denial('policy-unavailable').reason)
      }
      if (closing) return rememberDenial(denial('policy-disposed').reason)
      if (decision?.kind === 'deny') return rememberDenial(decision.reason)
      if (decision?.kind === 'context') {
        appendToolContext(exec, policyContextMessage(createUserMessage, decision.context))
      }
    }
    if (dataPolicyEnabled) {
      let dataDecision
      try {
        dataDecision = await evaluateDataPolicy(exec, correlation.context, 'pre-call', exec.arguments)
      } catch {
        return rememberDenial(denial('data-policy-unavailable').reason)
      }
      if (dataDecision?.kind !== 'data-policy' || dataDecision.decision.action !== 'allow') {
        const code = dataDecision?.kind === 'data-policy'
          ? dataDecision.decision.code
          : dataDecision?.kind === 'deny'
            ? dataDecision.reason
            : 'dsh-runtime-kit:data-policy-unavailable'
        const reason = code.startsWith('dsh-runtime-kit:') ? code : `dsh-runtime-kit:${code}`
        return rememberDenial(reason)
      }
    }
    if (exec.signal.aborted) return rememberDenial(denial('policy-caller-aborted').reason)

    let acceptanceReservation
    try {
      acceptanceReservation = await acceptance.admit(exec, correlation.context)
    } catch {
      return rememberDenial(denial('acceptance-unavailable').reason)
    }
    if (finishProbe.kind === 'ordinary' && exec.agent !== undefined
      && acceptance.governs(exec.agent)) {
      try {
        await acceptance.repositoryMutationStarting(exec, correlation.context)
      } catch {
        return rememberDenial(denial('acceptance-unavailable').reason)
      }
    }
    if (acceptanceReservation.kind !== 'mutation') {
      const finishReservation = await finishLine.begin(exec, correlation.context)
      if (!finishReservation.ok) {
        return rememberDenial(denial(finishReservation.reason ?? 'finish-line-unavailable').reason)
      }
    }
    if (closing) return rememberDenial(denial('policy-disposed').reason)
    if (exec.signal.aborted) return rememberDenial(denial('policy-caller-aborted').reason)

    authorizations.set(exec, { kind: 'allow', reason: undefined, ...identity })
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      finishLine.reject(exec)
      acceptance.reject(exec)
      prerequisites.reject(exec)
      compatibility.result(exec)
      authorizations.delete(exec)
      toolContexts.delete(exec)
      throw error
    }
    if (downstream.kind !== 'allow' && downstream.kind !== 'ask') {
      finishLine.reject(exec)
      acceptance.reject(exec)
      prerequisites.reject(exec)
      compatibility.result(exec)
      authorizations.delete(exec)
      toolContexts.delete(exec)
    }
    return downstream
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (isReviewer(exec.agent)) return next()
    const retainedContexts = contextsFor(exec)
    if (!compatibility.postTool(exec)) {
      toolContexts.delete(exec)
      return postBlock(denial('policy-correlation-invalid').reason, retainedContexts)
    }
    const correlation = compatibility.correlation(exec.token)
    if (correlation === undefined) {
      toolContexts.delete(exec)
      return postBlock(denial('policy-correlation-invalid').reason, retainedContexts)
    }
    let policyDecision
    try {
      policyDecision = await transport.evaluatePost(exec, result, correlation)
    } catch {
      toolContexts.delete(exec)
      return postBlock(denial('policy-unavailable').reason, retainedContexts)
    }
    if (closing || policyDecision?.kind === 'deny') {
      toolContexts.delete(exec)
      const reason = closing
        ? denial('policy-disposed').reason
        : policyDecision?.kind === 'deny'
          ? policyDecision.reason
          : denial('policy-unavailable').reason
      return postBlock(reason, retainedContexts)
    }
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      toolContexts.delete(exec)
      throw error
    }
    const contexts = [
      ...retainedContexts,
      ...(policyDecision?.kind === 'context'
        ? [policyContextMessage(createUserMessage, policyDecision.context)]
        : []),
      ...(downstream.additionalContexts ?? []),
    ]
    toolContexts.delete(exec)
    return contexts.length === 0
      ? downstream
      : {
          ...downstream,
          additionalContexts: contexts,
        }
  })

  ctx.tools.guard((exec) => {
    if (isReviewer(exec.agent)) return undefined
    const authorization = authorizations.get(exec)
    authorizations.delete(exec)
    if (exec.signal.aborted) return denial('policy-caller-aborted').reason
    if (authorization === undefined
      || !matchesAuthorization(authorization, exec)
      || !compatibility.matchesTool(exec)) {
      return denial('policy-marker-missing').reason
    }
    if (authorization.kind === 'allow'
      && (transport.degraded
        || authorization.admissionEpoch !== transport.admissionEpoch)) {
      return denial('policy-unavailable').reason
    }
    if (authorization.kind === 'deny') return authorization.reason
    authorizedTools.add(exec)
    return undefined
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (isReviewer(exec.agent)) return next()
    const routed = await finishLine.execute(exec)
    if (routed.kind !== 'delegate') return routed.result
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (isReviewer(exec.agent)) {
      compatibility.result(exec)
      return
    }
    authorizations.delete(exec)
    toolContexts.delete(exec)
    finishLine.result(exec, result)
    acceptance.result(exec, result)
    prerequisites.result(exec)
    compatibility.result(exec)
  })

  ctx.provide('dshRuntimeKit', Object.freeze({
    apiVersion: 1,
    get childPluginStatus() { return snapshotChildPluginStatus(childPlugins) },
    get plusOneExecutions() { return plusOneExecutions },
    get activePolicyChecks() { return transport.active },
    get activeContextRequests() { return contextClient.active },
    get activeFinishLineRequests() { return finishLineClient.active },
    get activeFinishLineReservations() { return finishLine.activeReservations },
    get policyTransportDegraded() { return transport.degraded },
    get dataPolicyAuditCount() { return dataPolicyAuditCount },
    /**
     * @param {import('@deepseek-ai/dsh-agent').Agent} agent
     * @param {number} turn
     */
    stopPolicyOutcome(agent, turn) {
      const observed = agent?.session === undefined
        ? undefined
        : stopPolicyOutcomes.get(agent.session)
      return observed !== undefined && observed.turn === turn
        ? observed.outcome
        : undefined
    },
    /**
     * @param {import('@deepseek-ai/dsh-agent').Agent} agent
     * @param {number} turn
     */
    stopPipelineOutcome(agent, turn) {
      const observed = agent?.session === undefined
        ? undefined
        : stopPipelineOutcomes.get(agent.session)
      return observed !== undefined && observed.turn === turn
        ? observed.outcome
        : undefined
    },
    get contextTransportDegraded() { return contextClient.degraded },
    get finishLineTransportDegraded() { return finishLineClient.degraded },
    get finishLineDegraded() { return finishLine.degraded },
    get pendingPolicyMarkers() { return authorizations.size },
    get pendingPrerequisites() { return prerequisites.pending },
    get activeAcceptanceOperations() { return acceptance.activeOperations },
    prerequisites: prerequisites.service,
    get pendingCorrelations() { return compatibility.pendingCorrelations },
    policyTimeoutMs: transport.timeoutMs,
    policyTeardownTimeoutMs: transport.teardownTimeoutMs,
    maxActivePolicyChecks: transport.maxActive,
    contextMaxBytes: contextClient.maxBytes,
    contextTimeoutMs: contextClient.timeoutMs,
    contextTeardownTimeoutMs: contextClient.teardownTimeoutMs,
    maxActiveContextRequests: contextClient.maxActive,
    finishLineTimeoutMs: finishLineClient.timeoutMs,
    finishLineTeardownTimeoutMs: finishLineClient.teardownTimeoutMs,
    maxActiveFinishLineRequests: finishLineClient.maxActive,
    maxSameTurnFinishLineSteers: finishLine.maxSameTurnSteers,
  }))
}
