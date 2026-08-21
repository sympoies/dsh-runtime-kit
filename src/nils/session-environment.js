// @ts-check

const MANAGED_SESSION_PREFIX = 'AGENT_SESSION_'

/**
 * Convert every ambient managed-session field into an explicit subprocess
 * tombstone. DSH has no authenticated session bridge yet, so no inherited
 * provider session identity is valid input to a nils child.
 *
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Readonly<NodeJS.ProcessEnv>}
 */
export function selectManagedSessionEnvironment(environment) {
  const tombstones = /** @type {NodeJS.ProcessEnv} */ ({})
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)) {
      tombstones[name] = undefined
    }
  }
  return Object.freeze(tombstones)
}

/** @param {Readonly<NodeJS.ProcessEnv> | undefined} explicit */
export function isolatedNilsEnvironment(explicit) {
  return {
    ...explicit,
    ...selectManagedSessionEnvironment(process.env),
  }
}
