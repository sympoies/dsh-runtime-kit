// @ts-check

import { createDshRc7Compatibility } from '../compat/dsh-rc7.js'
import { createRuntimeContextTool } from '../context/index.js'
import { createNilsContextClient } from '../context/nils-context.js'
import { createNilsTransport } from './nils-transport.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionToken} ToolExecutionToken */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolDefinition} ToolDefinition */

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
 * Compose the rc.7 lifecycle adapter, nils transport, and the DSH denial-only
 * guard. The transport effect is registered first so reverse disposal removes
 * every ingress listener and guard before process-tree draining begins.
 *
 * @param {Context} ctx
 * @param {{ agentHook?: string, agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string, contextMaxBytes?: number, contextTimeoutMs?: number, contextTeardownTimeoutMs?: number, maxActiveContextRequests?: number, policyTimeoutMs?: number, policyTeardownTimeoutMs?: number, maxActivePolicyChecks?: number }} config
 */
export function applyPolicy(ctx, config = {}) {
  const transport = createNilsTransport(ctx, config)
  const contextClient = createNilsContextClient(ctx, config)
  const compatibility = createDshRc7Compatibility(ctx)
  /** @type {Map<Readonly<ToolExecution>, Authorization>} */
  const authorizations = new Map()
  let closing = false

  ctx.effect(() => () => {
    closing = true
    authorizations.clear()
    compatibility.dispose()
  }, 'dsh-runtime-kit policy state')

  let plusOneExecutions = 0
  ctx.tools.register(createRuntimeContextTool(contextClient))
  ctx.tools.register(createPlusOneTool(() => { plusOneExecutions += 1 }))

  ctx.on('agent/session-start', payload => {
    compatibility.sessionStart(payload)
  })
  ctx.on('agent/pre-step', (payload, next) => compatibility.preStep(payload, next))
  ctx.on('agent/turn-stopping', payload => {
    compatibility.turnStopping(payload)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const identity = authorizationIdentity(exec, transport.admissionEpoch)
    /** @param {string} reason */
    const rememberDenial = (reason) => {
      authorizations.set(exec, { kind: 'deny', reason, ...identity })
      return { kind: /** @type {const} */ ('deny'), reason }
    }

    const correlation = compatibility.beginTool(exec)
    if (!correlation.ok) {
      return rememberDenial(denial(correlation.reason).reason)
    }
    let decision
    try {
      decision = await transport.evaluate(exec, correlation.context.cwd)
    } catch {
      if (closing) return denial('policy-disposed')
      return rememberDenial(denial('policy-unavailable').reason)
    }
    if (closing) return denial('policy-disposed')
    if (decision !== undefined) return rememberDenial(decision.reason)
    if (exec.signal.aborted) return rememberDenial(denial('policy-caller-aborted').reason)

    authorizations.set(exec, { kind: 'allow', reason: undefined, ...identity })
    let downstream
    try {
      downstream = await next()
    } catch (error) {
      authorizations.delete(exec)
      throw error
    }
    if (downstream.kind !== 'allow' && downstream.kind !== 'ask') {
      authorizations.delete(exec)
    }
    return downstream
  })

  ctx.on('tools/post-execute', (exec, _result, next) => {
    if (!compatibility.postTool(exec)) {
      return Promise.resolve({
        kind: /** @type {const} */ ('block'),
        feedback: [{
          type: /** @type {const} */ ('text'),
          text: `Error: ${denial('policy-correlation-invalid').reason}`,
        }],
      })
    }
    return next()
  })

  ctx.tools.guard((exec) => {
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
    return authorization.kind === 'deny' ? authorization.reason : undefined
  })

  ctx.on('tools/result', (exec) => {
    authorizations.delete(exec)
    compatibility.result(exec)
  })

  ctx.provide('dshRuntimeKit', Object.freeze({
    apiVersion: 1,
    get plusOneExecutions() { return plusOneExecutions },
    get activePolicyChecks() { return transport.active },
    get activeContextRequests() { return contextClient.active },
    get policyTransportDegraded() { return transport.degraded },
    get contextTransportDegraded() { return contextClient.degraded },
    get pendingPolicyMarkers() { return authorizations.size },
    get pendingCorrelations() { return compatibility.pendingCorrelations },
    policyTimeoutMs: transport.timeoutMs,
    policyTeardownTimeoutMs: transport.teardownTimeoutMs,
    maxActivePolicyChecks: transport.maxActive,
    contextMaxBytes: contextClient.maxBytes,
    contextTimeoutMs: contextClient.timeoutMs,
    contextTeardownTimeoutMs: contextClient.teardownTimeoutMs,
    maxActiveContextRequests: contextClient.maxActive,
  }))
}
