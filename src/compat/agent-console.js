// @ts-check

import { readFileSync } from 'node:fs'

/** @type {any} */
const CONTRACT = deepFreeze(JSON.parse(readFileSync(
  new URL('../../compatibility/agent-console.json', import.meta.url),
  'utf8',
)))

export class AgentConsoleProfileCompatibilityError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AgentConsoleProfileCompatibilityError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/** @param {any} value */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value
    : undefined
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** @param {readonly string[]} actual @param {readonly string[]} required */
function includesAll(actual, required) {
  const available = new Set(actual)
  return required.every(value => available.has(value))
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function fail(code, message, details) {
  throw new AgentConsoleProfileCompatibilityError(code, message, details)
}

/**
 * Return the immutable, machine-readable Agent Console rc.7 composition
 * contract. The caller supplies only observations; this module does not
 * discover profile homes, read credentials, or mutate DSH state.
 */
export function agentConsoleRc7ProfileContract() {
  return CONTRACT
}

/**
 * Authenticate a sanitized observation of the Agent Console profile. This is
 * deliberately stricter than generic DSH profile support: `dsh-tui` is an
 * exact base -> interaction/TUI -> runtime-kit composition, never an alias for
 * the native `headless` template or an arbitrary custom profile.
 *
 * @param {unknown} observation
 */
export function inspectAgentConsoleRc7Profile(observation) {
  const input = record(observation)
  if (input === undefined || input.profile !== CONTRACT.profile) {
    fail(
      'DSH_RUNTIME_KIT_UNSUPPORTED_AGENT_CONSOLE_PROFILE',
      `dsh-runtime-kit: unsupported Agent Console profile ${JSON.stringify(input?.profile)}`,
      { expected_profile: CONTRACT.profile },
    )
  }

  const dsh = record(input.dsh)
  const tui = record(input.tui)
  const composition = record(input.composition)
  const bundles = stringArray(input.bundles)
  const rows = stringArray(composition?.rowIds)
  const tools = stringArray(composition?.tools)
  const skills = stringArray(composition?.skills)
  const services = stringArray(composition?.services)
  if (dsh?.version !== CONTRACT.dsh.version
    || dsh?.revision !== CONTRACT.dsh.revision
    || tui?.package !== CONTRACT.tui.package
    || tui?.version !== CONTRACT.tui.version
    || bundles === undefined
    || !sameStrings(bundles, CONTRACT.bundles)
    || rows === undefined
    || !includesAll(rows, CONTRACT.required_rows)
    || tools === undefined
    || !includesAll(tools, CONTRACT.required_tools)
    || skills === undefined
    || !includesAll(skills, CONTRACT.required_skills)
    || services === undefined
    || !includesAll(services, CONTRACT.required_services)) {
    fail(
      'DSH_RUNTIME_KIT_INVALID_AGENT_CONSOLE_COMPOSITION',
      'dsh-runtime-kit: Agent Console rc.7 composition is incomplete or unsupported',
    )
  }

  const controller = record(input.controllerRoute)
  const worker = record(input.workerRoute)
  if (controller === undefined
    || worker === undefined
    || controller.provider !== CONTRACT.default_route.provider
    || controller?.model !== CONTRACT.default_route.model
    || worker?.provider !== controller.provider
    || worker?.model !== controller.model) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_MISMATCH',
      'dsh-runtime-kit: Agent Console worker route must inherit the Sol controller route',
      {
        expected_provider: CONTRACT.default_route.provider,
        expected_model: CONTRACT.default_route.model,
      },
    )
  }

  const authority = record(input.authority)
  const runtimeRows = stringArray(authority?.runtimeKitPatchRowIds)
  const credentials = Array.isArray(authority?.providerCredentials)
    ? authority.providerCredentials.map(record)
    : undefined
  const sandboxPair = CONTRACT.authority.sandbox_approval_pairs.some(
    (/** @type {any} */ pair) => pair.sandbox_mode === authority?.sandboxMode
      && pair.approval_policy === authority?.approvalPolicy,
  )
  const credentialsMatch = credentials !== undefined
    && credentials.length === CONTRACT.authority.provider_credentials.length
    && credentials.every((credential, index) => {
      const expected = CONTRACT.authority.provider_credentials[index]
      return credential !== undefined
        && credential.provider === expected.provider
        && credential.apiKeyEnv === expected.api_key_env
        && /^[A-Z][A-Z0-9_]*$/.test(credential.apiKeyEnv)
        && credential.inlineValuePresent === false
    })
  if (authority === undefined
    || runtimeRows === undefined
    || !sameStrings(runtimeRows, CONTRACT.authority.runtime_kit_patch_rows)
    || authority?.permissionModeSource !== CONTRACT.authority.permission_mode_source
    || !sandboxPair
    || !credentialsMatch) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_AUTHORITY_MISMATCH',
      'dsh-runtime-kit: Agent Console sandbox, approval, or credential authority changed',
    )
  }

  return Object.freeze({
    schema_version: 'dsh-runtime-kit.agent-console-profile-inspection.v1',
    compatible: true,
    profile: CONTRACT.profile,
    dsh_version: CONTRACT.dsh.version,
    tui_version: CONTRACT.tui.version,
    controller_route: Object.freeze({ ...controller }),
    worker_route: Object.freeze({ ...worker }),
    authority: Object.freeze({
      runtime_kit_patch_rows: Object.freeze([...runtimeRows]),
      sandbox_mode: authority.sandboxMode,
      approval_policy: authority.approvalPolicy,
      credentials: 'environment-reference-only',
    }),
  })
}
