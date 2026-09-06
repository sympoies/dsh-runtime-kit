const MANAGED_SESSION_PREFIX = 'AGENT_SESSION_'
const HOST_RUNTIME_FIELDS = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'PATH',
  'XDG_RUNTIME_DIR',
])
const BASELINE_FAILURE_CODES = new Set([
  'not-in-repository',
  'repository-unavailable',
  'uncovered-mutation-scope',
])

function selectExplicitNilsEnvironment(explicit: Readonly<NodeJS.ProcessEnv> | undefined) {
  const selected = (({}) as NodeJS.ProcessEnv)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (!HOST_RUNTIME_FIELDS.has(name)
      && !name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)) {
      selected[name] = value
    }
  }
  return selected
}

/**
 * Select the host-runtime values that need an authenticated replacement.
 * DSH's subprocess service already starts from its credential-scrubbed parent
 * environment, so PATH and HOME must remain ordinary host values instead of
 * being replaced here. Only the Linux user bus is reconstructed from its
 * canonical per-UID runtime directory; explicit caller values cannot override
 * any of these host-runtime fields.
 */

function selectNilsHostEnvironment(environment: Readonly<NodeJS.ProcessEnv>, runtime: {uid?: number, platform?: NodeJS.Platform}) {
  const uid = runtime.uid
  const selected = (({}) as NodeJS.ProcessEnv)
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
 * tombstone. Inherited provider session identity is never valid input to a
 * nils child until the in-process bridge authenticates and restores it.
 */

export function selectManagedSessionEnvironment(environment: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv>  {
  const tombstones = (({}) as NodeJS.ProcessEnv)
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)) {
      tombstones[name] = undefined
    }
  }
  return Object.freeze(tombstones)
}

export function isolatedNilsEnvironment(
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  runtime: {uid?: number, platform?: NodeJS.Platform} = { uid: process.getuid?.(), platform: process.platform },
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
 */

export function authenticatedNilsEnvironment(
  explicit: Readonly<NodeJS.ProcessEnv>,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  runtime: {uid?: number, platform?: NodeJS.Platform} = { uid: process.getuid?.(), platform: process.platform },
) {
  const restored = (({}) as NodeJS.ProcessEnv)
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
 * Resolve a DSH session to the authenticated managed principal owned by the
 * live bridge. The service is optional because unmanaged DSH sessions
 * deliberately remain isolated from ambient provider identity.
 *
 * @param _ctx retained for the transport call signature; never used
 */

export function resolveManagedSessionPrincipal(_ctx: unknown, sessionId: string, bridge?: {resolve?: (id:string) => unknown} | undefined): {sessionId:string, environment:Readonly<Record<string,string>>, baselineFailureCode?:'not-in-repository'|'repository-unavailable'|'uncovered-mutation-scope'} | undefined  {
  const raw = bridge?.resolve?.(sessionId)
  if (raw === null || typeof raw !== 'object') return undefined
  const principal = ((raw) as Record<string, unknown>)
  if (typeof principal.sessionId !== 'string' || principal.sessionId.length === 0
    || principal.environment === null
    || typeof principal.environment !== 'object'
    || Array.isArray(principal.environment)) return undefined
  const environment = ((principal.environment) as Record<string, unknown>)
  if (environment.AGENT_SESSION_ID !== principal.sessionId
    || !Object.entries(environment).every(([name, value]) => (
      name.toUpperCase().startsWith(MANAGED_SESSION_PREFIX)
      && typeof value === 'string'
      && value.length > 0
    ))) return undefined
  const baselineFailureCode = principal.baselineFailureCode
  if (baselineFailureCode !== undefined
    && (typeof baselineFailureCode !== 'string'
      || !BASELINE_FAILURE_CODES.has(baselineFailureCode))) {
    return undefined
  }
  return {
    sessionId: principal.sessionId,
    environment: ((environment) as Readonly<Record<string,string>>),
    ...(baselineFailureCode === undefined
      ? {}
      : { baselineFailureCode: ((baselineFailureCode) as 'not-in-repository'|'repository-unavailable'|'uncovered-mutation-scope') }),
  }
}
