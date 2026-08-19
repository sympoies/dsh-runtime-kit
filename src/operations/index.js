// @ts-check

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
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'

const PACKAGE_NAME = '@sympoies/dsh-runtime-kit'
const STATE_SCHEMA = 'dsh-runtime-kit.operations-state.v1'
const PLAN_SCHEMA = 'dsh-runtime-kit.operations-plan.v1'
const OUTPUT_SCHEMA = 'cli.dsh-runtime-kit.operations.v1'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const MAX_PACKED_PACKAGE_BYTES = 128 * 1024 * 1024
const MAX_INSTALLED_PACKAGE_FILES = 16_384
const MAX_INSTALLED_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_ARTIFACT_COUNT = 64
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
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
  /** @param {string} code @param {string} message @param {number} [exitCode] @param {Record<string, unknown>} [details] */
  constructor(code, message, exitCode = 65, details = {}) {
    super(message)
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** @param {unknown} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {string} path */
function readJson(path) {
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

/** @param {string} path */
function lstatMaybe(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}

/** @param {string} path @param {'directory' | 'file'} kind @param {boolean} [privateOnly] @param {boolean} [allowRoot] */
function assertOwnedPath(path, kind, privateOnly = false, allowRoot = false) {
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

/** @param {string} path */
function ensurePrivateDirectory(path) {
  const existed = lstatMaybe(path) !== null
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertOwnedPath(path, 'directory', true)
  if (!existed && lstatMaybe(dirname(path))?.isDirectory()) fsyncDirectory(dirname(path))
}

/** @param {string} path */
function fsyncDirectory(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** @param {string} path */
function assertSafeStateFile(path) {
  const stat = lstatMaybe(path)
  if (stat === null) return
  assertOwnedPath(path, 'file', true)
}

/** @param {string} path @param {unknown} value */
function atomicWriteJson(path, value) {
  ensurePrivateDirectory(dirname(path))
  assertSafeStateFile(path)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd
  let renamed = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    renamed = true
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} profile */
function validateProfile(profile) {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new OperationsError('invalid-profile', 'profile must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}', 64)
  }
  return profile
}

function resolveHome() {
  const configured = process.env.DSH_HOME
  return configured === undefined ? join(homedir(), '.dsh') : resolve(configured)
}

/** @param {string} home @param {string} profile */
function pathsFor(home, profile) {
  return {
    home,
    profileDir: join(home, 'profiles', profile),
    manifest: join(home, 'profiles', profile, 'package.json'),
    installedPackage: join(home, 'profiles', profile, 'node_modules', '@sympoies', 'dsh-runtime-kit'),
    installedManifest: join(home, 'profiles', profile, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json'),
    state: join(home, 'runtime-kit', 'state', `${profile}.json`),
    lock: join(home, 'runtime-kit', 'state', `${profile}.lock`),
    artifacts: join(home, 'runtime-kit', 'artifacts'),
  }
}

/** @param {ReturnType<typeof pathsFor>} paths */
function prepareOperationsTree(paths) {
  assertOperationsTree(paths)
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  assertOwnedPath(paths.home, 'directory')
  ensurePrivateDirectory(join(paths.home, 'runtime-kit'))
  ensurePrivateDirectory(dirname(paths.state))
  ensurePrivateDirectory(paths.artifacts)
}

/** @param {ReturnType<typeof pathsFor>} paths */
function assertOperationsTree(paths) {
  if (lstatMaybe(paths.home) !== null) assertOwnedPath(paths.home, 'directory')
  for (const path of [join(paths.home, 'runtime-kit'), dirname(paths.state), paths.artifacts]) {
    if (lstatMaybe(path) !== null) assertOwnedPath(path, 'directory', true)
  }
}

/** @param {ReturnType<typeof pathsFor>} paths */
function assertProfileTree(paths) {
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

/** @param {string} parent @param {string} child */
function pathIsWithin(parent, child) {
  const fragment = relative(parent, child)
  return fragment === '' || (!fragment.startsWith(`..${sep}`) && fragment !== '..' && !isAbsolute(fragment))
}

/** @param {string} packagePath @param {string} containmentPath */
function packageTreeDigest(packagePath, containmentPath) {
  const containmentRoot = realpathSync(containmentPath)
  const packageRoot = realpathSync(packagePath)
  if (!pathIsWithin(containmentRoot, packageRoot)) {
    throw new OperationsError('unsafe-profile-tree', 'runtime-kit package resolves outside its authenticated root')
  }
  const hash = createHash('sha256')
  let entries = 0
  let bytes = 0
  /** @param {string} absolute @param {string} logical @param {number} depth */
  const visit = (absolute, logical, depth) => {
    if (depth > 64) throw new OperationsError('installed-package-limit', 'installed package exceeds the depth limit')
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
    hash.update(`F\0${logical}\0${stat.mode & 0o111}\0${stat.size}\0`)
    hash.update(readFileSync(absolute))
  }
  visit(packageRoot, '', 0)
  return hash.digest('hex')
}

/** @param {ReturnType<typeof pathsFor>} paths */
function installedPackageDigest(paths) {
  return packageTreeDigest(paths.installedPackage, paths.profileDir)
}

/** @param {ReturnType<typeof pathsFor>} paths */
function readActual(paths) {
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

/** @param {ReturnType<typeof readActual>} actual */
function publicActual(actual) {
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

/** @param {ReturnType<typeof readActual>} actual */
function actualAbsent(actual) {
  return actual.dependency_spec === null && actual.bundle_indexes.length === 0
    && actual.installed_version === null && actual.installed_name === null
    && actual.installed_digest === null
    && actual.installed_entry === false
}

/** @param {ReturnType<typeof readActual>} actual */
function assertActualInstall(actual) {
  if (actual.dependency_spec === null || actual.bundle_indexes.length !== 1
    || actual.installed_name !== PACKAGE_NAME || actual.installed_version === null
    || actual.installed_digest === null) {
    throw new OperationsError('owned-state-drift', 'runtime-kit dependency, bundle row, and installed package are not one consistent installation')
  }
}

/** @param {unknown} value */
function validateTarget(value) {
  if (!plainRecord(value) || !['registry', 'local'].includes(/** @type {string} */ (value.kind))
    || typeof value.requested_spec !== 'string'
    || typeof value.expected_version !== 'string'
    || !EXACT_VERSION_PATTERN.test(value.expected_version)) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid package target')
  }
  if (value.kind === 'registry') {
    if (Object.keys(value).some(key => !['kind', 'requested_spec', 'expected_version'].includes(key))
      || value.requested_spec !== `${PACKAGE_NAME}@${value.expected_version}`) {
      throw new OperationsError('invalid-operations-state', 'operations state contains an invalid registry target')
    }
  } else if (Object.keys(value).some(key => ![
    'kind', 'requested_spec', 'source_path', 'expected_version', 'artifact_sha256', 'installed_sha256',
  ].includes(key)) || typeof value.source_path !== 'string' || !isAbsolute(value.source_path)
    || typeof value.artifact_sha256 !== 'string' || !DIGEST_PATTERN.test(value.artifact_sha256)
    || typeof value.installed_sha256 !== 'string' || !DIGEST_PATTERN.test(value.installed_sha256)) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid local package target')
  }
  return /** @type {{kind:'registry',requested_spec:string,expected_version:string}|{kind:'local',requested_spec:string,source_path:string,expected_version:string,artifact_sha256:string,installed_sha256:string}} */ (value)
}

/** @param {ReturnType<typeof pathsFor>} paths @param {ReturnType<typeof validateTarget>} target */
function artifactPathFor(paths, target) {
  if (target.kind !== 'local') throw new OperationsError('invalid-package-spec', 'registry targets do not have local artifacts')
  return join(paths.artifacts, `${target.artifact_sha256}.tgz`)
}

/** @param {string} spec @param {ReturnType<typeof pathsFor>} paths */
function dependencyPath(spec, paths) {
  const candidate = spec.replace(/^(?:file|link):/, '')
  return isAbsolute(candidate) ? resolve(candidate) : resolve(paths.profileDir, candidate)
}

/** @param {ReturnType<typeof readActual>} actual @param {ReturnType<typeof validateTarget>} target @param {ReturnType<typeof pathsFor>} paths */
function targetMatchesActual(actual, target, paths) {
  if (actual.dependency_spec === null || actual.bundle_indexes.length !== 1
    || actual.installed_name !== PACKAGE_NAME || actual.installed_version !== target.expected_version) return false
  if (target.kind === 'registry') {
    return actual.dependency_spec === target.expected_version
      || actual.dependency_spec === target.requested_spec
  }
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

/** @param {ReturnType<typeof readActual>} actual @param {ReturnType<typeof validateTarget>} target @param {ReturnType<typeof pathsFor>} paths */
function snapshot(actual, target, paths) {
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
    target,
  }
}

/** @param {unknown} value */
function validateSnapshot(value) {
  if (!plainRecord(value) || typeof value.requested_spec !== 'string'
    || typeof value.dependency_spec !== 'string' || typeof value.installed_version !== 'string'
    || typeof value.installed_digest !== 'string' || !DIGEST_PATTERN.test(value.installed_digest)
    || !Number.isSafeInteger(value.bundle_index) || /** @type {number} */ (value.bundle_index) < 0
    || Object.keys(value).some(key => ![
      'requested_spec', 'dependency_spec', 'installed_version', 'installed_digest', 'bundle_index', 'target',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid install snapshot')
  }
  const target = validateTarget(value.target)
  if (value.requested_spec !== target.requested_spec || value.installed_version !== target.expected_version) {
    throw new OperationsError('invalid-operations-state', 'install snapshot does not match its package target')
  }
  return /** @type {{requested_spec: string, dependency_spec: string, installed_version: string, installed_digest: string, bundle_index: number, target: ReturnType<typeof validateTarget>}} */ (value)
}

/** @param {ReturnType<typeof readActual>} actual @param {ReturnType<typeof validateSnapshot>} expected @param {ReturnType<typeof pathsFor>} paths */
function snapshotMatches(actual, expected, paths) {
  return actual.dependency_spec === expected.dependency_spec
    && actual.installed_version === expected.installed_version
    && actual.installed_digest === expected.installed_digest
    && actual.installed_name === PACKAGE_NAME
    && actual.bundle_indexes.length === 1
    && actual.bundle_indexes[0] === expected.bundle_index
    && targetMatchesActual(actual, expected.target, paths)
}

/** @param {string} path @param {string} expectedProfile */
function readState(path, expectedProfile) {
  if (lstatMaybe(path) === null) return { raw: null, digest: 'absent', value: null }
  assertSafeStateFile(path)
  const read = readJson(path)
  if (!plainRecord(read.value) || read.value.schema_version !== STATE_SCHEMA
    || read.value.profile !== expectedProfile
    || !['current', 'previous', 'last_applied', 'pending'].every(key => Object.hasOwn(read.value, key))
    || Object.keys(read.value).some(key => ![
      'schema_version', 'profile', 'current', 'previous', 'last_applied', 'pending',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'runtime-kit operations state has an unsupported schema')
  }
  if (read.value.current !== null) validateSnapshot(read.value.current)
  if (read.value.previous !== null) validateSnapshot(read.value.previous)
  if (read.value.pending !== null) validatePending(read.value.pending, expectedProfile)
  if (read.value.last_applied !== null) validateAppliedReceipt(read.value.last_applied, expectedProfile)
  return { raw: read.raw, digest: sha256(read.raw), value: read.value }
}

/** @param {string} sourcePath @param {string} npmBin @param {string} home */
function packLocalSource(sourcePath, npmBin, home) {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-pack-'))
  try {
    const result = spawn(npmBin, [
      'pack', '--ignore-scripts', '--json', '--pack-destination', temporary, sourcePath,
    ], home, {
      cwd: sourcePath,
      extraEnv: {
        NPM_CONFIG_USERCONFIG: '/dev/null',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_CACHE: join(temporary, 'npm-cache'),
      },
    })
    if (result.status !== 0) {
      throw new OperationsError('invalid-package-spec', 'npm could not create a script-free package artifact', 65, commandFailure(result))
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
    const extracted = join(temporary, 'extracted')
    mkdirSync(extracted, { mode: 0o700 })
    const tarBin = resolveExecutable('tar')
    const unpacked = spawn(tarBin, ['-xzf', archivePath, '-C', extracted], home)
    if (unpacked.status !== 0) {
      throw new OperationsError('invalid-package-spec', 'packed local package could not be inspected', 65, commandFailure(unpacked))
    }
    const installedSha256 = packageTreeDigest(join(extracted, 'package'), extracted)
    return {
      temporary,
      archive_path: archivePath,
      artifact_sha256: sha256(archive),
      installed_sha256: installedSha256,
      version: output[0].version,
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

/** @param {string} input @param {string} npmBin @param {string} home */
function resolveTarget(input, npmBin, home) {
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
    const packed = packLocalSource(absolute, npmBin, home)
    try {
      if (packed.version !== manifest.version) {
        throw new OperationsError('invalid-package-spec', 'packed local package version changed during inspection')
      }
      return {
        kind: /** @type {const} */ ('local'),
        requested_spec: requestedSpec,
        source_path: absolute,
        expected_version: manifest.version,
        artifact_sha256: packed.artifact_sha256,
        installed_sha256: packed.installed_sha256,
      }
    } finally {
      rmSync(packed.temporary, { recursive: true, force: true })
    }
  }
  const registry = /^@sympoies\/dsh-runtime-kit@(.+)$/.exec(input)
  if (registry === null || !EXACT_VERSION_PATTERN.test(registry[1])) {
    throw new OperationsError('invalid-package-spec', `package must be a local ${PACKAGE_NAME} directory or an exact ${PACKAGE_NAME}@<version>`, 64)
  }
  return {
    kind: /** @type {const} */ ('registry'),
    requested_spec: input,
    expected_version: registry[1],
  }
}

/** @param {Set<string>} digests @param {unknown} target */
function retainTargetArtifact(digests, target) {
  if (target === null || target === undefined) return
  const validated = validateTarget(target)
  if (validated.kind === 'local') digests.add(validated.artifact_sha256)
}

/** @param {ReturnType<typeof pathsFor>} paths */
function retainedArtifactDigests(paths) {
  const digests = new Set()
  if (lstatMaybe(dirname(paths.state)) === null) return digests
  for (const name of readdirSync(dirname(paths.state)).sort()) {
    if (!name.endsWith('.json')) continue
    const profile = name.slice(0, -'.json'.length)
    validateProfile(profile)
    const state = readState(join(dirname(paths.state), name), profile).value
    if (state === null) continue
    if (state.current !== null) retainTargetArtifact(digests, validateSnapshot(state.current).target)
    if (state.previous !== null) retainTargetArtifact(digests, validateSnapshot(state.previous).target)
    if (state.pending !== null) retainTargetArtifact(digests, validatePending(state.pending, profile).target)
    if (state.last_applied !== null) {
      const receipt = /** @type {any} */ (validateAppliedReceipt(state.last_applied, profile))
      retainTargetArtifact(digests, receipt.plan.target)
    }
  }
  return digests
}

/** @param {ReturnType<typeof pathsFor>} paths */
function reconcileArtifacts(paths) {
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

/** @param {ReturnType<typeof validateTarget>} target @param {ReturnType<typeof pathsFor>} paths @param {string} npmBin */
function installSpecForTarget(target, paths, npmBin) {
  if (target.kind === 'registry') return target.requested_spec
  ensurePrivateDirectory(paths.artifacts)
  const artifactPath = artifactPathFor(paths, target)
  const existing = lstatMaybe(artifactPath)
  if (existing !== null) {
    assertSafeStateFile(artifactPath)
    const archive = readFileSync(artifactPath)
    if (archive.byteLength > MAX_PACKED_PACKAGE_BYTES || sha256(archive) !== target.artifact_sha256) {
      throw new OperationsError('artifact-drift', 'stored local package artifact does not match its reviewed digest')
    }
    return `file:${artifactPath}`
  }

  const packed = packLocalSource(target.source_path, npmBin, paths.home)
  try {
    if (packed.version !== target.expected_version || packed.artifact_sha256 !== target.artifact_sha256
      || packed.installed_sha256 !== target.installed_sha256) {
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
    rmSync(packed.temporary, { recursive: true, force: true })
  }
}

/** @param {string} operation @param {string} profile @param {ReturnType<typeof readActual>} actual @param {ReturnType<typeof readState>} stateRead @param {ReturnType<typeof resolveTarget> | null} target @param {string} action */
function planFor(operation, profile, actual, stateRead, target, action) {
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation,
    profile,
    package_name: PACKAGE_NAME,
    action,
    target,
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

/** @param {unknown} value @param {string} profile */
function validatePlan(value, profile) {
  if (!plainRecord(value) || value.schema_version !== PLAN_SCHEMA || value.profile !== profile
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
    throw new OperationsError('invalid-operations-state', 'operations state contains an invalid reviewed plan')
  }
  const actions = {
    setup: ['install', 'noop'],
    update: ['update', 'noop'],
    rollback: ['rollback'],
    remove: ['remove', 'noop'],
  }
  const allowed = /** @type {Record<string, string[]>} */ (actions)[value.operation]
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

/** @param {unknown} value @param {string} profile */
function validatePending(value, profile) {
  if (!plainRecord(value) || typeof value.operation !== 'string'
    || typeof value.plan_digest !== 'string' || !DIGEST_PATTERN.test(value.plan_digest)
    || typeof value.started_at !== 'string'
    || Object.keys(value).some(key => ![
      'operation', 'plan_digest', 'target', 'plan', 'started_at',
    ].includes(key))) {
    throw new OperationsError('invalid-operations-state', 'runtime-kit pending operation is invalid')
  }
  const plan = validatePlan(value.plan, profile)
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

/** @param {unknown} value @param {string} profile */
function validateAppliedReceipt(value, profile) {
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

/** @param {string} operation @param {string} profile @param {ReturnType<typeof pathsFor>} paths @param {ReturnType<typeof readActual>} actual @param {ReturnType<typeof readState>} stateRead @param {ReturnType<typeof resolveTarget> | null} requestedTarget */
function buildMutationPlan(operation, profile, paths, actual, stateRead, requestedTarget) {
  const state = stateRead.value
  if (state?.pending !== null && state?.pending !== undefined) {
    throw new OperationsError('recovery-required', 'an interrupted operation must be resolved with doctor --repair')
  }
  const current = state?.current === null || state?.current === undefined
    ? null
    : validateSnapshot(state.current)
  if (current !== null && !snapshotMatches(actual, current, paths)) {
    throw new OperationsError('owned-state-drift', 'observed profile state does not match the last runtime-kit receipt')
  }
  if (current === null && !actualAbsent(actual)) {
    throw new OperationsError('unmanaged-owned-state', 'runtime-kit is installed without an authenticated operations receipt')
  }

  if (operation === 'setup') {
    if (requestedTarget === null) throw new OperationsError('missing-package', 'setup requires --package', 64)
    if (current !== null) {
      if (stableJson(current.target) !== stableJson(requestedTarget)) {
        throw new OperationsError('already-managed', 'runtime-kit is already managed; use update for a new exact package', 64)
      }
      return planFor(operation, profile, actual, stateRead, requestedTarget, 'noop')
    }
    return planFor(operation, profile, actual, stateRead, requestedTarget, 'install')
  }
  if (operation === 'update') {
    if (requestedTarget === null) throw new OperationsError('missing-package', 'update requires --package', 64)
    if (current === null) throw new OperationsError('not-managed', 'update requires a completed setup receipt', 64)
    return planFor(
      operation,
      profile,
      actual,
      stateRead,
      requestedTarget,
      stableJson(current.target) === stableJson(requestedTarget) ? 'noop' : 'update',
    )
  }
  if (operation === 'rollback') {
    if (current === null) throw new OperationsError('not-managed', 'rollback requires a current installation', 64)
    if (state?.previous === null || state?.previous === undefined) {
      throw new OperationsError('rollback-unavailable', 'no exact previous runtime-kit receipt is available', 64)
    }
    const previous = validateSnapshot(state.previous)
    const target = previous.target
    return planFor(operation, profile, actual, stateRead, target, 'rollback')
  }
  if (operation === 'remove') {
    if (current === null) return planFor(operation, profile, actual, stateRead, null, 'noop')
    return planFor(operation, profile, actual, stateRead, null, 'remove')
  }
  throw new OperationsError('unsupported-operation', `unsupported operation ${operation}`, 64)
}

/** @param {string} path @param {() => unknown} body */
function withLock(path, body) {
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

/** @param {ReturnType<typeof pathsFor>} paths @param {() => unknown} body */
function withOperationLocks(paths, body) {
  const artifactLock = join(dirname(paths.state), 'artifacts.lock')
  return withLock(artifactLock, () => withLock(paths.lock, body))
}

/** @param {string} input */
function resolveExecutable(input) {
  const candidates = input.includes('/')
    ? [resolve(input)]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, input))
  for (const candidate of candidates) {
    try {
      const exact = realpathSync(candidate)
      const stat = assertOwnedPath(exact, 'file', false, true)
      if ((stat.mode & 0o111) === 0) continue
      return exact
    } catch {}
  }
  throw new OperationsError('command-unavailable', `cannot resolve a trusted executable for ${basename(input)}`, 70)
}

/** @param {string} home @param {Record<string, string>} [extra] */
function minimalEnvironment(home, extra = {}) {
  const env = /** @type {Record<string, string>} */ ({ DSH_HOME: home })
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

/** @param {ReturnType<typeof spawnSync>} result */
function commandFailure(result) {
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  return {
    exit_code: result.status,
    stderr_bytes: Buffer.byteLength(stderr),
    stderr_sha256: sha256(stderr),
  }
}

/** @param {string} bin @param {string[]} args @param {string} home @param {{cwd?:string,extraEnv?:Record<string,string>}} [options] */
function spawn(bin, args, home, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    env: minimalEnvironment(home, options.extraEnv),
    cwd: options.cwd,
    shell: false,
    maxBuffer: 1024 * 1024,
  })
  if (result.error !== undefined) {
    throw new OperationsError('command-unavailable', `failed to start ${basename(bin)}`, 70, { cause: result.error.message })
  }
  return result
}

/** @param {string} dshBin @param {string} home @param {string} profile @param {string} verb @param {string | null} spec */
function runDshMutation(dshBin, home, profile, verb, spec) {
  const args = verb === 'add'
    ? ['plugin', '--profile', profile, 'add', '--save-exact', /** @type {string} */ (spec)]
    : ['plugin', '--profile', profile, 'remove', PACKAGE_NAME]
  const result = spawn(dshBin, args, home, {
    cwd: home,
    extraEnv: {
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
  })
  if (result.status !== 0) {
    throw new OperationsError('native-dsh-failed', `DSH plugin ${verb} failed`, result.status ?? 70, commandFailure(result))
  }
}

/** @param {string} profile @param {string} operation @param {string} planDigest @param {any} state @param {ReturnType<typeof resolveTarget> | null} target @param {unknown} plan */
function pendingState(profile, operation, planDigest, state, target, plan) {
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
      started_at: new Date().toISOString(),
    },
  }
}

/** @param {ReturnType<typeof pathsFor>} paths */
function cleanupInstalledEntry(paths) {
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

/** @param {any} state @param {ReturnType<typeof readActual>} actual @param {any} receipt @param {ReturnType<typeof pathsFor>} paths */
function duplicateIsTerminal(state, actual, receipt, paths) {
  if (state.pending !== null) return false
  if (receipt.operation === 'remove') return state.current === null && actualAbsent(actual)
  if (state.current === null) return false
  const current = validateSnapshot(state.current)
  return stableJson(current.target) === stableJson(receipt.plan.target)
    && snapshotMatches(actual, current, paths)
}

/** @param {string} operation @param {string} profile @param {ReturnType<typeof pathsFor>} paths @param {string} expectedPlanDigest @param {string | undefined} packageInput @param {string} dshInput */
function applyMutation(operation, profile, paths, expectedPlanDigest, packageInput, dshInput) {
  prepareOperationsTree(paths)
  return withOperationLocks(paths, () => {
    reconcileArtifacts(paths)
    const stateRead = readState(paths.state, profile)
    const priorState = /** @type {any} */ (stateRead.value)
    const actual = readActual(paths)
    if (priorState?.last_applied?.plan_digest === expectedPlanDigest
      && priorState.last_applied.operation === operation) {
      if (packageInput !== undefined) {
        const supplied = resolveTarget(packageInput, resolveExecutable('npm'), paths.home)
        if (stableJson(supplied) !== stableJson(priorState.last_applied.plan.target)) {
          throw new OperationsError('plan-drift', 'supplied package target does not match the applied receipt')
        }
      }
      if (!duplicateIsTerminal(priorState, actual, priorState.last_applied, paths)) {
        throw new OperationsError('owned-state-drift', 'duplicate receipt no longer matches the current terminal state')
      }
      return { mode: 'duplicate', plan: priorState.last_applied.plan, plan_digest: expectedPlanDigest }
    }
    const npmBin = resolveExecutable('npm')
    const requestedTarget = packageInput === undefined ? null : resolveTarget(packageInput, npmBin, paths.home)
    const reviewed = buildMutationPlan(operation, profile, paths, actual, stateRead, requestedTarget)
    if (reviewed.plan_digest !== expectedPlanDigest) {
      throw new OperationsError('plan-drift', 'profile or runtime-kit state changed after preview')
    }
    const target = reviewed.plan.target === null ? null : validateTarget(reviewed.plan.target)
    const state = stateRead.value
    if (reviewed.plan.action === 'noop') {
      const next = {
        schema_version: STATE_SCHEMA,
        profile,
        current: state?.current ?? null,
        previous: state?.previous ?? null,
        pending: null,
        last_applied: { operation, plan_digest: reviewed.plan_digest, plan: reviewed.plan, completed_at: new Date().toISOString() },
      }
      atomicWriteJson(paths.state, next)
      reconcileArtifacts(paths)
      return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
    }

    const dshBin = resolveExecutable(dshInput)
    const installSpec = target === null ? null : installSpecForTarget(target, paths, npmBin)
    atomicWriteJson(paths.state, pendingState(profile, operation, reviewed.plan_digest, state, target, reviewed.plan))
    if (operation === 'remove') {
      runDshMutation(dshBin, paths.home, profile, 'remove', null)
    } else {
      runDshMutation(dshBin, paths.home, profile, 'add', installSpec)
    }
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
      current = snapshot(observed, /** @type {ReturnType<typeof validateTarget>} */ (target), paths)
    }
    const previous = operation === 'update' || operation === 'rollback'
      ? state?.current ?? null
      : null
    const next = {
      schema_version: STATE_SCHEMA,
      profile,
      current,
      previous,
      pending: null,
      last_applied: { operation, plan_digest: reviewed.plan_digest, plan: reviewed.plan, completed_at: new Date().toISOString() },
    }
    atomicWriteJson(paths.state, next)
    reconcileArtifacts(paths)
    return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
  })
}

/** @param {ReturnType<typeof readActual>} actual @param {any} state @param {ReturnType<typeof pathsFor>} paths */
function recoveryFor(actual, state, paths) {
  if (state?.pending === null || state?.pending === undefined) return null
  const pending = validatePending(state.pending, state.profile)
  if (pending.operation === 'remove') {
    if (actual.dependency_spec === null && actual.bundle_indexes.length === 0) return { action: 'finalize', pending }
  } else {
    const target = validateTarget(pending.target)
    if (target.kind === 'local' && targetMatchesActual(actual, target, paths)) {
      return { action: 'finalize', pending }
    }
  }
  if (state.current === null && actualAbsent(actual)) return { action: 'clear', pending }
  if (state.current !== null && snapshotMatches(actual, validateSnapshot(state.current), paths)) {
    return { action: 'clear', pending }
  }
  return { action: 'unknown', pending }
}

/** @param {string} agentHookBin @param {string} home */
function agentHookDoctor(agentHookBin, home) {
  const result = spawn(agentHookBin, ['doctor', '--product', 'dsh', '--format', 'json'], home)
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

/** @param {string} dshBin @param {string} home */
function dshVersion(dshBin, home) {
  const result = spawn(dshBin, ['--version'], home)
  if (result.status !== 0) return { ok: false, ...commandFailure(result), error: 'DSH version check failed' }
  const version = result.stdout.trim()
  return version === '0.1.0-rc.7'
    ? { ok: true, version }
    : { ok: false, error: 'DSH version is not the supported 0.1.0-rc.7 release' }
}

/** @param {string} profile @param {ReturnType<typeof pathsFor>} paths @param {string} agentHookBin @param {string} dshBin */
function diagnose(profile, paths, agentHookBin, dshBin) {
  const actual = readActual(paths)
  const stateRead = readState(paths.state, profile)
  const state = stateRead.value
  const recovery = recoveryFor(actual, state, paths)
  let ownedStatus = 'absent'
  if (recovery !== null) ownedStatus = 'recovery-required'
  else if (state?.current !== null && state?.current !== undefined) {
    ownedStatus = snapshotMatches(actual, validateSnapshot(state.current), paths) ? 'installed' : 'drift'
  } else if (!actualAbsent(actual)) ownedStatus = 'unmanaged'
  else if (state !== null) ownedStatus = 'removed'
  const hook = agentHookDoctor(agentHookBin, paths.home)
  const dsh = dshVersion(dshBin, paths.home)
  const healthy = recovery === null && !['drift', 'unmanaged'].includes(ownedStatus) && hook.ok && dsh.ok
  return {
    schema_version: 'dsh-runtime-kit.doctor.v1',
    profile,
    status: healthy ? 'healthy' : 'needs-attention',
    owned_status: ownedStatus,
    recovery,
    observed: publicActual(actual),
    agent_hook: hook,
    dsh,
  }
}

/** @param {string} profile @param {ReturnType<typeof pathsFor>} paths @param {ReturnType<typeof diagnose>} diagnostic */
function repairPlan(profile, paths, diagnostic) {
  if (diagnostic.recovery === null) throw new OperationsError('repair-not-required', 'doctor found no interrupted operation', 64)
  if (diagnostic.recovery.action === 'unknown') {
    throw new OperationsError('recovery-ambiguous', 'interrupted operation does not match either reviewed terminal state')
  }
  const stateRead = readState(paths.state, profile)
  const state = /** @type {any} */ (stateRead.value)
  const pending = validatePending(diagnostic.recovery.pending, profile)
  let proposed
  if (diagnostic.recovery.action === 'clear') {
    proposed = {
      current: state.current,
      previous: state.previous,
      last_applied: state.last_applied,
      pending: null,
    }
  } else {
    const target = pending.operation === 'remove' ? null : validateTarget(pending.target)
    proposed = {
      current: target === null ? null : snapshot(readActual(paths), target, paths),
      previous: pending.operation === 'update' || pending.operation === 'rollback' ? state.current : null,
      last_applied: {
        operation: pending.operation,
        plan_digest: pending.plan_digest,
        plan: pending.plan,
        completed_at: '<apply-time>',
        recovered: true,
      },
      pending: null,
    }
  }
  const plan = {
    schema_version: PLAN_SCHEMA,
    operation: 'doctor-repair',
    profile,
    package_name: PACKAGE_NAME,
    action: diagnostic.recovery.action,
    pending_plan_digest: diagnostic.recovery.pending.plan_digest,
    observed_manifest_digest: diagnostic.observed.manifest_digest,
    state_digest: stateRead.digest,
    proposed_state: proposed,
  }
  return { plan, plan_digest: sha256(stableJson(plan)) }
}

/** @param {string} profile @param {ReturnType<typeof pathsFor>} paths @param {ReturnType<typeof repairPlan>} reviewed */
function applyRepair(profile, paths, reviewed) {
  prepareOperationsTree(paths)
  return withOperationLocks(paths, () => {
    reconcileArtifacts(paths)
    const actual = readActual(paths)
    const stateRead = readState(paths.state, profile)
    const state = stateRead.value
    const recovery = recoveryFor(actual, state, paths)
    if (recovery === null || recovery.action === 'unknown') {
      throw new OperationsError('recovery-drift', 'recovery state changed after preview')
    }
    const currentDiagnostic = {
      recovery,
      observed: actual,
    }
    const current = repairPlan(profile, paths, /** @type {any} */ (currentDiagnostic))
    if (current.plan_digest !== reviewed.plan_digest) {
      throw new OperationsError('plan-drift', 'recovery state changed after preview')
    }
    if (recovery.action === 'clear') {
      atomicWriteJson(paths.state, { ...state, pending: null })
    } else {
      const pending = /** @type {any} */ (recovery.pending)
      const recoveredState = /** @type {any} */ (state)
      let installed = null
      let previous = null
      if (pending.operation === 'remove') {
        if (actual.installed_entry) cleanupInstalledEntry(paths)
        const cleaned = readActual(paths)
        if (!actualAbsent(cleaned)) {
          throw new OperationsError('recovery-drift', 'recovered remove did not reach the reviewed absent state')
        }
      } else {
        installed = snapshot(actual, validateTarget(pending.target), paths)
        previous = pending.operation === 'update' || pending.operation === 'rollback'
          ? recoveredState.current
          : null
      }
      atomicWriteJson(paths.state, {
        schema_version: STATE_SCHEMA,
        profile,
        current: installed,
        previous,
        pending: null,
        last_applied: {
          operation: pending.operation,
          plan_digest: pending.plan_digest,
          plan: pending.plan,
          completed_at: new Date().toISOString(),
          recovered: true,
        },
      })
    }
    reconcileArtifacts(paths)
    return { mode: 'applied', plan: reviewed.plan, plan_digest: reviewed.plan_digest }
  })
}

/** @param {unknown} data @param {boolean} [ok] */
function envelope(data, ok = true) {
  return { schema_version: OUTPUT_SCHEMA, ok, data }
}

/** @param {unknown} value @param {'json' | 'text'} format */
function print(value, format) {
  if (format === 'json') process.stdout.write(`${JSON.stringify(value)}\n`)
  else process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`)
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  let format = /** @type {'json' | 'text'} */ ('text')
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
      const agentHookBin = resolveExecutable(process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? 'agent-hook')
      const diagnostic = diagnose(profile, paths, agentHookBin, dshBin)
      if (!parsed.values.repair) {
        print(envelope(diagnostic, diagnostic.status === 'healthy'), format)
        return diagnostic.status === 'healthy' ? 0 : 65
      }
      const planned = repairPlan(profile, paths, diagnostic)
      if (!apply) {
        print(envelope({ mode: 'dry-run', ...planned }), format)
        return 0
      }
      if (expected !== planned.plan_digest) throw new OperationsError('plan-drift', 'recovery plan changed after preview')
      print(envelope(applyRepair(profile, paths, planned)), format)
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
      const target = parsed.values.package === undefined ? null : resolveTarget(parsed.values.package, npmBin, home)
      const actual = readActual(paths)
      const stateRead = readState(paths.state, profile)
      const planned = buildMutationPlan(operation, profile, paths, actual, stateRead, target)
      print(envelope({ mode: 'dry-run', ...planned }), format)
      return 0
    }
    print(envelope(applyMutation(
      operation,
      profile,
      paths,
      /** @type {string} */ (expected),
      parsed.values.package,
      process.env.DSH_RUNTIME_KIT_DSH_BIN ?? 'dsh',
    )), format)
    return 0
  } catch (error) {
    const normalized = error instanceof OperationsError
      ? error
      : /** @type {NodeJS.ErrnoException & {code?: string}} */ (error).code?.startsWith('ERR_PARSE_ARGS')
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
