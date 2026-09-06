import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { createAuthoritativeAcceptanceCoordinator } from '../authoritative-acceptance/index.js'
import { DshCompatibilityError } from '../compat/contract.js'
import { createDshRc7Compatibility } from '../compat/dsh-rc7.js'
import { createRuntimeContextTool } from '../context/index.js'
import { createNilsContextClient } from '../context/nils-context.js'
import { createFinishLineCoordinator, resolveFinishLineShellTimeout } from '../finish-line/index.js'
import { createPrerequisiteCoordinator } from '../prerequisite/index.js'
import { createNilsFinishLineClient } from '../finish-line/nils-client.js'
import { resolveManagedSessionPrincipal } from '../nils/session-environment.js'
import { createNilsTransport } from './nils-transport.js'
import { createChildPluginStatus, snapshotChildPluginStatus } from '../runtime-status.js'
import { REVIEWER_ROLES } from '../review/index.js'

export type Context = import('@deepseek-ai/cordis').Context
export type FsObservation = import('@deepseek-ai/dsh-fs').FsObservation
export type FsTarget = import('@deepseek-ai/dsh-fs').FsTarget
export type ToolExecution = import('@deepseek-ai/dsh-tools').ToolExecution
export type ToolExecutionToken = import('@deepseek-ai/dsh-tools').ToolExecutionToken
export type ToolDefinition = import('@deepseek-ai/dsh-tools').ToolDefinition
export type ToolPersistenceCall = {callId:string, name:string, arguments:unknown, agent?:import('@deepseek-ai/dsh-agent').Agent, parent?:ToolExecutionToken, signal:AbortSignal, turn:number, step:number}
export type ToolPersistenceDecision = {kind:'keep'} | {kind:'replace', arguments:unknown}
export type ToolTerminalPolicy = {projectPersistence(call:Readonly<ToolPersistenceCall>):Promise<ToolPersistenceDecision>, projectResult(exec:Readonly<ToolExecution>, result:unknown):Promise<unknown>}
export type ToolTerminalPolicyRuntime = {registerTerminalPolicy(provider:ToolTerminalPolicy):() => void}

const MAX_LIFECYCLE_PROMPT_BYTES = 64 * 1024
/** Same-turn steering bound shared with the finish-line and acceptance coordinators. */
const MAX_SAME_TURN_STOP_STEERS = 2
const DATA_POLICY_CANDIDATE = 'typed-data-policy-protected-roots'
const REVIEWER_ROLE_IDS = new Set(REVIEWER_ROLES)

/**
 * Resolve the exact finish-line command through the active DSH shell provider.
 * The provider remains authoritative for its default and maximum timeout.
 */
export function resolveFinishLineShellSpec(shell: {resolve(request: Record<string, unknown>): Record<string, unknown>}, operation: {kind: 'validation' | 'ordinary', command: string, timeoutMs: number | undefined}, input: {workdir: string, signal: AbortSignal, dshEnv: Record<string, string>, policy?: unknown}) {
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
 * Linux remains the only authoritative finish-line execution host. Repository
 * presence is classified per operation by agent-hook; a session-start result
 * is metadata and never grants a persistent bypass.
 */
export function requiresAuthoritativeFinishLine(platform: NodeJS.Platform, principal: {environment?: Readonly<Record<string, string>>, baselineFailureCode?: string} | undefined) {
  const mode = principal?.environment?.AGENT_SESSION_COORDINATION_MODE
  if (platform === 'linux') return true
  return mode !== 'advisory' && mode !== 'off'
}

/**
 * Only an authenticated managed advisory/off principal may consume an exact
 * per-operation `finish-line-not-in-repository` result on Linux.
 */
export function allowsNonRepositoryFinishLineDelegation(platform: NodeJS.Platform, principal: {environment?: Readonly<Record<string, string>>} | undefined) {
  const mode = principal?.environment?.AGENT_SESSION_COORDINATION_MODE
  return platform === 'linux'
    && principal !== undefined
    && (mode === 'advisory' || mode === 'off')
}

/**
 * Serialize asynchronous Agent cleanup against the next acceptance startup in
 * the same workspace. DSH disposal events deliberately do not await returned
 * promises, so the barrier must be recorded synchronously by the listener and
 * joined by the later session-start path.
 */
export function createWorkspaceDisposalBarrier() {
  const pending: Map<string, Promise<void>> = new Map()
  const workspace = (agent: {session?: {header?: {cwd?: unknown}}}) => {
    const cwd = agent.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('dsh-runtime-kit: agent workspace unavailable')
    }
    return cwd
  }
  return Object.freeze({
    track(agent: {session?: {header?: {cwd?: unknown}}}, cleanup: () => Promise<unknown>) {
      const key = workspace(agent)
      const previous = pending.get(key) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(cleanup).then(() => {})
      pending.set(key, current)
      void current.finally(() => {
        if (pending.get(key) === current) pending.delete(key)
      }).catch(() => {})
      return current
    },
    async wait(agent: {session?: {header?: {cwd?: unknown}}}) {
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
    ready(agent: {session?: {header?: {cwd?: unknown}}}) {
      return !pending.has(workspace(agent))
    },
  })
}

export type Authorization = { kind: 'allow' | 'deny', reason: string | undefined, callId: string, rootCallId: string, name: string, evaluatedArguments: unknown, agent: ToolExecution['agent'], session: import('@deepseek-ai/dsh-agent').Agent['session'] | undefined, parent: ToolExecution['parent'], signal: AbortSignal, token: ToolExecutionToken, admissionEpoch: number }

function createPlusOneTool(onExecute: () => void = () => {}): ToolDefinition  {
  const definition: ToolDefinition = {
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
      const record = ((args) as Record<string, unknown>)
      const keys = Object.keys(record)
      if (keys.length !== 1 || keys[0] !== 'value' || !Number.isSafeInteger(record.value)) {
        throw new TypeError('runtime_kit_plus_one expects exactly one safe integer named value')
      }
      onExecute()
      return ((record.value) as number) + 1
    },
  }
  return Object.freeze(definition)
}

export const plusOneTool = createPlusOneTool()

function denial(reason: string) {
  return { kind: (('deny') as const), reason: `dsh-runtime-kit:${reason}` }
}

export function boundedUtf8Segments(segments: Iterable<string>, maxBytes: number) {
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

function lifecyclePrompt(messages: unknown[]) {
  function *textSegments() {
    for (const message of messages) {
      if (message === null || typeof message !== 'object') continue
      const candidate = ((message) as Record<string, any>)
      if (candidate.source?.kind !== 'user' || !Array.isArray(candidate.content)) continue
      for (const block of candidate.content) {
        if (block?.type === 'text' && typeof block.text === 'string') yield block.text
      }
    }
  }
  return boundedUtf8Segments(textSegments(), MAX_LIFECYCLE_PROMPT_BYTES)
}

function policyContextMessage(createUserMessage: (input: any) => any, text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-runtime-kit' },
  })
}

function explicitPolicyDenial(decision: {kind: string, reason?: string} | undefined) {
  return decision?.kind === 'deny'
    && typeof decision.reason === 'string'
    && decision.reason.startsWith('agent-hook:')
}

/**
 * Collapse a fail-closed lifecycle denial into a content-free operational
 * class. The public runtime service never exposes provider reasons, rule IDs,
 * policy context, or subprocess output.
 */
function stopPolicyFailureOutcome(decision: {kind: string, reason?: string} | undefined) {
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

function authorizationIdentity(exec: ToolExecution, admissionEpoch: number) {
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

function matchesAuthorization(authorization: Authorization, exec: Readonly<ToolExecution>) {
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
 */
export function normalizeSandboxEscalationRequest({
  permissions,
  justification,
  effectiveMode,
  isNonWideningEcho,
  validate,
}: {
  permissions: string | undefined,
  justification: string | undefined,
  effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  isNonWideningEcho(permissions: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access'): boolean,
  validate(permissions: any, justification: any): void,
}): {permissions: string, justification: string} | undefined {
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
 */
export function applyPolicy(ctx: Context, config: { agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number, policyTimeoutMs?: number, policyTeardownTimeoutMs?: number, maxActivePolicyChecks?: number, finishLineTimeoutMs?: number, finishLineTeardownTimeoutMs?: number, maxActiveFinishLineRequests?: number, maxSameTurnFinishLineSteers?: number, nilsCompatibilityCandidate?: string, protectedRoots?: string[], dataPolicyOpaqueTools?: string[], managedSessionBridge?: {resolve?: (id:string) => unknown, authenticate?: (id:string, execution:unknown) => Promise<unknown>} } = {}, dshRuntime?: {ENV_OVERRIDES: Record<string, string>, HarnessError: new (...args: any[]) => Error, TOOL_ABORTED: string, createUserMessage(input: any): any, approveEscalation(input: any, context: any): Promise<any>, canonicalPath(path: string): string, isNonWideningSandboxEcho(permissions: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access'): boolean, validateEscalationArgs(permissions: any, justification: any): void}, childPlugins: ReturnType<typeof createChildPluginStatus> = createChildPluginStatus()) {
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
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      'dsh-runtime-kit: authenticated DSH sandbox echo classifier is required',
      { missing: ['@deepseek-ai/dsh-sandbox:isNonWideningSandboxEcho:function'] },
    )
  }
  const dataPolicyEnabled = config.nilsCompatibilityCandidate === DATA_POLICY_CANDIDATE
  if (dataPolicyEnabled
    && typeof ((ctx.tools) as {registerTerminalPolicy?: unknown}).registerTerminalPolicy !== 'function') {
    throw new TypeError('dsh-runtime-kit: authenticated DSH terminal data-policy boundary is required')
  }
  const transport = createNilsTransport(ctx, config)
  const protectedRootConfig = config.protectedRoots ?? []
  if (!Array.isArray(protectedRootConfig)
    || protectedRootConfig.some(root => typeof root !== 'string' || root.length === 0)) {
    throw new TypeError('dsh-runtime-kit: protectedRoots must be an array of non-empty path strings')
  }
  if (protectedRootConfig.length > 0) {
    const sandboxPolicy = ((ctx.get('sandboxPolicy')) as {protect?: (roots: readonly string[]) => () => void} | undefined)
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
    allowsNonRepositoryDelegation: identity => allowsNonRepositoryFinishLineDelegation(
      process.platform,
      resolveManagedSessionPrincipal(ctx, identity.sessionId, config.managedSessionBridge),
    ),
    // Attribute an edit generation to the repository the operation targets.
    // The workspace-lease service already canonicalized and authenticated that
    // target for this exact execution, so the ledger reuses its decision rather
    // than deriving Git identity a second time. An embedder that composed no
    // lease service returns undefined and keeps the session anchor.
    resolveEditRoots: async exec => {
      const service = ((ctx.get('workspaceLease')) as {targets?: (exec: ToolExecution) => Promise<readonly string[]>})
      if (service === undefined || typeof service.targets !== 'function') return undefined
      return service.targets(exec)
    },
    prepareValidationRuntime: async (exec, operation, identity) => {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('dsh-runtime-kit: finish-line-session-missing')
      if (!await ctx.sessions.flush(session)) {
        throw new Error('dsh-runtime-kit: finish-line-session-persistence-unavailable')
      }
      const shell = ((ctx.get('shell')) as {sandboxMode?: string, resolve(request: Record<string, unknown>): Record<string, unknown>} | undefined)
      const shellEnv = ((ctx.get('shellEnv')) as {collect(execution: ToolExecution): Record<string, string>} | undefined)
      if (shell === undefined || shellEnv === undefined) {
        throw new Error('dsh-runtime-kit: finish-line-shell-unavailable')
      }

      let policy: {mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot: string, sessionId?: unknown} | undefined
      if (shell.sandboxMode !== undefined) {
        const service = ((ctx.get('sandboxPolicy')) as {resolve(input: {session: typeof session}): {mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot: string, sessionId?: unknown}} | undefined)
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
          && canonicalPath(spec.workdir) !== canonicalPath(identity.cwd))
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
        runner = { kind: (('unsandboxed') as const) }
      } else if (policy.mode === 'danger-full-access') {
        // This strict runner kind is the native full-host authority profile.
        // Nils may supervise its lifecycle, but must not add a second OS-level
        // permission sandbox around the already selected DSH mode.
        runner = { kind: (('danger-full-access') as const) }
      } else {
        const sandbox = ((ctx.get('sandbox')) as {confine(argv: string[], policy: {mode: 'read-only' | 'workspace-write', workspaceRoot: string, sessionId?: unknown}): {argv: string[], enforcement: 'full' | 'partial', denialSignatures: string[], runnerFailureRules: Array<{allowedExitCodes?: number[], fatalSignatures: string[], informationalLines?: string[]}>}} | undefined)
        if (sandbox === undefined) throw new Error('dsh-runtime-kit: finish-line-sandbox-unavailable')
        const confinedPolicy = ((policy) as {mode: 'read-only' | 'workspace-write', workspaceRoot: string, sessionId?: unknown})
        const confined = sandbox.confine(['bash', '-c', operation.command], confinedPolicy)
        runner = {
          kind: (('confined') as const),
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
  const authorizations: Map<Readonly<ToolExecution>, Authorization> = new Map()
  const toolContexts: Map<Readonly<ToolExecution>, import('@deepseek-ai/dsh-llm').UserMessage[]> = new Map()
  let dataPolicyGenerations: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], string> = new WeakMap()
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
  const authorizedTools: WeakSet<Readonly<ToolExecution>> = new WeakSet()
  let acceptedLifecycleSteps: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], { position: string, promptDigest: string, status: 'pending' | 'accepted', context?: string, settled: Promise<boolean>, resolve: (accepted: boolean) => void }> = new WeakMap()
  let startupEvaluated: WeakSet<import('@deepseek-ai/dsh-agent').Agent['session']> = new WeakSet()
  let evaluatedStops: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], number> = new WeakMap()
  let stopPolicyOutcomes: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, outcome: 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'}> = new WeakMap()
  let stopSteers: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, count: number}> = new WeakMap()
  let stopPipelineOutcomes: WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], {turn: number, outcome: 'acceptance-denied' | 'finish-line-denied' | 'context-invalid' | 'already-evaluated' | 'reservation-unterminalized' | 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled'}> = new WeakMap()
  let closing = false

  const isReviewer = (agent: import('@deepseek-ai/dsh-agent').Agent | undefined) => {
    if (agent === undefined) return false
    const subagents = ((ctx.get('subagents')) as {roleOf?: (agent: import('@deepseek-ai/dsh-agent').Agent) => string | undefined} | undefined)
    const role = subagents?.roleOf?.(agent)
    return role !== undefined && REVIEWER_ROLE_IDS.has(role)
  }

  const dataPolicySource = (name: string) => {
    if (opaqueTools.has(name)) {
      return 'provider.opaque-reference'
    }
    if (name === 'bash' || name === 'pwsh') return 'tool.shell'
    if (name === 'run_code') return 'tool.code'
    if (name.startsWith('mcp_')) return 'tool.mcp'
    if (name === 'web' || name.startsWith('web_') || name.startsWith('web.')) return 'tool.web'
    return 'tool.native'
  }

  const evaluateDataPolicy = async (exec: Readonly<ToolExecution> | Readonly<ToolPersistenceCall>, correlation: {sessionId:string, cwd:string, turn:number, step:number, callId:string, rootCallId:string}, phase: 'pre-call' | 'final-result', payload: unknown, sinkId?: 'tool.execute' | 'session.persist') => {
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

  const appendToolContext = (exec: Readonly<ToolExecution>, message: import('@deepseek-ai/dsh-llm').UserMessage) => {
    const retained = toolContexts.get(exec)
    if (retained === undefined) toolContexts.set(exec, [message])
    else retained.push(message)
  }

  const contextsFor = (exec: Readonly<ToolExecution>) => {
    if (!authorizedTools.has(exec)) return []
    return toolContexts.get(exec) ?? []
  }

  const postBlock = (reason: string, contexts: import('@deepseek-ai/dsh-llm').UserMessage[]) => ({
    kind: (('block') as const),
    feedback: [{
      type: (('text') as const),
      text: `Error: ${reason}`,
    }],
    ...contexts.length === 0 ? {} : { additionalContexts: contexts },
  })

  if (dataPolicyEnabled) {
    const terminalPolicyRuntime = ctx.tools as unknown as ToolTerminalPolicyRuntime
    terminalPolicyRuntime.registerTerminalPolicy({
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
          ? { kind: (('keep') as const) }
          : {
              kind: (('replace') as const),
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
          return { kind: (('accept') as const) }
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
 */

  const steerStop = (agent: import('@deepseek-ai/dsh-agent').Agent, turn: number, outcome: string, text: string) => {
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

  const attachDataPolicyGeneration = (agent: import('@deepseek-ai/dsh-agent').Agent) => {
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
    const withPolicyContext = (context: string | undefined) => context === undefined
      ? downstream
      : {
          ...downstream,
          messages: [...downstream.messages, policyContextMessage(createUserMessage, context)],
        }
    let claim: { position: string, promptDigest: string, status: 'pending' | 'accepted', context?: string, settled: Promise<boolean>, resolve: (accepted: boolean) => void } | undefined
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
      let resolve: (accepted: boolean) => void = () => {}
      const settled = new Promise<boolean>(resolvePromise => { resolve = resolvePromise })
      claim = { position, promptDigest, status: 'pending', settled, resolve }
      acceptedLifecycleSteps.set(session, claim)
    }
    const settleClaim = (accepted: boolean) => {
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
      return { kind: (('reject') as const) }
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
    const recordPipelineOutcome = (outcome: 'acceptance-denied' | 'finish-line-denied' | 'context-invalid' | 'already-evaluated' | 'reservation-unterminalized' | 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled') => {
      stopPipelineOutcomes.set(payload.agent.session, { turn: payload.turn, outcome })
    }
    const recordPolicyOutcome = (outcome: 'allow' | 'context' | 'policy-denied' | 'capability-unavailable' | 'transport-failed' | 'provider-failed' | 'cancelled') => {
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
    target: FsTarget,
    observation: FsObservation,
    actor: object | undefined,
  ) => {
    finishLine.observeFs(target, observation, actor)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (isReviewer(exec.agent)) {
      if (!dataPolicyEnabled) return next()
      const correlation = compatibility.beginTool(exec)
      if (!correlation.ok) return { kind: (('deny') as const), reason: denial(correlation.reason).reason }
      let dataDecision
      try {
        dataDecision = await evaluateDataPolicy(exec, correlation.context, 'pre-call', exec.arguments)
      } catch {
        return { kind: (('deny') as const), reason: denial('data-policy-unavailable').reason }
      }
      if (dataDecision?.kind !== 'data-policy' || dataDecision.decision.action !== 'allow') {
        const code = dataDecision?.kind === 'data-policy'
          ? dataDecision.decision.code
          : dataDecision?.kind === 'deny'
            ? dataDecision.reason
            : 'dsh-runtime-kit:data-policy-unavailable'
        return {
          kind: (('deny') as const),
          reason: code.startsWith('dsh-runtime-kit:') ? code : `dsh-runtime-kit:${code}`,
        }
      }
      return next()
    }
    const identity = authorizationIdentity(exec, transport.admissionEpoch)
    const rememberDenial = (reason: string) => {
      finishLine.reject(exec)
      acceptance.reject(exec)
      prerequisites.reject(exec)
      toolContexts.delete(exec)
      authorizations.set(exec, { kind: 'deny', reason, ...identity })
      return { kind: (('deny') as const), reason }
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
    stopPolicyOutcome(agent: import('@deepseek-ai/dsh-agent').Agent, turn: number) {
      const observed = agent?.session === undefined
        ? undefined
        : stopPolicyOutcomes.get(agent.session)
      return observed !== undefined && observed.turn === turn
        ? observed.outcome
        : undefined
    },
    stopPipelineOutcome(agent: import('@deepseek-ai/dsh-agent').Agent, turn: number) {
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
