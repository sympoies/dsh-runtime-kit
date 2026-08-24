// @ts-check

import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { dshRc7SessionHeader } from '../compat/dsh-rc7.js'
import { createCliClient } from '../main-agent/cli-client.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */

const READINESS_ENVELOPE_SCHEMA = 'cli.main-agent.self-readiness.v1'
const READINESS_SCHEMA = 'main-agent.runtime-readiness.v1'
const AGENT_SESSION_BASENAME = 'agent-session'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
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
 * @param {{bind?: (id:string, principal:unknown) => (() => void)}} bridge
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
  /** @type {Map<string, Promise<Readonly<{principal: Readonly<{sessionId:string, environment:Readonly<Record<string,string>>}>, dispose: () => void}>>>} */
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
    if (pending !== undefined) return pending
    const authentication = (async () => {
      if (exec?.agent === null
        || typeof exec?.agent !== 'object'
        || disposedAgents.has(exec.agent)) {
        throw new Error('dsh-runtime-kit: managed session agent unavailable')
      }
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
      ], { cwd, signal: exec.signal, env: candidate })
      if (!result.ok
        || result.envelope.schema_version !== READINESS_ENVELOPE_SCHEMA
        || result.envelope.ok !== true) {
        throw new Error('dsh-runtime-kit: managed session readiness unavailable')
      }
      const readiness = result.envelope.data
      const trustedHelper = await trustedAgentSessionCli(exec.signal)
      let helperMatches = false
      try {
        helperMatches = trustedHelper !== undefined
          && realpathSync(candidate.AGENT_SESSION_BIN) === realpathSync(trustedHelper)
      } catch {
        helperMatches = false
      }
      if (readiness?.schema_version !== READINESS_SCHEMA
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
      const principal = Object.freeze({
        sessionId: candidate.AGENT_SESSION_ID,
        environment: candidate,
      })
      const dispose = bridge.bind?.(providerSessionId, principal)
      if (typeof dispose !== 'function') {
        throw new Error('dsh-runtime-kit: managed session bridge unavailable')
      }
      if (closing || exec.signal?.aborted || disposedAgents.has(exec.agent)) {
        dispose()
        throw new Error('dsh-runtime-kit: managed session authentication interrupted')
      }
      const binding = Object.freeze({ principal, dispose })
      bindings.set(providerSessionId, binding)
      return binding
    })()
    authenticating.set(providerSessionId, authentication)
    try {
      return await authentication
    } finally {
      if (authenticating.get(providerSessionId) === authentication) {
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

  ctx.effect(() => () => {
    closing = true
    authenticating.clear()
    for (const providerSessionId of [...bindings.keys()]) release(providerSessionId)
  }, 'dsh-runtime-kit managed session authentication')

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== null && typeof agent === 'object') disposedAgents.add(agent)
    const sessionId = dshRc7SessionHeader(agent).id
    if (typeof sessionId === 'string') release(sessionId)
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
