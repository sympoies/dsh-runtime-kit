// @ts-check

/**
 * Private in-process bridge between the optional Main Agent child plugin and
 * the always-on policy/context transports. The bridge carries only a resolver;
 * it never persists or logs the capability-bearing environment it returns.
 */
export function createManagedSessionBridge() {
  /** @type {((sessionId:string) => unknown) | undefined} */
  let resolver
  return Object.freeze({
    /** @param {(sessionId:string) => unknown} candidate */
    register(candidate) {
      if (resolver !== undefined) throw new Error('dsh-runtime-kit: session bridge already registered')
      resolver = candidate
      return () => {
        if (resolver === candidate) resolver = undefined
      }
    },
    /** @param {string} sessionId */
    resolve(sessionId) {
      return resolver?.(sessionId)
    },
  })
}
