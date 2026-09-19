export type Agent = import('@deepseek-ai/dsh-agent').Agent
export type SessionStartSource = import('@deepseek-ai/dsh-agent').SessionStartSource

type LifecyclePayload = { agent: Agent, source: SessionStartSource }
type LifecycleContext = {
  on(event: string, listener: (payload: unknown) => void): unknown
}

const SOURCES = new Set<SessionStartSource>(['startup', 'resume', 'clear', 'compact'])

function payload(value: unknown, sourceRequired: boolean): LifecyclePayload | undefined {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('dsh-runtime-kit: DSH agent lifecycle payload is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.source === undefined && !sourceRequired) return undefined
  if ((candidate.agent === null || typeof candidate.agent !== 'object')
    || !SOURCES.has(candidate.source as SessionStartSource)) {
    throw new TypeError('dsh-runtime-kit: DSH agent lifecycle payload is invalid')
  }
  return candidate as LifecyclePayload
}

/**
 * Observe the session-start edge across the two retained DSH releases.
 *
 * DSH 0.1.5 emits `agent/created` without a source and then emits
 * `agent/session-start`. DSH 0.1.6 folds that edge into the serial
 * `agent/created` payload and removes the old event. Registering both aliases
 * keeps the compatibility decision in one version-scoped adapter.
 */
export function onDshSessionStart(
  context: unknown,
  listener: (payload: LifecyclePayload) => void,
) {
  const ctx = context as LifecycleContext
  const dispatch = (value: unknown, sourceRequired: boolean) => {
    const lifecycle = payload(value, sourceRequired)
    if (lifecycle !== undefined) listener(lifecycle)
  }
  ctx.on('agent/created', value => dispatch(value, false))
  ctx.on('agent/session-start', value => dispatch(value, true))
}
