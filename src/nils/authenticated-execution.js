// @ts-check

const DESCRIPTOR_PATH = /^(?:\/proc\/\d+\/fd\/\d+|\/dev\/fd\/\d+)(?:\/|$)/u

const unboundExecution = Object.freeze({
  /** @param {AbortSignal} signal */
  acquire(signal) {
    return Object.freeze({ signal, release() {} })
  },
  async dispose() {},
})

/**
 * Resolve the package-owned command lease used by every consumer of an
 * authenticated descriptor path. Standalone clients may retain ordinary
 * executable paths without a lease; a naked descriptor path always fails.
 *
 * @param {{agentHook?: string, agentDocs?: string, authenticatedNilsExecution?: {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void}, createScope?: () => {acquire?: (signal: AbortSignal) => {signal: AbortSignal, release: () => void}, dispose?: () => void | Promise<void>}}}} config
 */
export function resolveAuthenticatedNilsExecution(config) {
  const execution = config.authenticatedNilsExecution
  if (execution === undefined) {
    if ([config.agentHook, config.agentDocs]
      .some(path => typeof path === 'string' && DESCRIPTOR_PATH.test(path))) {
      throw new TypeError('dsh-runtime-kit: authenticated nils descriptor requires an execution owner')
    }
    return unboundExecution
  }
  if (typeof execution !== 'object'
    || (typeof execution.createScope !== 'function' && typeof execution.acquire !== 'function')) {
    throw new TypeError('dsh-runtime-kit: authenticatedNilsExecution is invalid')
  }
  const scoped = typeof execution.createScope === 'function' ? execution.createScope() : execution
  if (scoped === null || typeof scoped !== 'object' || typeof scoped.acquire !== 'function') {
    throw new TypeError('dsh-runtime-kit: authenticated nils execution scope is invalid')
  }
  const target = /** @type {{acquire: (signal: AbortSignal) => {signal: AbortSignal, release: () => void}, dispose?: () => void | Promise<void>}} */ (scoped)
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
      return lease
    },
    async dispose() { await dispose() },
  })
}
