// @ts-check

const MANAGED_SESSION_PREFIX = 'AGENT_SESSION_'
const TRUSTED_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const HOST_RUNTIME_FIELDS = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'PATH',
  'XDG_RUNTIME_DIR',
])

/** @param {Readonly<NodeJS.ProcessEnv> | undefined} explicit */
function selectExplicitNilsEnvironment(explicit) {
  const selected = /** @type {NodeJS.ProcessEnv} */ ({})
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (!HOST_RUNTIME_FIELDS.has(name)
      && !name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)) {
      selected[name] = value
    }
  }
  return selected
}

/**
 * Select the small host-runtime boundary required by nils itself. DSH
 * subprocess environments are replacement maps, so omitting these values
 * disconnects Linux agent-hook children from the authenticated user manager.
 * Ambient PATH, HOME, and D-Bus addresses remain untrusted: the path is fixed
 * and the bus address is derived only from the canonical per-UID runtime
 * directory. Every nils user/config/state root is already passed explicitly.
 *
 * @param {Readonly<NodeJS.ProcessEnv>} environment
 * @param {{uid?: number, platform?: NodeJS.Platform}} runtime
 */
function selectNilsHostEnvironment(environment, runtime) {
  const uid = runtime.uid
  const selected = /** @type {NodeJS.ProcessEnv} */ ({
    PATH: TRUSTED_SYSTEM_PATH,
  })
  if (runtime.platform === 'linux'
    && typeof uid === 'number'
    && Number.isSafeInteger(uid)
    && uid >= 0
    && environment.XDG_RUNTIME_DIR === `/run/user/${uid}`) {
    selected.XDG_RUNTIME_DIR = environment.XDG_RUNTIME_DIR
    selected.DBUS_SESSION_BUS_ADDRESS = `unix:path=${environment.XDG_RUNTIME_DIR}/bus`
  }
  return selected
}

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

/**
 * @param {Readonly<NodeJS.ProcessEnv> | undefined} explicit
 * @param {Readonly<NodeJS.ProcessEnv>} [environment]
 * @param {{uid?: number, platform?: NodeJS.Platform}} [runtime]
 */
export function isolatedNilsEnvironment(
  explicit,
  environment = process.env,
  runtime = { uid: process.getuid?.(), platform: process.platform },
) {
  return {
    ...selectExplicitNilsEnvironment(explicit),
    ...selectNilsHostEnvironment(environment, runtime),
    ...selectManagedSessionEnvironment({ ...environment, ...explicit }),
  }
}

/**
 * Build the same scrubbed nils environment, then restore only the managed
 * session fields supplied by an authenticated in-process lane bridge. Ambient
 * managed fields stay tombstoned and unrelated explicit values stay filtered.
 *
 * @param {Readonly<NodeJS.ProcessEnv>} explicit
 * @param {Readonly<NodeJS.ProcessEnv>} [environment]
 * @param {{uid?: number, platform?: NodeJS.Platform}} [runtime]
 */
export function authenticatedNilsEnvironment(
  explicit,
  environment = process.env,
  runtime = { uid: process.getuid?.(), platform: process.platform },
) {
  const restored = /** @type {NodeJS.ProcessEnv} */ ({})
  for (const [name, value] of Object.entries(explicit)) {
    if (name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)
      && typeof value === 'string'
      && value.length > 0) {
      restored[name] = value
    }
  }
  return {
    ...isolatedNilsEnvironment(explicit, environment, runtime),
    ...restored,
  }
}

/**
 * Resolve a DSH child session to the authenticated Main Agent worker principal
 * owned by the live lane registry. The service is optional because ordinary
 * DSH sessions deliberately remain isolated from ambient provider identity.
 *
 * @param {unknown} _ctx retained for the transport call signature; never used
 * @param {string} sessionId
 * @param {{resolve?: (id:string) => unknown} | undefined} [bridge]
 * @returns {{sessionId:string, environment:Readonly<Record<string,string>>} | undefined}
 */
export function resolveManagedSessionPrincipal(_ctx, sessionId, bridge) {
  const raw = bridge?.resolve?.(sessionId)
  if (raw === null || typeof raw !== 'object') return undefined
  const principal = /** @type {Record<string, unknown>} */ (raw)
  if (typeof principal.sessionId !== 'string' || principal.sessionId.length === 0
    || principal.environment === null
    || typeof principal.environment !== 'object'
    || Array.isArray(principal.environment)) return undefined
  const environment = /** @type {Record<string, unknown>} */ (principal.environment)
  if (environment.AGENT_SESSION_ID !== principal.sessionId
    || !Object.entries(environment).every(([name, value]) => (
      name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)
      && typeof value === 'string'
      && value.length > 0
    ))) return undefined
  return {
    sessionId: principal.sessionId,
    environment: /** @type {Readonly<Record<string,string>>} */ (environment),
  }
}
