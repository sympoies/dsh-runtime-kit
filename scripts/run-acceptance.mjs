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
  symlink,
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
} from '../src/acceptance/contract.js'
import { extractFreshPackage } from '../src/acceptance/package-staging.js'
import { validateDshCompatibilityManifest } from '../src/compat/contract.js'
import { inspectSelectedDshCheckout } from '../src/compat/git-checkout.js'

const sourceProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_SCHEMA = 'dsh-runtime-kit.acceptance-cli.v1'
const MAX_OUTPUT = 64 * 1024 * 1024
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_GIT = '/usr/bin/git'
const DEFAULT_TAR = '/usr/bin/tar'
const DEFAULT_SYSTEMD_RUN = '/usr/bin/systemd-run'
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,127}$/u

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
        'git-cli-bin': { type: 'string' },
        'review-specialists-bin': { type: 'string' },
        'semantic-commit-bin': { type: 'string' },
        'forge-cli-bin': { type: 'string' },
        'pnpm-bin': { type: 'string' },
        'npm-bin': { type: 'string' },
        'git-bin': { type: 'string', default: DEFAULT_GIT },
        'tar-bin': { type: 'string', default: DEFAULT_TAR },
        'systemd-run-bin': { type: 'string', default: DEFAULT_SYSTEMD_RUN },
        'run-id': { type: 'string' },
        'package-tarball': { type: 'string' },
        'package-sha256': { type: 'string' },
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
  ].filter(value => value !== undefined)
  const hasPackageTarball = parsed.values['package-tarball'] !== undefined
  const hasPackageSha256 = parsed.values['package-sha256'] !== undefined
  if (required.some(value => typeof value !== 'string')
    || paths.some(value => typeof value !== 'string' || !isAbsolute(value))
    || (parsed.values['run-id'] !== undefined
      && !RUN_ID.test(parsed.values['run-id']))
    || hasPackageTarball !== hasPackageSha256
    || (hasPackageSha256
      && !/^[0-9a-f]{64}$/u.test(parsed.values['package-sha256']))) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'acceptance executable and source paths must be absolute',
    )
  }
  return Object.freeze({
    dshSourceRoot: resolve(required[0]),
    agentHookBin: resolve(required[1]),
    agentDocsBin: resolve(required[2]),
    gitCliBin: resolve(required[3]),
    reviewSpecialistsBin: resolve(required[4]),
    semanticCommitBin: resolve(required[5]),
    forgeCliBin: resolve(required[6]),
    pnpmBin: resolve(required[7]),
    npmBin: resolve(required[8]),
    gitBin: resolve(required[9]),
    tarBin: resolve(required[10]),
    systemdRunBin: resolve(required[11]),
    runId: parsed.values['run-id'],
    packageTarball: parsed.values['package-tarball'],
    packageSha256: parsed.values['package-sha256'],
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
 * @param {{cwd?:string,env?:Record<string,string>,timeout?:number,label:string}} options
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
    )
  }
  return result
}

/** @param {string} root @param {Record<string,{path:string,sha256:string}>} tools */
async function createToolPath(root, tools) {
  const path = resolve(root, 'tool-path')
  await mkdir(path, { mode: 0o700 })
  const entries = {
    git: tools.git.path,
    npm: tools.npm.path,
    pnpm: tools.pnpm.path,
    tar: tools.tar.path,
    node: process.execPath,
  }
  for (const [name, target] of Object.entries(entries)) {
    await symlink(target, resolve(path, name))
  }
  return path
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
 */
async function prepareDsh(root, sourceRoot, revision, tools, env) {
  const destination = resolve(root, 'dsh')
  runChecked(tools.git.path, [
    '-c', 'safe.directory=' + sourceRoot,
    'clone',
    '--no-hardlinks',
    '--no-checkout',
    sourceRoot,
    destination,
  ], { env, label: 'fresh DSH source clone' })
  runChecked(tools.git.path, ['-C', destination, 'checkout', '--detach', revision], {
    env,
    label: 'pinned DSH source checkout',
  })
  const store = runChecked(tools.pnpm.path, ['store', 'path', '--silent'], {
    env: { ...env, HOME: process.env.HOME ?? env.HOME },
    label: 'pnpm store discovery',
  }).stdout.trim()
  if (!isAbsolute(store)) {
    throw new AcceptanceError(
      'DSH_RUNTIME_KIT_ACCEPTANCE_ARGUMENT_INVALID',
      'pnpm store path is invalid',
    )
  }
  const canonicalStore = await realpath(store)
  env.NPM_CONFIG_STORE_DIR = canonicalStore
  env.npm_config_store_dir = canonicalStore
  runChecked(tools.pnpm.path, [
    'install',
    '--offline',
    '--frozen-lockfile',
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
  return Object.freeze({
    project,
    operationPackages: Object.freeze(operationPackages),
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
  await writeFile(resolve(project, 'package-lock.json'), artifact.packageLock, {
    mode: 0o600,
    flag: 'wx',
  })
  const npmCache = resolve(process.env.HOME ?? '/', '.npm')
  runChecked(tools.npm.path, [
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
    label: 'runtime-kit acceptance dependency installation',
  })
  return project
}

/**
 * @param {string} script
 * @param {Record<string,string>} env
 * @param {string} label
 * @param {{path:string,sha256:string}} systemdRun
 */
async function runScenario(script, env, label, systemdRun) {
  const before = await digest(script)
  const unit = 'dsh-runtime-kit-acceptance-' + randomUUID()
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
    '--property=RuntimeMaxSec=300s',
    '--property=UMask=0022',
    '--working-directory=' + dirname(dirname(script)),
    '/usr/bin/env',
    '-i',
    ...scenarioEnvironment,
    process.execPath,
    script,
  ], {
    env: managerEnvironment,
    timeout: SCENARIO_TIMEOUT_MS + 30_000,
    label,
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
  const runRoot = await mkdtemp(resolve(tmpdir(), 'dsh-runtime-kit-acceptance-'))
  await chmod(runRoot, 0o700)
  try {
    await mkdir(resolve(runRoot, 'bin'), { mode: 0o700 })
    const [
      git,
      tar,
      pnpm,
      npm,
      hookSource,
      docsSource,
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
      trustedExecutable(input.gitCliBin, 'git-cli'),
      trustedExecutable(input.reviewSpecialistsBin, 'review-specialists'),
      trustedExecutable(input.semanticCommitBin, 'semantic-commit'),
      trustedExecutable(input.forgeCliBin, 'forge-cli'),
      trustedExecutable(input.systemdRunBin, 'systemd-run'),
    ])
    const tools = Object.freeze({ git, tar, pnpm, npm })
    const toolPath = await createToolPath(runRoot, tools)
    const home = resolve(runRoot, 'home')
    const config = resolve(runRoot, 'config')
    const state = resolve(runRoot, 'state')
    const cache = resolve(runRoot, 'cache')
    await Promise.all([
      mkdir(home, { mode: 0o700 }),
      mkdir(config, { mode: 0o700 }),
      mkdir(state, { mode: 0o700 }),
      mkdir(cache, { mode: 0o700 }),
    ])
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
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

    const dshManifestPath = resolve(sourceProjectRoot, 'compatibility', 'dsh.json')
    const dshManifest = validateDshCompatibilityManifest(
      await jsonFile(dshManifestPath, 'DSH compatibility manifest'),
    )
    const selected = dshManifest.channels.pinned
    await inspectSelectedDshCheckout({
      sourceRoot: input.dshSourceRoot,
      channel: 'pinned',
      gitBin: git.path,
      manifest: dshManifest,
    })
    const dshSourceRoot = await prepareDsh(
      runRoot,
      input.dshSourceRoot,
      selected.revision,
      tools,
      env,
    )
    const dshReport = await inspectSelectedDshCheckout({
      sourceRoot: dshSourceRoot,
      channel: 'pinned',
      gitBin: git.path,
      manifest: dshManifest,
    })
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
    const operationsLeg = await prepareOperationsLeg(
      runRoot,
      artifact,
      packageSha256,
      tools,
      env,
    )
    const [agentHook, agentDocs, gitCli, reviewSpecialists, semanticCommit, forgeCli] = await Promise.all([
      snapshotBinary(runRoot, hookSource, 'agent-hook'),
      snapshotBinary(runRoot, docsSource, 'agent-docs'),
      snapshotBinary(runRoot, gitCliSource, 'git-cli'),
      snapshotBinary(runRoot, reviewSpecialistsSource, 'review-specialists'),
      snapshotBinary(runRoot, semanticCommitSource, 'semantic-commit'),
      snapshotBinary(runRoot, forgeCliSource, 'forge-cli'),
    ])
    const scenarioEnv = {
      ...env,
      PATH: resolve(runRoot, 'bin') + ':' + env.PATH,
      DSH_SOURCE_ROOT: dshSourceRoot,
      AGENT_HOOK_BIN: agentHook.path,
      AGENT_DOCS_BIN: agentDocs.path,
    }
    const hookIdentity = nilsIdentity(agentHook, 'agent-hook', scenarioEnv)
    const docsIdentity = nilsIdentity(agentDocs, 'agent-docs', scenarioEnv)
    const gitCliIdentity = nilsIdentity(gitCli, 'git-cli', scenarioEnv)
    const reviewIdentity = nilsIdentity(reviewSpecialists, 'review-specialists', scenarioEnv)
    const semanticCommitIdentity = nilsIdentity(semanticCommit, 'semantic-commit', scenarioEnv)
    const forgeCliIdentity = nilsIdentity(forgeCli, 'forge-cli', scenarioEnv)
    const nilsIdentities = [
      hookIdentity,
      docsIdentity,
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

    const operationsScript = resolve(operationsLeg.project, 'test', 'operations-smoke.mjs')
    const controlDigests = new Map([
      [artifact.tarball, packageSha256],
      ...[
        agentHook,
        agentDocs,
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
      await inspectSelectedDshCheckout({
        sourceRoot: dshSourceRoot,
        channel: 'pinned',
        gitBin: git.path,
        manifest: dshManifest,
      })
    }
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
    const runtimeProject = await prepareRuntimeLeg(
      runRoot,
      artifact,
      packageSha256,
      tools,
      env,
    )
    const runtimeScript = resolve(runtimeProject, 'test', 'smoke.mjs')
    const runtime = await runScenario(
      runtimeScript,
      scenarioEnv,
      'packed runtime scenario',
      systemdRun,
    )
    await verifyControlPlane()
    for (const [name, original, copy] of [
      ['agent-hook', hookSource, agentHook],
      ['agent-docs', docsSource, agentDocs],
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
      dsh: dshReport,
      expected_dsh: {
        repository: dshManifest.repository,
        channel: 'pinned',
        revision: selected.revision,
        version: selected.version,
      },
      compatibility,
      nils: {
        version: hookIdentity.version,
        source_revision: hookIdentity.source_revision,
        artifacts: {
          'agent-hook': { sha256: hookIdentity.sha256 },
          'agent-docs': { sha256: docsIdentity.sha256 },
          'git-cli': { sha256: gitCliIdentity.sha256 },
          'review-specialists': { sha256: reviewIdentity.sha256 },
          'semantic-commit': { sha256: semanticCommitIdentity.sha256 },
          'forge-cli': { sha256: forgeCliIdentity.sha256 },
        },
      },
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
    await rm(runRoot, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  const failure = error instanceof AcceptanceError
    ? error
    : new AcceptanceError(
        'DSH_RUNTIME_KIT_ACCEPTANCE_FAILED',
        'acceptance runner failed',
      )
  process.stdout.write(JSON.stringify({
    schema_version: CLI_SCHEMA,
    ok: false,
    error: failure.diagnostic,
  }) + '\n')
  process.exitCode = 1
}
