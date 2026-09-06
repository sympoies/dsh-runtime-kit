import { packageAsset } from '../package-root.js'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parse as parseYaml } from 'yaml'

import { inspectCanonicalPackageArtifact } from '../compat/package-artifact.js'
import {
  assertProvenanceOutsideSources,
  BuildSourceContainmentError,
  BuildSourceLimitError,
  packedSourceDigest,
  validateBuildProvenance,
} from './build-provenance.js'
import { requiredAbsolutePath, resolveAgentHookRuntime } from '../nils/agent-hook-runtime.js'
import {
  activationSha256,
  assetSetSha256,
  policyOverridesSha256,
  readActivation,
  renderAgentHookConfig,
  resolveActivationRoot,
  resolveProviderDisjointPath,
  resolveProviderHomeTopology,
  validatePolicyOverrides,
} from '../activation/index.js'

const PACKAGE_NAME = '@sympoies/dsh-runtime-kit'
const POLICY_OVERRIDES_SCHEMA = 'dsh-runtime-kit.policy-overrides.v1'
const LEGACY_STATE_SCHEMA = 'dsh-runtime-kit.operations-state.v1'
const STATE_SCHEMA = 'dsh-runtime-kit.operations-state.v2'
const LEGACY_PLAN_SCHEMA = 'dsh-runtime-kit.operations-plan.v1'
const PLAN_SCHEMA = 'dsh-runtime-kit.operations-plan.v2'
const OUTPUT_SCHEMA = 'cli.dsh-runtime-kit.operations.v1'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const MAX_PACKED_PACKAGE_BYTES = 128 * 1024 * 1024
const MAX_INSTALLED_PACKAGE_FILES = 16_384
const MAX_INSTALLED_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_ARTIFACT_COUNT = 64
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const MAX_ACTIVATION_ASSET_BYTES = 4 * 1024 * 1024
const MAX_ACTIVATION_ASSET_SETS = 16
const RUNTIME_ROOT_OWNER_SCHEMA = 'dsh-runtime-kit.runtime-root-owner.v1'
// The declarative profile lifecycle a reviewed package carries
// (`package.json#dsh.lifecycle`). The vocabulary below is the complete set of
// surfaces, assets, migrations, probes, and behaviours this engine implements;
// a declaration outside it is unsupported rather than silently ignored.
const LIFECYCLE_SCHEMA = 'dsh-runtime-kit.profile-lifecycle.v1'
const LIFECYCLE_OWNED_PROFILE_SURFACES = Object.freeze([
  'dependency', 'bundle', 'installed-package', 'lockfile-projection',
])
const LIFECYCLE_OWNED_HOME_SURFACES = Object.freeze([
  'operations-state', 'operations-lock', 'artifact-store',
])
const LIFECYCLE_GENERATED_SURFACES = Object.freeze([
  'activation-manifest', 'runtime-root-owner', 'asset-set', 'agent-hook-state', 'agent-docs-state',
])
const LIFECYCLE_ACTIVATION_ASSETS = Object.freeze({
  policy: 'policy/dsh-runtime-kit-v1.toml',
  catalog: 'agent-docs/AGENT_DOCS.toml',
  document: 'agent-docs/PROJECT_DEV_EDIT.md',
})
const LIFECYCLE_COMPATIBILITY = Object.freeze({
  dsh: 'compatibility/dsh.json',
  nils_cli: 'compatibility/nils-cli.json',
})
const LIFECYCLE_DEPENDENCIES = Object.freeze(['agent-hook', 'agent-docs'])
const LIFECYCLE_MIGRATION_V1_TO_V2 = 'operations-state-v1-to-v2'
const LIFECYCLE_MIGRATIONS = Object.freeze({
  [LIFECYCLE_MIGRATION_V1_TO_V2]: Object.freeze({
    from: LEGACY_STATE_SCHEMA,
    to: STATE_SCHEMA,
    path: 'doctor --repair',
  }),
})
const LIFECYCLE_HEALTH_PROBES = Object.freeze(['dsh-version', 'agent-hook-doctor', 'agent-docs-version'])
const INSTALL_LIFECYCLE_SCRIPTS = Object.freeze([
  'preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare',
  'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies',
])
const TARGET_LIFECYCLES = new WeakMap()
const DSH_COMPATIBILITY = JSON.parse(readFileSync(
  packageAsset('compatibility', 'dsh.json'),
  'utf8',
))
const HEALTH_COMMAND_TIMEOUT_MS = 30_000
const PACKAGE_COMMAND_TIMEOUT_MS = 120_000
const MUTATION_COMMAND_TIMEOUT_MS = 10 * 60_000
const MIN_COMMAND_TIMEOUT_MS = 100
// `supervise-command.mjs` is plain JavaScript that the build does not emit,
// so it is resolved from the shipped sources rather than from `dist`.
const COMMAND_SUPERVISOR = packageAsset('src', 'operations', 'supervise-command.mjs')
const NILS_COMPATIBILITY = JSON.parse(readFileSync(
  packageAsset('compatibility', 'nils-cli.json'),
  'utf8',
))
const AGENT_DOCS_MINIMUM_RELEASE = NILS_COMPATIBILITY.minimum_supported_release
const AGENT_DOCS_VALIDATED_RELEASE = NILS_COMPATIBILITY.validated_release
const SUPERVISOR_SETTLEMENT_MS = 7_000
const PROCESS_GROUP_SETTLEMENT_MS = 5_000
const PACKED_TARGETS = new WeakMap()
const SAFE_ENVIRONMENT_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TZ', 'NO_PROXY', 'no_proxy',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME',
  'LC_MONETARY', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE',
  'LC_MEASUREMENT', 'LC_IDENTIFICATION',
])
const PROXY_ENVIRONMENT_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
])

class OperationsError extends Error {
  code
  exitCode
  details

  constructor(code: string, message: string, exitCode: number = 65, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

// Applying a reviewed repair may discover that the profile, recovery state,
// activation inventory, or provider-root topology changed since preview. Only
// those durable evidence failures are plan drift. Command supervision and
// runtime isolation failures retain their typed infrastructure/config codes.
const REVIEWED_REPAIR_DRIFT_CODES = new Set([
  'activation-asset-inventory-invalid',
  'activation-asset-retention-limit',
  'activation-drift',
  'installed-package-limit',
  'invalid-installed-package',
  'invalid-json',
  'invalid-operations-state',
  'invalid-profile-manifest',
  'owned-state-drift',
  'profile-snapshot-limit',
  'recovery-ambiguous',
  'repair-not-required',
  'runtime-root-owner-invalid',
  'runtime-root-owner-missing',
  'unsafe-profile-tree',
  'unsafe-repair-runtime-root',
])

function reviewedRepairApplyError(error: unknown) {
  if (error instanceof OperationsError && REVIEWED_REPAIR_DRIFT_CODES.has(error.code)) {
    return new OperationsError('plan-drift', 'recovery state changed after preview')
  }
  return error
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string  {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = ((value) as Record<string, unknown>)
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function readJson(path: string) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new OperationsError('state-read-failed', `failed to read ${path}`, 65, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    return { raw, value: JSON.parse(raw) }
  } catch {
    throw new OperationsError('invalid-json', `${path} is not valid JSON`)
  }
}

function lstatMaybe(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (((error) as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertOwnedPath(path: string, kind: 'directory' | 'file', privateOnly: boolean = false, allowRoot: boolean = false) {
  const stat = lstatMaybe(path)
  if (stat === null || stat.isSymbolicLink()
    || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new OperationsError('unsafe-profile-tree', `${path} must be a real ${kind}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid() && !(allowRoot && stat.uid === 0)) {
    throw new OperationsError('unsafe-profile-tree', `${path} must be owned by the current user`)
  }
  const forbidden = privateOnly ? 0o077 : 0o022
  if ((stat.mode & forbidden) !== 0) {
    throw new OperationsError('unsafe-profile-tree', `${path} has unsafe permissions`)
  }
  return stat
}

function ensurePrivateDirectory(path: string) {
  const existed = lstatMaybe(path) !== null
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertOwnedPath(path, 'directory', true)
  if (!existed && lstatMaybe(dirname(path))?.isDirectory()) fsyncDirectory(dirname(path))
}

function fsyncDirectory(path: string) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function assertSafeStateFile(path: string) {
  const stat = lstatMaybe(path)
  if (stat === null) return
  assertOwnedPath(path, 'file', true)
}

const ATOMIC_REPLACE_MARKER = '.dsh-runtime-kit-atomic.'

function injectTestFault(point: string) {
  if (process.env.NODE_ENV === 'test'
    && process.env.DSH_RUNTIME_KIT_TEST_FAULT_POINT === point) {
    process.kill(process.pid, 'SIGKILL')
  }
}

function cleanupAtomicReplaceTemporaries(path: string, privateOnly: boolean) {
  const directory = dirname(path)
  assertOwnedPath(directory, 'directory', privateOnly)
  const prefix = `.${basename(path)}${ATOMIC_REPLACE_MARKER}`
  let removed = false
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const temporary = join(directory, name)
    const stat = assertOwnedPath(temporary, 'file', true)
    if (stat.nlink !== 1) {
      throw new OperationsError('unsafe-profile-tree', `${temporary} must have exactly one link`)
    }
    unlinkSync(temporary)
    removed = true
  }
  if (removed) fsyncDirectory(directory)
}

/**
 * Replace an owned control file without modifying its current inode in place.
 * The durable temporary is private and lives in the target directory.
 */
function atomicReplaceOwnedFile(path: string, content: string | Buffer, mode: number, options: {privateOnly?: boolean, faultPoint?: string} = {}) {
  const privateOnly = options.privateOnly ?? false
  if (lstatMaybe(path) !== null) assertOwnedPath(path, 'file', privateOnly)
  cleanupAtomicReplaceTemporaries(path, privateOnly)
  const temporary = join(
    dirname(path),
    `.${basename(path)}${ATOMIC_REPLACE_MARKER}${process.pid}.${randomUUID()}.tmp`,
  )
  let fd
  let renamed = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (options.faultPoint !== undefined) injectTestFault(options.faultPoint)
    renameSync(temporary, path)
    renamed = true
    chmodSync(path, mode)
    fd = openSync(path, 'r')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    fsyncDirectory(dirname(path))
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    if (!renamed) {
      try { unlinkSync(temporary) } catch {}
    }
  }
}

function atomicRemoveOwnedFile(path: string, options: {privateOnly?: boolean, beforeFaultPoint?: string, afterFaultPoint?: string} = {}) {
  const privateOnly = options.privateOnly ?? false
  cleanupAtomicReplaceTemporaries(path, privateOnly)
  if (lstatMaybe(path) === null) return
  assertOwnedPath(path, 'file', privateOnly)
  if (options.beforeFaultPoint !== undefined) injectTestFault(options.beforeFaultPoint)
  unlinkSync(path)
  fsyncDirectory(dirname(path))
  if (options.afterFaultPoint !== undefined) injectTestFault(options.afterFaultPoint)
}

function atomicWriteJson(path: string, value: unknown) {
  ensurePrivateDirectory(dirname(path))
  assertSafeStateFile(path)
  atomicReplaceOwnedFile(path, `${JSON.stringify(value, undefined, 2)}\n`, 0o600, {
    privateOnly: true,
  })
}

function plainRecord(value: unknown): value is Record<string, unknown>  {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reviewedDshRevision(version: unknown) {
  if (typeof version !== 'string' || !plainRecord(DSH_COMPATIBILITY.validated_releases)) return null
  const release = DSH_COMPATIBILITY.validated_releases[version]
  if (!plainRecord(release)
    || Object.keys(release).sort().join(',') !== 'cordis,ref,revision'
    || (release.cordis !== '4.0.1' && release.cordis !== '4.0.2')
    || typeof release.ref !== 'string'
    || typeof release.revision !== 'string'
    || !/^[a-f0-9]{40}$/.test(release.revision)) return null
  return release.revision
}

function validateProfile(profile: string) {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new OperationsError('invalid-profile', 'profile must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}', 64)
  }
  return profile
}

function resolveHome() {
  const configured = process.env.DSH_HOME
  const requested = configured === undefined ? join(homedir(), '.dsh') : configured
  try {
    return resolveProviderDisjointPath(requested, 'DSH home')
  } catch (error) {
    throw new OperationsError(
      'unsafe-dsh-home',
      error instanceof Error ? error.message : 'DSH home overlaps a provider runtime home',
    )
  }
}

function pathsFor(home: string, profile: string) {
  return {
    home,
    profile,
    profileDir: join(home, 'profiles', profile),
    manifest: join(home, 'profiles', profile, 'package.json'),
    installedPackage: join(home, 'profiles', profile, 'node_modules', '@sympoies', 'dsh-runtime-kit'),
    installedManifest: join(home, 'profiles', profile, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json'),
    state: join(home, 'runtime-kit', 'state', `${profile}.json`),
    lock: join(home, 'runtime-kit', 'state', `${profile}.lock`),
    artifacts: join(home, 'runtime-kit', 'artifacts'),
  }
}

function prepareOperationsTree(paths: ReturnType<typeof pathsFor>) {
  assertOperationsTree(paths)
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  assertOwnedPath(paths.home, 'directory')
  ensurePrivateDirectory(join(paths.home, 'runtime-kit'))
  ensurePrivateDirectory(dirname(paths.state))
  ensurePrivateDirectory(paths.artifacts)
}

function assertOperationsTree(paths: ReturnType<typeof pathsFor>) {
  if (lstatMaybe(paths.home) !== null) assertOwnedPath(paths.home, 'directory')
  for (const path of [join(paths.home, 'runtime-kit'), dirname(paths.state), paths.artifacts]) {
    if (lstatMaybe(path) !== null) assertOwnedPath(path, 'directory', true)
  }
}

function assertProfileTree(paths: ReturnType<typeof pathsFor>) {
  const profilesRoot = join(paths.home, 'profiles')
  if (lstatMaybe(profilesRoot) !== null) assertOwnedPath(profilesRoot, 'directory')
  if (lstatMaybe(paths.profileDir) !== null) assertOwnedPath(paths.profileDir, 'directory')
  const manifestStat = lstatMaybe(paths.manifest)
  if (manifestStat === null) return
  assertOwnedPath(paths.manifest, 'file')
  const nodeModules = join(paths.profileDir, 'node_modules')
  const scope = join(nodeModules, '@sympoies')
  if (lstatMaybe(nodeModules) !== null) assertOwnedPath(nodeModules, 'directory')
  if (lstatMaybe(scope) !== null) assertOwnedPath(scope, 'directory')
}

function pathIsWithin(parent: string, child: string) {
  const fragment = relative(parent, child)
  return fragment === '' || (!fragment.startsWith(`..${sep}`) && fragment !== '..' && !isAbsolute(fragment))
}

function packageTreeDigest(packagePath: string, containmentPath: string) {
  const containmentRoot = realpathSync(containmentPath)
  const packageRoot = realpathSync(packagePath)
  if (!pathIsWithin(containmentRoot, packageRoot)) {
    throw new OperationsError('unsafe-profile-tree', 'runtime-kit package resolves outside its authenticated root')
  }
  const hash = createHash('sha256')
  let entries = 0
  let bytes = 0
  const visit = (absolute: string, logical: string, depth: number) => {
    if (depth > 64) throw new OperationsError('installed-package-limit', 'installed package exceeds the depth limit')
    // The authenticated npm artifact digest binds the complete bundled
    // dependency closure. pnpm owns and normalizes the installed top-level
    // node_modules materialization, so the post-install identity projects that
    // subtree out while continuing to bind every package-owned path.
    if (depth === 1 && logical === 'node_modules') return
    const stat = lstatSync(absolute)
    entries += 1
    if (entries > MAX_INSTALLED_PACKAGE_FILES) {
      throw new OperationsError('installed-package-limit', 'installed package exceeds the entry limit')
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute)
      const resolved = realpathSync(absolute)
      if (!pathIsWithin(packageRoot, resolved)) {
        throw new OperationsError('unsafe-profile-tree', 'installed package contains an escaping symlink')
      }
      hash.update(`L\0${logical}\0${target}\0`)
      return
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${logical}\0`)
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), logical === '' ? name : `${logical}/${name}`, depth + 1)
      return
    }
    if (!stat.isFile()) throw new OperationsError('unsafe-profile-tree', 'installed package contains a special filesystem entry')
    bytes += stat.size
    if (bytes > MAX_INSTALLED_PACKAGE_BYTES) {
      throw new OperationsError('installed-package-limit', 'installed package exceeds the byte limit')
    }
    // npm/pnpm preserve whether a file is executable but may normalize an
    // owner-only 0700 source entry to 0755 while installing it. Bind the
    // executable role, not the caller's umask-specific distribution bits.
    hash.update(`F\0${logical}\0${(stat.mode & 0o111) === 0 ? 0 : 1}\0${stat.size}\0`)
    hash.update(readFileSync(absolute))
  }
  visit(packageRoot, '', 0)
  return hash.digest('hex')
}

function installedPackageDigest(paths: ReturnType<typeof pathsFor>) {
  return packageTreeDigest(paths.installedPackage, paths.profileDir)
}

function packageAssets(packageRoot: string) {
  const paths = {
    policy: join(packageRoot, 'policy', 'dsh-runtime-kit-v1.toml'),
    catalog: join(packageRoot, 'agent-docs', 'AGENT_DOCS.toml'),
    document: join(packageRoot, 'agent-docs', 'PROJECT_DEV_EDIT.md'),
  }
  const bytes = (({}) as Record<string, Buffer>)
  let total = 0
  for (const [name, path] of Object.entries(paths)) {
    const stat = lstatMaybe(path)
    if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
      throw new OperationsError('invalid-package-spec', `package activation asset ${name} must be a regular file`)
    }
    total += stat.size
    if (total > MAX_ACTIVATION_ASSET_BYTES) {
      throw new OperationsError('invalid-package-spec', 'package activation assets exceed the byte limit')
    }
    bytes[name] = readFileSync(path)
  }
  const assets = {
    catalog_sha256: sha256(bytes.catalog),
    document_sha256: sha256(bytes.document),
    policy_sha256: sha256(bytes.policy),
  }
  return {
    ...assets,
    asset_set_sha256: assetSetSha256(assets),
  }
}

/**
 * Bind receipt-bound policy overrides into a target's asset set so the plan
 * digest, the staged config, and the activation manifest all change with them.
 */
function assetsWithOverrides(assets: ReturnType<typeof packageAssets>, overrides: Record<string, 'advise'> | undefined) {
  if (overrides === undefined) return assets
  const members = {
    catalog_sha256: assets.catalog_sha256,
    document_sha256: assets.document_sha256,
    policy_sha256: assets.policy_sha256,
    policy_overrides_sha256: policyOverridesSha256(overrides),
  }
  return { ...members, asset_set_sha256: assetSetSha256(members) }
}

/**
 * The `override_class` declared for every `[[rules]]` entry of a runtime-kit
 * policy bundle. The bundle is strict TOML written by this repository, so a
 * line-oriented read of `id` and `override_class` inside each table is exact.
 */
function policyRuleClasses(text: string): Map<string, string>  {
  const classes: Map<string, string> = new Map()
  let id: string | undefined
  let overrideClass: string | undefined
  const flush = () => {
    if (id !== undefined && overrideClass !== undefined) classes.set(id, overrideClass)
    id = undefined
    overrideClass = undefined
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '[[rules]]') { flush(); continue }
    const match = /^(id|override_class)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line)
    if (match === null) continue
    if (match[1] === 'id') id = match[2]
    else overrideClass = match[2]
  }
  flush()
  return classes
}

/**
 * Accept a policy override only for a rule the packaged bundle itself declares
 * `downgrade-only` (Tier B). Tier A and Tier C rules are `locked`, so naming
 * one is a typed refusal before any mutation; nils rejects the same override
 * at load time, and this check exists to fail at preview instead of at
 * activation health.
 */
function assertOverridesDowngradable(packageRoot: string, overrides: Record<string, 'advise'> | undefined) {
  if (overrides === undefined) return
  const classes = policyRuleClasses(
    readFileSync(join(packageRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8'),
  )
  for (const id of Object.keys(overrides)) {
    const overrideClass = classes.get(id)
    if (overrideClass === undefined) {
      throw new OperationsError('policy-override-unknown-rule', `policy override names no rule of the package: ${id}`, 64)
    }
    if (overrideClass !== 'downgrade-only') {
      throw new OperationsError(
        'policy-override-not-downgradable',
        `policy override names a ${overrideClass} rule that cannot be downgraded: ${id}`,
        64,
      )
    }
  }
}

/** Read and validate a `dsh-runtime-kit.policy-overrides.v1` file. */
function readPolicyOverrides(path: string | undefined): Record<string, 'advise'> | undefined  {
  if (path === undefined) return undefined
  const absolute = resolve(path)
  const stat = lstatMaybe(absolute)
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new OperationsError('invalid-policy-overrides', 'policy overrides must be a small regular JSON file', 64)
  }
  const value = readJson(absolute).value
  if (!plainRecord(value)
    || value.schema_version !== POLICY_OVERRIDES_SCHEMA
    || Object.keys(value).sort().join(',') !== 'overrides,schema_version') {
    throw new OperationsError('invalid-policy-overrides', `policy overrides must carry ${POLICY_OVERRIDES_SCHEMA} and an overrides map`, 64)
  }
  try {
    return validatePolicyOverrides(value.overrides)
  } catch (error) {
    throw new OperationsError('invalid-policy-overrides', error instanceof Error ? error.message : 'invalid policy overrides', 64)
  }
}

function validateAssets(value: unknown) {
  const keys = plainRecord(value) ? Object.keys(value).sort().join(',') : ''
  const withOverrides = keys === 'asset_set_sha256,catalog_sha256,document_sha256,policy_overrides_sha256,policy_sha256'
  if (!plainRecord(value)
    || (keys !== 'asset_set_sha256,catalog_sha256,document_sha256,policy_sha256' && !withOverrides)
    || !Object.keys(value).every(key => typeof value[key] === 'string' && DIGEST_PATTERN.test(value[key]))) {
    throw new OperationsError('invalid-operations-state', 'package target has invalid activation assets')
  }
  const expected = assetSetSha256({
    catalog_sha256: ((value.catalog_sha256) as string),
    document_sha256: ((value.document_sha256) as string),
    policy_sha256: ((value.policy_sha256) as string),
    ...withOverrides ? { policy_overrides_sha256: ((value.policy_overrides_sha256) as string) } : {},
  })
  if (expected !== value.asset_set_sha256) {
    throw new OperationsError('invalid-operations-state', 'package target activation asset digest is inconsistent')
  }
  return ((value) as {asset_set_sha256:string,catalog_sha256:string,document_sha256:string,policy_sha256:string,policy_overrides_sha256?:string})
}

function readActual(paths: ReturnType<typeof pathsFor>) {
  assertProfileTree(paths)
  if (lstatMaybe(paths.manifest) === null) {
    return {
      profile_exists: false,
      manifest_digest: 'absent',
      dependency_spec: null,
      bundle_indexes: [],
      installed_version: null,
      installed_name: null,
      installed_digest: null,
      installed_entry: false,
    }
  }
  const manifest = readJson(paths.manifest)
  if (!plainRecord(manifest.value)) throw new OperationsError('invalid-profile-manifest', 'profile package.json must be an object')
  const dependencies = plainRecord(manifest.value.dependencies) ? manifest.value.dependencies : {}
  const dependency = dependencies[PACKAGE_NAME]
  if (dependency !== undefined && typeof dependency !== 'string') {
    throw new OperationsError('invalid-profile-manifest', `${PACKAGE_NAME} dependency must be a string`)
  }
  const dsh = plainRecord(manifest.value.dsh) ? manifest.value.dsh : {}
  const profile = plainRecord(dsh.profile) ? dsh.profile : {}
  const bundles = profile.bundles === undefined ? [] : profile.bundles
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
    throw new OperationsError('invalid-profile-manifest', 'dsh.profile.bundles must be a string array')
  }
  let installedVersion = null
  let installedName = null
  let installedDigest = null
  const installedEntry = lstatMaybe(paths.installedPackage) !== null
  if (installedEntry && existsSync(paths.installedManifest)) {
    const installed = readJson(paths.installedManifest).value
    if (!plainRecord(installed) || typeof installed.name !== 'string' || typeof installed.version !== 'string') {
      throw new OperationsError('invalid-installed-package', 'installed runtime-kit package manifest is invalid')
    }
    installedName = installed.name
    installedVersion = installed.version
    installedDigest = installedPackageDigest(paths)
  }
  return {
    profile_exists: true,
    manifest_digest: sha256(manifest.raw),
    dependency_spec: typeof dependency === 'string' ? dependency : null,
    bundle_indexes: bundles.flatMap((value, index) => value === PACKAGE_NAME ? [index] : []),
    installed_version: installedVersion,
    installed_name: installedName,
    installed_digest: installedDigest,
    installed_entry: installedEntry,
  }
}

function publicActual(actual: ReturnType<typeof readActual>) {
  return {
    profile_exists: actual.profile_exists,
    manifest_digest: actual.manifest_digest,
    dependency_spec_digest: actual.dependency_spec === null ? null : sha256(actual.dependency_spec),
    bundle_indexes: actual.bundle_indexes,
    installed_version: actual.installed_version,
    installed_name: actual.installed_name,
    installed_digest: actual.installed_digest,
    installed_entry: actual.installed_entry,
  }
}

const PROFILE_SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'pnpm-workspace.yml']

function captureProfileSnapshot(paths: ReturnType<typeof pathsFor>) {
  let total = 0
  const files = PROFILE_SNAPSHOT_FILES.map(name => {
    const path = join(paths.profileDir, name)
    const stat = lstatMaybe(path)
    if (stat === null) return { name, present: false, content: null, mode: null }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new OperationsError('unsafe-profile-tree', `${name} must be a regular profile file`)
    }
    total += stat.size
    if (total > 16 * 1024 * 1024) {
      throw new OperationsError('profile-snapshot-limit', 'profile control files exceed the snapshot byte limit')
    }
    return { name, present: true, content: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 }
  })
  return { files, digest: sha256(stableJson(files)) }
}

function validateProfileSnapshot(value: unknown) {
  if (!plainRecord(value) || typeof value.digest !== 'string' || !DIGEST_PATTERN.test(value.digest)
    || !Array.isArray(value.files) || value.files.length !== PROFILE_SNAPSHOT_FILES.length) {
    throw new OperationsError('invalid-operations-state', 'pending profile snapshot is invalid')
  }
  const names = value.files.map(file => plainRecord(file) ? file.name : undefined)
  if (stableJson(names) !== stableJson(PROFILE_SNAPSHOT_FILES)) {
    throw new OperationsError('invalid-operations-state', 'pending profile snapshot inventory is invalid')
  }
  let total = 0
  for (const file of value.files) {
    if (!plainRecord(file) || typeof file.name !== 'string' || typeof file.present !== 'boolean'
      || (file.present
        ? (typeof file.content !== 'string' || !Number.isSafeInteger(file.mode))
        : !(file.content === null && file.mode === null))) {
      throw new OperationsError('invalid-operations-state', 'pending profile snapshot file is invalid')
    }
    if (file.present) total += Buffer.byteLength(((file.content) as string))
  }
  if (total > 16 * 1024 * 1024 || sha256(stableJson(value.files)) !== value.digest) {
    throw new OperationsError('invalid-operations-state', 'pending profile snapshot digest is invalid')
  }
  return ((value) as ReturnType<typeof captureProfileSnapshot>)
}

function restoreProfileSnapshot(snapshot: ReturnType<typeof captureProfileSnapshot>, paths: ReturnType<typeof pathsFor>) {
  for (const file of snapshot.files) {
    const path = join(paths.profileDir, file.name)
    if (!file.present) {
      atomicRemoveOwnedFile(path, {
        beforeFaultPoint: `restore-profile:${file.name}:before-unlink`,
        afterFaultPoint: `restore-profile:${file.name}:after-unlink`,
      })
      continue
    }
    atomicReplaceOwnedFile(
      path,
      ((file.content) as string),
      ((file.mode) as number),
      { faultPoint: `restore-profile:${file.name}` },
    )
  }
}

function cleanupProfileRestoreTemporaries(snapshot: ReturnType<typeof captureProfileSnapshot>, paths: ReturnType<typeof pathsFor>) {
  for (const file of snapshot.files) {
    cleanupAtomicReplaceTemporaries(join(paths.profileDir, file.name), false)
  }
}

function commitRestoredState(path: string, stateRead: ReturnType<typeof readState>) {
  if (stateRead.raw === null) {
    atomicRemoveOwnedFile(path, {
      privateOnly: true,
      beforeFaultPoint: 'restore-state:before-unlink',
      afterFaultPoint: 'restore-state:after-unlink',
    })
    return
  }
  atomicReplaceOwnedFile(path, stateRead.raw, 0o600, {
    privateOnly: true,
    faultPoint: 'restore-state',
  })
}

function unownedManifest(raw: string) {
  const manifest = JSON.parse(raw)
  if (plainRecord(manifest.dependencies)) {
    delete manifest.dependencies[PACKAGE_NAME]
    // pnpm drops the dependencies object once its last entry is removed, so a
    // profile whose only dependency was runtime-kit projects to the same
    // unowned manifest whether the empty object is present or absent.
    if (Object.keys(manifest.dependencies).length === 0) delete manifest.dependencies
  }
  if (plainRecord(manifest.dsh) && plainRecord(manifest.dsh.profile)
    && Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      /** @param {unknown} value */ (value: unknown) => value !== PACKAGE_NAME,
    )
  }
  return manifest
}

function lockInventory(lock: Record<string, unknown>) {
  return new Set(['packages', 'snapshots'].flatMap(section => {
    const entry = lock[section]
    return plainRecord(entry) ? Object.keys(entry) : []
  }))
}

function runtimeKitLockClosure(lock: Record<string, unknown>, inventory: Set<string>) {
  const roots = new Set([...inventory].filter(key => key.startsWith(`${PACKAGE_NAME}@`)))
  const closure = new Set(roots)
  const snapshots = plainRecord(lock.snapshots) ? lock.snapshots : {}
  const queue = [...roots]
  while (queue.length > 0) {
    const key = ((queue.shift()) as string)
    const snapshot = snapshots[key]
    if (!plainRecord(snapshot)) continue
    for (const field of ['dependencies', 'optionalDependencies']) {
      const dependencies = snapshot[field]
      if (!plainRecord(dependencies)) continue
      for (const [name, resolution] of Object.entries(dependencies)) {
        const version = typeof resolution === 'string'
          ? resolution
          : plainRecord(resolution) && typeof resolution.version === 'string'
            ? resolution.version
            : undefined
        if (version === undefined) continue
        const prefix = `${name}@${version}`
        for (const candidate of inventory) {
          if ((candidate === prefix || candidate.startsWith(`${prefix}(`))
            && !closure.has(candidate)) {
            closure.add(candidate)
            queue.push(candidate)
          }
        }
      }
    }
  }
  return { roots, closure }
}

function unownedLock(lock: Record<string, unknown>, removed: Set<string>) {
  const projected = structuredClone(lock)
  if (plainRecord(projected.importers)) {
    for (const details of Object.values(projected.importers)) {
      if (!plainRecord(details)) continue
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        if (!plainRecord(details[field])) continue
        delete details[field][PACKAGE_NAME]
        if (Object.keys(details[field]).length === 0) delete details[field]
      }
    }
  }
  for (const section of ['packages', 'snapshots']) {
    if (!plainRecord(projected[section])) continue
    for (const key of removed) delete projected[section][key]
    if (Object.keys(projected[section]).length === 0) delete projected[section]
  }
  return projected
}

/**
 * Accept a lock created from an empty profile only when it contains exactly
 * the one reviewed artifact root. Runtime-kit-prefixed keys and dependency
 * edges are not ownership evidence: both can be supplied by the mutating DSH
 * process itself.
 */
function generatedLockContainsOnlyReviewedRoot(raw: string, target: ReturnType<typeof validateTarget> | null, paths: ReturnType<typeof pathsFor> | null) {
  if (target === null || paths === null) return false
  const lock = parseYaml(raw)
  if (!plainRecord(lock)
    || Object.keys(lock).sort().join(',') !== 'importers,lockfileVersion,packages,settings,snapshots'
    || lock.lockfileVersion !== '9.0'
    || stableJson(lock.settings) !== stableJson({
      autoInstallPeers: false,
      excludeLinksFromLockfile: false,
    })
    || !plainRecord(lock.importers)
    || Object.keys(lock.importers).join(',') !== '.'
    || !plainRecord(lock.importers['.'])
    || Object.keys(lock.importers['.']).join(',') !== 'dependencies'
    || !plainRecord(lock.importers['.'].dependencies)
    || Object.keys(lock.importers['.'].dependencies).join(',') !== PACKAGE_NAME) return false

  const dependency = lock.importers['.'].dependencies[PACKAGE_NAME]
  if (!plainRecord(dependency)
    || Object.keys(dependency).sort().join(',') !== 'specifier,version'
    || typeof dependency.specifier !== 'string'
    || typeof dependency.version !== 'string') return false

  const artifact = artifactPathFor(paths, target)
  if (dependencyPath(dependency.specifier, paths) !== artifact
    || dependencyPath(dependency.version, paths) !== artifact) return false

  const root = `${PACKAGE_NAME}@${dependency.version}`
  if (!plainRecord(lock.packages)
    || Object.keys(lock.packages).join(',') !== root
    || !plainRecord(lock.snapshots)
    || Object.keys(lock.snapshots).join(',') !== root) return false

  const packageEntry = lock.packages[root]
  const snapshotEntry = lock.snapshots[root]
  if (!plainRecord(packageEntry)
    || Object.keys(packageEntry).some(key => ![
      'resolution', 'version', 'engines', 'hasBin', 'peerDependencies', 'bundledDependencies',
    ].includes(key))
    || !plainRecord(packageEntry.resolution)
    || Object.keys(packageEntry.resolution).sort().join(',') !== 'integrity,tarball'
    || typeof packageEntry.resolution.integrity !== 'string'
    || packageEntry.resolution.integrity.length === 0
    || typeof packageEntry.resolution.tarball !== 'string'
    || dependencyPath(packageEntry.resolution.tarball, paths) !== artifact
    || packageEntry.version !== target.expected_version
    || (Object.hasOwn(packageEntry, 'engines') && !plainRecord(packageEntry.engines))
    || (Object.hasOwn(packageEntry, 'hasBin') && typeof packageEntry.hasBin !== 'boolean')
    || (Object.hasOwn(packageEntry, 'peerDependencies') && !plainRecord(packageEntry.peerDependencies))
    || (Object.hasOwn(packageEntry, 'bundledDependencies') && !Array.isArray(packageEntry.bundledDependencies))
    || !plainRecord(snapshotEntry)
    || Object.keys(snapshotEntry).length !== 0) return false
  return true
}

function lockProjections(leftRaw: string | null, rightRaw: string | null, ownedTarget: ReturnType<typeof validateTarget> | null = null, paths: ReturnType<typeof pathsFor> | null = null) {
  if (leftRaw === null && rightRaw === null) return [null, null]
  if (leftRaw === null) {
    return generatedLockContainsOnlyReviewedRoot(((rightRaw) as string), ownedTarget, paths)
      ? [null, null]
      : [leftRaw, rightRaw]
  }
  if (rightRaw === null) {
    return generatedLockContainsOnlyReviewedRoot(leftRaw, ownedTarget, paths)
      ? [null, null]
      : [leftRaw, rightRaw]
  }
  const left = parseYaml(leftRaw)
  const right = parseYaml(rightRaw)
  if (!plainRecord(left) || !plainRecord(right)) return [left, right]
  const leftInventory = lockInventory(left)
  const rightInventory = lockInventory(right)
  const leftClosure = runtimeKitLockClosure(left, leftInventory)
  const rightClosure = runtimeKitLockClosure(right, rightInventory)
  const leftRemoved = new Set([
    ...leftClosure.roots,
    ...[...leftClosure.closure].filter(key => !rightInventory.has(key)),
  ])
  const rightRemoved = new Set([
    ...rightClosure.roots,
    ...[...rightClosure.closure].filter(key => !leftInventory.has(key)),
  ])
  return [unownedLock(left, leftRemoved), unownedLock(right, rightRemoved)]
}

function profileHasCollateralMutation(
  before: ReturnType<typeof captureProfileSnapshot>,
  after: ReturnType<typeof captureProfileSnapshot>,
  allowInitialization: boolean = false,
  ownedTarget: ReturnType<typeof validateTarget> | null = null,
  paths: ReturnType<typeof pathsFor> | null = null,
) {
  const beforeMap = new Map(before.files.map(file => [file.name, file]))
  const afterMap = new Map(after.files.map(file => [file.name, file]))
  const beforeManifest = beforeMap.get('package.json')
  const afterManifest = afterMap.get('package.json')
  const beforeManifestPresent = beforeManifest?.present === true
  const afterManifestPresent = afterManifest?.present === true
  const initializedByMutation = allowInitialization
    && !beforeManifestPresent
    && afterManifestPresent
  if (beforeManifestPresent !== afterManifestPresent && !initializedByMutation) return true
  if (beforeManifestPresent && afterManifestPresent
    && stableJson(unownedManifest(((beforeManifest.content) as string)))
      !== stableJson(unownedManifest(((afterManifest.content) as string)))) return true
  for (const name of PROFILE_SNAPSHOT_FILES.slice(1)) {
    const left = beforeMap.get(name)
    const right = afterMap.get(name)
    // A pinned native DSH invocation owns the files it creates while
    // initializing a profile whose manifest was absent. Existing profile
    // control files remain collateral-protected below.
    if (initializedByMutation && left?.present !== true) continue
    const leftRaw = left?.present ? ((left.content) as string) : null
    const rightRaw = right?.present ? ((right.content) as string) : null
    try {
      const [leftProjection, rightProjection] = lockProjections(leftRaw, rightRaw, ownedTarget, paths)
      if (stableJson(leftProjection) !== stableJson(rightProjection)) return true
    } catch {
      return true
    }
  }
  return false
}

function actualAbsent(actual: ReturnType<typeof readActual>) {
  return actual.dependency_spec === null && actual.bundle_indexes.length === 0
    && actual.installed_version === null && actual.installed_name === null
    && actual.installed_digest === null
    && actual.installed_entry === false
}

function assertActualInstall(actual: ReturnType<typeof readActual>) {
  if (actual.dependency_spec === null || actual.bundle_indexes.length !== 1
    || actual.installed_name !== PACKAGE_NAME || actual.installed_version === null
    || actual.installed_digest === null) {
    throw new OperationsError('owned-state-drift', 'runtime-kit dependency, bundle row, and installed package are not one consistent installation')
  }
}

function validateTarget(value: unknown) {
  if (!plainRecord(value) || !['registry', 'local'].includes(((value.kind) as string))
    || typeof value.requested_spec !== 'string'
    || typeof value.expected_version !== 'string'
    || !EXACT_VERSION_PATTERN.test(value.expected_version)) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid package target')
  }
  if (value.kind === 'registry') {
    if (Object.keys(value).some(key => ![
      'kind', 'requested_spec', 'expected_version', 'artifact_sha256', 'installed_sha256', 'assets', 'policy_overrides',
    ].includes(key))
      || value.requested_spec !== `${PACKAGE_NAME}@${value.expected_version}`
      || typeof value.artifact_sha256 !== 'string' || !DIGEST_PATTERN.test(value.artifact_sha256)
      || typeof value.installed_sha256 !== 'string' || !DIGEST_PATTERN.test(value.installed_sha256)) {
      throw new OperationsError('invalid-operations-state', 'operations state contains an invalid registry target')
    }
  } else if (Object.keys(value).some(key => ![
    'kind', 'requested_spec', 'source_path', 'expected_version', 'artifact_sha256', 'installed_sha256', 'assets', 'policy_overrides',
  ].includes(key)) || typeof value.source_path !== 'string' || !isAbsolute(value.source_path)
    || typeof value.artifact_sha256 !== 'string' || !DIGEST_PATTERN.test(value.artifact_sha256)
    || typeof value.installed_sha256 !== 'string' || !DIGEST_PATTERN.test(value.installed_sha256)) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid local package target')
  }
  const assets = validateAssets(value.assets)
  let overrides: Record<string, 'advise'> | undefined
  try {
    overrides = validatePolicyOverrides(value.policy_overrides)
  } catch {
    throw new OperationsError('invalid-operations-state', 'operations state contains invalid policy overrides')
  }
  if ((overrides === undefined) !== (assets.policy_overrides_sha256 === undefined)
    || (overrides !== undefined && policyOverridesSha256(overrides) !== assets.policy_overrides_sha256)) {
    throw new OperationsError('invalid-operations-state', 'package target policy overrides do not match their asset digest')
  }
  return ((value) as {kind:'registry',requested_spec:string,expected_version:string,artifact_sha256:string,installed_sha256:string,assets:ReturnType<typeof validateAssets>,policy_overrides?:Record<string,'advise'>}|{kind:'local',requested_spec:string,source_path:string,expected_version:string,artifact_sha256:string,installed_sha256:string,assets:ReturnType<typeof validateAssets>,policy_overrides?:Record<string,'advise'>})
}

function validateLegacyTarget(value: unknown) {
  if (!plainRecord(value) || !['registry', 'local'].includes(((value.kind) as string))
    || typeof value.requested_spec !== 'string'
    || typeof value.expected_version !== 'string'
    || !EXACT_VERSION_PATTERN.test(value.expected_version)) {
    throw new OperationsError('invalid-operations-state', 'legacy operations state contains an invalid package target')
  }
  const common = ['kind', 'requested_spec', 'expected_version', 'artifact_sha256', 'installed_sha256']
  if (value.kind === 'registry') {
    if (Object.keys(value).some(key => !common.includes(key))
      || value.requested_spec !== `${PACKAGE_NAME}@${value.expected_version}`
      || typeof value.artifact_sha256 !== 'string' || !DIGEST_PATTERN.test(value.artifact_sha256)
      || typeof value.installed_sha256 !== 'string' || !DIGEST_PATTERN.test(value.installed_sha256)) {
      throw new OperationsError('invalid-operations-state', 'legacy operations state contains an invalid registry target')
    }
  } else if (Object.keys(value).some(key => ![...common, 'source_path'].includes(key))
    || typeof value.source_path !== 'string' || !isAbsolute(value.source_path)
    || typeof value.artifact_sha256 !== 'string' || !DIGEST_PATTERN.test(value.artifact_sha256)
    || typeof value.installed_sha256 !== 'string' || !DIGEST_PATTERN.test(value.installed_sha256)) {
    throw new OperationsError('invalid-operations-state', 'legacy operations state contains an invalid local package target')
  }
  return ((value) as {kind:'registry',requested_spec:string,expected_version:string,artifact_sha256:string,installed_sha256:string}|{kind:'local',requested_spec:string,source_path:string,expected_version:string,artifact_sha256:string,installed_sha256:string})
}

function artifactPathFor(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>) {
  return join(paths.artifacts, `${target.artifact_sha256}.tgz`)
}

function dependencyPath(spec: string, paths: ReturnType<typeof pathsFor>) {
  const candidate = spec.replace(/^(?:file|link):/, '')
  return isAbsolute(candidate) ? resolve(candidate) : resolve(paths.profileDir, candidate)
}

function targetMatchesActual(actual: ReturnType<typeof readActual>, target: ReturnType<typeof validateTarget>, paths: ReturnType<typeof pathsFor>) {
  if (actual.dependency_spec === null || actual.bundle_indexes.length !== 1
    || actual.installed_name !== PACKAGE_NAME || actual.installed_version !== target.expected_version) return false
  const artifactPath = artifactPathFor(paths, target)
  try {
    assertSafeStateFile(artifactPath)
    const stat = statSync(artifactPath)
    if (stat.size > MAX_PACKED_PACKAGE_BYTES || sha256(readFileSync(artifactPath)) !== target.artifact_sha256) return false
    return dependencyPath(actual.dependency_spec, paths) === artifactPath
      && actual.installed_digest === target.installed_sha256
  } catch {
    return false
  }
}

function expectedSnapshot(actual: ReturnType<typeof readActual>, target: ReturnType<typeof validateTarget>, paths: ReturnType<typeof pathsFor>, runtimeRoot: string, profile: string) {
  assertActualInstall(actual)
  if (!targetMatchesActual(actual, target, paths)) {
    throw new OperationsError('native-dsh-verification-failed', 'installed runtime-kit target does not match the reviewed package identity')
  }
  return {
    requested_spec: target.requested_spec,
    dependency_spec: actual.dependency_spec,
    installed_version: actual.installed_version,
    installed_digest: actual.installed_digest,
    bundle_index: actual.bundle_indexes[0],
    runtime_root: runtimeRoot,
    activation_digest: sha256(`${JSON.stringify(activationManifest(target, profile), undefined, 2)}\n`),
    target,
  }
}

function snapshot(actual: ReturnType<typeof readActual>, target: ReturnType<typeof validateTarget>, paths: ReturnType<typeof pathsFor>, runtimeRoot: string, profile: string) {
  const expected = expectedSnapshot(actual, target, paths, runtimeRoot, profile)
  if (!activationMatches(target, runtimeRoot, profile)
    || sha256(readFileSync(join(runtimeRoot, 'activation.json'))) !== expected.activation_digest) {
    throw new OperationsError('activation-drift', 'active policy and docs do not match the installed package')
  }
  return expected
}

function validateSnapshot(value: unknown) {
  if (!plainRecord(value) || typeof value.requested_spec !== 'string'
    || typeof value.dependency_spec !== 'string' || typeof value.installed_version !== 'string'
    || typeof value.installed_digest !== 'string' || !DIGEST_PATTERN.test(value.installed_digest)
    || !Number.isSafeInteger(value.bundle_index) || ((value.bundle_index) as number) < 0
    || typeof value.runtime_root !== 'string' || !isAbsolute(value.runtime_root)
    || typeof value.activation_digest !== 'string' || !DIGEST_PATTERN.test(value.activation_digest)
    || Object.keys(value).some(key => ![
      'requested_spec', 'dependency_spec', 'installed_version', 'installed_digest', 'bundle_index',
      'runtime_root', 'activation_digest', 'target',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid install snapshot')
  }
  const target = validateTarget(value.target)
  if (value.requested_spec !== target.requested_spec || value.installed_version !== target.expected_version) {
    throw new OperationsError('invalid-operations-state', 'install snapshot does not match its package target')
  }
  return ((value) as {requested_spec: string, dependency_spec: string, installed_version: string, installed_digest: string, bundle_index: number, runtime_root: string, activation_digest: string, target: ReturnType<typeof validateTarget>})
}

function validateLegacySnapshot(value: unknown) {
  if (!plainRecord(value) || typeof value.requested_spec !== 'string'
    || typeof value.dependency_spec !== 'string' || typeof value.installed_version !== 'string'
    || typeof value.installed_digest !== 'string' || !DIGEST_PATTERN.test(value.installed_digest)
    || !Number.isSafeInteger(value.bundle_index) || ((value.bundle_index) as number) < 0
    || Object.keys(value).some(key => ![
      'requested_spec', 'dependency_spec', 'installed_version', 'installed_digest', 'bundle_index', 'target',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'legacy operations state contains an invalid install snapshot')
  }
  const target = validateLegacyTarget(value.target)
  if (value.requested_spec !== target.requested_spec || value.installed_version !== target.expected_version) {
    throw new OperationsError('invalid-operations-state', 'legacy install snapshot does not match its package target')
  }
  return ((value) as {requested_spec: string, dependency_spec: string, installed_version: string, installed_digest: string, bundle_index: number, target: ReturnType<typeof validateLegacyTarget>})
}

function snapshotMatches(actual: ReturnType<typeof readActual>, expected: ReturnType<typeof validateSnapshot>, paths: ReturnType<typeof pathsFor>) {
  return actual.dependency_spec === expected.dependency_spec
    && actual.installed_version === expected.installed_version
    && actual.installed_digest === expected.installed_digest
    && actual.installed_name === PACKAGE_NAME
    && actual.bundle_indexes.length === 1
    && actual.bundle_indexes[0] === expected.bundle_index
    && targetMatchesActual(actual, expected.target, paths)
    && activationMatches(expected.target, expected.runtime_root, paths.profile)
    && sha256(readFileSync(join(expected.runtime_root, 'activation.json'))) === expected.activation_digest
}

function readState(path: string, expectedProfile: string) {
  if (lstatMaybe(path) === null) return { raw: null, digest: 'absent', value: null, version: null }
  assertSafeStateFile(path)
  const read = readJson(path)
  if (!plainRecord(read.value)
    || read.value.profile !== expectedProfile
    || !['current', 'previous', 'last_applied', 'pending'].every(key => Object.hasOwn(read.value, key))
    || Object.keys(read.value).some(key => ![
      'schema_version', 'profile', 'current', 'previous', 'last_applied', 'pending',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'runtime-kit operations state has an unsupported schema')
  }
  if (read.value.schema_version === STATE_SCHEMA) {
    if (read.value.current !== null) validateSnapshot(read.value.current)
    if (read.value.previous !== null) validateSnapshot(read.value.previous)
    if (read.value.pending !== null) validatePending(read.value.pending, expectedProfile)
    if (read.value.last_applied !== null) validateAppliedReceipt(read.value.last_applied, expectedProfile)
    return { raw: read.raw, digest: sha256(read.raw), value: read.value, version: 2 }
  }
  if (read.value.schema_version === LEGACY_STATE_SCHEMA) {
    if (read.value.current !== null) validateLegacySnapshot(read.value.current)
    if (read.value.previous !== null) validateLegacySnapshot(read.value.previous)
    if (read.value.pending !== null) validateLegacyPending(read.value.pending, expectedProfile)
    if (read.value.last_applied !== null) validateLegacyAppliedReceipt(read.value.last_applied, expectedProfile)
    return { raw: read.raw, digest: sha256(read.raw), value: read.value, version: 1 }
  }
  throw new OperationsError('invalid-operations-state', 'runtime-kit operations state has an unsupported schema')
}

function sameStringSet(left: unknown, right: readonly string[]) {
  return Array.isArray(left)
    && left.every(value => typeof value === 'string')
    && new Set(left).size === left.length
    && left.length === right.length
    && [...left].sort().join('\0') === [...right].sort().join('\0')
}

function invalidLifecycle(message: string, details: Record<string, unknown> = {}) {
  return new OperationsError('invalid-lifecycle-manifest', message, 65, details)
}

function invalidBuildProvenance(message: string, details: Record<string, unknown> = {}) {
  return new OperationsError('invalid-build-provenance', message, 65, details)
}

/**
 * Authenticate a reviewed package that ships build output against the sources
 * it was built from. A package that declares no `dsh.build` ships its reviewed
 * sources directly and is admitted unchanged.
 *
 * The build records the digest of the sources it consumed; this recomputes that
 * digest from the sources as packed. They disagree exactly when the output no
 * longer corresponds to the shipped sources — the failure no other signal
 * catches, because `npm pack --ignore-scripts` runs no build and every
 * lifecycle hook that could is already refused.
 *
 * Scope: this authenticates the sources, not the output. A `dist/` left
 * partially written by an interrupted build still matches its sources and is
 * admitted; what the gate refuses is output built from *different* sources.
 *
 * Throws or returns nothing: verification is the whole contribution, and no
 * provenance is bound into the reviewed plan.
 */
function packageBuildProvenance(packageRoot: string) {
  const manifest = readJson(join(packageRoot, 'package.json')).value
  if (!plainRecord(manifest)) throw new OperationsError('invalid-package-spec', 'package manifest must be an object')
  const dsh = plainRecord(manifest.dsh) ? manifest.dsh : {}
  if (dsh.build === undefined) return null
  const declared = dsh.build
  if (typeof declared !== 'string'
    || !/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/u.test(declared)) {
    throw invalidBuildProvenance('dsh.build must be a package-relative JSON path')
  }
  const root = resolve(packageRoot)
  const provenancePath = resolve(root, declared)
  if (provenancePath === root || !pathIsWithin(root, provenancePath)) {
    throw invalidBuildProvenance('dsh.build must stay inside the package')
  }
  const stat = lstatMaybe(provenancePath)
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidBuildProvenance('build provenance must be a regular file inside the package', { path: declared })
  }
  const raw = readFileSync(provenancePath)
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw invalidBuildProvenance('build provenance is not valid JSON', { path: declared })
  }
  let validated
  try {
    validated = validateBuildProvenance(parsed)
    // A provenance file inside its own sources would be an input to the digest
    // it records, so no value could ever satisfy the check.
    assertProvenanceOutsideSources(relative(root, provenancePath), validated.sources)
  } catch (error) {
    throw invalidBuildProvenance(error instanceof Error ? error.message : 'build provenance is invalid', { path: declared })
  }
  for (const declaredRoot of [...validated.sources, ...validated.outputs]) {
    const absolute = resolve(root, declaredRoot)
    if (!pathIsWithin(root, absolute)) {
      throw invalidBuildProvenance('build provenance names a path outside the package', { path: declaredRoot })
    }
    const rootStat = lstatMaybe(absolute)
    if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw invalidBuildProvenance('build provenance names a missing root', { path: declaredRoot })
    }
  }
  let observed
  try {
    observed = packedSourceDigest(root, validated.sources)
  } catch (error) {
    // A budget trip or a containment refusal is a property of the tree, not of
    // the declaration, and an unexpected read failure is environmental. Keeping
    // them apart stops a transient error from blaming a correct package, the
    // same separation `packageTreeDigest` already makes.
    if (error instanceof BuildSourceLimitError) {
      throw new OperationsError('installed-package-limit', error.message, 65)
    }
    if (error instanceof BuildSourceContainmentError) {
      throw new OperationsError('unsafe-profile-tree', error.message, 65)
    }
    throw new OperationsError(
      'invalid-package-spec',
      'declared build provenance sources could not be read from the packed package',
      65,
    )
  }
  if (observed !== validated.source_sha256) {
    throw new OperationsError(
      'build-output-stale',
      'packed build output was produced from different sources than the package ships; rebuild before packing',
      65,
      { declared_source_sha256: validated.source_sha256, observed_source_sha256: observed },
    )
  }
}

function unsupportedLifecycle(message: string, details: Record<string, unknown> = {}) {
  return new OperationsError('unsupported-lifecycle-manifest', message, 65, details)
}

/**
 * Validate one declarative profile-lifecycle manifest against the vocabulary
 * this engine enforces. Shape errors are invalid. A well-formed declaration
 * that names a surface, asset, migration, probe, or behaviour this engine does
 * not implement is unsupported, so a newer package can never be installed by an
 * engine that would silently ignore part of its declared contract.
 */
function validateLifecycleManifest(value: unknown) {
  if (!plainRecord(value)) throw invalidLifecycle('lifecycle manifest must be an object')
  const keys = [
    'schema_version', 'package', 'owned_surfaces', 'generated_surfaces', 'activation_assets',
    'compatibility', 'dependencies', 'migrations', 'health_probes', 'lifecycle_scripts', 'removal',
  ]
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw invalidLifecycle('lifecycle manifest has missing or unknown keys')
  }
  if (value.schema_version !== LIFECYCLE_SCHEMA) {
    throw invalidLifecycle('lifecycle manifest schema is not supported', { schema_version: value.schema_version })
  }
  if (value.package !== PACKAGE_NAME) throw invalidLifecycle('lifecycle manifest names a different package')
  const owned = value.owned_surfaces
  if (!plainRecord(owned) || Object.keys(owned).sort().join(',') !== 'home,profile'
    || !Array.isArray(owned.profile) || !Array.isArray(owned.home)
    || !plainRecord(value.activation_assets) || !plainRecord(value.compatibility)
    || !Array.isArray(value.generated_surfaces) || !Array.isArray(value.dependencies)
    || !Array.isArray(value.migrations) || !Array.isArray(value.health_probes)
    || typeof value.lifecycle_scripts !== 'string' || typeof value.removal !== 'string') {
    throw invalidLifecycle('lifecycle manifest sections have invalid shapes')
  }
  if (!sameStringSet(owned.profile, LIFECYCLE_OWNED_PROFILE_SURFACES)
    || !sameStringSet(owned.home, LIFECYCLE_OWNED_HOME_SURFACES)) {
    throw unsupportedLifecycle('declared owned surfaces are not the surfaces this engine manages')
  }
  if (!sameStringSet(value.generated_surfaces, LIFECYCLE_GENERATED_SURFACES)) {
    throw unsupportedLifecycle('declared generated surfaces are not the surfaces this engine manages')
  }
  if (stableJson(value.activation_assets) !== stableJson(LIFECYCLE_ACTIVATION_ASSETS)) {
    throw unsupportedLifecycle('declared activation assets are not the assets this engine activates')
  }
  if (stableJson(value.compatibility) !== stableJson(LIFECYCLE_COMPATIBILITY)) {
    throw unsupportedLifecycle('declared compatibility sources are not the sources this engine checks')
  }
  if (!sameStringSet(value.dependencies, LIFECYCLE_DEPENDENCIES)) {
    throw unsupportedLifecycle('declared native dependencies are not the companions this engine authenticates')
  }
  const migrations: string[] = []
  for (const migration of value.migrations) {
    if (!plainRecord(migration) || Object.keys(migration).sort().join(',') !== 'from,id,path,to'
      || [migration.id, migration.from, migration.to, migration.path].some(field => typeof field !== 'string')) {
      throw invalidLifecycle('lifecycle migrations must declare id, from, to, and path')
    }
    const known = ((LIFECYCLE_MIGRATIONS) as Record<string, {from: string, to: string, path: string}>)[
      ((migration.id) as string)
    ]
    if (known === undefined || known.from !== migration.from || known.to !== migration.to
      || known.path !== migration.path) {
      throw unsupportedLifecycle('declared migration is not implemented by this engine', { migration: migration.id })
    }
    migrations.push(((migration.id) as string))
  }
  if (new Set(migrations).size !== migrations.length) throw invalidLifecycle('lifecycle migrations must be unique')
  const probes = value.health_probes
  if (probes.length === 0 || probes.some(probe => typeof probe !== 'string')
    || new Set(probes).size !== probes.length) {
    throw invalidLifecycle('lifecycle health probes must be a non-empty unique list')
  }
  if (probes.some(probe => !LIFECYCLE_HEALTH_PROBES.includes(probe))) {
    throw unsupportedLifecycle('declared health probe is not implemented by this engine')
  }
  if (value.lifecycle_scripts !== 'none') {
    throw unsupportedLifecycle('lifecycle scripts other than none are not supported', {
      lifecycle_scripts: value.lifecycle_scripts,
    })
  }
  if (value.removal !== 'owned-surfaces-only') {
    throw unsupportedLifecycle('removal behaviour other than owned-surfaces-only is not supported', {
      removal: value.removal,
    })
  }
  return { migrations, health_probes: (([...probes]) as string[]) }
}

function lifecycleJson(packageRoot: string, relative: string, label: string) {
  const path = join(packageRoot, relative)
  const stat = lstatMaybe(path)
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidLifecycle(`${label} must be a regular file inside the package`, { path: relative })
  }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw invalidLifecycle(`${label} is not valid JSON`, { path: relative })
  }
  if (!plainRecord(value)) throw invalidLifecycle(`${label} must be an object`, { path: relative })
  return value
}

/**
 * Read the declarative profile lifecycle a reviewed package carries. A package
 * that predates the declaration yields null: it is admitted under this engine's
 * own compatibility manifest and reported as undeclared. Install-time package
 * manager scripts are refused for every package, declared or not, because the
 * only lifecycle authority is the reviewed transaction itself.
 */
function packageLifecycle(packageRoot: string) {
  const manifest = readJson(join(packageRoot, 'package.json')).value
  if (!plainRecord(manifest)) throw new OperationsError('invalid-package-spec', 'package manifest must be an object')
  const scripts = plainRecord(manifest.scripts) ? manifest.scripts : {}
  const installScripts = INSTALL_LIFECYCLE_SCRIPTS.filter(name => Object.hasOwn(scripts, name))
  if (installScripts.length > 0) {
    throw new OperationsError(
      'lifecycle-scripts-declared',
      'package declares install-time lifecycle scripts; runtime-kit lifecycle runs only through the reviewed transaction',
      65,
      { scripts: installScripts },
    )
  }
  const dsh = plainRecord(manifest.dsh) ? manifest.dsh : {}
  if (dsh.lifecycle === undefined) return null
  const declared = dsh.lifecycle
  if (typeof declared !== 'string'
    || !/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/u.test(declared)) {
    throw invalidLifecycle('dsh.lifecycle must be a package-relative JSON path')
  }
  const root = resolve(packageRoot)
  const lifecyclePath = resolve(root, declared)
  if (lifecyclePath === root || !pathIsWithin(root, lifecyclePath)) {
    throw invalidLifecycle('dsh.lifecycle must stay inside the package')
  }
  const stat = lstatMaybe(lifecyclePath)
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidLifecycle('lifecycle manifest must be a regular file inside the package', { path: declared })
  }
  const raw = readFileSync(lifecyclePath)
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw invalidLifecycle('lifecycle manifest is not valid JSON', { path: declared })
  }
  const validated = validateLifecycleManifest(value)
  const dshCompatibility = lifecycleJson(root, LIFECYCLE_COMPATIBILITY.dsh, 'declared DSH compatibility manifest')
  if (dshCompatibility.schema_version !== 'dsh-runtime-kit.dsh-compatibility.v1'
    || !plainRecord(dshCompatibility.validated_releases)) {
    throw invalidLifecycle('declared DSH compatibility manifest has an unsupported schema')
  }
  const releases = Object.keys(dshCompatibility.validated_releases).sort()
  if (releases.length === 0 || releases.some(release => !EXACT_VERSION_PATTERN.test(release))) {
    throw invalidLifecycle('declared DSH compatibility manifest lists no exact validated release')
  }
  const nilsCompatibility = lifecycleJson(root, LIFECYCLE_COMPATIBILITY.nils_cli, 'declared nils compatibility manifest')
  if (nilsCompatibility.schema_version !== 'dsh-runtime-kit.nils-compatibility.v1'
    || typeof nilsCompatibility.minimum_supported_release !== 'string'
    || typeof nilsCompatibility.validated_release !== 'string') {
    throw invalidLifecycle('declared nils compatibility manifest has an unsupported schema')
  }
  return {
    schema_version: LIFECYCLE_SCHEMA,
    sha256: sha256(raw),
    dsh_releases: releases,
    migrations: validated.migrations,
    health_probes: validated.health_probes,
  }
}

function validatePlanLifecycle(value: unknown) {
  if (value === null || value === undefined) return null
  if (!plainRecord(value)
    || Object.keys(value).sort().join(',') !== 'dsh_releases,health_probes,migrations,schema_version,sha256'
    || value.schema_version !== LIFECYCLE_SCHEMA
    || typeof value.sha256 !== 'string' || !DIGEST_PATTERN.test(value.sha256)
    || !Array.isArray(value.dsh_releases) || value.dsh_releases.length === 0
    || value.dsh_releases.some(release => typeof release !== 'string' || !EXACT_VERSION_PATTERN.test(release))
    || !Array.isArray(value.migrations)
    || value.migrations.some(id => typeof id !== 'string' || !Object.hasOwn(LIFECYCLE_MIGRATIONS, id))
    || !Array.isArray(value.health_probes) || value.health_probes.length === 0
    || value.health_probes.some(probe => typeof probe !== 'string' || !LIFECYCLE_HEALTH_PROBES.includes(probe))) {
    throw new OperationsError('invalid-operations-state', 'reviewed plan contains an invalid lifecycle binding')
  }
  return ((value) as ReturnType<typeof packageLifecycle>)
}

/**
 * Read the retained package artifact for a target and authenticate it against
 * the target's reviewed digest before any consumer extracts or installs it.
 */
function readVerifiedArtifact(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>) {
  const path = artifactPathFor(paths, target)
  assertSafeStateFile(path)
  const archive = readFileSync(path)
  if (archive.byteLength > MAX_PACKED_PACKAGE_BYTES || sha256(archive) !== target.artifact_sha256) {
    throw new OperationsError('artifact-drift', 'stored package artifact does not match its reviewed digest')
  }
  return { path, archive }
}

/**
 * Resolve the lifecycle a reviewed target declares. A freshly packed target
 * carries it from inspection; a target known only through its retained
 * artifact (rollback, recovery, migration) is inspected from that exact
 * authenticated archive.
 */
function lifecycleForTarget(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>) {
  // The cache is keyed by target object identity: resolvedTarget seeds it for
  // every freshly packed target and validateTarget returns its input, so a
  // setup or update plan hits without re-extracting. Targets known only from
  // persisted state (rollback, recovery, migration) miss and are inspected
  // from their retained authenticated archive.
  if (TARGET_LIFECYCLES.has(target)) return ((TARGET_LIFECYCLES.get(target)) as ReturnType<typeof packageLifecycle>)
  const { path: artifact, archive } = readVerifiedArtifact(paths, target)
  try {
    inspectCanonicalPackageArtifact(archive)
  } catch {
    throw new OperationsError('artifact-drift', 'stored package artifact is not a canonical bounded package')
  }
  const extracted = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-lifecycle-'))
  try {
    const unpacked = spawn(resolveExecutable('tar'), ['-xzf', artifact, '-C', extracted], paths.home, {
      timeoutMs: PACKAGE_COMMAND_TIMEOUT_MS,
    })
    if (unpacked.status !== 0) {
      throw new OperationsError('artifact-drift', 'stored package artifact could not be inspected')
    }
    const lifecycle = packageLifecycle(join(extracted, 'package'))
    TARGET_LIFECYCLES.set(target, lifecycle)
    return lifecycle
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}

/**
 * Provider and DSH compatibility are checked before any profile mutation: the
 * reviewed package must itself declare the bound DSH release. An undeclared
 * package keeps the engine's own manifest as its only gate.
 */
function assertLifecycleCompatibility(lifecycle: ReturnType<typeof packageLifecycle>, toolchain: ReturnType<typeof resolveToolchain>) {
  if (lifecycle === null) return
  if (!lifecycle.dsh_releases.includes(toolchain.dsh.version)) {
    throw new OperationsError(
      'package-incompatible-dsh',
      'reviewed package does not declare compatibility with the bound DSH release',
      65,
      { dsh_version: toolchain.dsh.version, declared_dsh_releases: lifecycle.dsh_releases },
    )
  }
}

function packPackageSpec(packageSpec: string, cwd: string, npmBin: string, home: string) {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-pack-'))
  try {
    const result = spawn(npmBin, [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary, packageSpec,
    ], home, {
      cwd,
      timeoutMs: PACKAGE_COMMAND_TIMEOUT_MS,
      extraEnv: {
        NPM_CONFIG_USERCONFIG: '/dev/null',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_CACHE: join(temporary, 'npm-cache'),
      },
    })
    if (result.status !== 0) {
      throw new OperationsError('invalid-package-spec', 'npm could not resolve a script-free package artifact', 65, commandFailure(result))
    }
    let output
    try { output = JSON.parse(result.stdout) } catch {
      throw new OperationsError('invalid-package-spec', 'npm pack returned invalid JSON')
    }
    if (!Array.isArray(output) || output.length !== 1 || !plainRecord(output[0])
      || output[0].name !== PACKAGE_NAME || typeof output[0].version !== 'string'
      || typeof output[0].filename !== 'string' || basename(output[0].filename) !== output[0].filename) {
      throw new OperationsError('invalid-package-spec', 'npm pack returned an incompatible package identity')
    }
    const archivePath = join(temporary, output[0].filename)
    const archive = readFileSync(archivePath)
    if (archive.byteLength > MAX_PACKED_PACKAGE_BYTES) {
      throw new OperationsError('invalid-package-spec', 'packed local package exceeds the 128 MiB limit')
    }
    try {
      inspectCanonicalPackageArtifact(archive)
    } catch {
      throw new OperationsError(
        'invalid-package-spec',
        'packed package exceeds expansion limits or contains an unsupported archive structure',
      )
    }
    const extracted = join(temporary, 'extracted')
    mkdirSync(extracted, { mode: 0o700 })
    const tarBin = resolveExecutable('tar')
    const unpacked = spawn(tarBin, ['-xzf', archivePath, '-C', extracted], home, {
      timeoutMs: PACKAGE_COMMAND_TIMEOUT_MS,
    })
    if (unpacked.status !== 0) {
      throw new OperationsError('invalid-package-spec', 'packed local package could not be inspected', 65, commandFailure(unpacked))
    }
    const extractedPackage = join(extracted, 'package')
    const installedSha256 = packageTreeDigest(extractedPackage, extracted)
    const assets = packageAssets(extractedPackage)
    const lifecycle = packageLifecycle(extractedPackage)
    // Verification is the whole contribution: the gate throws, and nothing is
    // bound into the plan, because a receipt shape change would break the
    // baseline-engine readability the lifecycle binding protects.
    packageBuildProvenance(extractedPackage)
    return {
      temporary,
      extracted: extractedPackage,
      archive_path: archivePath,
      artifact_sha256: sha256(archive),
      installed_sha256: installedSha256,
      assets,
      lifecycle,
      version: output[0].version,
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function resolvedTarget(target: Record<string, unknown>, packed: ReturnType<typeof packPackageSpec>, retainPacked: boolean, overrides: Record<string, 'advise'> | undefined = undefined) {
  try {
    assertOverridesDowngradable(packed.extracted, overrides)
  } catch (error) {
    rmSync(packed.temporary, { recursive: true, force: true })
    throw error
  }
  TARGET_LIFECYCLES.set(target, packed.lifecycle)
  if (retainPacked) {
    PACKED_TARGETS.set(target, packed)
  } else {
    rmSync(packed.temporary, { recursive: true, force: true })
  }
  return target
}

function withResolvedTarget(target: ReturnType<typeof resolveTarget> | null, body: () => unknown) {
  try {
    return body()
  } finally {
    const packed = target === null ? undefined : PACKED_TARGETS.get(target)
    if (packed !== undefined) rmSync(packed.temporary, { recursive: true, force: true })
    if (target !== null) PACKED_TARGETS.delete(target)
  }
}

/** @param overrides receipt-bound Tier B downgrades bound into the target */
function resolveTarget(input: string, npmBin: string, home: string, retainPacked: boolean = false, overrides: Record<string, 'advise'> | undefined = undefined) {
  let requestedSpec = input
  let candidate = input
  let prefix = ''
  const prefixed = /^(file|link):(.+)$/.exec(input)
  if (prefixed !== null) {
    prefix = `${prefixed[1]}:`
    candidate = prefixed[2]
  }
  const pathLike = prefix !== '' || isAbsolute(candidate) || candidate === '.' || candidate === '..'
    || candidate.startsWith('./') || candidate.startsWith('../')
  if (pathLike) {
    const absolute = resolve(candidate)
    assertOwnedPath(absolute, 'directory')
    const manifestPath = join(absolute, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new OperationsError('invalid-package-spec', `local package has no package.json: ${absolute}`, 64)
    }
    const manifest = readJson(manifestPath).value
    if (!plainRecord(manifest) || manifest.name !== PACKAGE_NAME
      || typeof manifest.version !== 'string' || !EXACT_VERSION_PATTERN.test(manifest.version)) {
      throw new OperationsError('invalid-package-spec', `local package must be ${PACKAGE_NAME} with an exact version`, 64)
    }
    requestedSpec = `${prefix}${absolute}`
    const packed = packPackageSpec(absolute, absolute, npmBin, home)
    if (packed.version !== manifest.version) {
      rmSync(packed.temporary, { recursive: true, force: true })
      throw new OperationsError('invalid-package-spec', 'packed local package version changed during inspection')
    }
    return resolvedTarget({
        kind: (('local') as const),
        requested_spec: requestedSpec,
        source_path: absolute,
        expected_version: manifest.version,
        artifact_sha256: packed.artifact_sha256,
        installed_sha256: packed.installed_sha256,
        assets: assetsWithOverrides(packed.assets, overrides),
        ...overrides === undefined ? {} : { policy_overrides: overrides },
      }, packed, retainPacked, overrides)
  }
  const registry = /^@sympoies\/dsh-runtime-kit@(.+)$/.exec(input)
  if (registry === null || !EXACT_VERSION_PATTERN.test(registry[1])) {
    throw new OperationsError('invalid-package-spec', `package must be a local ${PACKAGE_NAME} directory or an exact ${PACKAGE_NAME}@<version>`, 64)
  }
  const packed = packPackageSpec(input, home, npmBin, home)
  if (packed.version !== registry[1]) {
    rmSync(packed.temporary, { recursive: true, force: true })
    throw new OperationsError('invalid-package-spec', 'resolved registry package version did not match the exact request')
  }
  return resolvedTarget({
      kind: (('registry') as const),
      requested_spec: input,
      expected_version: registry[1],
      artifact_sha256: packed.artifact_sha256,
      installed_sha256: packed.installed_sha256,
      assets: assetsWithOverrides(packed.assets, overrides),
      ...overrides === undefined ? {} : { policy_overrides: overrides },
    }, packed, retainPacked, overrides)
}

function retainTargetArtifact(digests: Set<string>, target: unknown) {
  if (target === null || target === undefined) return
  const validated = validateTarget(target)
  digests.add(validated.artifact_sha256)
}

function retainedArtifactDigests(paths: ReturnType<typeof pathsFor>) {
  const digests: Set<string> = new Set()
  if (lstatMaybe(dirname(paths.state)) === null) return digests
  for (const name of readdirSync(dirname(paths.state)).sort()) {
    if (!name.endsWith('.json')) continue
    const profile = name.slice(0, -'.json'.length)
    validateProfile(profile)
    const stateRead = readState(join(dirname(paths.state), name), profile)
    const state = stateRead.value
    if (state === null) continue
    if (stateRead.version === 1) {
      if (state.current !== null) digests.add(validateLegacySnapshot(state.current).target.artifact_sha256)
      if (state.previous !== null) digests.add(validateLegacySnapshot(state.previous).target.artifact_sha256)
      if (state.pending !== null) {
        const pending = validateLegacyPending(state.pending, profile)
        if (pending.target !== null) digests.add(validateLegacyTarget(pending.target).artifact_sha256)
      }
      if (state.last_applied !== null) {
        const receipt = ((validateLegacyAppliedReceipt(state.last_applied, profile)) as any)
        if (receipt.plan.target !== null) digests.add(validateLegacyTarget(receipt.plan.target).artifact_sha256)
      }
    } else {
      if (state.current !== null) retainTargetArtifact(digests, validateSnapshot(state.current).target)
      if (state.previous !== null) retainTargetArtifact(digests, validateSnapshot(state.previous).target)
      if (state.pending !== null) retainTargetArtifact(digests, validatePending(state.pending, profile).target)
      if (state.last_applied !== null) {
        const receipt = ((validateAppliedReceipt(state.last_applied, profile)) as any)
        retainTargetArtifact(digests, receipt.plan.target)
      }
    }
  }
  return digests
}

function reconcileArtifacts(paths: ReturnType<typeof pathsFor>) {
  ensurePrivateDirectory(paths.artifacts)
  const retained = retainedArtifactDigests(paths)
  let changed = false
  let count = 0
  let bytes = 0
  for (const name of readdirSync(paths.artifacts).sort()) {
    const path = join(paths.artifacts, name)
    if (/^[a-f0-9]{64}\.tgz\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) {
      assertSafeStateFile(path)
      unlinkSync(path)
      changed = true
      continue
    }
    const match = /^([a-f0-9]{64})\.tgz$/.exec(name)
    if (match === null) throw new OperationsError('artifact-store-invalid', 'artifact store contains an unsupported entry')
    assertSafeStateFile(path)
    if (!retained.has(match[1])) {
      unlinkSync(path)
      changed = true
      continue
    }
    const stat = statSync(path)
    count += 1
    bytes += stat.size
  }
  if (changed) fsyncDirectory(paths.artifacts)
  if (count > MAX_ARTIFACT_COUNT || bytes > MAX_ARTIFACT_BYTES) {
    throw new OperationsError('artifact-capacity', 'retained runtime-kit artifacts exceed the bounded store capacity')
  }
  return { count, bytes, retained }
}

function installSpecForTarget(target: ReturnType<typeof validateTarget>, paths: ReturnType<typeof pathsFor>, npmBin: string) {
  ensurePrivateDirectory(paths.artifacts)
  const artifactPath = artifactPathFor(paths, target)
  const existing = lstatMaybe(artifactPath)
  if (existing !== null) {
    readVerifiedArtifact(paths, target)
    return `file:${artifactPath}`
  }

  const retainedPacked = PACKED_TARGETS.get(target)
  const packageSpec = target.kind === 'local' ? target.source_path : target.requested_spec
  const cwd = target.kind === 'local' ? target.source_path : paths.home
  const packed = retainedPacked ?? packPackageSpec(packageSpec, cwd, npmBin, paths.home)
  try {
    if (packed.version !== target.expected_version || packed.artifact_sha256 !== target.artifact_sha256
      || packed.installed_sha256 !== target.installed_sha256
      || stableJson(assetsWithOverrides(packed.assets, target.policy_overrides)) !== stableJson(target.assets)) {
      throw new OperationsError('plan-drift', 'local package content changed after preview')
    }
    const inventory = reconcileArtifacts(paths)
    const archiveBytes = statSync(packed.archive_path).size
    if (!inventory.retained.has(target.artifact_sha256)
      && (inventory.count + 1 > MAX_ARTIFACT_COUNT || inventory.bytes + archiveBytes > MAX_ARTIFACT_BYTES)) {
      throw new OperationsError('artifact-capacity', 'local package artifact would exceed the bounded store capacity')
    }
    const temporary = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    let complete = false
    try {
      writeFileSync(fd, readFileSync(packed.archive_path))
      fsyncSync(fd)
      closeSync(fd)
      renameSync(temporary, artifactPath)
      fsyncDirectory(paths.artifacts)
      complete = true
    } finally {
      try { closeSync(fd) } catch {}
      if (!complete) {
        try { unlinkSync(temporary) } catch {}
      }
    }
    return `file:${artifactPath}`
  } finally {
    if (retainedPacked === undefined) rmSync(packed.temporary, { recursive: true, force: true })
  }
}

function planFor(operation: string, profile: string, actual: ReturnType<typeof readActual>, stateRead: ReturnType<typeof readState>, target: ReturnType<typeof resolveTarget> | null, action: string, runtimeRoot: string, toolchain: ReturnType<typeof resolveToolchain>, lifecycle: ReturnType<typeof packageLifecycle>) {
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation,
    profile,
    package_name: PACKAGE_NAME,
    action,
    target,
    // A declared lifecycle is bound into the plan; an undeclared target or a
    // remove plan omits the key so the receipt stays readable by the accepted
    // baseline engine, whose plan validator predates the binding.
    ...lifecycle === null ? {} : { lifecycle },
    runtime_root: runtimeRoot,
    toolchain,
    observed: {
      profile_exists: actual.profile_exists,
      dependency_spec_digest: actual.dependency_spec === null ? null : sha256(actual.dependency_spec),
      bundle_indexes: actual.bundle_indexes,
      installed_version: actual.installed_version,
      installed_digest: actual.installed_digest,
      installed_entry: actual.installed_entry,
      manifest_digest: actual.manifest_digest,
      state_digest: stateRead.digest,
    },
  }
  return { plan, plan_digest: sha256(stableJson(plan)) }
}

function validatePlan(value: unknown, profile: string) {
  if (!plainRecord(value) || value.schema_version !== PLAN_SCHEMA || value.profile !== profile
    || value.package_name !== PACKAGE_NAME || typeof value.operation !== 'string'
    || typeof value.action !== 'string' || !plainRecord(value.observed)
    || typeof value.runtime_root !== 'string' || !isAbsolute(value.runtime_root)
    || !plainRecord(value.toolchain)
    || Object.keys(value).some(key => ![
      'schema_version', 'operation', 'profile', 'package_name', 'action', 'target', 'lifecycle',
      'runtime_root', 'toolchain', 'observed',
    ].includes(key))
    || Object.keys(value.observed).some(key => ![
      'profile_exists', 'dependency_spec_digest', 'bundle_indexes', 'installed_version',
      'installed_digest', 'installed_entry', 'manifest_digest', 'state_digest',
    ].includes(key))
    || typeof value.observed.profile_exists !== 'boolean'
    || !(value.observed.dependency_spec_digest === null
      || (typeof value.observed.dependency_spec_digest === 'string' && DIGEST_PATTERN.test(value.observed.dependency_spec_digest)))
    || !Array.isArray(value.observed.bundle_indexes)
    || value.observed.bundle_indexes.some(index => !Number.isSafeInteger(index) || index < 0)
    || !(value.observed.installed_version === null || typeof value.observed.installed_version === 'string')
    || !(value.observed.installed_digest === null
      || (typeof value.observed.installed_digest === 'string' && DIGEST_PATTERN.test(value.observed.installed_digest)))
    || typeof value.observed.installed_entry !== 'boolean'
    || typeof value.observed.manifest_digest !== 'string'
    || !(value.observed.state_digest === 'absent'
      || (typeof value.observed.state_digest === 'string' && DIGEST_PATTERN.test(value.observed.state_digest)))) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid reviewed plan')
  }
  validateToolchain(value.toolchain)
  validatePlanLifecycle(value.lifecycle)
  const actions = {
    setup: ['install', 'noop'],
    update: ['update', 'noop'],
    rollback: ['rollback'],
    remove: ['remove', 'noop'],
  }
  const allowed = ((actions) as Record<string, string[]>)[value.operation]
  if (allowed === undefined || !allowed.includes(value.action)) {
    throw new OperationsError('invalid-operations-state', 'reviewed plan operation and action are inconsistent')
  }
  if (value.operation === 'remove') {
    if (value.target !== null) throw new OperationsError('invalid-operations-state', 'remove plan must not contain a package target')
  } else {
    validateTarget(value.target)
  }
  return value
}

function validatePending(value: unknown, profile: string) {
  if (!plainRecord(value) || typeof value.operation !== 'string'
    || typeof value.plan_digest !== 'string' || !DIGEST_PATTERN.test(value.plan_digest)
    || typeof value.started_at !== 'string'
    || !(value.phase === undefined || ['prepared', 'native-applied'].includes(((value.phase) as string)))
    || Object.keys(value).some(key => ![
      'operation', 'plan_digest', 'target', 'plan', 'phase', 'started_at', 'profile_before',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'runtime-kit pending operation is invalid')
  }
  const plan = validatePlan(value.plan, profile)
  validateProfileSnapshot(value.profile_before)
  if (plan.operation !== value.operation || sha256(stableJson(plan)) !== value.plan_digest
    || stableJson(plan.target) !== stableJson(value.target)) {
    throw new OperationsError('invalid-operations-state', 'pending operation does not match its reviewed plan')
  }
  if (value.operation === 'remove') {
    if (value.target !== null) throw new OperationsError('invalid-operations-state', 'pending remove target must be null')
  } else {
    validateTarget(value.target)
  }
  return value
}

function validateAppliedReceipt(value: unknown, profile: string) {
  if (!plainRecord(value) || typeof value.operation !== 'string'
    || typeof value.plan_digest !== 'string' || !DIGEST_PATTERN.test(value.plan_digest)
    || typeof value.completed_at !== 'string'
    || !(value.recovered === undefined || value.recovered === true)
    || Object.keys(value).some(key => ![
      'operation', 'plan_digest', 'plan', 'completed_at', 'recovered',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'runtime-kit last-applied receipt is invalid')
  }
  const plan = validatePlan(value.plan, profile)
  if (plan.operation !== value.operation || sha256(stableJson(plan)) !== value.plan_digest) {
    throw new OperationsError('invalid-operations-state', 'last-applied receipt does not match its reviewed plan')
  }
  return value
}

function validateLegacyPlan(value: unknown, profile: string) {
  if (!plainRecord(value) || value.schema_version !== LEGACY_PLAN_SCHEMA || value.profile !== profile
    || value.package_name !== PACKAGE_NAME || typeof value.operation !== 'string'
    || typeof value.action !== 'string' || !plainRecord(value.observed)
    || Object.keys(value).some(key => ![
      'schema_version', 'operation', 'profile', 'package_name', 'action', 'target', 'observed',
    ].includes(key))
    || Object.keys(value.observed).some(key => ![
      'profile_exists', 'dependency_spec_digest', 'bundle_indexes', 'installed_version',
      'installed_digest', 'installed_entry', 'manifest_digest', 'state_digest',
    ].includes(key))
    || typeof value.observed.profile_exists !== 'boolean'
    || !(value.observed.dependency_spec_digest === null
      || (typeof value.observed.dependency_spec_digest === 'string' && DIGEST_PATTERN.test(value.observed.dependency_spec_digest)))
    || !Array.isArray(value.observed.bundle_indexes)
    || value.observed.bundle_indexes.some(index => !Number.isSafeInteger(index) || index < 0)
    || !(value.observed.installed_version === null || typeof value.observed.installed_version === 'string')
    || !(value.observed.installed_digest === null
      || (typeof value.observed.installed_digest === 'string' && DIGEST_PATTERN.test(value.observed.installed_digest)))
    || typeof value.observed.installed_entry !== 'boolean'
    || typeof value.observed.manifest_digest !== 'string'
    || !(value.observed.state_digest === 'absent'
      || (typeof value.observed.state_digest === 'string' && DIGEST_PATTERN.test(value.observed.state_digest)))) {
    throw new OperationsError('invalid-operations-state', 'legacy operations state contains an invalid reviewed plan')
  }
  const actions = {
    setup: ['install', 'noop'],
    update: ['update', 'noop'],
    rollback: ['rollback'],
    remove: ['remove', 'noop'],
  }
  const allowed = ((actions) as Record<string, string[]>)[value.operation]
  if (allowed === undefined || !allowed.includes(((value.action) as string))) {
    throw new OperationsError('invalid-operations-state', 'legacy reviewed plan operation and action are inconsistent')
  }
  if (value.operation === 'remove') {
    if (value.target !== null) throw new OperationsError('invalid-operations-state', 'legacy remove plan must not contain a package target')
  } else {
    validateLegacyTarget(value.target)
  }
  return value
}

function validateLegacyPending(value: unknown, profile: string) {
  if (!plainRecord(value) || typeof value.operation !== 'string'
    || typeof value.plan_digest !== 'string' || !DIGEST_PATTERN.test(value.plan_digest)
    || typeof value.started_at !== 'string'
    || !(value.phase === undefined || ['prepared', 'native-applied'].includes(((value.phase) as string)))
    || Object.keys(value).some(key => ![
      'operation', 'plan_digest', 'target', 'plan', 'phase', 'started_at',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'legacy pending operation is invalid')
  }
  const plan = validateLegacyPlan(value.plan, profile)
  if (plan.operation !== value.operation || sha256(stableJson(plan)) !== value.plan_digest
    || stableJson(plan.target) !== stableJson(value.target)) {
    throw new OperationsError('invalid-operations-state', 'legacy pending operation does not match its reviewed plan')
  }
  if (value.operation === 'remove') {
    if (value.target !== null) throw new OperationsError('invalid-operations-state', 'legacy pending remove target must be null')
  } else {
    validateLegacyTarget(value.target)
  }
  return value
}

function validateLegacyAppliedReceipt(value: unknown, profile: string) {
  if (!plainRecord(value) || typeof value.operation !== 'string'
    || typeof value.plan_digest !== 'string' || !DIGEST_PATTERN.test(value.plan_digest)
    || typeof value.completed_at !== 'string'
    || !(value.recovered === undefined || value.recovered === true)
    || Object.keys(value).some(key => ![
      'operation', 'plan_digest', 'plan', 'completed_at', 'recovered',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'legacy last-applied receipt is invalid')
  }
  const plan = validateLegacyPlan(value.plan, profile)
  if (plan.operation !== value.operation || sha256(stableJson(plan)) !== value.plan_digest) {
    throw new OperationsError('invalid-operations-state', 'legacy last-applied receipt does not match its reviewed plan')
  }
  return value
}

function buildMutationPlan(operation: string, profile: string, paths: ReturnType<typeof pathsFor>, actual: ReturnType<typeof readActual>, stateRead: ReturnType<typeof readState>, requestedTarget: ReturnType<typeof resolveTarget> | null, runtimeRoot: string, toolchain: ReturnType<typeof resolveToolchain>) {
  const state = stateRead.value
  if (stateRead.version === 1) {
    throw new OperationsError(
      'operations-state-migration-required',
      'legacy operations state must be migrated with doctor --repair before package mutation',
    )
  }
  if (state?.pending !== null && state?.pending !== undefined) {
    throw new OperationsError('recovery-required', 'an interrupted operation must be resolved with doctor --repair')
  }
  const current = state?.current === null || state?.current === undefined
    ? null
    : validateSnapshot(state.current)
  if (current !== null && current.runtime_root !== runtimeRoot) {
    throw new OperationsError(
      'runtime-root-drift',
      'supplied runtime root does not match the persisted current receipt',
    )
  }
  if (current !== null && !snapshotMatches(actual, current, paths)) {
    throw new OperationsError('owned-state-drift', 'observed profile state does not match the last runtime-kit receipt')
  }
  if (current === null && !actualAbsent(actual)) {
    throw new OperationsError('unmanaged-owned-state', 'runtime-kit is installed without an authenticated operations receipt')
  }

  if (operation === 'setup') {
    if (requestedTarget === null) throw new OperationsError('missing-package', 'setup requires --package', 64)
    const lifecycle = lifecycleForTarget(paths, validateTarget(requestedTarget))
    if (current !== null) {
      if (stableJson(current.target) !== stableJson(requestedTarget)) {
        throw new OperationsError('already-managed', 'runtime-kit is already managed; use update for a new exact package', 64)
      }
      return planFor(operation, profile, actual, stateRead, requestedTarget, 'noop', runtimeRoot, toolchain, lifecycle)
    }
    assertLifecycleCompatibility(lifecycle, toolchain)
    return planFor(operation, profile, actual, stateRead, requestedTarget, 'install', runtimeRoot, toolchain, lifecycle)
  }
  if (operation === 'update') {
    if (requestedTarget === null) throw new OperationsError('missing-package', 'update requires --package', 64)
    if (current === null) throw new OperationsError('not-managed', 'update requires a completed setup receipt', 64)
    const lifecycle = lifecycleForTarget(paths, validateTarget(requestedTarget))
    const action = stableJson(current.target) === stableJson(requestedTarget) ? 'noop' : 'update'
    if (action === 'update') assertLifecycleCompatibility(lifecycle, toolchain)
    return planFor(
      operation,
      profile,
      actual,
      stateRead,
      requestedTarget,
      action,
      runtimeRoot,
      toolchain,
      lifecycle,
    )
  }
  if (operation === 'rollback') {
    if (current === null) throw new OperationsError('not-managed', 'rollback requires a current installation', 64)
    if (state?.previous === null || state?.previous === undefined) {
      throw new OperationsError('rollback-unavailable', 'no exact previous runtime-kit receipt is available', 64)
    }
    const previous = validateSnapshot(state.previous)
    if (previous.runtime_root !== runtimeRoot) {
      throw new OperationsError(
        'runtime-root-drift',
        'supplied runtime root does not match the persisted rollback receipt',
      )
    }
    const target = previous.target
    const lifecycle = lifecycleForTarget(paths, target)
    assertLifecycleCompatibility(lifecycle, toolchain)
    return planFor(operation, profile, actual, stateRead, target, 'rollback', runtimeRoot, toolchain, lifecycle)
  }
  if (operation === 'remove') {
    if (current === null) return planFor(operation, profile, actual, stateRead, null, 'noop', runtimeRoot, toolchain, null)
    return planFor(operation, profile, actual, stateRead, null, 'remove', runtimeRoot, toolchain, null)
  }
  throw new OperationsError('unsupported-operation', `unsupported operation ${operation}`, 64)
}

function withLock(path: string, body: () => unknown) {
  ensurePrivateDirectory(dirname(path))
  if (lstatMaybe(path) !== null) assertSafeStateFile(path)
  let database
  try {
    database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    database.exec('PRAGMA busy_timeout = 0')
  } catch (error) {
    try { database?.close() } catch {}
    throw new OperationsError('operations-lock-invalid', 'the runtime-kit operations lock database is unavailable', 65, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  try {
    try {
      database.exec('BEGIN EXCLUSIVE')
    } catch {
      throw new OperationsError('operations-locked', 'another runtime-kit operation is active')
    }
    return body()
  } finally {
    try { database.exec('ROLLBACK') } catch {}
    try { database.close() } catch {}
  }
}

function withOperationLocks(paths: ReturnType<typeof pathsFor>, body: () => unknown) {
  const artifactLock = join(dirname(paths.state), 'artifacts.lock')
  return withLock(artifactLock, () => withLock(paths.lock, body))
}

function assertRuntimeRootOwner(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  const ownerPath = join(runtimeRoot, '.dsh-runtime-kit-owner.json')
  const home = realpathSync(paths.home)
  if (lstatMaybe(ownerPath) === null) {
    throw new OperationsError('runtime-root-owner-missing', 'runtime root ownership record is missing')
  }
  assertSafeStateFile(ownerPath)
  const owner = readJson(ownerPath).value
  if (!plainRecord(owner)
    || owner.schema_version !== RUNTIME_ROOT_OWNER_SCHEMA
    || typeof owner.dsh_home !== 'string'
    || !isAbsolute(owner.dsh_home)
    || Object.keys(owner).sort().join(',') !== 'dsh_home,schema_version') {
    throw new OperationsError('runtime-root-owner-invalid', 'runtime root ownership record is invalid')
  }
  let recordedHome
  try { recordedHome = realpathSync(owner.dsh_home) } catch {
    throw new OperationsError('runtime-root-owner-invalid', 'runtime root owner home is unavailable')
  }
  if (recordedHome !== home) {
    throw new OperationsError(
      'runtime-root-owner-mismatch',
      'runtime root is owned by a different DSH home',
    )
  }
}

function assertRuntimeRootClaimable(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  const ownerPath = join(runtimeRoot, '.dsh-runtime-kit-owner.json')
  if (lstatMaybe(ownerPath) !== null) return assertRuntimeRootOwner(paths, runtimeRoot)
  if (lstatMaybe(join(runtimeRoot, 'activation.json')) !== null
    || lstatMaybe(join(runtimeRoot, 'assets')) !== null) {
    throw new OperationsError(
      'runtime-root-owner-missing',
      'runtime root contains activation state without a dsh-runtime-kit ownership record',
    )
  }
}

function ensureRuntimeRootOwner(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  assertRuntimeRootClaimable(paths, runtimeRoot)
  writeRuntimeRootOwner(paths, runtimeRoot)
}

function writeRuntimeRootOwner(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  const ownerPath = join(runtimeRoot, '.dsh-runtime-kit-owner.json')
  if (lstatMaybe(ownerPath) === null) {
    atomicWriteJson(ownerPath, {
      schema_version: RUNTIME_ROOT_OWNER_SCHEMA,
      dsh_home: realpathSync(paths.home),
    })
  }
  assertRuntimeRootOwner(paths, runtimeRoot)
}

function withRuntimeRootLock(paths: ReturnType<typeof pathsFor>, runtimeRoot: string, body: () => unknown, options: {allowOwnerless?: boolean} = {}) {
  const lock = join(runtimeRoot, '.dsh-runtime-kit.lock')
  return withLock(lock, () => {
    if (options.allowOwnerless !== true) assertRuntimeRootClaimable(paths, runtimeRoot)
    return body()
  })
}

function resolveExecutable(input: string) {
  const candidates = input.includes('/')
    ? [resolve(input)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, input))
  for (const candidate of candidates) {
    try {
      const exact = realpathSync(candidate)
      assertTrustedExecutableAncestors(exact)
      const stat = assertOwnedPath(exact, 'file', false, true)
      if ((stat.mode & 0o111) === 0) continue
      return exact
    } catch {}
  }
  throw new OperationsError('command-unavailable', `cannot resolve a trusted executable for ${basename(input)}`, 70)
}

function assertTrustedExecutableAncestors(executable: string) {
  const filesystemRoot = parse(executable).root
  for (let directory = dirname(executable);; directory = dirname(directory)) {
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperationsError('command-unavailable', 'toolchain executable has an invalid ancestor', 70)
    }
    const currentOwner = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    const rootOwner = stat.uid === 0
    const stickyOwner = (stat.mode & 0o1000) !== 0 && (currentOwner || rootOwner)
    if ((!currentOwner && !rootOwner) || ((stat.mode & 0o022) !== 0 && !stickyOwner)) {
      throw new OperationsError('command-unavailable', 'toolchain executable has an unsafe writable ancestor', 70)
    }
    if (directory === filesystemRoot) break
  }
}

function validateToolchain(value: unknown) {
  if (!plainRecord(value) || !plainRecord(value.dsh) || !plainRecord(value.pnpm)
    || Object.keys(value).sort().join(',') !== 'dsh,pnpm'
    || Object.keys(value.dsh).sort().join(',') !== 'executable,executable_sha256,source_revision,version'
    || Object.keys(value.pnpm).sort().join(',') !== 'executable,executable_sha256,version'
    || typeof value.dsh.executable !== 'string' || !isAbsolute(value.dsh.executable)
    || typeof value.dsh.executable_sha256 !== 'string' || !DIGEST_PATTERN.test(value.dsh.executable_sha256)
    || typeof value.dsh.version !== 'string'
    || typeof value.dsh.source_revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.dsh.source_revision)
    || reviewedDshRevision(value.dsh.version) === null
    || reviewedDshRevision(value.dsh.version) !== value.dsh.source_revision
    || typeof value.pnpm.executable !== 'string' || !isAbsolute(value.pnpm.executable)
    || typeof value.pnpm.executable_sha256 !== 'string' || !DIGEST_PATTERN.test(value.pnpm.executable_sha256)
    || typeof value.pnpm.version !== 'string' || !EXACT_VERSION_PATTERN.test(value.pnpm.version)) {
    throw new OperationsError('invalid-operations-state', 'operations plan has an invalid toolchain identity')
  }
  return ((value) as {dsh:{executable:string,executable_sha256:string,source_revision:string,version:string},pnpm:{executable:string,executable_sha256:string,version:string}})
}

function executableDigest(path: string) {
  const stat = statSync(path)
  if (stat.size > MAX_PACKED_PACKAGE_BYTES) {
    throw new OperationsError('command-unavailable', `${basename(path)} executable exceeds the identity bound`, 70)
  }
  return sha256(readFileSync(path))
}

function resolveToolchain(dshInput: string, home: string) {
  const dsh = resolveExecutable(dshInput)
  const pnpm = resolveExecutable('pnpm')
  const dshResult = spawn(dsh, ['--version'], home, { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
  const pnpmResult = spawn(pnpm, ['--version'], home, { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
  const dshVersion = dshResult.status === 0 ? dshResult.stdout.trim() : ''
  const pnpmVersion = pnpmResult.status === 0 ? pnpmResult.stdout.trim() : ''
  const dshSourceRevision = reviewedDshRevision(dshVersion)
  if (dshSourceRevision === null) {
    throw new OperationsError('command-unavailable', 'DSH toolchain is not an exact reviewed release', 70)
  }
  if (!EXACT_VERSION_PATTERN.test(pnpmVersion)) {
    throw new OperationsError('command-unavailable', 'pnpm toolchain did not report an exact version', 70)
  }
  return validateToolchain({
    dsh: {
      executable: dsh,
      executable_sha256: executableDigest(dsh),
      source_revision: dshSourceRevision,
      version: dshVersion,
    },
    pnpm: {
      executable: pnpm,
      executable_sha256: executableDigest(pnpm),
      version: pnpmVersion,
    },
  })
}

function minimalEnvironment(home: string, extra: Record<string, string> = {}) {
  const env = (({ DSH_HOME: home }) as Record<string, string>)
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key)) env[key] = value
    else if (value !== undefined && PROXY_ENVIRONMENT_KEYS.has(key)) {
      try {
        const proxy = new URL(value)
        if (proxy.username === '' && proxy.password === '') env[key] = value
      } catch {}
    }
  }
  return { ...env, ...extra }
}

function explicitOfflineEnvironment() {
  if (!['NPM_CONFIG_OFFLINE', 'npm_config_offline', 'PNPM_OFFLINE']
    .some(name => process.env[name] === 'true')) return {}
  const environment = (({}) as Record<string, string>)
  for (const name of ['NPM_CONFIG_OFFLINE', 'npm_config_offline', 'PNPM_OFFLINE']) {
    environment[name] = 'true'
  }
  return environment
}

function commandFailure(result: ReturnType<typeof spawnSync>) {
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    exit_code: result.status,
    stderr_bytes: Buffer.byteLength(stderr),
    stderr_sha256: sha256(stderr),
  }
}

function commandTimeout(maximum: number) {
  const configured = Number(process.env.DSH_RUNTIME_KIT_COMMAND_TIMEOUT_MS)
  return Number.isSafeInteger(configured)
    && configured >= MIN_COMMAND_TIMEOUT_MS
    && configured <= maximum
    ? configured
    : maximum
}

function processGroupExists(pgid: number | undefined) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pgid)) return false
  try {
    process.kill(-((pgid) as number), 0)
    return true
  } catch (error) {
    return ((error) as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function settleSupervisorGroup(pgid: number | undefined) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pgid)) {
    return { supported: false, found: false, quiescent: false }
  }
  const found = processGroupExists(pgid)
  if (found) {
    try { process.kill(-((pgid) as number), 'SIGKILL') } catch (error) {
      if (((error) as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { supported: true, found, quiescent: false }
      }
    }
  }
  const deadline = Date.now() + PROCESS_GROUP_SETTLEMENT_MS
  while (processGroupExists(pgid)) {
    if (Date.now() >= deadline) return { supported: true, found, quiescent: false }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  return { supported: true, found, quiescent: true }
}

function supervisorControlBody(raw: unknown) {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8')
  return ''
}

function supervisorControl(raw: unknown) {
  const body = supervisorControlBody(raw)
  const lines = body.trim().split('\n').filter(Boolean)
  if (lines.length < 1 || lines.length > 2) throw new Error('invalid supervisor control rows')
  const records = lines.map(line => JSON.parse(line))
  if (lines.length === 1) return { pgid: undefined, control: records[0] }
  const started = records[0]
  if (!plainRecord(started)
    || Object.keys(started).sort().join(',') !== 'kind,pgid'
    || started.kind !== 'started'
    || typeof started.pgid !== 'number'
    || !Number.isSafeInteger(started.pgid)
    || started.pgid < 1) {
    throw new Error('invalid supervisor process group')
  }
  return { pgid: ((started.pgid) as number), control: records[1] }
}

function supervisorPgid(raw: unknown) {
  try {
    const body = supervisorControlBody(raw)
    const first = JSON.parse(body.split('\n', 1)[0] ?? '')
    return plainRecord(first)
      && Object.keys(first).sort().join(',') === 'kind,pgid'
      && first.kind === 'started'
      && typeof first.pgid === 'number'
      && Number.isSafeInteger(first.pgid)
      && first.pgid > 0
      ? ((first.pgid) as number)
      : undefined
  } catch {
    return undefined
  }
}

function spawn(bin: string, args: string[], home: string, options: {cwd?:string,extraEnv?:Record<string,string>,timeoutMs?:number} = {}) {
  const timeoutMs = commandTimeout(options.timeoutMs ?? HEALTH_COMMAND_TIMEOUT_MS)
  if (process.platform === 'win32') {
    throw new OperationsError('command-containment-unavailable', 'operations command containment requires POSIX process groups', 70)
  }
  const result = spawnSync(process.execPath, [COMMAND_SUPERVISOR, bin, ...args], {
    encoding: 'utf8',
    env: minimalEnvironment(home, {
      ...options.extraEnv,
      DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS: String(timeoutMs),
    }),
    cwd: options.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs + SUPERVISOR_SETTLEMENT_MS,
    killSignal: 'SIGKILL',
  })
  const rawControl = result.output[3]
  let envelope
  try { envelope = supervisorControl(rawControl) } catch {}
  const pgid = envelope?.pgid ?? supervisorPgid(rawControl)
  const noChild = envelope?.pgid === undefined && envelope?.control?.kind === 'spawn-error'
  const settlement = noChild
    ? { supported: true, found: false, quiescent: true }
    : settleSupervisorGroup(pgid)
  if (result.error !== undefined) {
    if (((result.error) as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      if (!settlement.quiescent) {
        throw new OperationsError(
          'command-quiescence-unknown',
          `${basename(bin)} supervisor did not prove process-group quiescence`,
          70,
          { timeout_ms: timeoutMs },
        )
      }
      throw new OperationsError(
        'command-supervisor-timeout',
        `${basename(bin)} supervisor exceeded its settlement deadline`,
        70,
        { timeout_ms: timeoutMs, process_group_quiescent: true },
      )
    }
    throw new OperationsError('command-unavailable', `failed to start ${basename(bin)}`, 70, { cause: result.error.message })
  }
  let control
  try {
    if (envelope === undefined) throw new Error('invalid supervisor result')
    control = envelope.control
  } catch {
    if (!settlement.quiescent) {
      throw new OperationsError('command-quiescence-unknown', `${basename(bin)} process group did not become quiescent`, 70)
    }
    throw new OperationsError('command-supervisor-failed', `${basename(bin)} supervisor returned an invalid result`, 70)
  }
  if (!settlement.quiescent) {
    throw new OperationsError(
      'command-quiescence-unknown',
      `${basename(bin)} process group did not become quiescent`,
      70,
      { timeout_ms: timeoutMs },
    )
  }
  if (control.kind === 'timeout') {
    throw new OperationsError(
      'command-timeout',
      `${basename(bin)} exceeded its bounded execution deadline`,
      70,
      { timeout_ms: timeoutMs, process_group_quiescent: true },
    )
  }
  if (control.kind === 'quiescence-failed') {
    throw new OperationsError(
      'command-quiescence-unknown',
      `${basename(bin)} process group did not become quiescent`,
      70,
      { timeout_ms: timeoutMs },
    )
  }
  if (control.kind === 'output-limit') {
    throw new OperationsError('command-output-limit', `${basename(bin)} exceeded the bounded output limit`, 70)
  }
  if (control.kind === 'spawn-error') {
    throw new OperationsError('command-unavailable', `failed to start ${basename(bin)}`, 70, {
      cause: typeof control.message === 'string' ? control.message : 'unknown spawn error',
    })
  }
  if (control.kind !== 'completed'
    || !(control.status === null || Number.isSafeInteger(control.status))
    || !(control.signal === null || typeof control.signal === 'string')) {
    throw new OperationsError('command-supervisor-failed', `${basename(bin)} supervisor returned an incompatible result`, 70)
  }
  if (settlement.found) {
    throw new OperationsError(
      'command-descendants-left-running',
      `${basename(bin)} returned while its process group remained active`,
      70,
      { process_group_quiescent: true },
    )
  }
  return { ...result, status: control.status, signal: control.signal, error: undefined }
}

function runDshMutation(dshBin: string, home: string, profile: string, verb: string, spec: string | null) {
  const offlineEnvironment = explicitOfflineEnvironment()
  const offline = Object.keys(offlineEnvironment).length > 0
  const args = verb === 'add'
    ? ['plugin', '--profile', profile, 'add', ...(offline ? ['--offline'] : []), '--save-exact', ((spec) as string)]
    : ['plugin', '--profile', profile, 'remove', PACKAGE_NAME]
  const result = spawn(dshBin, args, home, {
    cwd: home,
    timeoutMs: MUTATION_COMMAND_TIMEOUT_MS,
    extraEnv: {
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      ...offlineEnvironment,
    },
  })
  if (result.status !== 0) {
    throw new OperationsError('native-dsh-failed', `DSH plugin ${verb} failed`, result.status ?? 70, commandFailure(result))
  }
}

function activationMatches(target: ReturnType<typeof validateTarget>, runtimeRoot: string, profile: string) {
  try {
    const activation = readActivation(runtimeRoot).manifest
    return activation.profile === profile
      && activation.package_version === target.expected_version
      && activation.package_artifact_sha256 === target.artifact_sha256
      && activation.package_installed_sha256 === target.installed_sha256
      && activation.asset_set_sha256 === target.assets.asset_set_sha256
      && stableJson(activation.assets) === stableJson(manifestAssets(target))
      && stableJson(activation.policy_overrides ?? null) === stableJson(target.policy_overrides ?? null)
  } catch {
    return false
  }
}

function manifestAssets(target: ReturnType<typeof validateTarget>) {
  return {
    policy_sha256: target.assets.policy_sha256,
    catalog_sha256: target.assets.catalog_sha256,
    document_sha256: target.assets.document_sha256,
    ...target.assets.policy_overrides_sha256 === undefined
      ? {}
      : { policy_overrides_sha256: target.assets.policy_overrides_sha256 },
  }
}

function activationManifest(target: ReturnType<typeof validateTarget>, profile: string) {
  return {
    schema_version: 'dsh-runtime-kit.activation.v1',
    profile,
    package_version: target.expected_version,
    package_artifact_sha256: target.artifact_sha256,
    package_installed_sha256: target.installed_sha256,
    asset_set_sha256: target.assets.asset_set_sha256,
    assets: manifestAssets(target),
    ...target.policy_overrides === undefined ? {} : { policy_overrides: target.policy_overrides },
    agent_hook: {
      config: `assets/${target.assets.asset_set_sha256}/agent-hook/config.toml`,
      policy: `assets/${target.assets.asset_set_sha256}/agent-hook/policy.toml`,
      state: 'state/agent-hook',
    },
    agent_docs: {
      home: `assets/${target.assets.asset_set_sha256}/agent-docs`,
      state: 'state/agent-docs',
    },
  }
}

function stagedActivationAssetsMatch(target: ReturnType<typeof validateTarget>, runtimeRoot: string) {
  try {
    const finalRoot = join(runtimeRoot, 'assets', target.assets.asset_set_sha256)
    const hook = join(finalRoot, 'agent-hook')
    const docs = join(finalRoot, 'agent-docs')
    assertOwnedPath(finalRoot, 'directory', true)
    assertOwnedPath(hook, 'directory', true)
    assertOwnedPath(docs, 'directory', true)
    const policy = join(hook, 'policy.toml')
    const config = join(hook, 'config.toml')
    const catalog = join(docs, 'AGENT_DOCS.toml')
    const document = join(docs, 'PROJECT_DEV_EDIT.md')
    for (const path of [policy, config, catalog, document]) assertSafeStateFile(path)
    if (sha256(readFileSync(policy)) !== target.assets.policy_sha256
      || sha256(readFileSync(catalog)) !== target.assets.catalog_sha256
      || sha256(readFileSync(document)) !== target.assets.document_sha256) return false
    return readFileSync(config, 'utf8') === renderAgentHookConfig(
      policy,
      target.assets.policy_sha256,
      target.policy_overrides,
    )
  } catch {
    return false
  }
}

function stageActivationAssets(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>, runtimeRoot: string) {
  ensurePrivateDirectory(runtimeRoot)
  const assetsRoot = join(runtimeRoot, 'assets')
  const stateRoot = join(runtimeRoot, 'state')
  ensurePrivateDirectory(assetsRoot)
  ensurePrivateDirectory(stateRoot)
  ensurePrivateDirectory(join(stateRoot, 'agent-hook'))
  ensurePrivateDirectory(join(stateRoot, 'agent-docs'))

  const artifact = artifactPathFor(paths, target)
  assertSafeStateFile(artifact)
  if (sha256(readFileSync(artifact)) !== target.artifact_sha256) {
    throw new OperationsError('artifact-drift', 'activation package artifact no longer matches its reviewed digest')
  }
  const finalRoot = join(assetsRoot, target.assets.asset_set_sha256)
  if (lstatMaybe(finalRoot) === null) {
    const extracted = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-assets-'))
    const temporary = mkdtempSync(join(assetsRoot, `.${target.assets.asset_set_sha256}.`))
    try {
      const tar = resolveExecutable('tar')
      const unpacked = spawn(tar, ['-xzf', artifact, '-C', extracted], paths.home, {
        timeoutMs: PACKAGE_COMMAND_TIMEOUT_MS,
      })
      if (unpacked.status !== 0) {
        throw new OperationsError('activation-staging-failed', 'reviewed activation assets could not be extracted')
      }
      const source = join(extracted, 'package')
      const observedAssets = assetsWithOverrides(packageAssets(source), target.policy_overrides)
      if (stableJson(observedAssets) !== stableJson(target.assets)) {
        throw new OperationsError('activation-staging-failed', 'reviewed activation assets changed before staging')
      }
      const hook = join(temporary, 'agent-hook')
      const docs = join(temporary, 'agent-docs')
      mkdirSync(hook, { mode: 0o700 })
      mkdirSync(docs, { mode: 0o700 })
      const policyPath = join(hook, 'policy.toml')
      writeFileSync(policyPath, readFileSync(join(source, 'policy', 'dsh-runtime-kit-v1.toml')), { mode: 0o600 })
      writeFileSync(join(docs, 'AGENT_DOCS.toml'), readFileSync(join(source, 'agent-docs', 'AGENT_DOCS.toml')), { mode: 0o600 })
      writeFileSync(join(docs, 'PROJECT_DEV_EDIT.md'), readFileSync(join(source, 'agent-docs', 'PROJECT_DEV_EDIT.md')), { mode: 0o600 })
      writeFileSync(
        join(hook, 'config.toml'),
        renderAgentHookConfig(
          join(finalRoot, 'agent-hook', 'policy.toml'),
          target.assets.policy_sha256,
          target.policy_overrides,
        ),
        { mode: 0o600 },
      )
      renameSync(temporary, finalRoot)
      fsyncDirectory(assetsRoot)
    } finally {
      rmSync(extracted, { recursive: true, force: true })
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  if (!stagedActivationAssetsMatch(target, runtimeRoot)) {
    throw new OperationsError('activation-staging-failed', 'staged activation assets failed pre-switch verification')
  }
}

function activateStagedAssets(target: ReturnType<typeof validateTarget>, runtimeRoot: string, profile: string) {
  if (!stagedActivationAssetsMatch(target, runtimeRoot)) {
    throw new OperationsError('activation-staging-failed', 'staged activation assets changed before activation')
  }
  const activation = activationManifest(target, profile)
  atomicWriteJson(join(runtimeRoot, 'activation.json'), activation)
  if (!activationMatches(target, runtimeRoot, profile)) {
    throw new OperationsError('activation-staging-failed', 'activated asset set did not pass provenance validation')
  }
  return activation
}

export type HealthExecutables = {dsh: string, agentHook: string, agentDocs: string | undefined}
/**
 * The executables the health probes run. `dsh` is the resolved host executable
 * bound by the plan; `agentHook` and `agentDocs` are the companion inputs the
 * CLI received and are resolved inside the probe so an unavailable companion
 * is a typed probe failure rather than a crash.
 */

/**
 * Run the declared runtime health probes against the staged asset set. The
 * probes see exactly the configuration activation would publish: the staged
 * hook config and policy, the staged docs catalog, and the mutable state
 * roots. Apply runs them before the native mutation so a failing probe is a
 * clean typed refusal with nothing mutated; recovery runs them again before it
 * activates a transaction that was already applied natively. No health text
 * enters the prompt.
 */
function activationHealth(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>, runtimeRoot: string, lifecycle: ReturnType<typeof packageLifecycle>, executables: HealthExecutables) {
  if (!stagedActivationAssetsMatch(target, runtimeRoot)) {
    throw new OperationsError('activation-staging-failed', 'staged activation assets changed before health verification')
  }
  const probes = lifecycle === null ? LIFECYCLE_HEALTH_PROBES : lifecycle.health_probes
  const assetRoot = join(runtimeRoot, 'assets', target.assets.asset_set_sha256)
  const results: Record<string, {ok: boolean, error?: string}> = {}
  for (const probe of probes) {
    let result: {ok: boolean, error?: string}
    if (probe === 'dsh-version') {
      result = dshVersion(executables.dsh, paths.home)
    } else if (probe === 'agent-hook-doctor') {
      try {
        const agentHook = resolveAgentHookRuntime({
          agentHook: resolveExecutable(executables.agentHook),
          agentHookConfig: join(assetRoot, 'agent-hook', 'config.toml'),
          agentHookPolicy: join(assetRoot, 'agent-hook', 'policy.toml'),
          agentHookStateDir: join(runtimeRoot, 'state', 'agent-hook'),
        })
        result = agentHookDoctor(agentHook, paths.home)
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : 'agent-hook runtime is unavailable' }
      }
    } else if (probe === 'agent-docs-version') {
      result = agentDocsDoctor({
        agentDocs: executables.agentDocs,
        agentDocsHome: join(assetRoot, 'agent-docs'),
        agentDocsStateHome: join(runtimeRoot, 'state', 'agent-docs'),
      }, paths.home, undefined)
    } else {
      result = { ok: false, error: 'unsupported health probe' }
    }
    results[probe] = result
    if (result.ok !== true) {
      throw new OperationsError(
        'activation-health-failed',
        `runtime health probe ${probe} failed before activation; the transaction remains pending and repairable`,
        65,
        { probe, error: typeof result.error === 'string' ? result.error : 'health probe failed' },
      )
    }
  }
  return results
}

function stageActivation(paths: ReturnType<typeof pathsFor>, target: ReturnType<typeof validateTarget>, runtimeRoot: string, profile: string, lifecycle: ReturnType<typeof packageLifecycle>, executables: HealthExecutables) {
  reconcileActivationAssets(paths, runtimeRoot, target.assets.asset_set_sha256)
  stageActivationAssets(paths, target, runtimeRoot)
  activationHealth(paths, target, runtimeRoot, lifecycle, executables)
  return activateStagedAssets(target, runtimeRoot, profile)
}

function retainActivationTarget(targets: Map<string,ReturnType<typeof validateTarget>>, target: ReturnType<typeof validateTarget>) {
  const digest = target.assets.asset_set_sha256
  const existing = targets.get(digest)
  if (existing !== undefined && stableJson(existing.assets) !== stableJson(target.assets)) {
    throw new OperationsError(
      'activation-asset-inventory-invalid',
      'retained activation asset digest has conflicting authenticated targets',
    )
  }
  if (existing === undefined) targets.set(digest, target)
}

function retainSnapshotAssetSet(retained: Set<string>, targets: Map<string,ReturnType<typeof validateTarget>>, value: unknown, runtimeRoot: string) {
  if (value === null || value === undefined) return
  const snapshot = validateSnapshot(value)
  if (snapshot.runtime_root === runtimeRoot) {
    retained.add(snapshot.target.assets.asset_set_sha256)
    retainActivationTarget(targets, snapshot.target)
  }
}

function retainedActivationAssets(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  const retained: Set<string> = new Set()
  const targets: Map<string, ReturnType<typeof validateTarget>> = new Map()
  for (const name of readdirSync(dirname(paths.state)).sort()) {
    if (!name.endsWith('.json')) continue
    const profile = validateProfile(name.slice(0, -'.json'.length))
    const stateRead = readState(join(dirname(paths.state), name), profile)
    const state = stateRead.value
    if (stateRead.version !== 2 || state === null) continue
    retainSnapshotAssetSet(retained, targets, state.current, runtimeRoot)
    retainSnapshotAssetSet(retained, targets, state.previous, runtimeRoot)
    if (state.pending !== null) {
      const pending = validatePending(state.pending, profile)
      const plan = ((validatePlan(pending.plan, profile)) as any)
      if (plan.runtime_root === runtimeRoot && pending.target !== null) {
        const target = validateTarget(pending.target)
        retained.add(target.assets.asset_set_sha256)
        retainActivationTarget(targets, target)
      }
    }
  }
  if (lstatMaybe(join(runtimeRoot, 'activation.json')) !== null) {
    retained.add(readActivation(runtimeRoot).manifest.asset_set_sha256)
  }
  return { retained, targets }
}

function retainedActivationAssetSets(paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  return retainedActivationAssets(paths, runtimeRoot).retained
}

function activationAssetSetEvidence(root: string) {
  let entries = 0
  let bytes = 0
  const inventory: Array<{path:string,type:'directory'|'file',mode:number,nlink:number,size:number,sha256:string|null}> = []
  const visit = (path: string, relativePath: string, depth: number) => {
    if (depth > 8) throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set exceeds the depth limit')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set contains a symbolic link')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set is not owned by the current user')
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set is not owner-only')
    }
    entries += 1
    if (entries > 16) throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set contains too many entries')
    if (stat.isDirectory()) {
      inventory.push({
        path: relativePath,
        type: 'directory',
        mode: stat.mode & 0o777,
        nlink: stat.nlink,
        size: stat.size,
        sha256: null,
      })
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name), depth + 1)
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new OperationsError('activation-asset-inventory-invalid', 'activation asset set contains an unsupported entry')
    }
    const content = readFileSync(path)
    if (content.length !== stat.size) {
      throw new OperationsError('activation-asset-inventory-invalid', 'activation asset file changed during validation')
    }
    bytes += content.length
    if (bytes > MAX_ACTIVATION_ASSET_BYTES + 64 * 1024) {
      throw new OperationsError('activation-asset-retention-limit', 'activation asset set exceeds the storage limit')
    }
    inventory.push({
      path: relativePath,
      type: 'file',
      mode: stat.mode & 0o777,
      nlink: stat.nlink,
      size: stat.size,
      sha256: sha256(content),
    })
  }
  visit(root, '.', 0)
  inventory.sort((left, right) => left.path.localeCompare(right.path))
  return {
    bytes,
    tree_sha256: sha256(stableJson(inventory)),
  }
}

function activationAssetSetBytes(root: string) {
  return activationAssetSetEvidence(root).bytes
}

/**
 * Validate an ownerless pre-ownership asset store without collecting or
 * staging anything. Every authoritative retained set must be present, every
 * present set must be authoritative, and interrupted staging entries are not
 * adoptable provenance.
 */
function validateExactRetainedActivationAssets(paths: ReturnType<typeof pathsFor>, runtimeRoot: string, options: {allowUnreferenced?:boolean} = {}) {
  const { retained, targets } = retainedActivationAssets(paths, runtimeRoot)
  if ((retained.size === 0 && options.allowUnreferenced !== true) || retained.size > MAX_ACTIVATION_ASSET_SETS) {
    throw new OperationsError(
      'activation-asset-retention-limit',
      retained.size === 0
        ? 'ownerless runtime root has no retained activation asset set'
        : 'runtime root retains too many activation asset sets',
    )
  }
  const assetsRoot = join(runtimeRoot, 'assets')
  assertOwnedPath(assetsRoot, 'directory', true)
  const present = new Map()
  const entries = readdirSync(assetsRoot, { withFileTypes: true })
  if (entries.length > MAX_ACTIVATION_ASSET_SETS) {
    throw new OperationsError(
      'activation-asset-retention-limit',
      'runtime root contains too many activation asset sets',
    )
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}$/.test(entry.name)
      || (options.allowUnreferenced !== true && !retained.has(entry.name))) {
      throw new OperationsError(
        'activation-asset-inventory-invalid',
        'ownerless runtime asset root contains an unmanaged or staging entry',
      )
    }
    const path = join(assetsRoot, entry.name)
    assertOwnedPath(path, 'directory', true)
    present.set(entry.name, activationAssetSetEvidence(path))
  }
  for (const digest of retained) {
    if (!present.has(digest)) {
      throw new OperationsError(
        'activation-asset-inventory-invalid',
        'ownerless runtime root is missing a retained activation asset set',
      )
    }
    const target = targets.get(digest)
    if (target === undefined) {
      throw new OperationsError(
        'activation-asset-inventory-invalid',
        'retained activation asset set has no authenticated target',
      )
    }
    if (!stagedActivationAssetsMatch(target, runtimeRoot)) {
      throw new OperationsError(
        'activation-asset-inventory-invalid',
        'retained activation asset set does not match its authenticated target',
      )
    }
  }
  return [...present].sort(([left], [right]) => left.localeCompare(right)).map(([digest, evidence]) => ({
    digest,
    ...evidence,
  }))
}

/**
 * Reconcile only asset sets owned by this DSH home while the root lock is
 * held. Current, rollback, pending, and active sets are authoritative; all
 * other digest directories and interrupted staging temporaries are orphans.
 */
function reconcileActivationAssets(paths: ReturnType<typeof pathsFor>, runtimeRoot: string, projectedAssetSet?: string) {
  const retained = retainedActivationAssetSets(paths, runtimeRoot)
  if (projectedAssetSet !== undefined) retained.add(projectedAssetSet)
  if (retained.size > MAX_ACTIVATION_ASSET_SETS) {
    throw new OperationsError('activation-asset-retention-limit', 'runtime root retains too many activation asset sets')
  }
  const assetsRoot = join(runtimeRoot, 'assets')
  if (lstatMaybe(assetsRoot) === null) return
  assertOwnedPath(assetsRoot, 'directory', true)
  let removed = false
  for (const entry of readdirSync(assetsRoot, { withFileTypes: true })) {
    const path = join(assetsRoot, entry.name)
    if (/^[0-9a-f]{64}$/.test(entry.name)) {
      assertOwnedPath(path, 'directory', true)
      if (!retained.has(entry.name)) {
        rmSync(path, { recursive: true, force: false })
        removed = true
        continue
      }
      activationAssetSetBytes(path)
      continue
    }
    if (/^\.[0-9a-f]{64}\.[0-9A-Za-z_-]+$/.test(entry.name)) {
      assertOwnedPath(path, 'directory', true)
      rmSync(path, { recursive: true, force: false })
      removed = true
      continue
    }
    throw new OperationsError('activation-asset-inventory-invalid', 'runtime asset root contains an unmanaged entry')
  }
  if (removed) fsyncDirectory(assetsRoot)
}

function migrateLegacyTarget(paths: ReturnType<typeof pathsFor>, legacy: ReturnType<typeof validateLegacyTarget>) {
  const artifact = artifactPathFor(paths, ((legacy) as any))
  assertSafeStateFile(artifact)
  const archive = readFileSync(artifact)
  if (archive.byteLength > MAX_PACKED_PACKAGE_BYTES || sha256(archive) !== legacy.artifact_sha256) {
    throw new OperationsError('artifact-drift', 'legacy package artifact does not match its authenticated digest')
  }
  try {
    inspectCanonicalPackageArtifact(archive)
  } catch {
    throw new OperationsError('artifact-drift', 'legacy package artifact is not a canonical bounded package')
  }
  const extracted = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-migrate-v1-'))
  try {
    const unpacked = spawn(resolveExecutable('tar'), ['-xzf', artifact, '-C', extracted], paths.home, {
      timeoutMs: PACKAGE_COMMAND_TIMEOUT_MS,
    })
    if (unpacked.status !== 0) {
      throw new OperationsError('artifact-drift', 'legacy package artifact could not be inspected')
    }
    const installedSha256 = packageTreeDigest(join(extracted, 'package'), extracted)
    if (installedSha256 !== legacy.installed_sha256) {
      throw new OperationsError('artifact-drift', 'legacy installed digest does not match its authenticated artifact')
    }
    return validateTarget({
      ...legacy,
      assets: packageAssets(join(extracted, 'package')),
    })
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}

function migratedLegacySnapshot(legacy: ReturnType<typeof validateLegacySnapshot>, target: ReturnType<typeof validateTarget>, runtimeRoot: string, profile: string) {
  if (legacy.installed_digest !== target.installed_sha256) {
    throw new OperationsError('artifact-drift', 'legacy snapshot digest does not match its authenticated artifact')
  }
  return validateSnapshot({
    ...legacy,
    runtime_root: runtimeRoot,
    activation_digest: sha256(`${JSON.stringify(activationManifest(target, profile), undefined, 2)}\n`),
    target,
  })
}

function legacyMigrationPlan(profile: string, paths: ReturnType<typeof pathsFor>, actual: ReturnType<typeof readActual>, stateRead: ReturnType<typeof readState>, runtimeRoot: string) {
  if (stateRead.version !== 1 || stateRead.value === null) {
    throw new OperationsError('migration-not-required', 'operations state is not a legacy v1 record', 64)
  }
  const state = stateRead.value
  if (state.pending !== null) {
    throw legacyPendingUnsupported()
  }
  const currentLegacy = state.current === null ? null : validateLegacySnapshot(state.current)
  const previousLegacy = state.previous === null ? null : validateLegacySnapshot(state.previous)
  let current = null
  if (currentLegacy === null) {
    if (!actualAbsent(actual)) {
      throw new OperationsError('owned-state-drift', 'legacy removed receipt does not match the current profile state')
    }
  } else {
    const target = migrateLegacyTarget(paths, currentLegacy.target)
    if (actual.dependency_spec !== currentLegacy.dependency_spec
      || actual.installed_version !== currentLegacy.installed_version
      || actual.installed_digest !== currentLegacy.installed_digest
      || actual.bundle_indexes.length !== 1
      || actual.bundle_indexes[0] !== currentLegacy.bundle_index
      || !targetMatchesActual(actual, target, paths)) {
      throw new OperationsError('owned-state-drift', 'legacy current receipt does not match the installed package')
    }
    current = migratedLegacySnapshot(currentLegacy, target, runtimeRoot, profile)
  }
  const previous = previousLegacy === null
    ? null
    : migratedLegacySnapshot(
        previousLegacy,
        migrateLegacyTarget(paths, previousLegacy.target),
        runtimeRoot,
        profile,
      )
  const proposedState = versionedOperationsState(
    profile,
    terminalStateFields(current, previous, null),
  )
  const installedLifecycleRead = installedLifecycle(paths, actual)
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation: 'doctor-repair',
    profile,
    package_name: PACKAGE_NAME,
    action: 'migrate-v1',
    migration: {
      id: LIFECYCLE_MIGRATION_V1_TO_V2,
      from: LEGACY_STATE_SCHEMA,
      to: STATE_SCHEMA,
      declared: installedLifecycleRead.declared?.migrations.includes(LIFECYCLE_MIGRATION_V1_TO_V2) ?? false,
    },
    state_digest: stateRead.digest,
    observed_manifest_digest: actual.manifest_digest,
    runtime_root: runtimeRoot,
    proposed_state: proposedState,
  }
  return { plan, plan_digest: sha256(stableJson(plan)) }
}

function removeActivation(runtimeRoot: string) {
  const path = join(runtimeRoot, 'activation.json')
  if (lstatMaybe(path) === null) return
  assertSafeStateFile(path)
  unlinkSync(path)
  fsyncDirectory(runtimeRoot)
}

function restoreAfterCollateral(dshBin: string, paths: ReturnType<typeof pathsFor>, profile: string, priorState: any, profileBefore: ReturnType<typeof captureProfileSnapshot>, stateRead: ReturnType<typeof readState>, npmBin: string, runtimeRoot: string) {
  const previous = priorState?.current === null || priorState?.current === undefined
    ? null
    : validateSnapshot(priorState.current)
  if (previous === null) {
    runDshMutation(dshBin, paths.home, profile, 'remove', null)
    if (lstatMaybe(paths.installedPackage) !== null) cleanupInstalledEntry(paths)
    removeActivation(runtimeRoot)
  } else {
    const installSpec = installSpecForTarget(previous.target, paths, npmBin)
    runDshMutation(dshBin, paths.home, profile, 'add', installSpec)
    // Restoring the exact prior activation re-publishes a set that already
    // passed its health gate; the collateral path must not fail on a probe.
    reconcileActivationAssets(paths, previous.runtime_root, previous.target.assets.asset_set_sha256)
    stageActivationAssets(paths, previous.target, previous.runtime_root)
    activateStagedAssets(previous.target, previous.runtime_root, profile)
  }
  restoreProfileSnapshot(profileBefore, paths)
  const restoredActual = readActual(paths)
  const profileRestored = !profileHasCollateralMutation(profileBefore, captureProfileSnapshot(paths))
  const packageRestored = previous === null
    ? actualAbsent(restoredActual)
    : snapshotMatches(restoredActual, previous, paths)
  if (!profileRestored || !packageRestored) {
    throw new OperationsError(
      'native-dsh-collateral-recovery-failed',
      'DSH collateral restoration did not reach the exact prior package and profile state',
    )
  }
  commitRestoredState(paths.state, stateRead)
}

function pendingState(profile: string, operation: string, planDigest: string, state: any, target: ReturnType<typeof resolveTarget> | null, plan: unknown, profileBefore: ReturnType<typeof captureProfileSnapshot>) {
  return {
    schema_version: STATE_SCHEMA,
    profile,
    current: state?.current ?? null,
    previous: state?.previous ?? null,
    last_applied: state?.last_applied ?? null,
    pending: {
      operation,
      plan_digest: planDigest,
      target,
      plan,
      phase: 'prepared',
      started_at: new Date().toISOString(),
      profile_before: profileBefore,
    },
  }
}

function appliedReceipt(operation: string, planDigest: string, plan: unknown, completedAt: string, recovered: boolean = false) {
  return {
    operation,
    plan_digest: planDigest,
    plan,
    completed_at: completedAt,
    ...recovered ? { recovered: true } : {},
  }
}

function terminalStateFields(current: unknown, previous: unknown, lastApplied: unknown) {
  return {
    current,
    previous,
    last_applied: lastApplied,
    pending: null,
  }
}

function versionedOperationsState(profile: string, fields: ReturnType<typeof terminalStateFields>) {
  return {
    schema_version: STATE_SCHEMA,
    profile,
    ...fields,
  }
}

function cleanupInstalledEntry(paths: ReturnType<typeof pathsFor>) {
  assertProfileTree(paths)
  const entry = lstatMaybe(paths.installedPackage)
  if (entry === null) return
  if (entry.isSymbolicLink()) {
    unlinkSync(paths.installedPackage)
    return
  }
  assertOwnedPath(paths.installedPackage, 'directory')
  const scope = realpathSync(join(paths.profileDir, 'node_modules', '@sympoies'))
  if (dirname(realpathSync(paths.installedPackage)) !== scope) {
    throw new OperationsError('unsafe-profile-tree', 'installed runtime-kit package escapes the selected profile')
  }
  rmSync(paths.installedPackage, { recursive: true, force: true })
}

function duplicateIsTerminal(state: any, actual: ReturnType<typeof readActual>, receipt: any, paths: ReturnType<typeof pathsFor>) {
  if (state.pending !== null) return false
  if (receipt.operation === 'remove') return state.current === null && actualAbsent(actual)
  if (state.current === null) return false
  const current = validateSnapshot(state.current)
  return stableJson(current.target) === stableJson(receipt.plan.target)
    && snapshotMatches(actual, current, paths)
}

function applyMutation(operation: string, profile: string, paths: ReturnType<typeof pathsFor>, expectedPlanDigest: string, packageInput: string | undefined, dshInput: string, companions: {agentHook: string, agentDocs: string | undefined}, policyOverrides: Record<string, 'advise'> | undefined = undefined) {
  prepareOperationsTree(paths)
  return withOperationLocks(paths, () => {
    const runtimeRoot = resolveActivationRoot(process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT)
    const toolchain = resolveToolchain(dshInput, paths.home)
    return withRuntimeRootLock(paths, runtimeRoot, () => {
    reconcileActivationAssets(paths, runtimeRoot)
    try {
    reconcileArtifacts(paths)
    const stateRead = readState(paths.state, profile)
    const priorState = ((stateRead.value) as any)
    const actual = readActual(paths)
    if (priorState?.last_applied?.plan_digest === expectedPlanDigest
      && priorState.last_applied.operation === operation) {
      if (priorState.last_applied.plan.runtime_root !== runtimeRoot
        || stableJson(priorState.last_applied.plan.toolchain) !== stableJson(toolchain)) {
        throw new OperationsError('plan-drift', 'runtime root or toolchain changed after the applied receipt')
      }
      if (packageInput !== undefined) {
        const supplied = resolveTarget(packageInput, resolveExecutable('npm'), paths.home, false, policyOverrides)
        if (stableJson(supplied) !== stableJson(priorState.last_applied.plan.target)) {
          throw new OperationsError('plan-drift', 'supplied package target does not match the applied receipt')
        }
      }
      if (!duplicateIsTerminal(priorState, actual, priorState.last_applied, paths)) {
        throw new OperationsError('owned-state-drift', 'duplicate receipt no longer matches the current terminal state')
      }
      ensureRuntimeRootOwner(paths, runtimeRoot)
      return { mode: 'duplicate', plan: priorState.last_applied.plan, plan_digest: expectedPlanDigest }
    }
    const npmBin = resolveExecutable('npm')
    const requestedTarget = packageInput === undefined
      ? null
      : resolveTarget(packageInput, npmBin, paths.home, true, policyOverrides)
    return withResolvedTarget(requestedTarget, () => {
    const reviewed = buildMutationPlan(
      operation,
      profile,
      paths,
      actual,
      stateRead,
      requestedTarget,
      runtimeRoot,
      toolchain,
    )
    if (reviewed.plan_digest !== expectedPlanDigest) {
      throw new OperationsError('plan-drift', 'profile or runtime-kit state changed after preview')
    }
    ensureRuntimeRootOwner(paths, runtimeRoot)
    const target = reviewed.plan.target === null ? null : validateTarget(reviewed.plan.target)
    const state = stateRead.value
    if (reviewed.plan.action === 'noop') {
      const next = versionedOperationsState(profile, terminalStateFields(
        state?.current ?? null,
        state?.previous ?? null,
        appliedReceipt(operation, reviewed.plan_digest, reviewed.plan, new Date().toISOString()),
      ))
      atomicWriteJson(paths.state, next)
      reconcileArtifacts(paths)
      return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    }

    const dshBin = toolchain.dsh.executable
    const installSpec = target === null ? null : installSpecForTarget(target, paths, npmBin)
    if (target !== null) {
      reconcileActivationAssets(paths, runtimeRoot, target.assets.asset_set_sha256)
      stageActivationAssets(paths, target, runtimeRoot)
      injectTestFault('after-stage-activation-assets')
      // Health runs before the pending marker and the native mutation: the
      // probes need only the staged assets, the companions, and the bound
      // host, so a failing probe refuses the transaction with nothing mutated.
      activationHealth(
        paths,
        target,
        runtimeRoot,
        validatePlanLifecycle(reviewed.plan.lifecycle),
        { ...companions, dsh: dshBin },
      )
    }
    const profileBefore = captureProfileSnapshot(paths)
    const pending = pendingState(
      profile,
      operation,
      reviewed.plan_digest,
      state,
      target,
      reviewed.plan,
      profileBefore,
    )
    atomicWriteJson(paths.state, pending)
    if (operation === 'remove') {
      runDshMutation(dshBin, paths.home, profile, 'remove', null)
    } else {
      runDshMutation(dshBin, paths.home, profile, 'add', installSpec)
    }
    const profileAfter = captureProfileSnapshot(paths)
    const collateralTarget = operation === 'remove'
      && plainRecord(state)
      && state.current !== null
      && state.current !== undefined
      ? validateSnapshot(state.current).target
      : target
    if (profileHasCollateralMutation(profileBefore, profileAfter, true, collateralTarget, paths)) {
      try {
        restoreAfterCollateral(
          dshBin,
          paths,
          profile,
          state,
          profileBefore,
          stateRead,
          npmBin,
          reviewed.plan.runtime_root,
        )
      } catch {
        throw new OperationsError(
          'native-dsh-collateral-recovery-failed',
          'DSH changed unrelated profile state and the exact pre-mutation snapshot could not be restored',
        )
      }
      throw new OperationsError(
        'native-dsh-collateral-mutation',
        'DSH changed profile or lockfile state outside the reviewed runtime-kit boundary',
      )
    }
    atomicWriteJson(paths.state, {
      ...pending,
      pending: { ...pending.pending, phase: 'native-applied' },
    })
    if (operation === 'remove') removeActivation(runtimeRoot)
    else activateStagedAssets(((target) as ReturnType<typeof validateTarget>), runtimeRoot, profile)
    let observed = readActual(paths)
    let current = null
    if (operation === 'remove') {
      if (observed.dependency_spec === null && observed.bundle_indexes.length === 0
        && observed.installed_entry) {
        // pnpm can retain a local file/link package after removing the exact
        // dependency. DSH has already removed both authoritative profile
        // markers, so deleting only this fixed package path is exact cleanup.
        cleanupInstalledEntry(paths)
        observed = readActual(paths)
      }
      if (!actualAbsent(observed)) {
        throw new OperationsError(
          'native-dsh-verification-failed',
          'DSH remove left runtime-kit owned profile state',
          65,
          { observed: publicActual(observed) },
        )
      }
    } else {
      assertActualInstall(observed)
      current = snapshot(
        observed,
        ((target) as ReturnType<typeof validateTarget>),
        paths,
        runtimeRoot,
        profile,
      )
    }
    const previous = operation === 'update' || operation === 'rollback'
      ? state?.current ?? null
      : null
    const next = versionedOperationsState(profile, terminalStateFields(
      current,
      previous,
      appliedReceipt(operation, reviewed.plan_digest, reviewed.plan, new Date().toISOString()),
    ))
    atomicWriteJson(paths.state, next)
    reconcileArtifacts(paths)
    return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    })
    } finally {
      reconcileActivationAssets(paths, runtimeRoot)
    }
    })
  })
}

function recoveryFor(actual: ReturnType<typeof readActual>, state: any, paths: ReturnType<typeof pathsFor>) {
  if (state?.pending === null || state?.pending === undefined) return null
  const pending = validatePending(state.pending, state.profile)
  const collateralTarget = pending.operation === 'remove' && state.current !== null
    ? validateTarget(state.current.target)
    : pending.operation === 'remove'
      ? null
      : validateTarget(pending.target)
  if (profileHasCollateralMutation(
    validateProfileSnapshot(pending.profile_before),
    captureProfileSnapshot(paths),
    false,
    collateralTarget,
    paths,
  )) {
    return { action: 'restore-collateral', pending }
  }
  if (pending.operation === 'remove') {
    if (actual.dependency_spec === null && actual.bundle_indexes.length === 0) return { action: 'finalize', pending }
  } else {
    const target = validateTarget(pending.target)
    if (targetMatchesActual(actual, target, paths)) {
      return { action: 'finalize', pending }
    }
  }
  if (state.current === null && actualAbsent(actual)) return { action: 'clear', pending }
  if (state.current !== null && snapshotMatches(actual, validateSnapshot(state.current), paths)) {
    return { action: 'clear', pending }
  }
  return { action: 'unknown', pending }
}

/**
 * Revalidate every persisted activation root against the provider homes and
 * symlink topology that exist now, before recovery can inspect or mutate any
 * of those roots. The returned canonical roots and labeled provider topology
 * are included in the reviewed repair-plan digest.
 */
function repairRuntimeRootTopology(state: any, profile: string, paths: ReturnType<typeof pathsFor>, selectedRuntimeRoot: string, options: {allowOwnerless?: boolean} = {}) {
  try {
    const selected = resolveActivationRoot(selectedRuntimeRoot)
    const pending = state?.pending === null || state?.pending === undefined
      ? null
      : validatePending(state.pending, profile)
    const pendingPlan = pending === null ? null : validatePlan(pending.plan, profile)
    const current = state?.current === null || state?.current === undefined
      ? null
      : validateSnapshot(state.current)
    const previous = state?.previous === null || state?.previous === undefined
      ? null
      : validateSnapshot(state.previous)
    const lastApplied = state?.last_applied === null || state?.last_applied === undefined
      ? null
      : validateAppliedReceipt(state.last_applied, profile)
    const roots = {
      pending: pendingPlan === null ? null : resolveActivationRoot(pendingPlan.runtime_root),
      current: current === null ? null : resolveActivationRoot(current.runtime_root),
      previous: previous === null ? null : resolveActivationRoot(previous.runtime_root),
      last_applied: lastApplied === null
        ? null
        : resolveActivationRoot(((lastApplied) as any).plan.runtime_root),
    }
    for (const root of Object.values(roots)) {
      if (root !== null && root !== selected) {
        throw new TypeError('persisted runtime root does not match the selected DSH runtime root')
      }
    }
    const managed = Object.values(roots).some(root => root !== null)
      || lstatMaybe(join(selected, 'activation.json')) !== null
      || lstatMaybe(join(selected, 'assets')) !== null
    if (managed && lstatMaybe(join(selected, '.dsh-runtime-kit-owner.json')) === null) {
      if (options.allowOwnerless !== true) {
        throw new OperationsError('runtime-root-owner-missing', 'runtime root ownership record is missing')
      }
    } else if (managed) {
      assertRuntimeRootOwner(paths, selected)
    }
    return {
      roots,
      provider_homes: resolveProviderHomeTopology(),
    }
  } catch (error) {
    throw new OperationsError(
      'unsafe-repair-runtime-root',
      error instanceof Error
        ? `persisted recovery runtime root is unsafe: ${error.message}`
        : 'persisted recovery runtime root is unsafe for the current provider topology',
    )
  }
}

/**
 * Produce immutable evidence for one ownerless pre-ownership v2 runtime root.
 * This reads but does not reconcile: every retained set and reference must be
 * exact before the ownership record can be reviewed or written.
 */
function ownerlessRuntimeRootAdoption(paths: ReturnType<typeof pathsFor>, runtimeRoot: string, profile: string) {
  if (lstatMaybe(join(runtimeRoot, '.dsh-runtime-kit-owner.json')) !== null) {
    throw new OperationsError('runtime-root-owner-invalid', 'runtime root already has an ownership record')
  }
  const stateRead = readState(paths.state, profile)
  if (stateRead.version !== 2 || stateRead.value === null) {
    throw new OperationsError(
      'runtime-root-owner-missing',
      'ownerless runtime root has no exact version 2 state in the selected DSH home',
    )
  }
  const state = ((stateRead.value) as any)
  const topology = repairRuntimeRootTopology(state, profile, paths, runtimeRoot, { allowOwnerless: true })
  const activationPath = join(runtimeRoot, 'activation.json')
  let activation = null
  let activationDigest = 'absent'
  if (lstatMaybe(activationPath) !== null) {
    try {
      activation = readActivation(runtimeRoot)
      activationDigest = sha256(readFileSync(activationPath))
    } catch (error) {
      throw new OperationsError(
        'runtime-root-owner-missing',
        error instanceof Error
          ? `ownerless runtime activation is invalid: ${error.message}`
          : 'ownerless runtime activation is invalid',
      )
    }
  }
  const candidates = (({}) as Record<string, {target:ReturnType<typeof validateTarget>,activation_digest:string}>)
  if (state.current !== null) {
    const current = validateSnapshot(state.current)
    candidates.current = {
      target: current.target,
      activation_digest: current.activation_digest,
    }
  }
  let pending = null
  let pendingPlan = null
  if (state.pending !== null) {
    pending = validatePending(state.pending, profile)
    pendingPlan = ((validatePlan(pending.plan, profile)) as any)
    if (!['prepared', 'native-applied'].includes(((pending.phase) as string))) {
      throw new OperationsError(
        'runtime-root-owner-missing',
        'ownerless runtime adoption requires an explicit pending protocol phase',
      )
    }
    if (pending.operation !== 'remove') {
      if (pending.target === null) {
        throw new OperationsError(
          'runtime-root-owner-missing',
          'ownerless runtime pending target is missing',
        )
      }
      const target = validateTarget(pending.target)
      candidates.pending = {
        target,
        activation_digest: sha256(`${JSON.stringify(activationManifest(target, profile), undefined, 2)}\n`),
      }
    }
  }
  const lastApplied = state.last_applied === null ? null : validateAppliedReceipt(state.last_applied, profile)
  const actual = readActual(paths)
  const actualMatches = (({
    absent: actualAbsent(actual),
    ...Object.fromEntries(Object.entries(candidates).map(([source, candidate]) => [
      source,
      targetMatchesActual(actual, candidate.target, paths),
    ])),
  }) as Record<string,boolean>)
  const activationMatchesSource = (({
    absent: activation === null,
    ...Object.fromEntries(Object.entries(candidates).map(([source, candidate]) => [
      source,
      activation !== null
        && activationMatches(candidate.target, runtimeRoot, profile)
        && activationDigest === candidate.activation_digest,
    ])),
  }) as Record<string,boolean>)
  const terminalRemoved = pending === null
    && candidates.current === undefined
    && state.previous === null
    && lastApplied?.operation === 'remove'
    && ((lastApplied) as any).plan.action === 'remove'
  let allowedPairs = (([]) as Array<[string,string]>)
  if (pending === null) {
    allowedPairs = candidates.current === undefined
      ? terminalRemoved ? [['absent', 'absent']] : []
      : [['current', 'current']]
  } else if (pending.operation === 'remove') {
    if (candidates.current === undefined) {
      allowedPairs = []
    } else if (pending.phase === 'prepared') {
      allowedPairs = [['current', 'current'], ['absent', 'current']]
    } else {
      allowedPairs = [['absent', 'current'], ['absent', 'absent']]
    }
  } else if (candidates.current === undefined) {
    allowedPairs = pending.phase === 'native-applied' ? [['pending', 'pending']] : []
  } else if (pending.phase === 'prepared') {
    allowedPairs = [['current', 'current'], ['pending', 'current']]
  } else {
    allowedPairs = [['pending', 'current'], ['pending', 'pending']]
  }
  const observedPairs = allowedPairs.filter(([actualSource, activationSource]) => (
    actualMatches[actualSource] === true && activationMatchesSource[activationSource] === true
  ))
  if (observedPairs.length !== 1) {
    throw new OperationsError(
      'runtime-root-owner-missing',
      'ownerless runtime root does not match one phase-consistent authenticated v2 target pair',
    )
  }
  const [observedActualSource, observedActivationSource] = observedPairs[0]
  const globallyRetainedAssetSets = retainedActivationAssetSets(paths, runtimeRoot)
  if (terminalRemoved && globallyRetainedAssetSets.size !== 0) {
    throw new OperationsError(
      'runtime-root-owner-missing',
      'terminal removed ownerless runtime root still has retained activation references',
    )
  }
  const assetSets = validateExactRetainedActivationAssets(paths, runtimeRoot, {
    allowUnreferenced: terminalRemoved,
  })
  return {
    schema_version: 'dsh-runtime-kit.runtime-root-adoption.v2',
    dsh_home: realpathSync(paths.home),
    runtime_root: runtimeRoot,
    state_digest: stateRead.digest,
    activation_digest: activationDigest,
    observed_actual_source: observedActualSource,
    observed_activation_source: observedActivationSource,
    pending_phase: pending?.phase ?? null,
    pending_action: pendingPlan?.action ?? (terminalRemoved ? 'remove' : null),
    active_asset_set_sha256: activation?.manifest.asset_set_sha256 ?? null,
    retained_asset_sets: terminalRemoved ? [] : assetSets,
    reviewed_orphan_asset_sets: terminalRemoved ? assetSets : [],
    runtime_root_topology: topology,
  }
}

function agentHookDoctor(agentHook: ReturnType<typeof resolveAgentHookRuntime>, home: string) {
  const [agentHookBin, ...args] = agentHook.argv([
    'doctor', '--product', 'dsh', '--format', 'json',
  ])
  const result = spawn(agentHookBin, args, home, {
    timeoutMs: HEALTH_COMMAND_TIMEOUT_MS,
  })
  if (result.status !== 0) return { ok: false, ...commandFailure(result), error: 'agent-hook doctor failed' }
  try {
    const value = JSON.parse(result.stdout)
    if (!plainRecord(value) || value.schema_version !== 'cli.agent-hook.doctor.v1'
      || value.ok !== true || !Array.isArray(value.data) || value.data.length !== 1) {
      return { ok: false, error: 'agent-hook doctor returned an incompatible envelope' }
    }
    const row = value.data[0]
    if (!plainRecord(row) || row.product !== 'dsh'
      || row.registration_owner !== 'dsh-runtime-kit' || row.dispatch_supported !== true) {
      return { ok: false, error: 'agent-hook doctor did not delegate DSH registration to dsh-runtime-kit' }
    }
    return {
      ok: true,
      product: row.product,
      registration_owner: row.registration_owner,
      dispatch_supported: row.dispatch_supported,
    }
  } catch {
    return { ok: false, error: 'agent-hook doctor returned invalid JSON' }
  }
}

function stableReleaseTuple(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value)
  return match === null ? null : match.slice(1).map(Number)
}

function compareReleaseTuples(left: number[], right: number[]) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function supportedStableRelease(value: string, minimum: string, validated: string) {
  const candidate = stableReleaseTuple(value)
  const lower = stableReleaseTuple(minimum)
  const upper = stableReleaseTuple(validated)
  return candidate !== null && lower !== null && upper !== null
    && compareReleaseTuples(candidate, lower) >= 0
    && compareReleaseTuples(candidate, upper) <= 0
}

function agentDocsSupportedRange() {
  const feature = process.env.DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE
  if (feature === undefined) {
    return {
      minimum: AGENT_DOCS_MINIMUM_RELEASE,
      validated: AGENT_DOCS_VALIDATED_RELEASE,
    }
  }
  const candidate = NILS_COMPATIBILITY.candidate_validation
  if (!plainRecord(candidate)
    || candidate.feature !== feature
    || candidate.status !== 'reviewed-source-candidate'
    || candidate.validation !== 'exact-reviewed-source'
    || typeof candidate.version !== 'string'
    || stableReleaseTuple(candidate.version) === null
    || typeof candidate.source_commit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(candidate.source_commit)
    || typeof candidate.platform !== 'string'
    || candidate.platform.length === 0) {
    throw new Error('agent-docs compatibility candidate is invalid')
  }
  const artifacts = candidate.artifacts
  if (!plainRecord(artifacts)) {
    throw new Error('agent-docs compatibility candidate is invalid')
  }
  const agentDocs = artifacts['agent-docs']
  if (!plainRecord(agentDocs)
    || typeof agentDocs.sha256 !== 'string'
    || !DIGEST_PATTERN.test(agentDocs.sha256)) {
    throw new Error('agent-docs compatibility candidate is invalid')
  }
  return { minimum: candidate.version, validated: candidate.version }
}

function agentDocsDoctor(config: {agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string}, home: string, _dshRelease: string | undefined) {
  try {
    const executable = resolveExecutable(config.agentDocs ?? 'agent-docs')
    const docsHome = requiredAbsolutePath(config.agentDocsHome, 'agentDocsHome')
    const stateHome = requiredAbsolutePath(config.agentDocsStateHome, 'agentDocsStateHome')
    assertOwnedPath(docsHome, 'directory', true)
    assertOwnedPath(stateHome, 'directory', true)
    const catalog = join(docsHome, 'AGENT_DOCS.toml')
    try {
      assertOwnedPath(catalog, 'file', true)
    } catch (error) {
      throw new Error(`agent-docs catalog is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    const result = spawn(executable, ['--version'], home, {
      timeoutMs: HEALTH_COMMAND_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      return { ok: false, ...commandFailure(result), error: 'agent-docs version check failed' }
    }
    const match = /^agent-docs ([0-9]+\.[0-9]+\.[0-9]+) \([^\r\n]+\)$/u.exec(result.stdout.trim())
    const supported = agentDocsSupportedRange()
    if (match === null || !supportedStableRelease(
      match[1],
      supported.minimum,
      supported.validated,
    )) {
      return {
        ok: false,
        error: `agent-docs version is outside the supported range ${supported.minimum} through ${supported.validated}`,
      }
    }
    return { ok: true, version: match[1], catalog, state_home: stateHome }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'agent-docs isolation is invalid',
    }
  }
}

function dshVersion(dshBin: string, home: string) {
  const result = spawn(dshBin, ['--version'], home, { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
  if (result.status !== 0) return { ok: false, ...commandFailure(result), error: 'DSH version check failed' }
  const version = result.stdout.trim()
  return reviewedDshRevision(version) !== null
    ? { ok: true, version }
    : { ok: false, error: 'DSH version is not an exact reviewed release' }
}

/**
 * Read the lifecycle the installed package declares, if any, without letting a
 * malformed declaration abort diagnosis: doctor reports it as an error instead.
 */
function installedLifecycle(paths: ReturnType<typeof pathsFor>, actual: ReturnType<typeof readActual>): {declared: ReturnType<typeof packageLifecycle>, error?: string}  {
  if (!actual.installed_entry || lstatMaybe(paths.installedManifest) === null) return { declared: null }
  try {
    return { declared: packageLifecycle(paths.installedPackage) }
  } catch (error) {
    return {
      declared: null,
      error: error instanceof OperationsError
        ? `${error.code}: ${error.message}`
        : 'installed lifecycle declaration is unreadable',
    }
  }
}

/**
 * Classify every declared owned and generated surface as present, altered,
 * missing (expected by a receipt but gone), or absent (nothing expected).
 * Detection never writes; repair remains the digest-reviewed path.
 */
function lifecycleSurfaces(paths: ReturnType<typeof pathsFor>, profile: string, state: any, actual: ReturnType<typeof readActual>, activationInput: {runtimeRoot?: string, data?: ReturnType<typeof readActivation>, error?: string, ownerMissing?: boolean}) {
  const current = plainRecord(state?.current) ? validateSnapshot(state.current) : null
  const pendingTarget = plainRecord(state?.pending) && state.pending.target !== null
    && state.pending.target !== undefined
    ? validateTarget(state.pending.target)
    : null
  const expectedTarget = current?.target ?? pendingTarget
  const expectingInstall = expectedTarget !== null
  const status = (present: boolean, intact: boolean = true) => {
    if (present) return intact ? 'present' : 'altered'
    return expectingInstall ? 'missing' : 'absent'
  }
  const owned = {
    dependency: status(
      actual.dependency_spec !== null,
      current === null || actual.dependency_spec === current.dependency_spec,
    ),
    bundle: status(
      actual.bundle_indexes.length > 0,
      actual.bundle_indexes.length === 1 && (current === null || actual.bundle_indexes[0] === current.bundle_index),
    ),
    'installed-package': status(
      actual.installed_entry,
      actual.installed_name === PACKAGE_NAME
        && (current === null || actual.installed_digest === current.installed_digest),
    ),
    'lockfile-projection': lstatMaybe(join(paths.profileDir, 'pnpm-lock.yaml')) === null ? 'absent' : 'present',
    'operations-state': lstatMaybe(paths.state) === null ? 'absent' : 'present',
    'operations-lock': lstatMaybe(paths.lock) === null ? 'absent' : 'present',
    'artifact-store': lstatMaybe(paths.artifacts) === null ? 'absent' : 'present',
  }
  const generated: Record<string, string> = {}
  const runtimeRoot = activationInput.runtimeRoot
  if (runtimeRoot === undefined) {
    for (const surface of LIFECYCLE_GENERATED_SURFACES) generated[surface] = 'unknown'
    return { owned, generated }
  }
  generated['activation-manifest'] = status(
    lstatMaybe(join(runtimeRoot, 'activation.json')) !== null,
    activationInput.data !== undefined && expectedTarget !== null
      && activationMatches(expectedTarget, runtimeRoot, profile),
  )
  generated['runtime-root-owner'] = status(lstatMaybe(join(runtimeRoot, '.dsh-runtime-kit-owner.json')) !== null)
  if (expectedTarget === null) {
    generated['asset-set'] = lstatMaybe(join(runtimeRoot, 'assets')) === null ? 'absent' : 'present'
  } else {
    generated['asset-set'] = status(
      lstatMaybe(join(runtimeRoot, 'assets', expectedTarget.assets.asset_set_sha256)) !== null,
      stagedActivationAssetsMatch(expectedTarget, runtimeRoot),
    )
  }
  for (const [surface, relative] of [
    ['agent-hook-state', join('state', 'agent-hook')],
    ['agent-docs-state', join('state', 'agent-docs')],
  ]) {
    const stat = lstatMaybe(join(runtimeRoot, relative))
    generated[surface] = status(stat !== null && stat.isDirectory() && !stat.isSymbolicLink())
  }
  return { owned, generated }
}

function lifecycleDiagnostic(paths: ReturnType<typeof pathsFor>, profile: string, state: any, stateVersion: number | null, actual: ReturnType<typeof readActual>, activationInput: {runtimeRoot?: string, data?: ReturnType<typeof readActivation>, error?: string, ownerMissing?: boolean}) {
  const installed = installedLifecycle(paths, actual)
  const declared = installed.declared
  return {
    declared: declared !== null,
    ...declared === null ? {} : {
      schema_version: declared.schema_version,
      sha256: declared.sha256,
      dsh_releases: declared.dsh_releases,
      health_probes: declared.health_probes,
    },
    ...installed.error === undefined ? {} : { error: installed.error },
    surfaces: lifecycleSurfaces(paths, profile, state, actual, activationInput),
    migrations: {
      declared: declared?.migrations ?? [],
      pending: stateVersion === 1 ? [LIFECYCLE_MIGRATION_V1_TO_V2] : [],
    },
  }
}

function diagnose(profile: string, paths: ReturnType<typeof pathsFor>, agentHook: ReturnType<typeof resolveAgentHookRuntime>, agentDocs: {agentDocs?: string, agentDocsHome?: string, agentDocsStateHome?: string}, dshBin: string, activationInput: {runtimeRoot?: string, data?: ReturnType<typeof readActivation>, error?: string, ownerMissing?: boolean}) {
  const actual = readActual(paths)
  const stateRead = readState(paths.state, profile)
  const state = stateRead.value
  if (stateRead.version === 1) {
    const action = state?.pending === null ? 'migrate-v1' : 'legacy-pending'
    const dsh = dshVersion(dshBin, paths.home)
    return {
      schema_version: 'dsh-runtime-kit.doctor.v1',
      profile,
      status: 'needs-attention',
      advisories: [],
      owned_status: 'recovery-required',
      recovery: {
        action,
        schema_version: LEGACY_STATE_SCHEMA,
        runtime_root: activationInput.runtimeRoot ?? null,
      },
      observed: publicActual(actual),
      lifecycle: lifecycleDiagnostic(paths, profile, null, 1, actual, activationInput),
      agent_hook: agentHookDoctor(agentHook, paths.home),
      agent_docs: agentDocsDoctor(
        agentDocs,
        paths.home,
        dsh.ok === true ? dsh.version : undefined,
      ),
      activation: activationInput.error === undefined
        ? { ok: false, error: 'legacy operations state must be migrated before activation is authoritative' }
        : { ok: false, error: activationInput.error },
      policy: { ok: true, status: 'not-activated', downgrades: [], tier_table_sha256: null },
      dsh,
    }
  }
  if (state !== null && activationInput.runtimeRoot === undefined) {
    throw new OperationsError('unsafe-repair-runtime-root', 'selected DSH runtime root is unavailable')
  }
  if (activationInput.runtimeRoot !== undefined) {
    repairRuntimeRootTopology(
      state,
      profile,
      paths,
      activationInput.runtimeRoot,
      { allowOwnerless: activationInput.ownerMissing === true },
    )
  }
  const recovery = activationInput.ownerMissing === true
    ? {
        action: 'adopt-owner',
        adoption: ownerlessRuntimeRootAdoption(
          paths,
          ((activationInput.runtimeRoot) as string),
          profile,
        ),
      }
    : recoveryFor(actual, state, paths)
  let ownedStatus = 'absent'
  if (recovery !== null) ownedStatus = 'recovery-required'
  else if (state?.current !== null && state?.current !== undefined) {
    ownedStatus = snapshotMatches(actual, validateSnapshot(state.current), paths) ? 'installed' : 'drift'
  } else if (!actualAbsent(actual)) ownedStatus = 'unmanaged'
  else if (state !== null) ownedStatus = 'removed'
  const activationRequired = (state?.current !== null && state?.current !== undefined)
    || (state?.pending !== null && state?.pending !== undefined)
    || !actualAbsent(actual)
  let activation
  if (activationInput.error !== undefined) {
    activation = { ok: false, error: activationInput.error }
  } else if (activationInput.data === undefined) {
    activation = activationRequired
      ? { ok: false, error: 'runtime activation manifest is required' }
      : { ok: true, status: 'not-activated' }
  } else {
    const active = activationInput.data.manifest
    const currentTarget = plainRecord(state?.current) ? state.current.target : undefined
    const pendingTarget = plainRecord(state?.pending) ? state.pending.target : undefined
    const expected = currentTarget ?? pendingTarget
    activation = expected === null || expected === undefined
      ? { ok: false, error: 'runtime activation exists without a managed package target' }
      : activationMatches(
          validateTarget(expected),
          ((activationInput.runtimeRoot) as string),
          profile,
        )
        ? {
            ok: true,
            status: 'activated',
            asset_set_sha256: active.asset_set_sha256,
            package_version: active.package_version,
          }
        : { ok: false, error: 'runtime activation does not match the managed package target' }
  }
  const hook = agentHookDoctor(agentHook, paths.home)
  const policy = activation.ok === true && activation.status === 'activated'
    ? agentHookPolicyInventory(agentHook, paths.home)
    : { ok: true, status: 'not-activated', downgrades: [], tier_table_sha256: null }
  const dsh = dshVersion(dshBin, paths.home)
  const docs = agentDocsDoctor(
    agentDocs,
    paths.home,
    dsh.ok === true ? dsh.version : undefined,
  )
  const lifecycle = lifecycleDiagnostic(paths, profile, state, stateRead.version, actual, activationInput)
  const healthy = recovery === null
    && !['drift', 'unmanaged'].includes(ownedStatus)
    && hook.ok
    && policy.ok
    && docs.ok
    && activation.ok
    && dsh.ok
    && lifecycle.error === undefined
  // A downgraded seam is visible, not failing: the profile is healthy, and the
  // advisory tells an operator (and acceptance) that this profile must not
  // produce acceptance evidence.
  const downgrades = (('downgrades' in policy && Array.isArray(policy.downgrades) ? policy.downgrades : []) as string[])
  const advisories = downgrades.length > 0 ? ['policy-downgrades-active'] : []
  return {
    schema_version: 'dsh-runtime-kit.doctor.v1',
    profile,
    status: healthy ? 'healthy' : 'needs-attention',
    advisories,
    owned_status: ownedStatus,
    recovery,
    observed: publicActual(actual),
    lifecycle,
    agent_hook: hook,
    policy,
    agent_docs: docs,
    activation,
    dsh,
  }
}

/**
 * Read the effective policy tiers from the activated agent-hook config. nils
 * owns the tier table; runtime-kit only reports which Tier B rules the active
 * config downgraded to `advise` and a digest of the table it observed.
 */
function agentHookPolicyInventory(agentHook: ReturnType<typeof resolveAgentHookRuntime>, home: string) {
  const [agentHookBin, ...args] = agentHook.argv(['inventory', '--format', 'json'])
  const result = spawn(agentHookBin, args, home, { timeoutMs: HEALTH_COMMAND_TIMEOUT_MS })
  if (result.status !== 0) return { ok: false, ...commandFailure(result), error: 'agent-hook inventory failed' }
  try {
    const value = JSON.parse(result.stdout)
    if (!plainRecord(value) || value.schema_version !== 'cli.agent-hook.inventory.v1'
      || value.ok !== true || !plainRecord(value.data) || !Array.isArray(value.data.rules)) {
      return { ok: false, error: 'agent-hook inventory returned an incompatible envelope' }
    }
    // `downgrades` is derived from `effective_modes.dsh`, so a rule that omits
    // any of the tier fields is an incompatible inventory, not a clean profile.
    const rows = []
    for (const rule of value.data.rules) {
      if (!plainRecord(rule) || typeof rule.id !== 'string' || typeof rule.tier !== 'string'
        || typeof rule.override_class !== 'string'
        || !plainRecord(rule.effective_modes) || typeof rule.effective_modes.dsh !== 'string') {
        return { ok: false, error: 'agent-hook inventory returned a rule without id, tier, override_class, and effective_modes.dsh' }
      }
      rows.push({
        id: rule.id,
        tier: rule.tier,
        override_class: rule.override_class,
        effective_mode: rule.effective_modes.dsh,
      })
    }
    return {
      ok: true,
      status: 'activated',
      downgrades: rows.filter(row => row.effective_mode === 'advise').map(row => row.id),
      tier_table_sha256: sha256(stableJson(rows.map(row => ({
        id: row.id,
        tier: row.tier,
        override_class: row.override_class,
      })))),
    }
  } catch {
    return { ok: false, error: 'agent-hook inventory returned invalid JSON' }
  }
}

function ownerlessAdoptionPlan(profile: string, paths: ReturnType<typeof pathsFor>, runtimeRoot: string) {
  const adoption = ownerlessRuntimeRootAdoption(paths, runtimeRoot, profile)
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation: 'doctor-repair',
    profile,
    package_name: PACKAGE_NAME,
    action: 'adopt-owner',
    observed_manifest_digest: readActual(paths).manifest_digest,
    state_digest: adoption.state_digest,
    adoption,
  }
  return { plan, plan_digest: sha256(stableJson(plan)) }
}

/** A v1 pending marker has no recoverable phase vocabulary; the base CLI or a backup owns it. */
function legacyPendingUnsupported() {
  return new OperationsError(
    'legacy-pending-recovery-unsupported',
    'legacy pending state cannot be inferred safely; recover with the exact base CLI or restore an authenticated backup',
  )
}

function repairPlan(profile: string, paths: ReturnType<typeof pathsFor>, diagnostic: ReturnType<typeof diagnose>) {
  const recovery = ((diagnostic.recovery) as any)
  if (recovery === null) throw new OperationsError('repair-not-required', 'doctor found no interrupted operation', 64)
  if (recovery.action === 'legacy-pending') {
    throw legacyPendingUnsupported()
  }
  if (recovery.action === 'migrate-v1') {
    if (typeof recovery.runtime_root !== 'string') {
      throw new OperationsError('unsafe-repair-runtime-root', 'legacy migration requires a valid canonical runtime root')
    }
    const runtimeRoot = resolveActivationRoot(recovery.runtime_root)
    return legacyMigrationPlan(
      profile,
      paths,
      readActual(paths),
      readState(paths.state, profile),
      runtimeRoot,
    )
  }
  if (recovery.action === 'adopt-owner') {
    return ownerlessAdoptionPlan(
      profile,
      paths,
      resolveActivationRoot(recovery.adoption.runtime_root),
    )
  }
  if (recovery.action === 'unknown') {
    throw new OperationsError('recovery-ambiguous', 'interrupted operation does not match either reviewed terminal state')
  }
  const stateRead = readState(paths.state, profile)
  const state = ((stateRead.value) as any)
  const runtimeRootTopology = repairRuntimeRootTopology(
    state,
    profile,
    paths,
    resolveActivationRoot(process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT),
  )
  const pending = validatePending(recovery.pending, profile)
  let proposed
  if (recovery.action === 'clear' || recovery.action === 'restore-collateral') {
    proposed = {
      current: state.current,
      previous: state.previous,
      last_applied: state.last_applied,
      pending: null,
    }
  } else {
    const target = pending.operation === 'remove' ? null : validateTarget(pending.target)
    proposed = terminalStateFields(
      target === null
        ? null
        : expectedSnapshot(
            readActual(paths),
            target,
            paths,
            ((pending.plan) as any).runtime_root,
            profile,
          ),
      pending.operation === 'update' || pending.operation === 'rollback' ? state.current : null,
      appliedReceipt(
        ((pending.operation) as string),
        ((pending.plan_digest) as string),
        pending.plan,
        '<apply-time>',
        true,
      ),
    )
  }
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation: 'doctor-repair',
    profile,
    package_name: PACKAGE_NAME,
    action: recovery.action,
    pending_plan_digest: recovery.pending.plan_digest,
    observed_manifest_digest: diagnostic.observed.manifest_digest,
    state_digest: stateRead.digest,
    runtime_root_topology: runtimeRootTopology,
    proposed_state: proposed,
  }
  return { plan, plan_digest: sha256(stableJson(plan)) }
}

function applyRepair(profile: string, paths: ReturnType<typeof pathsFor>, reviewed: ReturnType<typeof repairPlan>, executables: HealthExecutables) {
  prepareOperationsTree(paths)
  return withOperationLocks(paths, () => {
    const stateRead = readState(paths.state, profile)
    const state = stateRead.value
    const adoption = ((reviewed.plan) as any).action === 'adopt-owner'
    const runtimeRoot = adoption
      ? resolveActivationRoot(((reviewed.plan) as any).adoption.runtime_root)
      : stateRead.version === 1
      ? resolveActivationRoot(((reviewed.plan) as any).runtime_root)
      : resolveActivationRoot(/** @type {any} */ (validatePlan(
          validatePending(((state) as any)?.pending, profile).plan,
          profile,
        )).runtime_root)
    return withRuntimeRootLock(paths, runtimeRoot, () => {
    if (adoption) {
      let current
      try {
        if (process.env.NODE_ENV === 'test'
          && process.env.DSH_RUNTIME_KIT_TEST_FAULT_POINT === 'ownerless-adoption-revalidation-infrastructure') {
          throw new OperationsError(
            'command-supervisor-failed',
            'ownerless adoption locked revalidation infrastructure failed',
            70,
            { point: 'ownerless-adoption-revalidation-infrastructure' },
          )
        }
        current = ownerlessAdoptionPlan(profile, paths, runtimeRoot)
      } catch (error) {
        throw reviewedRepairApplyError(error)
      }
      if (current.plan_digest !== reviewed.plan_digest) {
        throw new OperationsError('plan-drift', 'ownerless runtime root changed after preview')
      }
      writeRuntimeRootOwner(paths, runtimeRoot)
      return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    }
    reconcileArtifacts(paths)
    reconcileActivationAssets(paths, runtimeRoot)
    try {
    if (stateRead.version === 1) {
      const current = legacyMigrationPlan(profile, paths, readActual(paths), stateRead, runtimeRoot)
      if (current.plan_digest !== reviewed.plan_digest) {
        throw new OperationsError('plan-drift', 'legacy migration state changed after preview')
      }
      ensureRuntimeRootOwner(paths, runtimeRoot)
      const proposed = ((current.plan) as any).proposed_state
      if (proposed.current === null) {
        removeActivation(runtimeRoot)
      } else {
        const migratedTarget = validateTarget(proposed.current.target)
        stageActivation(
          paths,
          migratedTarget,
          runtimeRoot,
          profile,
          lifecycleForTarget(paths, migratedTarget),
          executables,
        )
      }
      atomicWriteJson(paths.state, proposed)
      reconcileArtifacts(paths)
      return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    }
    if (state?.pending !== null && state?.pending !== undefined) {
      const pending = validatePending(state.pending, profile)
      cleanupProfileRestoreTemporaries(
        validateProfileSnapshot(pending.profile_before),
        paths,
      )
    }
    const actual = readActual(paths)
    repairRuntimeRootTopology(state, profile, paths, runtimeRoot)
    const recovery = recoveryFor(actual, state, paths)
    if (recovery === null || recovery.action === 'unknown') {
      throw new OperationsError('recovery-drift', 'recovery state changed after preview')
    }
    const currentDiagnostic = {
      recovery,
      observed: actual,
    }
    const current = repairPlan(profile, paths, ((currentDiagnostic) as any))
    if (current.plan_digest !== reviewed.plan_digest) {
      throw new OperationsError('plan-drift', 'recovery state changed after preview')
    }
    ensureRuntimeRootOwner(paths, runtimeRoot)
    if (recovery.action === 'restore-collateral') {
      const pending = validatePending(recovery.pending, profile)
      const plan = ((validatePlan(pending.plan, profile)) as any)
      const plannedToolchain = validateToolchain(plan.toolchain)
      const toolchain = resolveToolchain(plannedToolchain.dsh.executable, paths.home)
      if (stableJson(toolchain) !== stableJson(plannedToolchain)) {
        throw new OperationsError('plan-drift', 'recovery toolchain changed after the interrupted operation')
      }
      const recoveredState = ((state) as any)
      const restoredState = { ...recoveredState, pending: null }
      const restoredStateRead = {
        raw: `${JSON.stringify(restoredState, undefined, 2)}\n`,
        digest: sha256(stableJson(restoredState)),
        value: restoredState,
        version: 2,
      }
      try {
        restoreAfterCollateral(
          toolchain.dsh.executable,
          paths,
          profile,
          recoveredState,
          validateProfileSnapshot(pending.profile_before),
          restoredStateRead,
          resolveExecutable('npm'),
          plan.runtime_root,
        )
      } catch {
        throw new OperationsError(
          'native-dsh-collateral-recovery-failed',
          'interrupted DSH collateral could not be restored to the exact prior package and profile state',
        )
      }
      throw new OperationsError(
        'native-dsh-collateral-mutation',
        'interrupted DSH mutation changed unrelated profile state; the exact prior state was restored',
      )
    }
    if (recovery.action === 'clear') {
      atomicWriteJson(paths.state, { ...state, pending: null })
    } else {
      const pending = ((recovery.pending) as any)
      const recoveredState = ((state) as any)
      let installed = null
      let previous = null
      if (pending.operation === 'remove') {
        if (actual.installed_entry) cleanupInstalledEntry(paths)
        const cleaned = readActual(paths)
        if (!actualAbsent(cleaned)) {
          throw new OperationsError('recovery-drift', 'recovered remove did not reach the reviewed absent state')
        }
        removeActivation(pending.plan.runtime_root)
      } else {
        const target = validateTarget(pending.target)
        const pendingPlan = ((validatePlan(pending.plan, profile)) as any)
        // Finalization activates a package the host already installed, so the
        // admission decisions the plan recorded must still hold: the live
        // toolchain must be the one the plan bound, and the package's own
        // declaration (re-read from its authenticated artifact, never trusted
        // from the persisted plan) must still admit that host.
        const plannedToolchain = validateToolchain(pendingPlan.toolchain)
        const liveToolchain = resolveToolchain(plannedToolchain.dsh.executable, paths.home)
        if (stableJson(liveToolchain) !== stableJson(plannedToolchain)) {
          throw new OperationsError('plan-drift', 'DSH or pnpm toolchain changed after the interrupted operation was reviewed')
        }
        assertLifecycleCompatibility(lifecycleForTarget(paths, target), liveToolchain)
        stageActivation(
          paths,
          target,
          pending.plan.runtime_root,
          profile,
          validatePlanLifecycle(pendingPlan.lifecycle),
          { ...executables, dsh: liveToolchain.dsh.executable },
        )
        installed = snapshot(actual, target, paths, pending.plan.runtime_root, profile)
        previous = pending.operation === 'update' || pending.operation === 'rollback'
          ? recoveredState.current
          : null
      }
      atomicWriteJson(paths.state, versionedOperationsState(profile, terminalStateFields(
        installed,
        previous,
        appliedReceipt(
          pending.operation,
          pending.plan_digest,
          pending.plan,
          new Date().toISOString(),
          true,
        ),
      )))
    }
    reconcileArtifacts(paths)
    return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    } finally {
      reconcileActivationAssets(paths, runtimeRoot)
    }
    }, { allowOwnerless: adoption })
  })
}

function envelope(data: unknown, ok: boolean = true) {
  return { schema_version: OUTPUT_SCHEMA, ok, data }
}

function print(value: unknown, format: 'json' | 'text') {
  if (format === 'json') process.stdout.write(`${JSON.stringify(value)}\n`)
  else process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`)
}

export function main(argv: string[] = process.argv.slice(2)) {
  let format = (('text') as 'json' | 'text')
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: 'string' },
        package: { type: 'string' },
        apply: { type: 'boolean', default: false },
        'expected-plan-digest': { type: 'string' },
        'policy-overrides': { type: 'string' },
        format: { type: 'string', default: 'text' },
        repair: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.format !== 'json' && parsed.values.format !== 'text') {
      throw new OperationsError('invalid-format', '--format must be json or text', 64)
    }
    format = parsed.values.format
    if (parsed.values.help) {
      process.stdout.write([
        'Usage: dsh-runtime-kit <setup|doctor|update|rollback|remove> --profile <name> [options]',
        '',
        'Mutations are dry-run by default. Apply only with:',
        '  --apply --expected-plan-digest <digest>',
        '',
        'setup/update:',
        '  preview/first apply: --package <exact @sympoies/dsh-runtime-kit@version or local directory>',
        '  completed digest replay: --package may be omitted; a supplied target must match',
        '  --policy-overrides <file>: dsh-runtime-kit.policy-overrides.v1 map projecting',
        '    downgrade-only rules to advise; bound to the plan digest and the receipt',
        '',
        'doctor recovery:',
        '  doctor --repair [--apply --expected-plan-digest <digest>]',
        '',
      ].join('\n'))
      return 0
    }
    if (parsed.positionals.length !== 1) throw new OperationsError('invalid-operation', 'choose one operation: setup, doctor, update, rollback, remove', 64)
    const operation = parsed.positionals[0]
    if (!['setup', 'doctor', 'update', 'rollback', 'remove'].includes(operation)) {
      throw new OperationsError('invalid-operation', `unsupported operation ${operation}`, 64)
    }
    if (parsed.values.profile === undefined) throw new OperationsError('missing-profile', '--profile is required', 64)
    if (parsed.values['policy-overrides'] !== undefined
      && (operation !== 'setup' && operation !== 'update' || parsed.values.package === undefined)) {
      throw new OperationsError('unexpected-policy-overrides', '--policy-overrides is valid only with setup or update and --package', 64)
    }
    const policyOverrides = readPolicyOverrides(parsed.values['policy-overrides'])
    const profile = validateProfile(parsed.values.profile)
    const home = resolveHome()
    const paths = pathsFor(home, profile)
    const apply = parsed.values.apply
    const expected = parsed.values['expected-plan-digest']
    if (apply && (expected === undefined || !DIGEST_PATTERN.test(expected))) {
      throw new OperationsError('expected-plan-digest-required', '--apply requires --expected-plan-digest <64 lowercase hex>', 64)
    }
    if (!apply && expected !== undefined) throw new OperationsError('unexpected-plan-digest', '--expected-plan-digest is valid only with --apply', 64)

    if (operation === 'doctor') {
      if (parsed.values.package !== undefined) throw new OperationsError('unexpected-package', 'doctor does not accept --package', 64)
      if (!parsed.values.repair && apply) {
        throw new OperationsError('unexpected-apply', 'doctor --apply requires --repair', 64)
      }
      assertOperationsTree(paths)
      const dshBin = resolveExecutable(process.env.DSH_RUNTIME_KIT_DSH_BIN ?? 'dsh')
      const activationInput: {runtimeRoot?: string, data?: ReturnType<typeof readActivation>, error?: string, ownerMissing?: boolean} = {}
      try {
        activationInput.runtimeRoot = resolveActivationRoot(process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT)
        if (existsSync(join(activationInput.runtimeRoot, '.dsh-runtime-kit-owner.json'))) {
          assertRuntimeRootOwner(paths, activationInput.runtimeRoot)
        } else if (existsSync(join(activationInput.runtimeRoot, 'activation.json'))
          || existsSync(join(activationInput.runtimeRoot, 'assets'))) {
          activationInput.ownerMissing = true
        }
        if (existsSync(join(activationInput.runtimeRoot, 'activation.json'))) {
          activationInput.data = readActivation(activationInput.runtimeRoot)
        }
      } catch (error) {
        activationInput.error = error instanceof Error ? error.message : 'runtime activation is invalid'
      }
      const activeEnvironment = activationInput.data?.environment ?? process.env
      let agentHook
      try {
        agentHook = resolveAgentHookRuntime({
          agentHook: resolveExecutable(process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook'),
          agentHookConfig: activeEnvironment.DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG,
          agentHookPolicy: activeEnvironment.DSH_RUNTIME_KIT_AGENT_HOOK_POLICY,
          agentHookStateDir: activeEnvironment.DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR,
        })
      } catch (error) {
        throw new OperationsError(
          'agent-hook-isolation-invalid',
          error instanceof Error ? error.message : 'agent-hook isolation is invalid',
        )
      }
      let diagnostic
      try {
        diagnostic = diagnose(profile, paths, agentHook, {
          agentDocs: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_BIN,
          agentDocsHome: activeEnvironment.DSH_RUNTIME_KIT_AGENT_DOCS_HOME,
          agentDocsStateHome: activeEnvironment.DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME,
        }, dshBin, activationInput)
      } catch (error) {
        if (parsed.values.repair && apply) {
          throw reviewedRepairApplyError(error)
        }
        throw error
      }
      if (!parsed.values.repair) {
        print(envelope(diagnostic, diagnostic.status === 'healthy'), format)
        return diagnostic.status === 'healthy' ? 0 : 65
      }
      let planned
      try {
        planned = repairPlan(profile, paths, diagnostic)
      } catch (error) {
        if (apply) throw reviewedRepairApplyError(error)
        throw error
      }
      if (!apply) {
        print(envelope({ mode: 'dry-run', ...planned }), format)
        return 0
      }
      if (expected !== planned.plan_digest) throw new OperationsError('plan-drift', 'recovery plan changed after preview')
      print(envelope(applyRepair(profile, paths, planned, {
        dsh: dshBin,
        agentHook: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook',
        agentDocs: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_BIN,
      })), format)
      return 0
    }

    if (parsed.values.repair) throw new OperationsError('invalid-repair', '--repair is valid only with doctor', 64)
    if (!apply && (operation === 'setup' || operation === 'update') && parsed.values.package === undefined) {
      throw new OperationsError('missing-package', `${operation} requires --package`, 64)
    }
    if ((operation === 'rollback' || operation === 'remove') && parsed.values.package !== undefined) {
      throw new OperationsError('unexpected-package', `${operation} does not accept --package`, 64)
    }
    assertOperationsTree(paths)
    if (!apply) {
      const npmBin = resolveExecutable('npm')
      const target = parsed.values.package === undefined
        ? null
        : resolveTarget(parsed.values.package, npmBin, home, false, policyOverrides)
      const actual = readActual(paths)
      const stateRead = readState(paths.state, profile)
      const runtimeRoot = resolveActivationRoot(process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT)
      const toolchain = resolveToolchain(process.env.DSH_RUNTIME_KIT_DSH_BIN ?? 'dsh', home)
      const planned = buildMutationPlan(
        operation,
        profile,
        paths,
        actual,
        stateRead,
        target,
        runtimeRoot,
        toolchain,
      )
      print(envelope({ mode: 'dry-run', ...planned }), format)
      return 0
    }
    print(envelope(applyMutation(
      operation,
      profile,
      paths,
      ((expected) as string),
      parsed.values.package,
      process.env.DSH_RUNTIME_KIT_DSH_BIN ?? 'dsh',
      {
        agentHook: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook',
        agentDocs: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_BIN,
      },
      policyOverrides,
    )), format)
    return 0
  } catch (error) {
    const normalized = error instanceof OperationsError
      ? error
      : ((error) as NodeJS.ErrnoException & {code?: string}).code?.startsWith('ERR_PARSE_ARGS')
          ? new OperationsError('invalid-arguments', error instanceof Error ? error.message : String(error), 64)
          : new OperationsError('operations-failed', error instanceof Error ? error.message : String(error), 70)
    print({
      schema_version: OUTPUT_SCHEMA,
      ok: false,
      error: { code: normalized.code, message: normalized.message, details: normalized.details },
    }, format)
    return normalized.exitCode
  }
}
