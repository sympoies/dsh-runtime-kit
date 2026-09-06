const AUTHENTICATED_EXECUTABLE_PATH = /^(?:(?:\/proc\/\d+\/fd\/\d+|\/dev\/fd\/\d+)(?:\/|$)|\/[^\0]*\/dsh-runtime-health-executables-[^/]+\/(?:agent-hook|agent-docs)$)/u

function unboundExecution(ctx: import('@deepseek-ai/cordis').Context) {
  return Object.freeze({
    acquire(signal: AbortSignal) {
      return Object.freeze({
        signal,
        release() {},
        spawn(spec: Record<string, unknown>) { return ctx.subprocess.spawn(((spec) as any)) },
      })
    },
    async dispose() {},
  })
}

/**
 * Resolve the package-owned command lease used by every consumer of an
 * authenticated descriptor path. Standalone clients may retain ordinary
 * executable paths without a lease; a naked descriptor path always fails.
 */

export function resolveAuthenticatedNilsExecution(ctx: import('@deepseek-ai/cordis').Context, config: {agentHook?: string, agentDocs?: string, authenticatedNilsExecution?: {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, createScope?: () => {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, dispose?: () => void | Promise<void>}}}) {
  const execution = config.authenticatedNilsExecution
  if (execution === undefined) {
    if ([config.agentHook, config.agentDocs]
      .some(path => typeof path === 'string' && AUTHENTICATED_EXECUTABLE_PATH.test(path))) {
      throw new TypeError('dsh-runtime-kit: authenticated nils executable requires an execution owner')
    }
    return unboundExecution(ctx)
  }
  if (typeof execution !== 'object'
    || (typeof execution.createScope !== 'function' && typeof execution.acquire !== 'function')) {
    throw new TypeError('dsh-runtime-kit: authenticatedNilsExecution is invalid')
  }
  const scoped = typeof execution.createScope === 'function' ? execution.createScope() : execution
  if (scoped === null || typeof scoped !== 'object' || typeof scoped.acquire !== 'function') {
    throw new TypeError('dsh-runtime-kit: authenticated nils execution scope is invalid')
  }
  const target = ((scoped) as {acquire: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, dispose?: () => void | Promise<void>})
  const acquire = target.acquire
  const dispose = typeof target.dispose === 'function' ? target.dispose.bind(target) : async () => {}
  return Object.freeze({
    acquire(signal: AbortSignal) {
      const lease = acquire(signal)
      if (lease === null || typeof lease !== 'object'
        || !(lease.signal instanceof AbortSignal) || typeof lease.release !== 'function') {
        throw new TypeError('dsh-runtime-kit: authenticated nils execution lease is invalid')
      }
      const spawn = typeof lease.spawn === 'function'
        ? lease.spawn.bind(lease)
        : (spec: Record<string, unknown>) => ctx.subprocess.spawn(((spec) as any))
      return Object.freeze({ ...lease, spawn })
    },
    async dispose() { await dispose() },
  })
}
