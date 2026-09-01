// @ts-check

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { dshRc7SessionHeader } from '../compat/dsh-rc7.js'
import { createCliClient } from '../main-agent/cli-client.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */

const READINESS_ENVELOPE_SCHEMA = 'cli.main-agent.self-readiness.v1'
const READINESS_SCHEMA = 'main-agent.runtime-readiness.v1'
const WORK_CONTEXT_SET_ENVELOPE_SCHEMA = 'cli.agent-session.work-context-set.v1'
const WORK_CONTEXT_SET_SCHEMA = 'agent-session.work-context-set-result.v1'
const WORK_CONTEXT_SCHEMA = 'agent-session.work-context.v1'
const CONFLICT_EVALUATION_SCHEMA = 'agent-session.conflict-evaluation.v1'
const BASELINE_SCOPE_UNAVAILABLE = new Set([
  'repository-unavailable',
  'uncovered-mutation-scope',
])
const BASELINE_INTENT = 'project-dev'
const BASELINE_TIER = 'L2'
const BASELINE_SUMMARY = 'DSH project-dev session'
const AGENT_SESSION_BASENAME = 'agent-session'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const CONFLICT_CLASSIFICATIONS = new Set([
  'conflict',
  'potential_conflict',
  'unknown',
  'no_known_conflict',
  'clear',
])
const PRINCIPAL_ENV_KEYS = Object.freeze([
  'AGENT_SESSION_ID',
  'AGENT_SESSION_RUNTIME_ID',
  'AGENT_SESSION_STATE_DIR',
  'AGENT_SESSION_COORDINATION_MODE',
  'AGENT_SESSION_CAPABILITY_FILE',
  'AGENT_SESSION_CHECKPOINT_FILE',
  'AGENT_SESSION_BIN',
])

/** @param {Readonly<NodeJS.ProcessEnv>} environment */
function hasManagedSessionCandidate(environment) {
  // Partial AGENT_SESSION_* values are also used as subprocess-isolation
  // sentinels. Only a complete producer principal may enter authentication.
  return PRINCIPAL_ENV_KEYS.every(
    name => typeof environment[name] === 'string' && environment[name].length > 0,
  )
}

/** @param {Readonly<NodeJS.ProcessEnv>} environment */
function selectCandidateEnvironment(environment) {
  /** @type {Record<string, string>} */
  const selected = {}
  for (const name of PRINCIPAL_ENV_KEYS) {
    const value = environment[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('dsh-runtime-kit: managed session principal unavailable')
    }
    selected[name] = value
  }
  return Object.freeze(selected)
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {number} maximum */
function isBoundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum
}

/** @param {unknown} value */
function validPublicWorkContext(value) {
  if (!isRecord(value)) return false
  const context = /** @type {Record<string, any>} */ (value)
  return context.schema_version === WORK_CONTEXT_SCHEMA
    && SESSION_ID.test(context.session_id ?? '')
    && isBoundedText(context.session_incarnation, 256)
    && CLAIM_ID.test(context.claim_id ?? '')
    && Number.isSafeInteger(context.revision)
    && context.revision > 0
    && context.state === 'active'
    && isBoundedText(context.intent, 64)
    && isBoundedText(context.tier, 16)
    && isBoundedText(context.summary, 240)
    && Array.isArray(context.repositories)
    && Array.isArray(context.worktrees)
    && Array.isArray(context.provider_refs)
    && Array.isArray(context.plan_refs)
    && Array.isArray(context.scopes)
    && isBoundedText(context.updated_at, 64)
    && isBoundedText(context.expires_at, 64)
}

/** @param {unknown} value */
function validConflictEvaluation(value) {
  if (!isRecord(value)) return false
  const evaluation = /** @type {Record<string, any>} */ (value)
  return evaluation.schema_version === CONFLICT_EVALUATION_SCHEMA
    && CONFLICT_CLASSIFICATIONS.has(evaluation.classification)
    && typeof evaluation.complete === 'boolean'
    && Array.isArray(evaluation.reasons)
    && Array.isArray(evaluation.peers)
}

/**
 * @param {unknown} envelope
 * @param {Readonly<Record<string, string>>} candidate
 */
function validBaselineClaim(envelope, candidate) {
  if (!isRecord(envelope)) return false
  const outer = /** @type {Record<string, any>} */ (envelope)
  const data = outer.data
  if (outer.schema_version !== WORK_CONTEXT_SET_ENVELOPE_SCHEMA
    || outer.ok !== true
    || !isRecord(data)) {
    return false
  }
  const context = data.context
  return data.schema_version === WORK_CONTEXT_SET_SCHEMA
    && typeof data.changed === 'boolean'
    && validPublicWorkContext(context)
    && context.session_id === candidate.AGENT_SESSION_ID
    && context.session_incarnation === candidate.AGENT_SESSION_RUNTIME_ID
    && validConflictEvaluation(data.evaluation)
    && data.mode === candidate.AGENT_SESSION_COORDINATION_MODE
    && (data.changed === false
      || (context.intent === BASELINE_INTENT
        && context.tier === BASELINE_TIER
        && context.summary === BASELINE_SUMMARY))
}

/**
 * A managed Agent Console may intentionally start outside a repository (for
 * example from the operator's home directory). The principal is still valid,
 * but nils cannot create the optional project baseline until a repository is
 * selected. Accept only the released, typed work-context failures for that
 * condition; every transport, schema, storage, and claim failure stays closed.
 *
 * @param {unknown} envelope
 */
function baselineScopeUnavailableCode(envelope) {
  if (!isRecord(envelope)) return undefined
  const outer = /** @type {Record<string, any>} */ (envelope)
  return outer.schema_version === WORK_CONTEXT_SET_ENVELOPE_SCHEMA
    && outer.ok === false
    && isRecord(outer.error)
    && BASELINE_SCOPE_UNAVAILABLE.has(outer.error.code)
    && isBoundedText(outer.error.message, 512)
    ? /** @type {'repository-unavailable' | 'uncovered-mutation-scope'} */ (outer.error.code)
    : undefined
}

/** @param {number} deadlineAt */
function remainingAuthenticationMs(deadlineAt) {
  const remaining = Math.floor(deadlineAt - Date.now())
  if (remaining <= 0) {
    throw new Error('dsh-runtime-kit: managed session authentication deadline exceeded')
  }
  return remaining
}

/**
 * Authenticate the top-level Agent Console principal before the always-on
 * policy middleware runs. This boundary cannot live behind the optional Main
 * Agent child plugin: an ordinary single-agent turn may reach its first
 * pre-step while that child is still pending activation.
 *
 * @param {Context} ctx
 * @param {{
 *   mainAgentCli?: string,
 *   agentSessionCli?: string,
 *   cliTimeoutMs?: number,
 *   cliTeardownTimeoutMs?: number,
 *   maxActiveCliCalls?: number,
 * }} config
 * @param {{bind?: (id:string, principal:unknown) => (() => void), registerAuthenticator?: (candidate:(id:string, execution:unknown) => Promise<unknown>) => (() => void)}} bridge
 * @param {Readonly<NodeJS.ProcessEnv>} [environment]
 */
export function applyManagedSessionAuthentication(
  ctx,
  config,
  bridge,
  environment = process.env,
) {
  const mainAgentCli = typeof config.mainAgentCli === 'string' && config.mainAgentCli.length > 0
    ? config.mainAgentCli
    : 'main-agent'
  const agentSessionCli = typeof config.agentSessionCli === 'string'
    && config.agentSessionCli.length > 0
    ? config.agentSessionCli
    : isAbsolute(mainAgentCli)
      ? resolve(dirname(mainAgentCli), AGENT_SESSION_BASENAME)
      : AGENT_SESSION_BASENAME
  const client = createCliClient(ctx, config)
  /** @type {Map<string, Readonly<{principal: Readonly<{sessionId:string, environment:Readonly<Record<string,string>>}>, dispose: () => void}>>} */
  const bindings = new Map()
  /** @type {Map<string, Readonly<{
   *   agent: object,
   *   controller: AbortController,
   *   promise: Promise<Readonly<{principal: Readonly<{sessionId:string, environment:Readonly<Record<string,string>>}>, dispose: () => void}>>,
   * }>>} */
  const authenticating = new Map()
  /** @type {WeakSet<object>} */
  const disposedAgents = new WeakSet()
  let closing = false

  /** @param {AbortSignal | undefined} signal */
  const trustedAgentSessionCli = async (signal) => {
    if (isAbsolute(agentSessionCli)) return agentSessionCli
    try {
      const executable = await ctx.subprocess.resolveExecutable(agentSessionCli, undefined, signal)
      return isAbsolute(executable) ? executable : undefined
    } catch {
      return undefined
    }
  }

  /** @param {string} providerSessionId @param {any} exec */
  const authenticate = async (providerSessionId, exec) => {
    const existing = bindings.get(providerSessionId)
    if (existing !== undefined) return existing
    const pending = authenticating.get(providerSessionId)
    if (pending !== undefined) return pending.promise
    if (exec?.agent === null
      || typeof exec?.agent !== 'object'
      || disposedAgents.has(exec.agent)) {
      throw new Error('dsh-runtime-kit: managed session agent unavailable')
    }
    const controller = new AbortController()
    const onExecAbort = () => controller.abort(exec.signal?.reason)
    exec.signal?.addEventListener('abort', onExecAbort, { once: true })
    if (exec.signal?.aborted) controller.abort(exec.signal.reason)
    const deadlineAt = Date.now() + client.timeoutMs
    const deadlineTimer = setTimeout(() => {
      controller.abort(new Error('dsh-runtime-kit managed session authentication deadline exceeded'))
    }, client.timeoutMs)
    const authentication = (async () => {
      const candidate = selectCandidateEnvironment(environment)
      const cwd = dshRc7SessionHeader(exec?.agent).cwd
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        throw new Error('dsh-runtime-kit: managed session cwd unavailable')
      }
      const result = await client.run([
        mainAgentCli,
        'self',
        'readiness',
        '--format',
        'json',
      ], {
        cwd,
        signal: controller.signal,
        timeoutMs: remainingAuthenticationMs(deadlineAt),
        env: candidate,
      })
      if (!result.ok
        || result.envelope.schema_version !== READINESS_ENVELOPE_SCHEMA
        || result.envelope.ok !== true) {
        throw new Error('dsh-runtime-kit: managed session readiness unavailable')
      }
      const readiness = result.envelope.data
      const trustedHelper = await trustedAgentSessionCli(controller.signal)
      let helperMatches = false
      try {
        helperMatches = trustedHelper !== undefined
          && realpathSync(candidate.AGENT_SESSION_BIN) === realpathSync(trustedHelper)
      } catch {
        helperMatches = false
      }
      if (trustedHelper === undefined
        || readiness?.schema_version !== READINESS_SCHEMA
        || readiness.ready !== true
        || readiness.session_id !== candidate.AGENT_SESSION_ID
        || readiness.session_incarnation !== candidate.AGENT_SESSION_RUNTIME_ID
        || readiness.checkpoint_file !== candidate.AGENT_SESSION_CHECKPOINT_FILE
        || !SESSION_ID.test(candidate.AGENT_SESSION_ID)
        || !isAbsolute(candidate.AGENT_SESSION_STATE_DIR)
        || !isAbsolute(candidate.AGENT_SESSION_CAPABILITY_FILE)
        || !isAbsolute(candidate.AGENT_SESSION_CHECKPOINT_FILE)
        || !isAbsolute(candidate.AGENT_SESSION_BIN)
        || !helperMatches) {
        throw new Error('dsh-runtime-kit: managed session principal invalid')
      }
      if (closing || controller.signal.aborted || disposedAgents.has(exec.agent)) {
        throw new Error('dsh-runtime-kit: managed session authentication interrupted')
      }
      const baseline = await client.run([
        trustedHelper,
        'work-context',
        'set',
        '--if-absent',
        '--intent',
        BASELINE_INTENT,
        '--tier',
        BASELINE_TIER,
        '--summary',
        BASELINE_SUMMARY,
        '--format',
        'json',
      ], {
        cwd,
        signal: controller.signal,
        timeoutMs: remainingAuthenticationMs(deadlineAt),
        env: candidate,
      })
      const baselineFailureCode = baseline.ok
        ? baselineScopeUnavailableCode(baseline.envelope)
        : undefined
      if (!baseline.ok
        || (!validBaselineClaim(baseline.envelope, candidate)
          && baselineFailureCode === undefined)) {
        throw new Error('dsh-runtime-kit: managed session baseline claim unavailable')
      }
      const principal = Object.freeze({
        sessionId: candidate.AGENT_SESSION_ID,
        environment: candidate,
        ...(baselineFailureCode === undefined ? {} : { baselineFailureCode }),
      })
      const dispose = bridge.bind?.(providerSessionId, principal)
      if (typeof dispose !== 'function') {
        throw new Error('dsh-runtime-kit: managed session bridge unavailable')
      }
      if (closing || controller.signal.aborted || disposedAgents.has(exec.agent)) {
        dispose()
        throw new Error('dsh-runtime-kit: managed session authentication interrupted')
      }
      const binding = Object.freeze({ principal, dispose })
      bindings.set(providerSessionId, binding)
      return binding
    })()
    const record = Object.freeze({ agent: exec.agent, controller, promise: authentication })
    authenticating.set(providerSessionId, record)
    try {
      return await authentication
    } finally {
      clearTimeout(deadlineTimer)
      exec.signal?.removeEventListener('abort', onExecAbort)
      if (authenticating.get(providerSessionId) === record) {
        authenticating.delete(providerSessionId)
      }
    }
  }

  /** @param {string} providerSessionId */
  const release = (providerSessionId) => {
    const binding = bindings.get(providerSessionId)
    if (binding === undefined) return
    bindings.delete(providerSessionId)
    binding.dispose()
  }

  const disposeAuthenticator = bridge.registerAuthenticator?.(async (providerSessionId, execution) => {
    if (!hasManagedSessionCandidate(environment)) return undefined
    const binding = await authenticate(providerSessionId, execution)
    return binding.principal
  })

  ctx.effect(() => () => {
    closing = true
    disposeAuthenticator?.()
    for (const pending of authenticating.values()) {
      pending.controller.abort(new Error('dsh-runtime-kit managed session authentication disposed'))
    }
    for (const providerSessionId of [...bindings.keys()]) release(providerSessionId)
  }, 'dsh-runtime-kit managed session authentication')

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== null && typeof agent === 'object') disposedAgents.add(agent)
    const sessionId = dshRc7SessionHeader(agent).id
    if (typeof sessionId === 'string') {
      const pending = authenticating.get(sessionId)
      if (pending?.agent === agent) {
        pending.controller.abort(new Error('dsh-runtime-kit managed session agent disposed'))
      }
      release(sessionId)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const { id: sessionId, parentSession } = dshRc7SessionHeader(payload?.agent)
    if (typeof sessionId !== 'string'
      || sessionId.length === 0
      || (typeof parentSession === 'string' && parentSession.length > 0)
      || !hasManagedSessionCandidate(environment)) {
      return next()
    }
    try {
      await authenticate(sessionId, payload)
    } catch {
      return {
        kind: /** @type {const} */ ('reject'),
        reason: 'dsh-runtime-kit:managed-session-authentication-failed',
      }
    }
    return next()
  })
}
