// @ts-check

const AUTHENTICATED_EXECUTABLE_PATH = /^(?:(?:\/proc\/\d+\/fd\/\d+|\/dev\/fd\/\d+)(?:\/|$)|\/[^\0]*\/dsh-runtime-health-executables-[^/]+\/(?:agent-hook|agent-docs)$)/u

/** @param {import('@deepseek-ai/cordis').Context} ctx */
function unboundExecution(ctx) {
  return Object.freeze({
    /** @param {AbortSignal} signal */
    acquire(signal) {
      return Object.freeze({
        signal,
        release() {},
        /** @param {Record<string, unknown>} spec */
        spawn(spec) { return ctx.subprocess.spawn(/** @type {any} */ (spec)) },
      })
    },
    async dispose() {},
  })
}

/**
 * Resolve the package-owned command lease used by every consumer of an
 * authenticated descriptor path. Standalone clients may retain ordinary
 * executable paths without a lease; a naked descriptor path always fails.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agentHook?: string, agentDocs?: string, authenticatedNilsExecution?: {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, createScope?: () => {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, dispose?: () => void | Promise<void>}}}} config
 */
export function resolveAuthenticatedNilsExecution(ctx, config) {
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
  const target = /** @type {{acquire: (signal: AbortSignal) => {signal: AbortSignal, release: () => void, spawn?: (spec: Record<string, unknown>) => import('@deepseek-ai/dsh-subprocess').SubprocessHandle}, dispose?: () => void | Promise<void>}} */ (scoped)
  const acquire = target.acquire
  const dispose = typeof target.dispose === 'function' ? target.dispose.bind(target) : async () => {}
  return Object.freeze({
    /** @param {AbortSignal} signal */
    acquire(signal) {
      const lease = acquire(signal)
      if (lease === null || typeof lease !== 'object'
        || !(lease.signal instanceof AbortSignal) || typeof lease.release !== 'function') {
        throw new TypeError('dsh-runtime-kit: authenticated nils execution lease is invalid')
      }
      const spawn = typeof lease.spawn === 'function'
        ? lease.spawn.bind(lease)
        : (/** @type {Record<string, unknown>} */ spec) => ctx.subprocess.spawn(/** @type {any} */ (spec))
      return Object.freeze({ ...lease, spawn })
    },
    async dispose() { await dispose() },
  })
}
