// @ts-check

import { createHash } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { createDshRc7Compatibility } from '../compat/dsh-rc7.js'
import { createRuntimeContextTool } from '../context/index.js'
import { createNilsContextClient } from '../context/nils-context.js'
import { createFinishLineCoordinator } from '../finish-line/index.js'
import { createNilsFinishLineClient } from '../finish-line/nils-client.js'
import { createNilsTransport } from './nils-transport.js'
import { createChildPluginStatus, snapshotChildPluginStatus } from '../runtime-status.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-fs').FsObservation} FsObservation */
/** @typedef {import('@deepseek-ai/dsh-fs').FsTarget} FsTarget */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionToken} ToolExecutionToken */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */

const MAX_LIFECYCLE_PROMPT_BYTES = 64 * 1024

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
 * DSH may preserve the effective sandbox mode in a Bash call even when the
 * caller did not request a wider boundary. Treat only that exact, unpaired
 * echo as a no-op; every other shape stays under the native escalation
 * validator.
 *
 * @param {{permissions: string | undefined, justification: string | undefined, effectiveMode: 'read-only' | 'workspace-write' | 'danger-full-access', validate(permissions: any, justification: any): void}} input
 * @returns {{permissions: string, justification: string} | undefined}
 */
export function normalizeSandboxEscalationRequest({
  permissions,
  justification,
  effectiveMode,
  validate,
}) {
  if (permissions === effectiveMode && justification === undefined) return undefined
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
 * @param {{ agentHook?: string, agentHookConfig?: string, agentHookPolicy?: string, agentHookStateDir?: string, agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number, policyTimeoutMs?: number, policyTeardownTimeoutMs?: number, maxActivePolicyChecks?: number, finishLineTimeoutMs?: number, finishLineTeardownTimeoutMs?: number, maxActiveFinishLineRequests?: number, maxSameTurnFinishLineSteers?: number }} config
 * @param {{roleOf(agent: import('@deepseek-ai/dsh-agent').Agent): string | undefined}} [reviewers]
 * @param {{ENV_OVERRIDES: Record<string, string>, HarnessError: new (...args: any[]) => Error, TOOL_ABORTED: string, createUserMessage(input: any): any, approveEscalation(input: any, context: any): Promise<any>, canonicalPath(path: string): string, validateEscalationArgs(permissions: any, justification: any): void}} [dshRuntime]
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
    validateEscalationArgs,
  } = dshRuntime
  const transport = createNilsTransport(ctx, config)
  const contextClient = createNilsContextClient(ctx, config)
  const finishLineClient = createNilsFinishLineClient(ctx, config)
  const finishLine = createFinishLineCoordinator(ctx, {
    client: finishLineClient,
    HarnessError,
    TOOL_ABORTED,
    maxSameTurnSteers: config.maxSameTurnFinishLineSteers,
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
      const spec = shell.resolve({
        command: operation.command,
        workdir,
        ...operation.timeoutMs === undefined ? {} : { timeoutMs: operation.timeoutMs },
        signal: exec.signal,
        dshEnv,
        ...policy === undefined ? {} : { sandboxPolicy: policy },
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
      const timeoutMs = Math.ceil(spec.timeoutMs)
      const outputMaxBytes = Math.min(64 * 1024, Math.floor(spec.stdoutMaxBytes))
      if (timeoutMs > 60 * 60 * 1_000 || outputMaxBytes <= 0) {
        throw new Error('dsh-runtime-kit: finish-line-shell-resolution-invalid')
      }

      let runner
      if (policy === undefined) {
        runner = { kind: /** @type {const} */ ('unsandboxed') }
      } else if (policy.mode === 'danger-full-access') {
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
        timeoutMs,
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
  const compatibility = createDshRc7Compatibility(ctx)
  /** @type {Map<Readonly<ToolExecution>, Authorization>} */
  const authorizations = new Map()
  /** @type {Map<Readonly<ToolExecution>, import('@deepseek-ai/dsh-llm').UserMessage>} */
  const toolContexts = new Map()
  /** @type {WeakSet<Readonly<ToolExecution>>} */
  const authorizedTools = new WeakSet()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], { position: string, promptDigest: string, status: 'pending' | 'accepted', settled: Promise<boolean>, resolve: (accepted: boolean) => void }>} */
  let acceptedLifecycleSteps = new WeakMap()
  /** @type {WeakSet<import('@deepseek-ai/dsh-agent').Agent['session']>} */
  let startupEvaluated = new WeakSet()
  /** @type {WeakMap<import('@deepseek-ai/dsh-agent').Agent['session'], number>} */
  let evaluatedStops = new WeakMap()
  let closing = false

  /** @param {import('@deepseek-ai/dsh-agent').Agent | undefined} agent */
  const isReviewer = agent => agent !== undefined && reviewers?.roleOf(agent) !== undefined

  ctx.effect(() => () => {
    closing = true
    authorizations.clear()
    toolContexts.clear()
    acceptedLifecycleSteps = new WeakMap()
    startupEvaluated = new WeakSet()
    evaluatedStops = new WeakMap()
    compatibility.dispose()
  }, 'dsh-runtime-kit policy state')

  let plusOneExecutions = 0
  ctx.tools.register(createRuntimeContextTool(contextClient))
  ctx.tools.register(createPlusOneTool(() => { plusOneExecutions += 1 }))

  ctx.on('agent/session-start', payload => {
    compatibility.sessionStart(payload)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (isReviewer(agent)) return
    void finishLine.agentDisposed(agent)
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
    /** @type {{ position: string, promptDigest: string, status: 'pending' | 'accepted', settled: Promise<boolean>, resolve: (accepted: boolean) => void } | undefined} */
    let claim
    while (claim === undefined) {
      const current = acceptedLifecycleSteps.get(session)
      if (current?.status === 'pending') {
        const accepted = await current.settled
        if (accepted && current.position === position && current.promptDigest === promptDigest) {
          return downstream
        }
        continue
      }
      if (current?.status === 'accepted'
          && current.position === position
          && current.promptDigest === promptDigest) {
        return downstream
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
    const accepted = policyDecision?.kind === 'context'
      ? {
          ...downstream,
          messages: [...downstream.messages, policyContextMessage(createUserMessage, policyDecision.context)],
        }
      : downstream
    settleClaim(true)
    return accepted
  })
  ctx.on('agent/turn-stopping', async payload => {
    if (isReviewer(payload.agent)) return
    const correlated = compatibility.turnStopping(payload)
    const finishAllowed = await finishLine.turnStopping(payload, correlated)
    if (!finishAllowed || closing || payload.signal.aborted) return
    const stop = compatibility.stopContext(payload)
    if (!stop.ok) return
    if (evaluatedStops.get(payload.agent.session) === payload.turn) return
    let policyDecision
    try {
      policyDecision = await transport.evaluateLifecycle({
        event: 'agent/turn-stopping',
        signal: payload.signal,
        context: stop.context,
      })
    } catch {
      if (!closing && !payload.signal.aborted) {
        payload.agent.steer(policyContextMessage(createUserMessage,
          'The lifecycle policy could not verify the stop boundary. Retry after policy availability is restored.',
        ))
      }
      return
    }
    if (closing || payload.signal.aborted) return
    if (policyDecision?.kind === 'context') {
      payload.agent.steer(policyContextMessage(createUserMessage, policyDecision.context))
      evaluatedStops.set(payload.agent.session, payload.turn)
    } else if (policyDecision === undefined) {
      evaluatedStops.set(payload.agent.session, payload.turn)
    } else {
      payload.agent.steer(policyContextMessage(createUserMessage,
        explicitPolicyDenial(policyDecision)
          ? 'The lifecycle policy blocked this stop boundary. Resolve the reported policy state and retry.'
          : 'The lifecycle policy could not verify the stop boundary. Retry after policy availability is restored.',
      ))
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
    if (isReviewer(exec.agent)) return next()
    const identity = authorizationIdentity(exec, transport.admissionEpoch)
    /** @param {string} reason */
    const rememberDenial = (reason) => {
      toolContexts.delete(exec)
      authorizations.set(exec, { kind: 'deny', reason, ...identity })
      return { kind: /** @type {const} */ ('deny'), reason }
    }

    const correlation = compatibility.beginTool(exec)
    if (!correlation.ok) {
      return rememberDenial(denial(correlation.reason).reason)
    }
    let decision
    try {
      decision = await transport.evaluate(exec, correlation.context)
    } catch {
      if (closing) return denial('policy-disposed')
      return rememberDenial(denial('policy-unavailable').reason)
    }
    if (closing) return denial('policy-disposed')
    if (decision?.kind === 'deny') return rememberDenial(decision.reason)
    if (decision?.kind === 'context') {
      toolContexts.set(exec, policyContextMessage(createUserMessage, decision.context))
    }
    if (exec.signal.aborted) return rememberDenial(denial('policy-caller-aborted').reason)

    const finishReservation = await finishLine.begin(exec, correlation.context)
    if (!finishReservation.ok) {
      return rememberDenial(denial(finishReservation.reason ?? 'finish-line-unavailable').reason)
    }
    if (closing) return denial('policy-disposed')
    if (exec.signal.aborted) return rememberDenial(denial('policy-caller-aborted').reason)

    authorizations.set(exec, { kind: 'allow', reason: undefined, ...identity })
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      authorizations.delete(exec)
      toolContexts.delete(exec)
      throw error
    }
    if (downstream.kind !== 'allow' && downstream.kind !== 'ask') {
      authorizations.delete(exec)
      toolContexts.delete(exec)
    }
    return downstream
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (isReviewer(exec.agent)) return next()
    if (!compatibility.postTool(exec)) {
      toolContexts.delete(exec)
      return {
        kind: /** @type {const} */ ('block'),
        feedback: [{
          type: /** @type {const} */ ('text'),
          text: `Error: ${denial('policy-correlation-invalid').reason}`,
        }],
      }
    }
    const correlation = compatibility.correlation(exec.token)
    if (correlation === undefined) {
      toolContexts.delete(exec)
      return {
        kind: /** @type {const} */ ('block'),
        feedback: [{
          type: /** @type {const} */ ('text'),
          text: `Error: ${denial('policy-correlation-invalid').reason}`,
        }],
      }
    }
    let policyDecision
    try {
      policyDecision = await transport.evaluatePost(exec, result, correlation)
    } catch {
      toolContexts.delete(exec)
      return {
        kind: /** @type {const} */ ('block'),
        feedback: [{
          type: /** @type {const} */ ('text'),
          text: `Error: ${denial('policy-unavailable').reason}`,
        }],
      }
    }
    if (closing || policyDecision?.kind === 'deny') {
      toolContexts.delete(exec)
      const reason = closing
        ? denial('policy-disposed').reason
        : policyDecision?.kind === 'deny'
          ? policyDecision.reason
          : denial('policy-unavailable').reason
      return {
        kind: /** @type {const} */ ('block'),
        feedback: [{
          type: /** @type {const} */ ('text'),
          text: `Error: ${reason}`,
        }],
      }
    }
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      toolContexts.delete(exec)
      throw error
    }
    const context = policyDecision?.kind === 'context'
      ? policyContextMessage(createUserMessage, policyDecision.context)
      : authorizedTools.has(exec) ? toolContexts.get(exec) : undefined
    toolContexts.delete(exec)
    return context === undefined
      ? downstream
      : {
          ...downstream,
          additionalContexts: [
            ...downstream.additionalContexts ?? [],
            context,
          ],
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
    return routed.kind === 'delegate' ? next() : routed.result
  })

  ctx.on('tools/result', (exec, result) => {
    if (isReviewer(exec.agent)) return
    authorizations.delete(exec)
    toolContexts.delete(exec)
    finishLine.result(exec, result)
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
    get contextTransportDegraded() { return contextClient.degraded },
    get finishLineTransportDegraded() { return finishLineClient.degraded },
    get finishLineDegraded() { return finishLine.degraded },
    get pendingPolicyMarkers() { return authorizations.size },
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
