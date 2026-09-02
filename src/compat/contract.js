// @ts-check

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPATIBILITY_SCHEMA = 'dsh-runtime-kit.dsh-compatibility.v1'
const DIAGNOSTIC_SCHEMA = 'dsh-runtime-kit.dsh-compatibility-diagnostic.v1'
const SHA1_PATTERN = /^[0-9a-f]{40}$/
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const CHANNELS = Object.freeze(['pinned', 'upstream-next'])
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SUPPORTED_DSH_RELEASES = Object.freeze({
  '0.1.0-rc.8': Object.freeze({
    ref: 'refs/tags/dsh-v0.1.0-rc.8',
    revision: '141eb6fef83422698aef7a981029e843e8161534',
    cordis: '4.0.1',
  }),
  '0.1.1-rc.2': Object.freeze({
    ref: 'refs/tags/dsh-v0.1.1-rc.2',
    revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
    cordis: '4.0.1',
  }),
  '0.1.2-alpha.4': Object.freeze({
    ref: 'refs/tags/dsh-v0.1.2-alpha.4',
    revision: '4e84901e6471b79ec0338099867ebb4606d12bb5',
    cordis: '4.0.2',
  }),
})
const SUPPORTED_DSH_VERSION_RANGE = Object.keys(SUPPORTED_DSH_RELEASES).join(' || ')
const SUPPORTED_CORDIS_RELEASES = Object.freeze(['4.0.1', '4.0.2'])
const SUPPORTED_CORDIS_VERSION_RANGE = SUPPORTED_CORDIS_RELEASES.join(' || ')
const DSH_SUPPORT_POLICY = Object.freeze({
  kind: 'rolling-latest-releases',
  maximum_releases: 3,
  promotion: 'add newest release and retire the oldest release in the same change',
})

export const DSH_RC7_RUNTIME_MODULES = Object.freeze({
  '@deepseek-ai/dsh-bash-local': Object.freeze({
    ENV_OVERRIDES: 'object',
  }),
  '@deepseek-ai/dsh-llm': Object.freeze({
    HarnessError: 'function',
    createUserMessage: 'function',
  }),
  '@deepseek-ai/dsh-sandbox': Object.freeze({
    approveEscalation: 'function',
    canonicalPath: 'function',
    validateEscalationArgs: 'function',
  }),
  '@deepseek-ai/dsh-skill-filesystem': Object.freeze({
    apply: 'function',
  }),
  '@deepseek-ai/dsh-tools': Object.freeze({
    TOOL_ABORTED: 'string',
  }),
})

export const DSH_RC7_PEER_VERSIONS = Object.freeze({
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-agent': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-bash-local': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-fs': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-llm': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-sandbox': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-skill-filesystem': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-subagent': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-subprocess': '0.1.2-alpha.4',
  '@deepseek-ai/dsh-tools': '0.1.2-alpha.4',
})

const DSH_RC7_PEER_RANGES = Object.freeze(Object.fromEntries(
  Object.keys(DSH_RC7_PEER_VERSIONS).map(name => [
    name,
    name === '@deepseek-ai/cordis' ? SUPPORTED_CORDIS_VERSION_RANGE : SUPPORTED_DSH_VERSION_RANGE,
  ]),
))

export const DSH_RC7_RUNTIME_SURFACE = Object.freeze([
  'on',
  'effect',
  'provide',
  'get',
  'plugin',
  'invariants.register',
  'llm.guard',
  'agents.list',
  'agents.get',
  'sessions.get',
  'sessions.flush',
  'shell.resolve',
  'shellEnv.collect',
  'skills.register',
  'subprocess.resolveExecutable',
  'subprocess.spawn',
  'subprocess.spawnDescriptor',
  'tools.bindPrerequisite',
  'tools.get',
  'tools.projectForPersistence',
  'tools.register',
  'tools.registerTerminalPolicy',
  'tools.guard',
])

export const DSH_RC7_OPTIONAL_RUNTIME_SURFACE = Object.freeze([
  'subagents.start',
  'subagents.getProvider',
  'subagents.configureRoleCapacity',
  'subagents.registerRole',
  'subagents.startRole',
  'subagents.roleOf',
  'subagents.roleStats',
])

export const DSH_RC7_ARTIFACT_LIMITS = Object.freeze({
  compressed_bytes: 128 * 1024 * 1024,
  expanded_bytes: 256 * 1024 * 1024,
  entries: 16_384,
  entry_bytes: 64 * 1024 * 1024,
})

/** A stable failure shape for promotion checks and runtime boot. */
export class DshCompatibilityError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DshCompatibilityError'
    this.code = code
    const missing = Array.isArray(details.missing)
      ? details.missing.filter(item => typeof item === 'string')
      : []
    const { missing: _ignoredMissing, ...safeDetails } = details
    this.diagnostic = Object.freeze({
      ...safeDetails,
      schema_version: DIAGNOSTIC_SCHEMA,
      compatible: false,
      code,
      missing: Object.freeze([...missing]),
    })
  }
}

/** @param {unknown} value @param {string} message */
function requireRecord(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshCompatibilityError('DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID', message)
  }
  return /** @type {Record<string, any>} */ (value)
}

/** @param {unknown} value @param {string} message */
function requirePositiveInteger(value, message) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new DshCompatibilityError('DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID', message)
  }
  return /** @type {number} */ (value)
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right */
function sameRecord(left, right) {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

/**
 * Validate the checked-in contract before it can drive a checkout or budget.
 * @param {unknown} input
 */
export function validateDshCompatibilityManifest(input) {
  const manifest = requireRecord(input, 'DSH compatibility manifest must be an object')
  if (manifest.schema_version !== COMPATIBILITY_SCHEMA
    || manifest.repository !== 'https://github.com/deepseek-ai/deepseek-harness') {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH compatibility manifest identity is invalid',
    )
  }
  if (!sameRecord(
    requireRecord(manifest.support_policy, 'DSH support policy is missing'),
    DSH_SUPPORT_POLICY,
  )) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH support policy must retain exactly the latest three reviewed releases',
    )
  }
  const channels = requireRecord(manifest.channels, 'DSH compatibility channels are missing')
  if (Object.keys(channels).sort().join('\0') !== [...CHANNELS].sort().join('\0')) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH compatibility channels must be pinned and upstream-next',
    )
  }
  for (const name of CHANNELS) {
    const channel = requireRecord(channels[name], `DSH compatibility channel ${name} is invalid`)
    if (typeof channel.ref !== 'string'
      || (name === 'pinned' && !channel.ref.startsWith('refs/tags/'))
      || (name === 'upstream-next' && !channel.ref.startsWith('refs/heads/'))
      || !SHA1_PATTERN.test(channel.revision)
      || typeof channel.version !== 'string'
      || !EXACT_VERSION_PATTERN.test(channel.version)) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
        `DSH compatibility channel ${name} is invalid`,
      )
    }
  }
  const validatedReleases = requireRecord(
    manifest.validated_releases,
    'DSH validated releases are missing',
  )
  if (!sameRecord(validatedReleases, SUPPORTED_DSH_RELEASES)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH validated releases do not match the reviewed release set',
    )
  }
  const packages = requireRecord(manifest.public_packages, 'DSH public package contracts are missing')
  if (!sameRecord(
    Object.fromEntries(Object.keys(packages).map(name => [name, true])),
    Object.fromEntries(Object.keys(DSH_RC7_PEER_VERSIONS).map(name => [name, true])),
  )) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH public package contracts must exactly match the production peer surface',
    )
  }
  for (const [name, value] of Object.entries(packages)) {
    const contract = requireRecord(value, `DSH package contract ${name} is invalid`)
    const peerRange = /** @type {Record<string, string>} */ (DSH_RC7_PEER_RANGES)[name]
    if (!name.startsWith('@deepseek-ai/')
      || contract.peer !== peerRange
      || typeof contract.path !== 'string'
      || contract.path.length === 0
      || isAbsolute(contract.path)
      || contract.path.split(/[\\/]/u).includes('..')
      || !SHA256_PATTERN.test(contract.entrypoint_sha256)
      || !SHA256_PATTERN.test(contract.types_sha256)
      || (contract.version !== undefined
        && (typeof contract.version !== 'string' || !EXACT_VERSION_PATTERN.test(contract.version)))) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
        `DSH package contract ${name} is invalid`,
      )
    }
    const exports = requireRecord(contract.exports, `DSH package exports ${name} are invalid`)
    for (const [symbol, kind] of Object.entries(exports)) {
      if (symbol.length === 0 || !['function', 'object', 'string'].includes(kind)) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
          `DSH package export contract ${name}:${symbol} is invalid`,
        )
      }
    }
    const runtimeExports = /** @type {Record<string, Record<string, string>>} */ (
      DSH_RC7_RUNTIME_MODULES
    )[name] ?? {}
    if (!sameRecord(exports, runtimeExports)) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
        `DSH package exports ${name} do not match the production runtime loader`,
      )
    }
  }
  const workspaceArtifacts = requireRecord(
    manifest.workspace_artifacts,
    'DSH workspace artifact contracts are missing',
  )
  if (Object.keys(workspaceArtifacts).length < Object.keys(packages).length) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH workspace artifact closure is incomplete',
    )
  }
  const artifactPaths = new Set()
  for (const [name, value] of Object.entries(workspaceArtifacts)) {
    const artifact = requireRecord(value, `DSH workspace artifact ${name} is invalid`)
    if (!name.startsWith('@deepseek-ai/')
      || typeof artifact.version !== 'string'
      || !EXACT_VERSION_PATTERN.test(artifact.version)
      || typeof artifact.path !== 'string'
      || artifact.path.length === 0
      || isAbsolute(artifact.path)
      || artifact.path.split(/[\\/]/u).includes('..')
      || !SHA256_PATTERN.test(artifact.artifact_sha256)
      || artifactPaths.has(artifact.path)) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
        `DSH workspace artifact ${name} is invalid`,
      )
    }
    artifactPaths.add(artifact.path)
  }
  for (const [name, contract] of Object.entries(packages)) {
    const artifact = workspaceArtifacts[name]
    const expectedVersion = contract.version ?? channels.pinned.version
    if (artifact?.path !== contract.path || artifact?.version !== expectedVersion) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
        `DSH public package ${name} is not bound to its workspace artifact`,
      )
    }
  }
  if (!Array.isArray(manifest.runtime_surface)
    || manifest.runtime_surface.join('\0') !== DSH_RC7_RUNTIME_SURFACE.join('\0')) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH runtime surface does not match the production adapter',
    )
  }
  if (!Array.isArray(manifest.optional_runtime_surface)
    || manifest.optional_runtime_surface.join('\0')
      !== DSH_RC7_OPTIONAL_RUNTIME_SURFACE.join('\0')) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH optional runtime surface does not match the production child plugins',
    )
  }
  const artifactLimits = requireRecord(
    manifest.artifact_limits,
    'DSH artifact limits are missing',
  )
  if (!sameRecord(artifactLimits, DSH_RC7_ARTIFACT_LIMITS)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH artifact limits do not match the production staging boundary',
    )
  }
  const performance = requireRecord(manifest.performance, 'DSH performance contract is missing')
  const preTool = requireRecord(performance.pre_tool, 'DSH pre-tool performance contract is missing')
  requirePositiveInteger(preTool.warmup_iterations, 'pre-tool warmup_iterations must be positive')
  requirePositiveInteger(preTool.iterations, 'pre-tool iterations must be positive')
  if (requirePositiveInteger(preTool.batches, 'pre-tool batches must be positive') < 2) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'pre-tool batches must preserve at least two retained-heap observations',
    )
  }
  requirePositiveInteger(preTool.retained_heap_bytes, 'pre-tool retained_heap_bytes must be positive')
  requirePositiveInteger(preTool.retained_growth_bytes, 'pre-tool retained_growth_bytes must be positive')
  if (typeof preTool.p95_ms !== 'number' || !Number.isFinite(preTool.p95_ms) || preTool.p95_ms <= 0
    || preTool.max_active_after !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH pre-tool performance budget is invalid',
    )
  }
  const subprocess = requireRecord(
    performance.pre_tool_subprocess,
    'DSH real subprocess performance contract is missing',
  )
  requirePositiveInteger(subprocess.warmup_iterations, 'subprocess warmup_iterations must be positive')
  if (requirePositiveInteger(subprocess.iterations, 'subprocess iterations must be positive') < 20
    || typeof subprocess.p95_ms !== 'number'
    || !Number.isFinite(subprocess.p95_ms)
    || subprocess.p95_ms <= 0
    || subprocess.max_active_after !== 0
    || subprocess.max_live_children_after !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH real subprocess performance budget is invalid',
    )
  }
  const lifecycleSubprocess = requireRecord(
    performance.tool_lifecycle_subprocess,
    'DSH tool lifecycle subprocess performance contract is missing',
  )
  requirePositiveInteger(
    lifecycleSubprocess.warmup_iterations,
    'tool lifecycle subprocess warmup_iterations must be positive',
  )
  if (requirePositiveInteger(
    lifecycleSubprocess.iterations,
    'tool lifecycle subprocess iterations must be positive',
  ) < 20
    || lifecycleSubprocess.subprocesses_per_iteration !== 5
    || typeof lifecycleSubprocess.p95_ms !== 'number'
    || !Number.isFinite(lifecycleSubprocess.p95_ms)
    || lifecycleSubprocess.p95_ms <= 0
    || lifecycleSubprocess.max_active_after !== 0
    || lifecycleSubprocess.max_live_children_after !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH tool lifecycle subprocess performance budget is invalid',
    )
  }
  return Object.freeze(structuredClone(manifest))
}

/** @param {Record<string, any>} root @param {string} path */
function resolveFunction(root, path) {
  let value = root
  for (const segment of path.split('.')) value = value?.[segment]
  return typeof value === 'function'
}

/**
 * Fail before any DSH listener, tool, service, or skill registration.
 * @param {unknown} ctx
 */
export function assertDshRc7Runtime(ctx) {
  const root = /** @type {Record<string, any>} */ (ctx)
  const missing = DSH_RC7_RUNTIME_SURFACE.filter(path => !resolveFunction(root, path))
  if (missing.length > 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      `DeepSeek Harness is missing required public runtime capabilities: ${missing.join(', ')}`,
      { adapter: 'dsh-rolling-v1', missing },
    )
  }
  return Object.freeze({
    schema_version: 'dsh-runtime-kit.dsh-runtime-report.v1',
    adapter: 'dsh-rolling-v1',
    compatible: true,
  })
}

/** @param {unknown} value @param {string} kind */
function matchesKind(value, kind) {
  if (kind === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === kind
}

/** @param {string} specifier */
async function resolvedPackageVersion(specifier) {
  let cursor
  try {
    cursor = dirname(fileURLToPath(import.meta.resolve(specifier)))
  } catch {
    return undefined
  }
  const filesystemRoot = parse(cursor).root
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(resolve(cursor, 'package.json'), 'utf8'))
      if (manifest.name === specifier) return manifest.version
    } catch {}
    if (cursor === filesystemRoot) return undefined
    cursor = dirname(cursor)
  }
}

/**
 * Load every consumed DSH runtime value behind one typed, version-bound seam.
 * No production module statically links these values before this check.
 * @param {{importModule?: (specifier: string) => Promise<Record<string, unknown>>, packageVersion?: (specifier: string) => Promise<string | undefined>}} [options]
 */
export async function loadDshRc7Runtime(options = {}) {
  const importModule = options.importModule ?? (specifier => import(specifier))
  const packageVersion = options.packageVersion ?? resolvedPackageVersion
  const namespaces = new Map()
  /** @type {Record<string, string>} */
  const versions = {}
  const missing = []
  const selectedDshVersions = new Set()
  for (const [specifier, expectedVersion] of Object.entries(DSH_RC7_PEER_RANGES)) {
    const version = await packageVersion(specifier)
    const supported = specifier === '@deepseek-ai/cordis'
      ? typeof version === 'string' && SUPPORTED_CORDIS_RELEASES.includes(version)
      : typeof version === 'string' && Object.hasOwn(SUPPORTED_DSH_RELEASES, version)
    if (!supported) {
      const diagnosticVersion = /** @type {Record<string, string>} */ (
        DSH_RC7_PEER_VERSIONS
      )[specifier] ?? expectedVersion
      missing.push(`${specifier}:version:${diagnosticVersion}`)
    } else {
      versions[specifier] = version
      if (specifier !== '@deepseek-ai/cordis') selectedDshVersions.add(version)
    }
  }
  if (missing.length === 0 && selectedDshVersions.size !== 1) {
    const retainedPeerVersions = /** @type {Record<string, string>} */ (DSH_RC7_PEER_VERSIONS)
    for (const [specifier, version] of Object.entries(versions)) {
      if (specifier !== '@deepseek-ai/cordis' && version !== retainedPeerVersions[specifier]) {
        missing.push(`${specifier}:version:${retainedPeerVersions[specifier]}`)
      }
    }
  }
  if (missing.length === 0) {
    const selectedDshVersion = /** @type {string} */ (
      selectedDshVersions.values().next().value
    )
    const expectedCordisVersion = /** @type {Record<string, {cordis: string}>} */ (
      SUPPORTED_DSH_RELEASES
    )[selectedDshVersion].cordis
    if (versions['@deepseek-ai/cordis'] !== expectedCordisVersion) {
      missing.push(`@deepseek-ai/cordis:version:${expectedCordisVersion}`)
    }
  }
  if (missing.length > 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      `Installed DSH peer identities do not match one reviewed release: ${missing.join(', ')}`,
      { adapter: 'dsh-rolling-v1', missing },
    )
  }
  for (const [specifier, exports] of Object.entries(DSH_RC7_RUNTIME_MODULES)) {
    let namespace
    try {
      namespace = await importModule(specifier)
    } catch {
      missing.push(`${specifier}:module`)
      continue
    }
    namespaces.set(specifier, namespace)
    for (const [symbol, kind] of Object.entries(exports)) {
      if (!matchesKind(namespace[symbol], kind)) {
        missing.push(`${specifier}:${symbol}:${kind}`)
      }
    }
  }
  if (missing.length > 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      `Installed DSH runtime values do not match the reviewed release: ${missing.join(', ')}`,
      { adapter: 'dsh-rolling-v1', missing },
    )
  }
  const bash = namespaces.get('@deepseek-ai/dsh-bash-local')
  const llm = namespaces.get('@deepseek-ai/dsh-llm')
  const sandbox = namespaces.get('@deepseek-ai/dsh-sandbox')
  const skills = namespaces.get('@deepseek-ai/dsh-skill-filesystem')
  const tools = namespaces.get('@deepseek-ai/dsh-tools')
  return Object.freeze({
    ENV_OVERRIDES: bash.ENV_OVERRIDES,
    HarnessError: llm.HarnessError,
    createUserMessage: llm.createUserMessage,
    approveEscalation: sandbox.approveEscalation,
    canonicalPath: sandbox.canonicalPath,
    isNonWideningSandboxEcho: sandbox.isNonWideningSandboxEcho,
    validateEscalationArgs: sandbox.validateEscalationArgs,
    filesystemSkillsApply: skills.apply,
    TOOL_ABORTED: tools.TOOL_ABORTED,
    versions: Object.freeze(versions),
  })
}

/** @param {string} root @param {string} child */
function containedPath(root, child) {
  const candidate = resolve(root, child)
  const rel = relative(root, candidate)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return candidate
  throw new DshCompatibilityError(
    'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
    `DSH package path escapes the checkout: ${child}`,
  )
}

/** @param {string} root @param {string} candidate */
async function canonicalContainedPath(root, candidate) {
  let canonical
  try {
    canonical = await realpath(candidate)
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      'A selected DSH public package path is unavailable',
    )
  }
  const rel = relative(root, canonical)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return canonical
  }
  throw new DshCompatibilityError(
    'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
    'A selected DSH public package path resolves outside the checkout',
  )
}

/** @param {string} path */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      `DeepSeek Harness package metadata is unavailable: ${path}`,
      { cause: String(/** @type {Error} */ (error)?.message ?? error) },
    )
  }
}

/**
 * Inspect one already-built, clean, selected DSH source checkout through its
 * declared package entrypoints. This never writes to the upstream checkout.
 * @param {{sourceRoot: string, channel: string, revision: string, clean: boolean, manifest: unknown}} input
 */
export async function inspectDshSource(input) {
  const manifest = validateDshCompatibilityManifest(input.manifest)
  if (!CHANNELS.includes(input.channel)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_CHANNEL_INVALID',
      `Unknown DSH compatibility channel: ${input.channel}`,
    )
  }
  const channel = manifest.channels[input.channel]
  if (input.revision !== channel.revision) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_UNSELECTED_DSH_REVISION',
      `DSH ${input.channel} revision does not match the reviewed selection`,
      { channel: input.channel, expected_revision: channel.revision, actual_revision: input.revision },
    )
  }
  if (input.clean !== true) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
      'DSH compatibility checkout must remain clean',
      { channel: input.channel, revision: input.revision },
    )
  }
  if (typeof input.sourceRoot !== 'string' || !isAbsolute(input.sourceRoot)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
      'DSH source root must be an absolute path',
    )
  }
  const root = await realpath(input.sourceRoot)
  const rootManifest = await readJson(joinPath(root, 'package.json'))
  if (rootManifest.name !== '@deepseek-ai/dsh-root' || rootManifest.version !== channel.version) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      'DSH root package identity does not match the selected channel',
      { expected_version: channel.version, actual_version: rootManifest.version },
    )
  }

  const missing = []
  const packages = []
  for (const [name, contract] of Object.entries(manifest.public_packages)) {
    const packageRoot = await canonicalContainedPath(root, containedPath(root, contract.path))
    const packageManifest = await readJson(joinPath(packageRoot, 'package.json'))
    const expectedVersion = contract.version ?? channel.version
    const rootExport = packageManifest.exports?.['.']
    if (packageManifest.name !== name
      || packageManifest.version !== expectedVersion
      || typeof rootExport?.types !== 'string'
      || typeof rootExport?.default !== 'string') {
      missing.push(`${name}:package-root`)
      continue
    }
    const entrypoint = await canonicalContainedPath(
      root,
      containedPath(packageRoot, rootExport.default),
    )
    const typeEntrypoint = await canonicalContainedPath(
      root,
      containedPath(packageRoot, rootExport.types),
    )
    try {
      const typeMetadata = await stat(typeEntrypoint)
      const metadata = await stat(entrypoint)
      if (!metadata.isFile() || !typeMetadata.isFile()) throw new Error('not a regular entrypoint')
      const [entrypointBytes, typeBytes] = await Promise.all([
        readFile(entrypoint),
        readFile(typeEntrypoint),
      ])
      const entrypointDigest = createHash('sha256').update(entrypointBytes).digest('hex')
      const typeDigest = createHash('sha256').update(typeBytes).digest('hex')
      if (entrypointDigest !== contract.entrypoint_sha256) {
        missing.push(`${name}:built-entrypoint-digest`)
      }
      if (typeDigest !== contract.types_sha256) missing.push(`${name}:types-digest`)
    } catch {
      missing.push(`${name}:built-entrypoint`)
    }
    packages.push(Object.freeze({
      name,
      version: packageManifest.version,
      expected_exports: Object.freeze({ ...contract.exports }),
    }))
  }
  if (missing.length > 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
      `DSH public package contract is incompatible: ${missing.join(', ')}`,
      { channel: input.channel, revision: input.revision, missing },
    )
  }
  return Object.freeze({
    schema_version: 'dsh-runtime-kit.dsh-source-report.v1',
    compatible: true,
    channel: input.channel,
    revision: input.revision,
    version: channel.version,
    packages: Object.freeze(packages),
  })
}

/** @param {string} left @param {string} right */
function joinPath(left, right) {
  return resolve(left, right)
}
