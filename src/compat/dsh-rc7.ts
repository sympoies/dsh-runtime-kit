import { isAbsolute } from 'node:path'
import { loadDshRc7Runtime } from './contract.js'

/**
 * Isolate the rc.7 Agent session-header shape used by optional integrations.
 * Validation stays with each consumer; this adapter only owns field routing so
 * a future Harness rc changes one compatibility seam.
 */
export function dshRc7SessionHeader(agent: unknown): Readonly<{id?: string, parentSession?: string, cwd?: string}>  {
  const header = ((agent) as any)?.session?.header
  if (header === null || typeof header !== 'object') return Object.freeze({})
  return Object.freeze({
    ...typeof header.id === 'string' ? { id: header.id } : {},
    ...typeof header.parentSession === 'string'
      ? { parentSession: header.parentSession }
      : {},
    ...typeof header.cwd === 'string' ? { cwd: header.cwd } : {},
  })
}

/**
 * Resolve the child-local Agent from the exact value supplied by the
 * authenticated continuation setup seam. Older patched releases supplied
 * only the context and retain the legacy direct property as a fallback.
 */
export function dshRc7ContextAgent(context: unknown, supplied?: unknown): unknown {
  if (supplied !== undefined) return supplied
  if (context === null || typeof context !== 'object') return undefined
  return ((context) as any).agent
}

/** Resolve one named child-context service through Cordis reflection. */
export function dshRc7ContextService(context: unknown, name: string): unknown {
  if (context === null || typeof context !== 'object') return undefined
  const get = ((context) as any).get
  if (typeof get === 'function') return get.call(context, name)
  return ((context) as any)[name]
}

export function dshRc7AgentRoute(agent: unknown): Readonly<{provider?: string, model?: string, reasoningEffort?: string}>  {
  const options = ((agent) as any)?.options
  if (options === null || typeof options !== 'object') return Object.freeze({})
  const session = ((agent) as any)?.session
  const requestHeader = typeof session?.requestHeader === 'function'
    ? session.requestHeader()
    : undefined
  const requestConfig = requestHeader !== null && typeof requestHeader === 'object'
    ? requestHeader.config
    : undefined
  return Object.freeze({
    ...typeof requestConfig?.provider === 'string'
      ? { provider: requestConfig.provider }
      : typeof options.provider === 'string' ? { provider: options.provider } : {},
    ...typeof requestConfig?.model === 'string'
      ? { model: requestConfig.model }
      : typeof options.model === 'string' ? { model: options.model } : {},
    ...typeof requestConfig?.reasoningEffort === 'string'
      ? { reasoningEffort: requestConfig.reasoningEffort }
      : typeof options.reasoningEffort === 'string'
        ? { reasoningEffort: options.reasoningEffort }
        : {},
  })
}

export function dshRc7RunInfo(payload: unknown): Readonly<{id?: string, stopReason?: string}>  {
  if (payload === null || typeof payload !== 'object') return Object.freeze({})
  const record = ((payload) as Record<string, unknown>)
  return Object.freeze({
    ...typeof record.id === 'string' ? { id: record.id } : {},
    ...typeof record.stopReason === 'string' ? { stopReason: record.stopReason } : {},
  })
}

export async function filesystemSkillsApply() {
  return (await loadDshRc7Runtime()).filesystemSkillsApply
}

export type Agent = import('@deepseek-ai/dsh-agent').Agent
export type PreStepDecision = import('@deepseek-ai/dsh-agent').PreStepDecision
export type SessionStartSource = import('@deepseek-ai/dsh-agent').SessionStartSource
export type ToolExecution = import('@deepseek-ai/dsh-tools').ToolExecution
export type ToolExecutionToken = import('@deepseek-ai/dsh-tools').ToolExecutionToken

export type DurablePosition = { turn: number | undefined, step: number | undefined }

export type SessionContext = { sessionId: string, session: Agent['session'], cwd: string | undefined, source: SessionStartSource | 'attached' | 'observed', turn: number | undefined, step: number | undefined, durableTurn: number | undefined, durableStep: number | undefined, eventCount: number, lastEvent: unknown | undefined, historyValid: boolean }

export type CallContext = { token: ToolExecutionToken, parent: ToolExecutionToken | undefined, sessionId: string, cwd: string, turn: number, step: number, callId: string, rootCallId: string, name: string }

export type BeginToolResult = { ok: false, reason: string } | { ok: true, context: Readonly<CallContext> }

export type StepContext = { sessionId: string, cwd: string, turn: number, step: number, sessionStartSource: SessionStartSource | 'observed' }

export type StopContext = { sessionId: string, cwd: string, turn: number }

function validPositiveInteger(value: unknown): value is number  {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function sessionIdentity(agent: Agent) {
  const id = String(agent?.id ?? '')
  const headerId = String(agent?.session?.header?.id ?? id)
  if (id.length === 0 || headerId !== id) return undefined
  const cwd = agent.session.header.cwd
  return {
    sessionId: id,
    cwd: typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined,
  }
}

export type SessionLog = { length: number, at(index: number): any }

/**
 * Read through either the alpha.4 indexed session-log boundary or one stable
 * legacy snapshot. The indexed route avoids copying the complete log at every
 * lifecycle boundary while retaining exact object-identity prefix checks.
 */
function sessionLog(session: Agent['session']): SessionLog  {
  const candidate = ((session) as any)
  if (Number.isSafeInteger(candidate.seq)
    && candidate.seq >= 0
    && typeof candidate.eventAt === 'function') {
    return {
      length: candidate.seq,
      at: index => candidate.eventAt(index),
    }
  }
  const events = typeof candidate.snapshotEvents === 'function'
    ? candidate.snapshotEvents()
    : Array.isArray(candidate.events) ? candidate.events : []
  return {
    length: events.length,
    at: index => events[index],
  }
}

function deriveOpenPosition(events: SessionLog) {
  let candidateTurn: number | undefined
  let candidateStep: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events.at(index)
    if (event === undefined) continue
    const data = ((event.data) as Record<string, unknown>)
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
 */
function foldLifecycleEvent(position: DurablePosition, event: any): DurablePosition  {
  const data = ((event.data) as Record<string, unknown>)
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
 */
export function createDshRc7Compatibility(ctx: { agents?: { list(): Agent[] } }) {
  let sessions: WeakMap<Agent, SessionContext> = new WeakMap()
  const calls: Map<Readonly<ToolExecution>, Readonly<CallContext>> = new Map()
  const tokenOwners: Map<ToolExecutionToken, Readonly<ToolExecution>> = new Map()
  const callSessions: Map<Readonly<ToolExecution>, Agent['session']> = new Map()
  let open = true

  function attach(agent: Agent, source: SessionContext['source']) {
    if (!open || typeof agent !== 'object' || agent === null) return undefined
    const identity = sessionIdentity(agent)
    if (identity === undefined) return undefined
    const events = sessionLog(agent.session)
    const position = deriveOpenPosition(events)
    const context: SessionContext = {
      ...identity,
      session: agent.session,
      source,
      ...position,
      durableTurn: position.turn,
      durableStep: position.step,
      eventCount: events.length,
      lastEvent: events.at(events.length - 1),
      historyValid: true,
    }
    sessions.set(agent, context)
    return context
  }

  function refreshPosition(agent: Agent, context: SessionContext) {
    const events = sessionLog(agent.session)
    const eventCount = events.length
    if (!context.historyValid || context.session !== agent.session) {
      context.turn = undefined
      context.step = undefined
      return { turn: undefined, step: undefined }
    }
    const appendOnly = eventCount >= context.eventCount
      && (context.eventCount === 0
        || events.at(context.eventCount - 1) === context.lastEvent)
    let position: DurablePosition
    if (appendOnly) {
      position = { turn: context.durableTurn, step: context.durableStep }
      for (let index = context.eventCount; index < eventCount; index += 1) {
        const event = events.at(index)
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
    context.lastEvent = events.at(eventCount - 1)
    context.durableTurn = position.turn
    context.durableStep = position.step
    context.turn = position.turn
    context.step = position.step
    return position
  }

  for (const agent of ctx.agents?.list?.() ?? []) attach(agent, 'attached')

  return Object.freeze({
    sessionStart(payload: { agent: Agent, source: SessionStartSource }) {
      attach(payload.agent, payload.source)
    },

    /**
 * Observe the exact proposed rc.7 step without accepting it. This context
 * is safe to send to an advisory evaluator before the waterfall settles;
 * callers must attach any returned context only after an `enter` decision.
 */

    preStepContext(payload: { agent: Agent, messages: unknown[], turn: number, step: number, signal: AbortSignal }): {ok: false, reason: string} | {ok: true, context: Readonly<StepContext>}  {
      if (!open) return { ok: false, reason: 'policy-disposed' }
      const stored = sessions.get(payload.agent)
      const context = stored === undefined || stored.session !== payload.agent.session
        ? attach(payload.agent, 'observed')
        : stored
      const identity = sessionIdentity(payload.agent)
      if (context === undefined || identity === undefined
        || context.sessionId !== identity.sessionId
        || context.cwd !== identity.cwd
        || identity.cwd === undefined
        || !context.historyValid
        || !validPositiveInteger(payload.turn)
        || !validPositiveInteger(payload.step)
        || payload.signal.aborted) {
        return { ok: false, reason: 'policy-step-context-invalid' }
      }
      return {
        ok: true,
        context: Object.freeze({
          sessionId: identity.sessionId,
          cwd: identity.cwd,
          turn: payload.turn,
          step: payload.step,
          sessionStartSource: context.source === 'attached' ? 'observed' : context.source,
        }),
      }
    },

    async preStep(payload: { agent: Agent, messages: unknown[], turn: number, step: number, signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>  {
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

    beginTool(exec: ToolExecution): BeginToolResult  {
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
      const call: Readonly<CallContext> = Object.freeze({
        token: exec.token,
        parent: exec.parent,
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

    matchesTool(exec: ToolExecution | Readonly<ToolExecution>) {
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
        && call.parent === exec.parent
        && call.callId === exec.callId
        && call.rootCallId === exec.rootCallId
        && call.name === exec.name
    },

    /**
 * The candidate post-tool result is deliberately not accepted here. Only
 * execution identity is observed at this non-authoritative boundary.
 */

    postTool(exec: ToolExecution) {
      return this.matchesTool(exec)
    },

    result(exec: Readonly<ToolExecution>) {
      const call = calls.get(exec)
      const matched = this.matchesTool(exec)
      calls.delete(exec)
      if (call !== undefined && tokenOwners.get(call.token) === exec) {
        tokenOwners.delete(call.token)
      }
      callSessions.delete(exec)
      return matched
    },

    turnStopping(payload: { agent: Agent, turn: number, signal: AbortSignal }) {
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

    /**
 * Read the correlated stop identity after `turnStopping()` has refreshed
 * the durable lifecycle suffix.
 */

    stopContext(payload: { agent: Agent, turn: number, signal: AbortSignal }): {ok: false, reason: string} | {ok: true, context: Readonly<StopContext>}  {
      if (!open || payload.signal.aborted) {
        return { ok: false, reason: 'policy-stop-context-invalid' }
      }
      const session = sessions.get(payload.agent)
      const identity = sessionIdentity(payload.agent)
      if (session === undefined || session.session !== payload.agent.session
        || identity === undefined || identity.cwd === undefined
        || session.sessionId !== identity.sessionId
        || session.cwd !== identity.cwd
        || !session.historyValid
        || !validPositiveInteger(payload.turn)
        || session.turn !== payload.turn) {
        return { ok: false, reason: 'policy-stop-context-invalid' }
      }
      return {
        ok: true,
        context: Object.freeze({
          sessionId: identity.sessionId,
          cwd: identity.cwd,
          turn: payload.turn,
        }),
      }
    },

    correlation(token: ToolExecutionToken) {
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
