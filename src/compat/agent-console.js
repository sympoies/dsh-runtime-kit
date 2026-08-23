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
function denseArray(value) {
  if (!Array.isArray(value)) return undefined
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return undefined
  }
  return value
}

/** @param {unknown} value */
function stringArray(value) {
  const values = denseArray(value)
  return values !== undefined && values.every(entry => typeof entry === 'string')
    ? /** @type {string[]} */ (values)
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

/** @param {readonly string[]} actual @param {readonly string[]} forbidden */
function excludesAll(actual, forbidden) {
  const available = new Set(actual)
  return forbidden.every(value => !available.has(value))
}

/** @param {Record<string, any>} value @param {readonly string[]} expected */
function hasExactKeys(value, expected) {
  return sameStrings(Object.keys(value).sort(), [...expected].sort())
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function fail(code, message, details) {
  throw new AgentConsoleProfileCompatibilityError(code, message, details)
}

/**
 * Return the immutable, machine-readable Agent Console composition contract.
 * The retained function name preserves the public adapter API while the exact
 * reviewed DSH/TUI pair advances. The caller supplies only observations; this
 * module does not discover profile homes, read credentials, or mutate DSH state.
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
  if (dsh?.version !== CONTRACT.dsh.version || dsh?.revision !== CONTRACT.dsh.revision) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_DSH_MISMATCH',
      'dsh-runtime-kit: Agent Console requires the authenticated DSH revision',
    )
  }

  const tui = record(input.tui)
  if (tui?.package !== CONTRACT.tui.package || tui?.version !== CONTRACT.tui.version) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_TUI_MISMATCH',
      'dsh-runtime-kit: Agent Console requires the authenticated TUI package release',
    )
  }

  const bundles = stringArray(input.bundles)
  if (bundles === undefined || !sameStrings(bundles, CONTRACT.bundles)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_BUNDLE_MISMATCH',
      'dsh-runtime-kit: Agent Console bundle order is incomplete or unsupported',
    )
  }

  const composition = record(input.composition)
  const rows = stringArray(composition?.rowIds)
  if (rows === undefined || !includesAll(rows, CONTRACT.required_rows)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROW_MISMATCH',
      'dsh-runtime-kit: Agent Console interaction or runtime row is missing',
    )
  }

  const controllerTools = stringArray(composition?.controllerTools)
  const controllerContract = CONTRACT.tool_surfaces.controller
  if (controllerTools === undefined
    || !includesAll(controllerTools, controllerContract.required)
    || !excludesAll(controllerTools, controllerContract.forbidden)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_CONTROLLER_TOOL_MISMATCH',
      'dsh-runtime-kit: Agent Console controller tool authority is incomplete or widened',
    )
  }

  const laneTools = stringArray(composition?.laneTools)
  const laneContract = CONTRACT.tool_surfaces.lane
  if (laneTools === undefined
    || !includesAll(laneTools, laneContract.required)
    || !excludesAll(laneTools, laneContract.forbidden)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_LANE_TOOL_MISMATCH',
      'dsh-runtime-kit: Agent Console lane tool authority is incomplete or widened',
    )
  }

  const skills = stringArray(composition?.skills)
  if (skills === undefined || !includesAll(skills, CONTRACT.required_skills)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_SKILL_MISMATCH',
      'dsh-runtime-kit: Agent Console runtime skill surface is incomplete',
    )
  }

  const services = stringArray(composition?.services)
  if (services === undefined || !includesAll(services, CONTRACT.required_services)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_SERVICE_MISMATCH',
      'dsh-runtime-kit: Agent Console interaction or orchestration service is missing',
    )
  }

  const controller = record(input.controllerRoute)
  const worker = record(input.workerRoute)
  if (controller === undefined
    || worker === undefined
    || !hasExactKeys(controller, ['provider', 'model', 'reasoningEffort'])
    || !hasExactKeys(worker, ['provider', 'model', 'reasoningEffort'])
    || typeof controller.provider !== 'string'
    || typeof controller.model !== 'string'
    || typeof controller.reasoningEffort !== 'string'
    || typeof worker.provider !== 'string'
    || typeof worker.model !== 'string'
    || typeof worker.reasoningEffort !== 'string') {
    // Do not echo the supplied route or its keys: rejected evidence may carry
    // credential-shaped extensions and error objects are commonly serialized.
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_SHAPE_INVALID',
      'dsh-runtime-kit: Agent Console route evidence must contain provider, model, and reasoningEffort only',
    )
  }
  if (controller.provider !== CONTRACT.default_route.provider
    || controller.model !== CONTRACT.default_route.model
    || controller.reasoningEffort !== CONTRACT.default_route.reasoning_effort
    || worker.provider !== controller.provider
    || worker.model !== controller.model
    || worker.reasoningEffort !== controller.reasoningEffort) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_ROUTE_MISMATCH',
      'dsh-runtime-kit: Agent Console worker route must inherit the high-effort Sol controller route',
      {
        expected_provider: CONTRACT.default_route.provider,
        expected_model: CONTRACT.default_route.model,
        expected_reasoning_effort: CONTRACT.default_route.reasoning_effort,
      },
    )
  }

  const authority = record(input.authority)
  const runtimeRows = stringArray(authority?.runtimeKitPatchRowIds)
  if (authority === undefined
    || runtimeRows === undefined
    || !sameStrings(runtimeRows, CONTRACT.authority.runtime_kit_patch_rows)) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_RUNTIME_AUTHORITY_MISMATCH',
      'dsh-runtime-kit: Agent Console runtime-kit patch authority changed',
    )
  }

  const sandboxPair = CONTRACT.authority.sandbox_approval_pairs.some(
    (/** @type {any} */ pair) => pair.sandbox_mode === authority?.sandboxMode
      && pair.approval_policy === authority?.approvalPolicy,
  )
  if (authority?.permissionModeSource !== CONTRACT.authority.permission_mode_source
    || !sandboxPair) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_PERMISSION_AUTHORITY_MISMATCH',
      'dsh-runtime-kit: Agent Console sandbox or approval authority changed',
    )
  }

  const credentialValues = denseArray(authority?.providerCredentials)
  const credentials = credentialValues === undefined
    ? undefined
    : credentialValues.map(record)
  const credentialsMatch = credentials !== undefined
    && credentials.length === CONTRACT.authority.provider_credentials.length
    && credentials.every((credential, index) => {
      const expected = CONTRACT.authority.provider_credentials[index]
      return credential !== undefined
        && hasExactKeys(credential, ['provider', 'apiKeyEnv', 'inlineValuePresent'])
        && credential.provider === expected.provider
        && credential.apiKeyEnv === expected.api_key_env
        && /^[A-Z][A-Z0-9_]*$/.test(credential.apiKeyEnv)
        && credential.inlineValuePresent === false
    })
  if (!credentialsMatch) {
    fail(
      'DSH_RUNTIME_KIT_AGENT_CONSOLE_CREDENTIAL_AUTHORITY_MISMATCH',
      'dsh-runtime-kit: Agent Console credential evidence is not an environment reference',
    )
  }

  return Object.freeze({
    schema_version: 'dsh-runtime-kit.agent-console-profile-inspection.v2',
    compatible: true,
    profile: CONTRACT.profile,
    dsh_version: CONTRACT.dsh.version,
    tui_version: CONTRACT.tui.version,
    controller_route: Object.freeze({
      provider: controller.provider,
      model: controller.model,
      reasoningEffort: controller.reasoningEffort,
    }),
    worker_route: Object.freeze({
      provider: worker.provider,
      model: worker.model,
      reasoningEffort: worker.reasoningEffort,
    }),
    authority: Object.freeze({
      runtime_kit_patch_rows: Object.freeze([...runtimeRows]),
      sandbox_mode: authority.sandboxMode,
      approval_policy: authority.approvalPolicy,
      credentials: 'environment-reference-only',
    }),
  })
}
