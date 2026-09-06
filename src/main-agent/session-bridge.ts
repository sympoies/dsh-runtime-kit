/**
 * Private in-process bridge between managed-session authentication, the
 * optional Main Agent child plugin, and the always-on policy/context
 * transports. The bridge never persists or logs the capability-bearing
 * environment it returns.
 */
export function createManagedSessionBridge() {
  let resolver: ((sessionId:string) => unknown) | undefined
  let authenticator: ((sessionId:string, execution:unknown) => Promise<unknown>) | undefined
  const bindings: Map<string, unknown> = new Map()
  return Object.freeze({
    bind(sessionId: string, principal: unknown) {
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
    register(candidate: (sessionId:string) => unknown) {
      if (resolver !== undefined) throw new Error('dsh-runtime-kit: session bridge already registered')
      resolver = candidate
      return () => {
        if (resolver === candidate) resolver = undefined
      }
    },
    registerAuthenticator(candidate: (sessionId:string, execution:unknown) => Promise<unknown>) {
      if (authenticator !== undefined) {
        throw new Error('dsh-runtime-kit: session authenticator already registered')
      }
      authenticator = candidate
      return () => {
        if (authenticator === candidate) authenticator = undefined
      }
    },
    async authenticate(sessionId: string, execution: unknown) {
      const existing = bindings.has(sessionId) ? bindings.get(sessionId) : resolver?.(sessionId)
      if (existing !== undefined) return existing
      return authenticator?.(sessionId, execution)
    },
    resolve(sessionId: string) {
      return bindings.has(sessionId) ? bindings.get(sessionId) : resolver?.(sessionId)
    },
  })
}
