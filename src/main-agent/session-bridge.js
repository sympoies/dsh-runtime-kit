// @ts-check

/**
 * Private in-process bridge between managed-session authentication, the
 * optional Main Agent child plugin, and the always-on policy/context
 * transports. The bridge never persists or logs the capability-bearing
 * environment it returns.
 */
export function createManagedSessionBridge() {
  /** @type {((sessionId:string) => unknown) | undefined} */
  let resolver
  /** @type {((sessionId:string, execution:unknown) => Promise<unknown>) | undefined} */
  let authenticator
  /** @type {Map<string, unknown>} */
  const bindings = new Map()
  return Object.freeze({
    /** @param {string} sessionId @param {unknown} principal */
    bind(sessionId, principal) {
      if (typeof sessionId !== 'string'
        || sessionId.length === 0
        || principal === null
        || typeof principal !== 'object') {
        throw new Error('dsh-runtime-kit: managed session binding is invalid')
      }
      if (bindings.has(sessionId)) {
        throw new Error('dsh-runtime-kit: managed session already bound')
      }
      bindings.set(sessionId, principal)
      return () => {
        if (bindings.get(sessionId) === principal) bindings.delete(sessionId)
      }
    },
    /** @param {(sessionId:string) => unknown} candidate */
    register(candidate) {
      if (resolver !== undefined) throw new Error('dsh-runtime-kit: session bridge already registered')
      resolver = candidate
      return () => {
        if (resolver === candidate) resolver = undefined
      }
    },
    /** @param {(sessionId:string, execution:unknown) => Promise<unknown>} candidate */
    registerAuthenticator(candidate) {
      if (authenticator !== undefined) {
        throw new Error('dsh-runtime-kit: session authenticator already registered')
      }
      authenticator = candidate
      return () => {
        if (authenticator === candidate) authenticator = undefined
      }
    },
    /** @param {string} sessionId @param {unknown} execution */
    async authenticate(sessionId, execution) {
      const existing = bindings.has(sessionId) ? bindings.get(sessionId) : resolver?.(sessionId)
      if (existing !== undefined) return existing
      return authenticator?.(sessionId, execution)
    },
    /** @param {string} sessionId */
    resolve(sessionId) {
      return bindings.has(sessionId) ? bindings.get(sessionId) : resolver?.(sessionId)
    },
  })
}
