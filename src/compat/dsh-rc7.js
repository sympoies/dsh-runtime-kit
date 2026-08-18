// @ts-check

import { isAbsolute } from 'node:path'

/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-agent').PreStepDecision} PreStepDecision */
/** @typedef {import('@deepseek-ai/dsh-agent').SessionStartSource} SessionStartSource */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecution} ToolExecution */
/** @typedef {import('@deepseek-ai/dsh-tools').ToolExecutionToken} ToolExecutionToken */

/**
 * @typedef DurablePosition
 * @property {number | undefined} turn
 * @property {number | undefined} step
 */

/**
 * @typedef SessionContext
 * @property {string} sessionId
 * @property {Agent['session']} session
 * @property {string | undefined} cwd
 * @property {SessionStartSource | 'attached' | 'observed'} source
 * @property {number | undefined} turn
 * @property {number | undefined} step
 * @property {number | undefined} durableTurn
 * @property {number | undefined} durableStep
 * @property {number} eventCount
 * @property {Agent['session']['events'][number] | undefined} lastEvent
 * @property {boolean} historyValid
 */

/**
 * @typedef CallContext
 * @property {ToolExecutionToken} token
 * @property {string} sessionId
 * @property {string} cwd
 * @property {number} turn
 * @property {number} step
 * @property {string} callId
 * @property {string} rootCallId
 * @property {string} name
 */

/** @typedef {{ ok: false, reason: string } | { ok: true, context: Readonly<CallContext> }} BeginToolResult */

/** @param {unknown} value @returns {value is number} */
function validPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** @param {Agent} agent */
function sessionIdentity(agent) {
  const id = String(agent?.id ?? '')
  const headerId = String(agent?.session?.header?.id ?? id)
  if (id.length === 0 || headerId !== id) return undefined
  const cwd = agent.session.header.cwd
  return {
    sessionId: id,
    cwd: typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined,
  }
}

/** @param {Agent['session']['events']} events */
function deriveOpenPosition(events) {
  /** @type {number | undefined} */
  let candidateTurn
  /** @type {number | undefined} */
  let candidateStep
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const data = /** @type {Record<string, unknown>} */ (event.data)
    if (candidateTurn !== undefined) {
      if (event.type === 'turn/end') return { turn: undefined, step: undefined }
      if (event.type === 'turn/start') {
        return data.turn === candidateTurn
          ? { turn: candidateTurn, step: candidateStep }
          : { turn: undefined, step: undefined }
      }
      continue
    }
    switch (event.type) {
      case 'turn/end':
        return { turn: undefined, step: undefined }
      case 'turn/start':
        return validPositiveInteger(data.turn)
          ? { turn: data.turn, step: undefined }
          : { turn: undefined, step: undefined }
      case 'step/start':
        if (!validPositiveInteger(data.turn) || !validPositiveInteger(data.step)) {
          return { turn: undefined, step: undefined }
        }
        candidateTurn = data.turn
        candidateStep = data.step
        break
      case 'step/end':
        if (!validPositiveInteger(data.turn)) {
          return { turn: undefined, step: undefined }
        }
        candidateTurn = data.turn
        candidateStep = undefined
        break
    }
  }
  return { turn: undefined, step: undefined }
}

/**
 * Incrementally fold only the lifecycle facts accepted by the rc.7 session.
 * Any malformed or out-of-order lifecycle event fails closed; unrelated
 * content-bearing events do not enter the retained position.
 *
 * @param {DurablePosition} position
 * @param {Agent['session']['events'][number]} event
 * @returns {DurablePosition}
 */
function foldLifecycleEvent(position, event) {
  const data = /** @type {Record<string, unknown>} */ (event.data)
  switch (event.type) {
    case 'turn/start':
      return validPositiveInteger(data.turn)
        ? { turn: data.turn, step: undefined }
        : { turn: undefined, step: undefined }
    case 'turn/end':
      return { turn: undefined, step: undefined }
    case 'step/start':
      return validPositiveInteger(data.turn)
        && validPositiveInteger(data.step)
        && position.turn === data.turn
        ? { turn: data.turn, step: data.step }
        : { turn: undefined, step: undefined }
    case 'step/end':
      return validPositiveInteger(data.turn)
        && validPositiveInteger(data.step)
        && position.turn === data.turn
        && position.step === data.step
        ? { turn: data.turn, step: undefined }
        : { turn: undefined, step: undefined }
    default:
      return position
  }
}

/**
 * Isolate the DeepSeek Harness rc.7 lifecycle vocabulary and retain only
 * content-free correlation facts. Prompt messages, tool arguments, candidate
 * results, and final result bodies never enter this adapter's state.
 *
 * @param {{ agents?: { list(): Agent[] } }} ctx
 */
export function createDshRc7Compatibility(ctx) {
  /** @type {WeakMap<Agent, SessionContext>} */
  let sessions = new WeakMap()
  /** @type {Map<Readonly<ToolExecution>, Readonly<CallContext>>} */
  const calls = new Map()
  /** @type {Map<ToolExecutionToken, Readonly<ToolExecution>>} */
  const tokenOwners = new Map()
  /** @type {Map<Readonly<ToolExecution>, Agent['session']>} */
  const callSessions = new Map()
  let open = true

  /**
   * @param {Agent} agent
   * @param {SessionContext['source']} source
   */
  function attach(agent, source) {
    if (!open || typeof agent !== 'object' || agent === null) return undefined
    const identity = sessionIdentity(agent)
    if (identity === undefined) return undefined
    const events = agent.session.events ?? []
    const position = deriveOpenPosition(events)
    /** @type {SessionContext} */
    const context = {
      ...identity,
      session: agent.session,
      source,
      ...position,
      durableTurn: position.turn,
      durableStep: position.step,
      eventCount: events.length,
      lastEvent: events.at(-1),
      historyValid: true,
    }
    sessions.set(agent, context)
    return context
  }

  /** @param {Agent} agent @param {SessionContext} context */
  function refreshPosition(agent, context) {
    const events = agent.session.events ?? []
    const eventCount = events.length
    if (!context.historyValid || context.session !== agent.session) {
      context.turn = undefined
      context.step = undefined
      return { turn: undefined, step: undefined }
    }
    const appendOnly = eventCount >= context.eventCount
      && (context.eventCount === 0
        || events[context.eventCount - 1] === context.lastEvent)
    /** @type {DurablePosition} */
    let position
    if (appendOnly) {
      position = { turn: context.durableTurn, step: context.durableStep }
      for (let index = context.eventCount; index < eventCount; index += 1) {
        const event = events[index]
        if (event !== undefined) position = foldLifecycleEvent(position, event)
      }
    } else {
      // rc.7 exposes immutable snapshots of one private append-only log. A
      // missing prefix anchor therefore invalidates this attachment rather
      // than authorizing from a replaced or truncated history.
      context.historyValid = false
      position = { turn: undefined, step: undefined }
    }
    context.eventCount = eventCount
    context.lastEvent = events.at(-1)
    context.durableTurn = position.turn
    context.durableStep = position.step
    context.turn = position.turn
    context.step = position.step
    return position
  }

  for (const agent of ctx.agents?.list?.() ?? []) attach(agent, 'attached')

  return Object.freeze({
    /** @param {{ agent: Agent, source: SessionStartSource }} payload */
    sessionStart(payload) {
      attach(payload.agent, payload.source)
    },

    /**
     * @param {{ agent: Agent, messages: unknown[], turn: number, step: number, signal: AbortSignal }} payload
     * @param {() => Promise<PreStepDecision>} next
     * @returns {Promise<PreStepDecision>}
     */
    async preStep(payload, next) {
      const stored = sessions.get(payload.agent)
      const context = stored === undefined || stored.session !== payload.agent.session
        ? attach(payload.agent, 'observed')
        : stored
      try {
        const decision = await next()
        if (context !== undefined) {
          if (context.historyValid
            && decision.kind === 'enter'
            && !payload.signal.aborted
            && validPositiveInteger(payload.turn)
            && validPositiveInteger(payload.step)) {
            context.turn = payload.turn
            context.step = payload.step
          } else {
            refreshPosition(payload.agent, context)
          }
        }
        return decision
      } catch (error) {
        if (context !== undefined) refreshPosition(payload.agent, context)
        throw error
      }
    },

    /** @param {ToolExecution} exec @returns {BeginToolResult} */
    beginTool(exec) {
      if (!open) return { ok: false, reason: 'policy-disposed' }
      if (exec.agent === undefined) return { ok: false, reason: 'policy-agent-missing' }
      const stored = sessions.get(exec.agent)
      const session = stored !== undefined && stored.session !== exec.agent.session
        ? attach(exec.agent, 'observed')
        : stored
      const identity = sessionIdentity(exec.agent)
      if (session === undefined || identity === undefined
        || session.sessionId !== identity.sessionId) {
        return { ok: false, reason: 'policy-session-missing' }
      }
      if (identity.cwd === undefined || session.cwd !== identity.cwd) {
        return { ok: false, reason: 'policy-cwd-invalid' }
      }
      const { turn, step } = refreshPosition(exec.agent, session)
      if (!validPositiveInteger(turn) || !validPositiveInteger(step)) {
        return { ok: false, reason: 'policy-step-missing' }
      }
      if (typeof exec.token !== 'symbol'
        || typeof exec.callId !== 'string' || exec.callId.length === 0
        || typeof exec.rootCallId !== 'string' || exec.rootCallId.length === 0
        || typeof exec.name !== 'string' || exec.name.length === 0
        || calls.has(exec) || tokenOwners.has(exec.token)) {
        return { ok: false, reason: 'policy-correlation-invalid' }
      }
      /** @type {Readonly<CallContext>} */
      const call = Object.freeze({
        token: exec.token,
        sessionId: session.sessionId,
        cwd: identity.cwd,
        turn,
        step,
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        name: exec.name,
      })
      calls.set(exec, call)
      tokenOwners.set(exec.token, exec)
      callSessions.set(exec, exec.agent.session)
      return { ok: true, context: call }
    },

    /** @param {ToolExecution | Readonly<ToolExecution>} exec */
    matchesTool(exec) {
      const call = calls.get(exec)
      if (call === undefined || exec.agent === undefined) return false
      const session = sessions.get(exec.agent)
      const identity = sessionIdentity(exec.agent)
      const position = session === undefined
        ? { turn: undefined, step: undefined }
        : refreshPosition(exec.agent, session)
      return session !== undefined
        && session.session === exec.agent.session
        && callSessions.get(exec) === exec.agent.session
        && identity !== undefined
        && session.sessionId === identity.sessionId
        && session.cwd === identity.cwd
        && call.sessionId === identity.sessionId
        && call.cwd === identity.cwd
        && call.sessionId === session.sessionId
        && call.cwd === session.cwd
        && call.turn === position.turn
        && call.step === position.step
        && call.token === exec.token
        && call.callId === exec.callId
        && call.rootCallId === exec.rootCallId
        && call.name === exec.name
    },

    /**
     * The candidate post-tool result is deliberately not accepted here. Only
     * execution identity is observed at this non-authoritative boundary.
     * @param {ToolExecution} exec
     */
    postTool(exec) {
      return this.matchesTool(exec)
    },

    /** @param {Readonly<ToolExecution>} exec */
    result(exec) {
      const call = calls.get(exec)
      const matched = this.matchesTool(exec)
      calls.delete(exec)
      if (call !== undefined && tokenOwners.get(call.token) === exec) {
        tokenOwners.delete(call.token)
      }
      callSessions.delete(exec)
      return matched
    },

    /** @param {{ agent: Agent, turn: number, signal: AbortSignal }} payload */
    turnStopping(payload) {
      const session = sessions.get(payload.agent)
      if (session !== undefined && session.session === payload.agent.session) {
        refreshPosition(payload.agent, session)
      }
      const matched = session !== undefined
        && session.session === payload.agent.session
        && session.historyValid
        && session.turn === payload.turn
      if (matched) session.step = undefined
      return matched
    },

    /** @param {ToolExecutionToken} token */
    correlation(token) {
      const owner = tokenOwners.get(token)
      return owner === undefined ? undefined : calls.get(owner)
    },

    get pendingCorrelations() {
      return calls.size
    },

    dispose() {
      open = false
      calls.clear()
      tokenOwners.clear()
      callSessions.clear()
      sessions = new WeakMap()
    },
  })
}
