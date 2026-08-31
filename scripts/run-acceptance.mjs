#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  AcceptanceError,
  buildAcceptanceCliResult,
  buildAcceptanceSummary,
  resolveSourceCandidateAcceptance,
  scenarioFailureDiagnostic,
} from '../src/acceptance/contract.js'
import { cloneAuthenticatedDshSource } from '../src/acceptance/dsh-clone.js'
import { digestDshBuildClosure } from '../src/acceptance/dsh-build.js'
import { extractFreshPackage } from '../src/acceptance/package-staging.js'
import {
  createToolPath,
  discoverPreparedPnpmStore,
} from '../src/acceptance/tool-path.js'
import { validateDshCompatibilityManifest } from '../src/compat/contract.js'
import { manageDshPatch } from '../src/compat/dsh-patch.js'
import {
  inspectSelectedDshCheckout,
  inspectSelectedDshCheckoutIdentity,
} from '../src/compat/git-checkout.js'

const sourceProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_SCHEMA = 'dsh-runtime-kit.acceptance-cli.v1'
const MAX_OUTPUT = 64 * 1024 * 1024
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000
const AUTHORITATIVE_SCENARIO_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_GIT = '/usr/bin/git'
const DEFAULT_TAR = '/usr/bin/tar'
const DEFAULT_SYSTEMD_RUN = '/usr/bin/systemd-run'
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,127}$/u
const MINIMUM_NODE_MAJOR = 24
let activePhase = 'arguments'

/** @param {string} phase */
function enterPhase(phase) {
  activePhase = phase
}

function assertSupportedNodeRuntime() {
  const major = Number(process.versions.node.split('.', 1)[0])
  if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) return
  throw new AcceptanceError(
    'DSH_RUNTIME_KIT_ACCEPTANCE_NODE_UNSUPPORTED',
    'acceptance requires Node.js ' + MINIMUM_NODE_MAJOR
      + '+; activate the pinned .node-version (for example `fnm use`) before running',
    { node_version: process.versions.node },
  )
}

/** @param {unknown} error */
function unexpectedAcceptanceFailure(error) {
  const causeCode = error !== null
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : 'UNCLASSIFIED'
  const causeName = error instanceof Error
    && ['Error', 'RangeError', 'SyntaxError', 'TypeError'].includes(error.name)
    ? error.name
    : 'Error'
  return new AcceptanceError(
    'DSH_RUNTIME_KIT_ACCEPTANCE_INTERNAL_FAILED',
    'acceptance runner failed during ' + activePhase,
    {
      phase: activePhase,
      cause_code: causeCode,
      cause_name: causeName,
    },
  )
}

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        'dsh-source-root': { type: 'string' },
        'agent-hook-bin': { type: 'string' },
        'agent-docs-bin': { type: 'string' },
        'agent-session-bin': { type: 'string' },
        'git-cli-bin': { type: 'string' },
        'review-specialists-bin': { type: 'string' },
        'semantic-commit-bin': { type: 'string' },
        'forge-cli-bin': { type: 'string' },
        'nils-source-commit': { type: 'string' },
        'nils-archive-name': { type: 'string' },
        'nils-archive-sha256': { type: 'string' },
        'pnpm-bin': { type: 'string' },
        'npm-bin': { type: 'string' },
        'git-bin': { type: 'string', default: DEFAULT_GIT },
        'tar-bin': { type: 'string', default: DEFAULT_TAR },
        'systemd-run-bin': { type: 'string', default: DEFAULT_SYSTEMD_RUN },
        'run-id': { type: 'string' },
        'package-tarball': { type: 'string' },
        'package-sha256': { type: 'string' },
        'baseline-package-tarball': { type: 'string' },
        'baseline-package-sha256': { type: 'string' },
        'baseline-nils-bin-dir': { type: 'string' },
        'baseline-nils-source-commit': { type: 'string' },
        output: { type: 'string' },
        'allow-source-nils': { type: 'boolean', default: false },
        'acknowledge-trusted-code': { type: 'boolean', default: false },
      },
    })
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'acceptance arguments are invalid',
    )
  }
  const required = [
    parsed.values['dsh-source-root'],
    parsed.values['agent-hook-bin'],
    parsed.values['agent-docs-bin'],
    parsed.values['agent-session-bin'],
    parsed.values['git-cli-bin'],
    parsed.values['review-specialists-bin'],
    parsed.values['semantic-commit-bin'],
    parsed.values['forge-cli-bin'],
    parsed.values['pnpm-bin'],
    parsed.values['npm-bin'],
    parsed.values['git-bin'],
    parsed.values['tar-bin'],
    parsed.values['systemd-run-bin'],
  ]
  const paths = [
    ...required,
    parsed.values.output,
    parsed.values['package-tarball'],
    parsed.values['baseline-package-tarball'],
    parsed.values['baseline-nils-bin-dir'],
  ].filter(value => value !== undefined)
  const hasPackageTarball = parsed.values['package-tarball'] !== undefined
  const hasPackageSha256 = parsed.values['package-sha256'] !== undefined
  const baselineValues = [
    parsed.values['baseline-package-tarball'],
    parsed.values['baseline-package-sha256'],
    parsed.values['baseline-nils-bin-dir'],
    parsed.values['baseline-nils-source-commit'],
  ]
  const hasAnyBaseline = baselineValues.some(value => value !== undefined)
  const hasCompleteBaseline = baselineValues.every(value => value !== undefined)
  const nilsSourceCommit = parsed.values['nils-source-commit']
  const nilsArchiveName = parsed.values['nils-archive-name']
  const nilsArchiveSha256 = parsed.values['nils-archive-sha256']
  if (required.some(value => typeof value !== 'string')
    || paths.some(value => typeof value !== 'string' || !isAbsolute(value))
    || (parsed.values['run-id'] !== undefined
      && !RUN_ID.test(parsed.values['run-id']))
    || hasPackageTarball !== hasPackageSha256
    || hasAnyBaseline !== hasCompleteBaseline
    || typeof nilsSourceCommit !== 'string'
    || !/^[0-9a-f]{40,64}$/u.test(nilsSourceCommit)
    || typeof nilsArchiveName !== 'string'
    || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u.test(nilsArchiveName)
    || typeof nilsArchiveSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(nilsArchiveSha256)
    || (hasPackageSha256
      && !/^[0-9a-f]{64}$/u.test(parsed.values['package-sha256']))
    || (hasCompleteBaseline
      && (!/^[0-9a-f]{64}$/u.test(parsed.values['baseline-package-sha256'])
        || !/^[0-9a-f]{40,64}$/u.test(parsed.values['baseline-nils-source-commit'])))) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'acceptance executable and source paths must be absolute',
    )
  }
  return Object.freeze({
    dshSourceRoot: resolve(required[0]),
    agentHookBin: resolve(required[1]),
    agentDocsBin: resolve(required[2]),
    agentSessionBin: resolve(required[3]),
    gitCliBin: resolve(required[4]),
    reviewSpecialistsBin: resolve(required[5]),
    semanticCommitBin: resolve(required[6]),
    forgeCliBin: resolve(required[7]),
    nilsSourceCommit,
    nilsArchiveName,
    nilsArchiveSha256,
    pnpmBin: resolve(required[8]),
    npmBin: resolve(required[9]),
    gitBin: resolve(required[10]),
    tarBin: resolve(required[11]),
    systemdRunBin: resolve(required[12]),
    runId: parsed.values['run-id'],
    packageTarball: parsed.values['package-tarball'],
    packageSha256: parsed.values['package-sha256'],
    baselinePackageTarball: parsed.values['baseline-package-tarball'],
    baselinePackageSha256: parsed.values['baseline-package-sha256'],
    baselineNilsBinDir: parsed.values['baseline-nils-bin-dir'],
    baselineNilsSourceCommit: parsed.values['baseline-nils-source-commit'],
    output: parsed.values.output,
    allowSourceNils: parsed.values['allow-source-nils'] === true,
    acknowledgeTrustedCode: parsed.values['acknowledge-trusted-code'] === true,
  })
}

/** @param {string} path */
async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** @param {string} path @param {string} label */
async function trustedExecutable(path, label) {
  let canonical
  let info
  try {
    canonical = await realpath(path)
    info = await stat(canonical)
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      label + ' is unavailable',
    )
  }
  const trustedOwner = typeof process.getuid !== 'function'
    || info.uid === 0
    || info.uid === process.getuid()
  if (!info.isFile()
    || !trustedOwner
    || (info.mode & 0o022) !== 0
    || (info.mode & 0o111) === 0) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      label + ' is not a trusted executable',
    )
  }
  return Object.freeze({
    path: canonical,
    sha256: await digest(canonical),
  })
}

/** @param {string} path @param {string} label */
async function trustedRegularFile(path, label) {
  let canonical
  let info
  try {
    canonical = await realpath(path)
    info = await stat(canonical)
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      label + ' is unavailable',
    )
  }
  const trustedOwner = typeof process.getuid !== 'function'
    || info.uid === 0
    || info.uid === process.getuid()
  if (!info.isFile() || !trustedOwner || (info.mode & 0o022) !== 0) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      label + ' is not a trusted regular file',
    )
  }
  return Object.freeze({
    path: canonical,
    sha256: await digest(canonical),
  })
}

/** @param {string} path */
async function trustedNilsBinDirectory(path) {
  let canonical
  let info
  try {
    canonical = await realpath(path)
    info = await stat(canonical)
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'baseline nils binary directory is unavailable',
    )
  }
  const trustedOwner = typeof process.getuid !== 'function'
    || info.uid === 0
    || info.uid === process.getuid()
  if (!info.isDirectory() || !trustedOwner || (info.mode & 0o022) !== 0) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'baseline nils binary directory is not trusted',
    )
  }
  return Object.freeze(Object.fromEntries(await Promise.all([
    'agent-hook',
    'agent-docs',
    'forge-cli',
    'git-cli',
    'review-specialists',
    'semantic-commit',
  ].map(async name => [name, await trustedExecutable(resolve(canonical, name), `baseline ${name}`)]))))
}

/** @param {string} path @param {string} label */
async function jsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      label + ' is not one JSON document',
    )
  }
}

/** @param {string} output @param {string} label */
function receiptFromOutput(output, label) {
  const candidates = output.split('\n').map(line => line.trim()).filter(Boolean).reverse()
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && parsed.ok === true) return parsed
    } catch {
      // Progress from an invoked CLI is not an acceptance receipt.
    }
  }
  throw new AcceptanceError(
    'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
    label + ' emitted no successful scenario receipt',
  )
}

/**
 * @param {{path:string,sha256:string}} binary
 * @param {string} expectedName
 * @param {Record<string,string>} env
 */
function nilsIdentity(binary, expectedName, env) {
  const result = spawnSync(binary.path, ['--version'], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  const match = result.stdout?.trim().match(
    new RegExp('^' + expectedName + ' (\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?) \\(([^,()]+)'),
  )
  if (result.status !== 0 || match === null) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_NILS_IDENTITY_INVALID',
      expectedName + ' did not return its exact build identity',
    )
  }
  return Object.freeze({
    version: match[1],
    source_revision: match[2],
    sha256: binary.sha256,
  })
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string,env?:Record<string,string>,timeout?:number,label:string,failureDetails?:(result:any)=>Record<string,unknown>}} options
 */
function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? SCENARIO_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  })
  if (result.status !== 0 || result.error !== undefined) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      options.label + ' failed',
      options.failureDetails?.(result) ?? {},
    )
  }
  return result
}

/** @param {string} root @param {{path:string,sha256:string}} source @param {string} name */
async function snapshotBinary(root, source, name) {
  const destination = resolve(root, 'bin', name)
  await copyFile(source.path, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o500)
  const copied = await trustedExecutable(destination, name + ' snapshot')
  if (copied.sha256 !== source.sha256) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_NILS_IDENTITY_INVALID',
      name + ' changed while it was snapshotted',
    )
  }
  return copied
}

/**
 * @param {string} root
 * @param {string} sourceRoot
 * @param {string} revision
 * @param {Record<string,{path:string,sha256:string}>} tools
 * @param {Record<string,string>} env
 * @param {(sourceRoot:string)=>Promise<void>} authenticateSource
 */
async function prepareDsh(root, sourceRoot, revision, tools, env, authenticateSource) {
  const destination = resolve(root, 'dsh')
  await cloneAuthenticatedDshSource({
    sourceRoot,
    destination,
    revision,
    gitBin: tools.git.path,
    env,
    authenticateSource,
    timeout: SCENARIO_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
  })
  const canonicalStore = await discoverPreparedPnpmStore({
    cwd: destination,
    env,
    home: process.env.HOME ?? env.HOME,
    pnpmBin: tools.pnpm.path,
    maxBuffer: MAX_OUTPUT,
    timeout: SCENARIO_TIMEOUT_MS,
  })
  env.NPM_CONFIG_STORE_DIR = canonicalStore
  env.npm_config_store_dir = canonicalStore
  runChecked(tools.pnpm.path, [
    'install',
    '--offline',
    '--frozen-lockfile',
    '--trust-lockfile',
    '--ignore-scripts',
    '--store-dir', canonicalStore,
  ], {
    cwd: destination,
    env,
    timeout: SCENARIO_TIMEOUT_MS,
    label: 'fresh pinned DSH dependency installation',
  })
  runChecked(tools.pnpm.path, ['run', 'build:lib:host'], {
    cwd: destination,
    env,
    timeout: SCENARIO_TIMEOUT_MS,
    label: 'fresh pinned DSH host build',
  })
  return destination
}

/**
 * @param {string} root
 * @param {Record<string,{path:string,sha256:string}>} tools
 * @param {Record<string,string>} env
 */
async function preparePackageArtifact(root, tools, env) {
  const packed = runChecked(tools.npm.path, [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination', root,
  ], {
    cwd: sourceProjectRoot,
    env,
    label: 'runtime-kit acceptance package snapshot',
  })
  const rows = JSON.parse(packed.stdout)
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].filename !== 'string') {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
      'npm pack did not return one package artifact',
    )
  }
  const tarball = resolve(root, rows[0].filename)
  return Object.freeze({
    tarball,
    packageLock: await readFile(resolve(sourceProjectRoot, 'package-lock.json')),
  })
}

/** @param {{path:string,sha256:string}} tarball */
async function providedPackageArtifact(tarball) {
  return Object.freeze({
    tarball: tarball.path,
    packageLock: await readFile(resolve(sourceProjectRoot, 'package-lock.json')),
  })
}

/**
 * @param {string} root
 * @param {{tarball:string,packageLock:Buffer}} artifact
 * @param {string} tarballSha256
 * @param {Record<string,{path:string,sha256:string}>} tools
 * @param {Record<string,string>} env
 */
async function prepareOperationsLeg(root, artifact, tarballSha256, tools, env) {
  const legRoot = resolve(root, 'operations-leg')
  await mkdir(legRoot, { mode: 0o700 })
  const project = await extractFreshPackage({
    tarball: artifact.tarball,
    tarballSha256,
    destination: resolve(legRoot, 'package'),
    tarBin: tools.tar.path,
    env,
    label: 'operations leg',
  })
  const operationPackages = {}
  for (const [key, version] of [
    ['v1', '0.0.0-acceptance.1'],
    ['v2', '0.0.0-acceptance.2'],
  ]) {
    const destination = resolve(legRoot, 'operation-package-' + key)
    await cp(project, destination, { recursive: true, force: false, errorOnExist: true })
    const manifestPath = resolve(destination, 'package.json')
    const manifest = await jsonFile(manifestPath, 'runtime-kit package manifest')
    if (manifest.name !== '@sympoies/dsh-runtime-kit') {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        'runtime-kit package identity is invalid',
      )
    }
    manifest.version = version
    await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    operationPackages[key] = destination
  }
  await installPackageDependencies(
    project,
    artifact.packageLock,
    tools.npm,
    env,
    'operations acceptance dependency installation',
  )
  return Object.freeze({
    project,
    operationPackages: Object.freeze(operationPackages),
  })
}

/**
 * @param {string} project
 * @param {Buffer} packageLock
 * @param {{path:string,sha256:string}} npm
 * @param {Record<string,string>} env
 * @param {string} label
 */
async function installPackageDependencies(project, packageLock, npm, env, label) {
  await writeFile(resolve(project, 'package-lock.json'), packageLock, {
    mode: 0o600,
    flag: 'wx',
  })
  const npmCache = resolve(process.env.HOME ?? '/', '.npm')
  runChecked(npm.path, [
    'ci',
    '--ignore-scripts',
    '--omit=dev',
    '--omit=peer',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
    '--cache', npmCache,
  ], {
    cwd: project,
    env: { ...env, NPM_CONFIG_OFFLINE: 'false' },
    label,
  })
}

/**
 * @param {string} root
 * @param {{tarball:string,packageLock:Buffer}} artifact
 * @param {string} tarballSha256
 * @param {Record<string,{path:string,sha256:string}>} tools
 * @param {Record<string,string>} env
 */
async function prepareRuntimeLeg(root, artifact, tarballSha256, tools, env) {
  const legRoot = resolve(root, 'runtime-leg')
  await mkdir(legRoot, { mode: 0o700 })
  const project = await extractFreshPackage({
    tarball: artifact.tarball,
    tarballSha256,
    destination: resolve(legRoot, 'package'),
    tarBin: tools.tar.path,
    env,
    label: 'runtime leg',
  })
  await installPackageDependencies(
    project,
    artifact.packageLock,
    tools.npm,
    env,
    'runtime-kit acceptance dependency installation',
  )
  return project
}

/**
 * @param {string} script
 * @param {Record<string,string>} env
 * @param {string} label
 * @param {{path:string,sha256:string}} systemdRun
 * @param {{timeout?:number}} [options]
 */
async function runScenario(script, env, label, systemdRun, options = {}) {
  const before = await digest(script)
  const unit = 'dsh-runtime-kit-acceptance-' + randomUUID()
  const timeout = options.timeout ?? SCENARIO_TIMEOUT_MS
  const scenarioEnvironment = Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name + '=' + value)
  const managerEnvironment = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
    if (typeof env[name] === 'string') managerEnvironment[name] = env[name]
  }
  const result = runChecked(systemdRun.path, [
    '--user',
    '--quiet',
    '--wait',
    '--pipe',
    '--collect',
    '--service-type=exec',
    '--unit=' + unit,
    '--property=KillMode=control-group',
    '--property=TimeoutStopSec=5s',
    '--property=RuntimeMaxSec=' + Math.ceil(timeout / 1000) + 's',
    '--property=UMask=0022',
    '--working-directory=' + dirname(dirname(script)),
    '/usr/bin/env',
    '-i',
    ...scenarioEnvironment,
    process.execPath,
    script,
  ], {
    env: managerEnvironment,
    timeout: timeout + 30_000,
    label,
    failureDetails: result => scenarioFailureDiagnostic(
      String(result.stdout ?? '') + '\n' + String(result.stderr ?? ''),
    ),
  })
  const after = await digest(script)
  if (before !== after) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
      label + ' changed its control program',
    )
  }
  return receiptFromOutput(result.stdout, label)
}

async function main() {
  assertSupportedNodeRuntime()
  const input = parseCli()
  if (input.acknowledgeTrustedCode !== true) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_TRUST_REQUIRED',
      'local rehearsal executes trusted candidate code with user systemd access; acknowledge explicitly',
    )
  }
  process.stderr.write(
    'warning: source rehearsal is for trusted candidate code and is not an OS isolation boundary\n',
  )
  enterPhase('workspace')
  const runRoot = await mkdtemp(resolve(tmpdir(), 'dsh-runtime-kit-acceptance-'))
  await chmod(runRoot, 0o700)
  try {
    await mkdir(resolve(runRoot, 'bin'), { mode: 0o700 })
    enterPhase('tool-authentication')
    const [
      git,
      tar,
      pnpm,
      npm,
      hookSource,
      docsSource,
      sessionSource,
      gitCliSource,
      reviewSpecialistsSource,
      semanticCommitSource,
      forgeCliSource,
      systemdRun,
    ] = await Promise.all([
      trustedExecutable(input.gitBin, 'git'),
      trustedExecutable(input.tarBin, 'tar'),
      trustedExecutable(input.pnpmBin, 'pnpm'),
      trustedExecutable(input.npmBin, 'npm'),
      trustedExecutable(input.agentHookBin, 'agent-hook'),
      trustedExecutable(input.agentDocsBin, 'agent-docs'),
      trustedExecutable(input.agentSessionBin, 'agent-session'),
      trustedExecutable(input.gitCliBin, 'git-cli'),
      trustedExecutable(input.reviewSpecialistsBin, 'review-specialists'),
      trustedExecutable(input.semanticCommitBin, 'semantic-commit'),
      trustedExecutable(input.forgeCliBin, 'forge-cli'),
      trustedExecutable(input.systemdRunBin, 'systemd-run'),
    ])
    if (input.baselinePackageTarball === undefined
      || input.baselinePackageSha256 === undefined
      || input.baselineNilsBinDir === undefined
      || input.baselineNilsSourceCommit === undefined) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
        'the exact rollback baseline package and nils binary set are required',
      )
    }
    const [baselinePackage, baselineSources] = await Promise.all([
      trustedRegularFile(input.baselinePackageTarball, 'baseline runtime-kit package tarball'),
      trustedNilsBinDirectory(input.baselineNilsBinDir),
    ])
    if (baselinePackage.sha256 !== input.baselinePackageSha256) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        'baseline runtime-kit package tarball digest does not match its binding',
      )
    }
    const tools = Object.freeze({ git, tar, pnpm, npm })
    enterPhase('workspace')
    const toolPath = await createToolPath(runRoot, tools)
    const home = resolve(runRoot, 'home')
    const config = resolve(runRoot, 'config')
    const state = resolve(runRoot, 'state')
    const cache = resolve(runRoot, 'cache')
    const gitConfig = resolve(runRoot, 'gitconfig')
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(config, { mode: 0o700 }),
      mkdir(state, { mode: 0o700 }),
      mkdir(cache, { mode: 0o700 }),
      writeFile(gitConfig, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
    ])
    const env = {
      CI: 'true',
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      PATH: toolPath + ':/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      NPM_CONFIG_OFFLINE: 'true',
      npm_config_ignore_scripts: 'true',
      PNPM_OFFLINE: 'true',
      DSH_TELEMETRY_DISABLED: '1',
    }
    for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
      if (typeof process.env[name] === 'string') env[name] = process.env[name]
    }

    enterPhase('dsh-compatibility')
    const dshManifestPath = resolve(sourceProjectRoot, 'compatibility', 'dsh.json')
    const dshManifest = validateDshCompatibilityManifest(
      await jsonFile(dshManifestPath, 'DSH compatibility manifest'),
    )
    const selected = dshManifest.channels.pinned
    const dshSourceRoot = await prepareDsh(
      runRoot,
      input.dshSourceRoot,
      selected.revision,
      tools,
      env,
      async authenticatedDshSourceRoot => {
        await inspectSelectedDshCheckoutIdentity({
          sourceRoot: authenticatedDshSourceRoot,
          channel: 'pinned',
          gitBin: git.path,
          manifest: dshManifest,
        })
        enterPhase('dsh-preparation')
      },
    )
    const dshReport = await inspectSelectedDshCheckout({
      sourceRoot: dshSourceRoot,
      channel: 'pinned',
      gitBin: git.path,
      manifest: dshManifest,
    })
    const dshPatchManifest = await jsonFile(
      resolve(sourceProjectRoot, 'compatibility', 'dsh-patches.json'),
      'DSH patch manifest',
    )
    const dshPatch = await manageDshPatch({
      action: 'apply',
      sourceRoot: dshSourceRoot,
      patchRoot: sourceProjectRoot,
      manifest: dshPatchManifest,
      gitBin: git.path,
    })
    runChecked(tools.pnpm.path, [
      'exec',
      'vitest',
      'run',
      'packages/goal/goal/tests/goal.spec.ts',
    ], {
      cwd: dshSourceRoot,
      env,
      timeout: SCENARIO_TIMEOUT_MS,
      label: 'patched DSH GoalService boundary tests',
    })
    runChecked(tools.pnpm.path, ['run', 'build:lib:host'], {
      cwd: dshSourceRoot,
      env,
      timeout: SCENARIO_TIMEOUT_MS,
      label: 'patched DSH host build',
    })
    const patchedDshBuild = await digestDshBuildClosure(dshSourceRoot)
    enterPhase('package-preparation')
    const suppliedPackage = input.packageTarball === undefined
      ? undefined
      : await trustedRegularFile(input.packageTarball, 'runtime-kit package tarball')
    if (suppliedPackage !== undefined && suppliedPackage.sha256 !== input.packageSha256) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        'runtime-kit package tarball digest does not match the trusted caller binding',
      )
    }
    const artifact = suppliedPackage === undefined
      ? await preparePackageArtifact(runRoot, tools, env)
      : await providedPackageArtifact(suppliedPackage)
    const packageSha256 = await digest(artifact.tarball)
    enterPhase('operations-preparation')
    const operationsLeg = await prepareOperationsLeg(
      runRoot,
      artifact,
      packageSha256,
      tools,
      env,
    )
    enterPhase('tool-snapshot')
    const [
      agentHook,
      agentDocs,
      agentSession,
      gitCli,
      reviewSpecialists,
      semanticCommit,
      forgeCli,
    ] = await Promise.all([
      snapshotBinary(runRoot, hookSource, 'agent-hook'),
      snapshotBinary(runRoot, docsSource, 'agent-docs'),
      snapshotBinary(runRoot, sessionSource, 'agent-session'),
      snapshotBinary(runRoot, gitCliSource, 'git-cli'),
      snapshotBinary(runRoot, reviewSpecialistsSource, 'review-specialists'),
      snapshotBinary(runRoot, semanticCommitSource, 'semantic-commit'),
      snapshotBinary(runRoot, forgeCliSource, 'forge-cli'),
    ])
    const baselineRoot = resolve(runRoot, 'baseline')
    await mkdir(resolve(baselineRoot, 'bin'), { recursive: true, mode: 0o700 })
    const baselineBinaries = Object.freeze(Object.fromEntries(await Promise.all(
      Object.entries(baselineSources).map(async ([name, source]) => [
        name,
        await snapshotBinary(baselineRoot, source, name),
      ]),
    )))
    const scenarioBaseEnv = {
      ...env,
      PATH: resolve(runRoot, 'bin') + ':' + env.PATH,
      DSH_SOURCE_ROOT: dshSourceRoot,
      AGENT_HOOK_BIN: agentHook.path,
      AGENT_DOCS_BIN: agentDocs.path,
    }
    enterPhase('tool-identity')
    const hookIdentity = nilsIdentity(agentHook, 'agent-hook', scenarioBaseEnv)
    const docsIdentity = nilsIdentity(agentDocs, 'agent-docs', scenarioBaseEnv)
    const sessionIdentity = nilsIdentity(agentSession, 'agent-session', scenarioBaseEnv)
    const gitCliIdentity = nilsIdentity(gitCli, 'git-cli', scenarioBaseEnv)
    const reviewIdentity = nilsIdentity(reviewSpecialists, 'review-specialists', scenarioBaseEnv)
    const semanticCommitIdentity = nilsIdentity(semanticCommit, 'semantic-commit', scenarioBaseEnv)
    const forgeCliIdentity = nilsIdentity(forgeCli, 'forge-cli', scenarioBaseEnv)
    const nilsIdentities = [
      hookIdentity,
      docsIdentity,
      sessionIdentity,
      gitCliIdentity,
      reviewIdentity,
      semanticCommitIdentity,
      forgeCliIdentity,
    ]
    if (nilsIdentities.some(identity => identity.version !== hookIdentity.version
      || identity.source_revision !== hookIdentity.source_revision)) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_NILS_IDENTITY_INVALID',
        'nils acceptance binaries do not have the same build identity',
      )
    }
    const baselineEnvironment = {
      ...scenarioBaseEnv,
      PATH: resolve(baselineRoot, 'bin') + ':' + env.PATH,
    }
    const baselineIdentities = Object.freeze(Object.fromEntries(Object.entries(
      baselineBinaries,
    ).map(([name, binary]) => [name, nilsIdentity(binary, name, baselineEnvironment)])))
    const baselineIdentityRows = Object.values(baselineIdentities)
    const baselineHookIdentity = baselineIdentities['agent-hook']
    if (baselineIdentityRows.some(identity => identity.version !== baselineHookIdentity.version
      || identity.source_revision !== baselineHookIdentity.source_revision)) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_NILS_IDENTITY_INVALID',
        'baseline nils acceptance binaries do not have the same build identity',
      )
    }
    const compatibility = await jsonFile(
      resolve(operationsLeg.project, 'compatibility', 'nils-cli.json'),
      'nils compatibility manifest',
    )
    if (compatibility.status !== 'released' && input.allowSourceNils !== true) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RELEASE_REQUIRED',
        'final acceptance requires exact validated nils release artifacts',
      )
    }
    const rollbackValidation = compatibility.rollback_validation
    const rollbackArtifacts = rollbackValidation?.artifacts
    const baselineArtifactNames = Object.keys(baselineIdentities).sort()
    const rollbackArtifactNames = rollbackArtifacts !== null
      && typeof rollbackArtifacts === 'object'
      ? Object.keys(rollbackArtifacts).sort()
      : []
    if (rollbackValidation === null || typeof rollbackValidation !== 'object'
      || rollbackValidation.runtime_package_sha256 !== baselinePackage.sha256
      || rollbackValidation.version !== baselineHookIdentity.version
      || rollbackValidation.source_revision !== baselineHookIdentity.source_revision
      || rollbackValidation.source_commit !== input.baselineNilsSourceCommit
      || rollbackValidation.platform !== 'x86_64-unknown-linux-gnu'
      || typeof rollbackValidation.archive?.name !== 'string'
      || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,255}$/u.test(rollbackValidation.archive.name)
      || typeof rollbackValidation.archive?.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(rollbackValidation.archive.sha256)
      || JSON.stringify(rollbackArtifactNames) !== JSON.stringify(baselineArtifactNames)
      || baselineArtifactNames.some(name => (
        rollbackArtifacts[name]?.sha256 !== baselineIdentities[name].sha256
      ))) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_NILS_IDENTITY_INVALID',
        'rollback baseline does not match the exact compatibility manifest',
      )
    }
    const nilsEvidence = {
      version: hookIdentity.version,
      source_revision: hookIdentity.source_revision,
      source_commit: input.nilsSourceCommit,
      archive: {
        name: input.nilsArchiveName,
        sha256: input.nilsArchiveSha256,
      },
      artifacts: {
        'agent-hook': { sha256: hookIdentity.sha256 },
        'agent-docs': { sha256: docsIdentity.sha256 },
        'agent-session': { sha256: sessionIdentity.sha256 },
        'git-cli': { sha256: gitCliIdentity.sha256 },
        'review-specialists': { sha256: reviewIdentity.sha256 },
        'semantic-commit': { sha256: semanticCommitIdentity.sha256 },
        'forge-cli': { sha256: forgeCliIdentity.sha256 },
      },
    }
    const sourceCandidate = input.allowSourceNils
      ? resolveSourceCandidateAcceptance(compatibility, nilsEvidence)
      : undefined
    const scenarioEnv = {
      ...scenarioBaseEnv,
      ...sourceCandidate === undefined ? {} : {
        DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: sourceCandidate.feature,
      },
    }

    const operationsScript = resolve(operationsLeg.project, 'test', 'operations-smoke.mjs')
    const controlDigests = new Map([
      [artifact.tarball, packageSha256],
      [baselinePackage.path, baselinePackage.sha256],
      ...[
        agentHook,
        agentDocs,
        agentSession,
        gitCli,
        reviewSpecialists,
        semanticCommit,
        forgeCli,
        git,
        tar,
        pnpm,
        npm,
        systemdRun,
      ].map(item => [item.path, item.sha256]),
      ...Object.values(baselineBinaries).map(item => [item.path, item.sha256]),
    ])
    async function verifyControlPlane() {
      for (const [path, expected] of controlDigests) {
        if (await digest(path) !== expected) {
          throw new AcceptanceError(
            'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
            'acceptance control plane changed during candidate execution',
          )
        }
      }
      const currentDshBuild = await digestDshBuildClosure(dshSourceRoot)
      if (currentDshBuild.sha256 !== patchedDshBuild.sha256
        || currentDshBuild.file_count !== patchedDshBuild.file_count
        || currentDshBuild.byte_count !== patchedDshBuild.byte_count) {
        throw new AcceptanceError(
          'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
          'patched DSH build closure changed during candidate execution',
        )
      }
      const patchState = await manageDshPatch({
        action: 'check',
        sourceRoot: dshSourceRoot,
        patchRoot: sourceProjectRoot,
        manifest: dshPatchManifest,
        gitBin: git.path,
      })
      if (patchState.after !== 'patched'
        || patchState.patch_id !== dshPatch.patch_id
        || patchState.version !== dshPatch.version
        || patchState.revision !== dshPatch.revision) {
        throw new AcceptanceError(
          'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
          'DSH patch identity changed during acceptance',
        )
      }
      return patchState
    }
    enterPhase('operations-scenario')
    await verifyControlPlane()
    const operations = await runScenario(
      operationsScript,
      {
        ...scenarioEnv,
        DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1: operationsLeg.operationPackages.v1,
        DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2: operationsLeg.operationPackages.v2,
      },
      'operations scenario',
      systemdRun,
    )
    await verifyControlPlane()
    enterPhase('runtime-preparation')
    const runtimeProject = await prepareRuntimeLeg(
      runRoot,
      artifact,
      packageSha256,
      tools,
      env,
    )
    const runtimeScript = resolve(runtimeProject, 'test', 'smoke.mjs')
    enterPhase('packed-runtime-scenario')
    const packedRuntime = await runScenario(
      runtimeScript,
      scenarioEnv,
      'packed runtime scenario',
      systemdRun,
    )
    const authoritativeScript = resolve(
      runtimeProject,
      'test',
      'authoritative-acceptance-smoke.mjs',
    )
    const authoritativeEnv = {
      ...scenarioEnv,
      PNPM_BIN: pnpm.path,
      NPM_BIN: npm.path,
      DSH_ACCEPTANCE_CANDIDATE_PACKAGE_TARBALL: artifact.tarball,
      DSH_ACCEPTANCE_CANDIDATE_PACKAGE_SHA256: packageSha256,
      DSH_ACCEPTANCE_BASELINE_PACKAGE_TARBALL: baselinePackage.path,
      DSH_ACCEPTANCE_BASELINE_PACKAGE_SHA256: baselinePackage.sha256,
      DSH_ACCEPTANCE_BASELINE_NILS_BIN_DIR: resolve(baselineRoot, 'bin'),
      DSH_ACCEPTANCE_BASELINE_NILS_SOURCE_COMMIT: input.baselineNilsSourceCommit,
      DSH_ACCEPTANCE_CANDIDATE_NILS_SOURCE_COMMIT: input.nilsSourceCommit,
      DSH_ACCEPTANCE_CANDIDATE_NILS_ARTIFACTS: JSON.stringify(Object.fromEntries(
        Object.entries(nilsEvidence.artifacts).map(([name, value]) => [name, value.sha256]),
      )),
      DSH_ACCEPTANCE_BASELINE_NILS_ARTIFACTS: JSON.stringify(Object.fromEntries(
        Object.entries(baselineIdentities).map(([name, value]) => [name, value.sha256]),
      )),
      DSH_ACCEPTANCE_DSH_VERSION: selected.version,
      DSH_ACCEPTANCE_DSH_REVISION: selected.revision,
    }
    enterPhase('authoritative-acceptance-scenario')
    const authoritative = await runScenario(
      authoritativeScript,
      authoritativeEnv,
      'authoritative acceptance packed process matrix',
      systemdRun,
      { timeout: AUTHORITATIVE_SCENARIO_TIMEOUT_MS },
    )
    if (authoritative.schema_version
        !== 'dsh-runtime-kit.authoritative-acceptance-smoke.v1'
      || authoritative.matrix === undefined) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        'authoritative acceptance scenario receipt is invalid',
      )
    }
    enterPhase('patched-final-verification')
    const finalDshPatch = await verifyControlPlane()
    const reverseDshPatch = await manageDshPatch({
      action: 'reverse',
      sourceRoot: dshSourceRoot,
      patchRoot: sourceProjectRoot,
      manifest: dshPatchManifest,
      gitBin: git.path,
    })
    runChecked(tools.pnpm.path, ['run', 'build:lib:host'], {
      cwd: dshSourceRoot,
      env,
      timeout: SCENARIO_TIMEOUT_MS,
      label: 'unpatched DSH host build',
    })
    const pristineDshBuild = await digestDshBuildClosure(dshSourceRoot)
    const pristinePatchState = await manageDshPatch({
      action: 'check',
      sourceRoot: dshSourceRoot,
      patchRoot: sourceProjectRoot,
      manifest: dshPatchManifest,
      gitBin: git.path,
    })
    if (pristinePatchState.after !== 'pristine'
      || pristinePatchState.source_checkout_clean !== true) {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
        'DSH source was not pristine after authenticated reverse and rebuild',
      )
    }
    enterPhase('unpatched-dsh-tools-scenario')
    const unpatched = await runScenario(
      authoritativeScript,
      { ...authoritativeEnv, DSH_ACCEPTANCE_UNPATCHED_ONLY: '1' },
      'unpatched DSH tools scenario',
      systemdRun,
    )
    if (unpatched.schema_version !== 'dsh-runtime-kit.authoritative-unpatched-smoke.v1'
      || unpatched.tool_outcome !== 'succeeded'
      || unpatched.acceptance_mode !== 'absent') {
      throw new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID',
        'unpatched DSH tools receipt is invalid',
      )
    }
    const lifecycle = {
      apply: {
        action: dshPatch.action,
        before: dshPatch.before,
        after: dshPatch.after,
        changed: dshPatch.changed,
        runtime_rebuilt: dshPatch.runtime_rebuilt,
      },
      patched_build: patchedDshBuild,
      reverse: {
        action: reverseDshPatch.action,
        before: reverseDshPatch.before,
        after: reverseDshPatch.after,
        changed: reverseDshPatch.changed,
        runtime_rebuilt: reverseDshPatch.runtime_rebuilt,
      },
      pristine_build: pristineDshBuild,
      unpatched_smoke: {
        process_instance_sha256: unpatched.process_instance_sha256,
        tool_outcome: unpatched.tool_outcome,
        acceptance_mode: unpatched.acceptance_mode,
      },
      final_source_state: pristinePatchState.after,
    }
    const runtime = {
      ...packedRuntime,
      scenarios: [
        ...packedRuntime.scenarios,
        {
          id: 'authoritative-acceptance',
          status: 'passed',
          producer: 'packed-runtime',
          evidence: [
            'acceptance:goal-completion-blocked-pre-mutation',
            'acceptance:exact-provider-verdict-satisfied',
            'acceptance:goal-completion-allowed-post-evidence',
            'acceptance:negative-goal-blocked-without-mutation',
            'acceptance:positive-exact-evidence-completed',
            'acceptance:concurrent-mutation-denied-before-body',
            'acceptance:active-contained-cancellation-terminalized',
            'acceptance:restart-retained-evidence-without-revalidation',
            'acceptance:recovery-revalidated-after-infrastructure-block',
            'acceptance:upgrade-rejected-baseline-stale-evidence',
            'acceptance:rollback-baseline-stop-blocked-and-revalidated',
            'acceptance:rollback-pristine-rebuild-unpatched-tools-smoke',
          ],
          matrix: { ...authoritative.matrix, dsh_lifecycle: lifecycle },
        },
      ],
    }
    enterPhase('final-verification')
    for (const [name, original, copy] of [
      ['agent-hook', hookSource, agentHook],
      ['agent-docs', docsSource, agentDocs],
      ['agent-session', sessionSource, agentSession],
      ['git-cli', gitCliSource, gitCli],
      ['review-specialists', reviewSpecialistsSource, reviewSpecialists],
      ['semantic-commit', semanticCommitSource, semanticCommit],
      ['forge-cli', forgeCliSource, forgeCli],
      ['git', git, git],
      ['tar', tar, tar],
      ['pnpm', pnpm, pnpm],
      ['npm', npm, npm],
      ['systemd-run', systemdRun, systemdRun],
    ]) {
      if (await digest(original.path) !== original.sha256
        || await digest(copy.path) !== copy.sha256) {
        throw new AcceptanceError(
          'DSH_RUNTIME_KIT_ACCEPTANCE_SCENARIO_FAILED',
          name + ' changed during acceptance',
        )
      }
    }
    const head = runChecked(git.path, [
      '-c', 'safe.directory=' + sourceProjectRoot,
      '-C', sourceProjectRoot,
      'rev-parse', 'HEAD',
    ], {
      env,
      label: 'runtime-kit head inspection',
    }).stdout.trim()
    const runId = input.runId ?? 'acceptance-' + randomUUID()
    const summary = buildAcceptanceSummary({
      runtime,
      operations,
      dsh: { ...dshReport, patch: finalDshPatch },
      expected_dsh: {
        repository: dshManifest.repository,
        channel: 'pinned',
        revision: selected.revision,
        version: selected.version,
      },
      compatibility,
      nils: nilsEvidence,
      package_sha256: packageSha256,
      environment: {
        mode: 'local-source-rehearsal',
        isolated: false,
      },
      run_id: runId,
      expected_delivery: {
        repository: 'https://github.com/sympoies/dsh-runtime-kit',
        head_sha: head,
        package_sha256: packageSha256,
      },
      allow_source_nils: input.allowSourceNils,
    })
    const result = buildAcceptanceCliResult(summary)
    const serialized = JSON.stringify(result.envelope) + '\n'
    if (input.output !== undefined) {
      await writeFile(input.output, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    }
    process.stdout.write(serialized)
    process.exitCode = result.exit_code
  } finally {
    const completedPhase = activePhase
    enterPhase('cleanup')
    try {
      await rm(runRoot, { recursive: true, force: true })
    } catch (error) {
      enterPhase('cleanup')
      throw error
    }
    enterPhase(completedPhase)
  }
}

try {
  await main()
} catch (error) {
  const failure = error instanceof AcceptanceError
    ? error
    : unexpectedAcceptanceFailure(error)
  process.stdout.write(JSON.stringify({
    schema_version: CLI_SCHEMA,
    ok: false,
    error: failure.diagnostic,
  }) + '\n')
  process.exitCode = 1
}
