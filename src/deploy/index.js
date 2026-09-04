// @ts-check

/**
 * Repository-owned generic deploy dispatcher.
 *
 * `.agents/scripts/deploy.sh` (the shared `meta:deploy` target) execs this
 * module. It binds an explicit deployment scope — an immutable package
 * artifact, one DSH home and profile, one owner-only runtime root, the DSH
 * executable, and the requested lifecycle phase — and then hands the request to
 * the existing digest-reviewed operations engine through the owner launcher.
 * It never duplicates activation, rollback, package, or health policy: every
 * refusal about the profile, artifact identity, lifecycle declaration, or host
 * comes from the engine and is surfaced unchanged.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import {
  extractPackageArtifact,
  inspectCanonicalPackageArtifact,
  packageArtifactEntries,
} from '../compat/package-artifact.js'

export const OUTPUT_SCHEMA = 'cli.dsh-runtime-kit.deploy.v1'
export const RECEIPT_SCHEMA = 'dsh-runtime-kit.deploy-receipt.v1'
export const PACKAGE_NAME = '@sympoies/dsh-runtime-kit'

const PHASES = Object.freeze(['setup', 'doctor', 'update', 'rollback', 'remove', 'repair'])
const ARTIFACT_PHASES = new Set(['setup', 'update'])
const SCOPES = Object.freeze(['canary', 'primary'])
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const ENGINE_OUTPUT_SCHEMA = 'cli.dsh-runtime-kit.operations.v1'
const MAX_ENGINE_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_CHARS = 2048
const MAX_DETAIL_CHARS = 4096
const MAX_STDERR_TAIL_CHARS = 1024
const ENGINE_TIMEOUT_MS = 30 * 60 * 1000

/** Every typed code this dispatcher can emit; the acceptance contract mirrors it. */
export const DEPLOY_ERROR_CODES = Object.freeze([
  'artifact-digest-mismatch',
  'artifact-invalid',
  'artifact-unreadable',
  'engine-output-invalid',
  'engine-refused',
  'engine-unavailable',
  'expected-plan-digest-required',
  'invalid-agent-docs-bin',
  'invalid-agent-hook-bin',
  'invalid-arguments',
  'invalid-artifact-path',
  'invalid-artifact-sha256',
  'invalid-dsh-bin',
  'invalid-dsh-home',
  'invalid-engine-root',
  'invalid-phase',
  'invalid-profile',
  'invalid-receipt-path',
  'invalid-runtime-root',
  'invalid-scope',
  'invalid-stage-root',
  'missing-artifact',
  'missing-artifact-sha256',
  'missing-dsh-bin',
  'missing-dsh-home',
  'missing-phase',
  'missing-profile',
  'missing-runtime-root',
  'primary-home-requires-primary-scope',
  'primary-scope-unauthorized',
  'profile-unhealthy',
  'receipt-write-failed',
  'stage-unavailable',
  'unexpected-artifact',
  'unexpected-artifact-sha256',
  'unexpected-authorized-by',
  'unexpected-plan-digest',
])

export class DeployError extends Error {
  /** @param {string} code @param {string} message @param {number} [exitCode] @param {Record<string, unknown>} [details] */
  constructor(code, message, exitCode = 65, details = {}) {
    super(message)
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function usage(code, message, details = {}) {
  return new DeployError(code, message, 64, details)
}

/** @param {string} value */
const sha256 = value => createHash('sha256').update(value).digest('hex')

/** @param {unknown} value */
function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/** @param {unknown} value @param {number} limit */
function boundedString(value, limit) {
  if (typeof value !== 'string') return undefined
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/** @param {unknown} value */
function boundedDetails(value) {
  const record = plainRecord(value)
  if (record === undefined) return undefined
  const text = JSON.stringify(record)
  return text.length <= MAX_DETAIL_CHARS ? record : { truncated: true, bytes: text.length }
}

/** @param {string} path */
function canonical(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export const USAGE = [
  'Usage: .agents/scripts/deploy.sh --phase <setup|doctor|update|rollback|remove|repair>',
  '         --profile <name> --dsh-home <absolute> --runtime-root <absolute-owner-only>',
  '         --dsh-bin <absolute> [--agent-hook-bin <absolute>] [--agent-docs-bin <absolute>]',
  '         [--artifact <absolute .tgz> --artifact-sha256 <64 hex>]',
  '         [--apply --expected-plan-digest <64 hex>] [--receipt <absolute path>]',
  '         [--scope canary|primary] [--authorized-by <identity>] [--stage-root <absolute>]',
  '         [--engine-root <absolute installed @sympoies/dsh-runtime-kit root>]',
  '',
  'Generic deployment of this repository into one DSH profile. Every phase is a',
  'non-mutating preview by default and reports the plan digest the engine bound.',
  'Applying a plan requires that exact digest: --apply --expected-plan-digest <digest>.',
  '',
  'setup/update require the immutable packed artifact and its SHA-256; doctor,',
  'rollback, remove, and repair refuse one. The authenticated artifact is staged',
  'under --stage-root (default $XDG_CACHE_HOME/dsh-runtime-kit/deploy-stage) at a',
  'digest-keyed path the engine reviews; a stage that no longer equals the',
  'artifact bytes is rebuilt before any preview or apply. The ambient DSH_HOME and',
  'every DSH_RUNTIME_KIT_* variable are ignored; the scope must be explicit.',
  '',
  'Scope: canary (default) refuses the default and ambient DSH home so candidate',
  'acceptance cannot touch a live profile; primary requires --authorized-by and is',
  'recorded in the receipt.',
  '',
  'The digest-reviewed operations engine of this checkout performs every profile',
  'decision; --engine-root selects another installed @sympoies/dsh-runtime-kit',
  'tree (for example the packed candidate) when the checkout has no dependencies.',
  '',
  'Output: one cli.dsh-runtime-kit.deploy.v1 JSON envelope whose data is a',
  'bounded dsh-runtime-kit.deploy-receipt.v1; --receipt also persists it (0600).',
  '',
].join('\n')

/**
 * @typedef {{
 *   phase: string,
 *   operation: string,
 *   mode: 'preview' | 'apply' | 'inspect',
 *   scope: string,
 *   authorizedBy: string | undefined,
 *   profile: string,
 *   dshHome: string,
 *   runtimeRoot: string,
 *   dshBin: string,
 *   agentHookBin: string | undefined,
 *   agentDocsBin: string | undefined,
 *   artifactPath: string | undefined,
 *   artifactSha256: string | undefined,
 *   apply: boolean,
 *   expectedPlanDigest: string | undefined,
 *   receiptPath: string | undefined,
 *   stageRoot: string,
 *   engineRoot: string | undefined,
 *   resumeArgv: string[],
 * }} DeployScope
 */

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{help: true} | {help: false, scope: DeployScope}}
 */
export function parseScope(argv, env) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        phase: { type: 'string' },
        profile: { type: 'string' },
        'dsh-home': { type: 'string' },
        'runtime-root': { type: 'string' },
        'dsh-bin': { type: 'string' },
        'agent-hook-bin': { type: 'string' },
        'agent-docs-bin': { type: 'string' },
        artifact: { type: 'string' },
        'artifact-sha256': { type: 'string' },
        apply: { type: 'boolean', default: false },
        'expected-plan-digest': { type: 'string' },
        receipt: { type: 'string' },
        scope: { type: 'string', default: 'canary' },
        'authorized-by': { type: 'string' },
        'stage-root': { type: 'string' },
        'engine-root': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    throw usage('invalid-arguments', error instanceof Error ? error.message : String(error))
  }
  const values = parsed.values
  if (values.help) return { help: true }

  if (values.phase === undefined) throw usage('missing-phase', `--phase is required: ${PHASES.join(', ')}`)
  if (!PHASES.includes(values.phase)) throw usage('invalid-phase', `unsupported phase ${values.phase}; expected ${PHASES.join(', ')}`)
  const phase = values.phase
  if (values.profile === undefined) throw usage('missing-profile', '--profile is required')
  if (!PROFILE_PATTERN.test(values.profile)) throw usage('invalid-profile', 'profile must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  if (values['dsh-home'] === undefined) throw usage('missing-dsh-home', '--dsh-home is required; the ambient DSH_HOME is never used')
  if (!isAbsolute(values['dsh-home'])) throw usage('invalid-dsh-home', '--dsh-home must be an absolute path')
  if (values['runtime-root'] === undefined) throw usage('missing-runtime-root', '--runtime-root is required')
  if (!isAbsolute(values['runtime-root'])) throw usage('invalid-runtime-root', '--runtime-root must be an absolute path')
  if (values['dsh-bin'] === undefined) throw usage('missing-dsh-bin', '--dsh-bin is required; the DSH executable is never resolved from PATH')
  if (!isAbsolute(values['dsh-bin'])) throw usage('invalid-dsh-bin', '--dsh-bin must be an absolute path')
  if (values['agent-hook-bin'] !== undefined && !isAbsolute(values['agent-hook-bin'])) {
    throw usage('invalid-agent-hook-bin', '--agent-hook-bin must be an absolute path')
  }
  if (values['agent-docs-bin'] !== undefined && !isAbsolute(values['agent-docs-bin'])) {
    throw usage('invalid-agent-docs-bin', '--agent-docs-bin must be an absolute path')
  }
  if (!SCOPES.includes(values.scope)) throw usage('invalid-scope', `--scope must be one of ${SCOPES.join(', ')}`)
  const authorizedBy = values['authorized-by']?.trim()
  if (values.scope === 'primary') {
    if (authorizedBy === undefined || authorizedBy.length === 0) {
      throw usage('primary-scope-unauthorized', '--scope primary requires --authorized-by <identity> naming who authorized the live-profile change')
    }
  } else if (values['authorized-by'] !== undefined) {
    throw usage('unexpected-authorized-by', '--authorized-by is valid only with --scope primary')
  }

  const dshHome = canonical(values['dsh-home'])
  if (values.scope === 'canary') {
    const primaryHomes = [
      join(env.HOME ?? homedir(), '.dsh'),
      ...(typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? [env.DSH_HOME] : []),
    ].map(canonical)
    if (primaryHomes.includes(dshHome)) {
      throw usage('primary-home-requires-primary-scope', 'the selected DSH home is the default or ambient live home; pass --scope primary --authorized-by <identity> to deploy into it')
    }
  }

  if (ARTIFACT_PHASES.has(phase)) {
    if (values.artifact === undefined) throw usage('missing-artifact', `${phase} requires --artifact <packed .tgz>`)
    if (!isAbsolute(values.artifact)) throw usage('invalid-artifact-path', '--artifact must be an absolute path to the packed .tgz')
    if (values['artifact-sha256'] === undefined) throw usage('missing-artifact-sha256', `${phase} requires --artifact-sha256 <64 lowercase hex> for the immutable artifact`)
    if (!DIGEST_PATTERN.test(values['artifact-sha256'])) throw usage('invalid-artifact-sha256', '--artifact-sha256 must be 64 lowercase hex characters')
  } else {
    if (values.artifact !== undefined) throw usage('unexpected-artifact', `${phase} does not accept --artifact`)
    if (values['artifact-sha256'] !== undefined) throw usage('unexpected-artifact-sha256', `${phase} does not accept --artifact-sha256`)
  }

  const expected = values['expected-plan-digest']
  if (values.apply && (expected === undefined || !DIGEST_PATTERN.test(expected))) {
    throw usage('expected-plan-digest-required', '--apply requires --expected-plan-digest <64 lowercase hex> from the unchanged preview')
  }
  if (!values.apply && expected !== undefined) throw usage('unexpected-plan-digest', '--expected-plan-digest is valid only with --apply')
  if (phase === 'doctor' && values.apply) throw usage('invalid-arguments', 'doctor is an inspection and does not accept --apply')
  if (values.receipt !== undefined && !isAbsolute(values.receipt)) {
    throw usage('invalid-receipt-path', '--receipt must be an absolute path')
  }
  if (values['stage-root'] !== undefined && !isAbsolute(values['stage-root'])) {
    throw usage('invalid-stage-root', '--stage-root must be an absolute path')
  }
  if (values['engine-root'] !== undefined && !isAbsolute(values['engine-root'])) {
    throw usage('invalid-engine-root', '--engine-root must be an absolute path')
  }
  const cacheHome = typeof env.XDG_CACHE_HOME === 'string' && isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : join(env.HOME ?? homedir(), '.cache')

  const resumeArgv = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--receipt') { index += 1; continue }
    if (argv[index].startsWith('--receipt=')) continue
    resumeArgv.push(argv[index])
  }

  return {
    help: false,
    scope: {
      phase,
      operation: phase === 'repair' ? 'doctor' : phase,
      mode: phase === 'doctor' ? 'inspect' : values.apply ? 'apply' : 'preview',
      scope: values.scope,
      authorizedBy: values.scope === 'primary' ? authorizedBy : undefined,
      profile: values.profile,
      dshHome,
      runtimeRoot: resolve(values['runtime-root']),
      dshBin: resolve(values['dsh-bin']),
      agentHookBin: values['agent-hook-bin'] === undefined ? undefined : resolve(values['agent-hook-bin']),
      agentDocsBin: values['agent-docs-bin'] === undefined ? undefined : resolve(values['agent-docs-bin']),
      artifactPath: values.artifact === undefined ? undefined : resolve(values.artifact),
      artifactSha256: values['artifact-sha256'],
      apply: values.apply,
      expectedPlanDigest: expected,
      receiptPath: values.receipt === undefined ? undefined : resolve(values.receipt),
      stageRoot: values['stage-root'] === undefined
        ? join(cacheHome, 'dsh-runtime-kit', 'deploy-stage')
        : resolve(values['stage-root']),
      engineRoot: values['engine-root'] === undefined ? undefined : resolve(values['engine-root']),
      resumeArgv,
    },
  }
}

/**
 * Walk one staged package tree and report whether it still equals the
 * authenticated archive entries: same regular-file set, same bytes, same mode.
 * @param {string} packageRoot @param {ReadonlyArray<{path: string, mode: number, bytes: Buffer}>} entries
 */
function stagedTreeMatches(packageRoot, entries) {
  /** @type {Map<string, {mode: number, bytes: Buffer}>} */
  const expected = new Map(entries.map(entry => [entry.path.slice('package/'.length), { mode: entry.mode & 0o777, bytes: entry.bytes }]))
  /** @type {string[]} */
  const seen = []
  /** @param {string} directory */
  const walk = directory => {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) return false
      if (info.isDirectory()) {
        if (!walk(path)) return false
        continue
      }
      if (!info.isFile()) return false
      const key = relative(packageRoot, path).split(sep).join('/')
      const want = expected.get(key)
      if (want === undefined || (info.mode & 0o777) !== want.mode || !readFileSync(path).equals(want.bytes)) return false
      seen.push(key)
    }
    return true
  }
  try {
    return walk(packageRoot) && seen.length === expected.size
  } catch {
    return false
  }
}

/**
 * Authenticate the immutable artifact against its declared digest and make sure
 * the digest-keyed stage the engine reviews holds exactly its contents. The
 * stage path is deterministic so the preview and the later apply bind the same
 * local target; a stage that drifted from the bytes is rebuilt, never trusted.
 * @param {string} artifactPath @param {string} expectedSha256 @param {string} stageRoot
 */
async function stageArtifact(artifactPath, expectedSha256, stageRoot) {
  let bytes
  try {
    bytes = readFileSync(artifactPath)
  } catch (error) {
    throw new DeployError('artifact-unreadable', `cannot read the deploy artifact: ${error instanceof Error ? error.message : String(error)}`, 65, { path: artifactPath })
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) {
    throw new DeployError('artifact-digest-mismatch', 'the deploy artifact does not match --artifact-sha256; refusing to stage or deploy it', 65, {
      path: artifactPath,
      expected_sha256: expectedSha256,
      actual_sha256: actual,
    })
  }
  let identity
  try {
    identity = inspectCanonicalPackageArtifact(bytes)
  } catch (error) {
    throw new DeployError('artifact-invalid', `the deploy artifact is not a bounded ${PACKAGE_NAME} package archive`, 65, {
      path: artifactPath,
      reason: boundedString(error instanceof Error ? error.message : String(error), MAX_MESSAGE_CHARS),
    })
  }
  if (identity.name !== PACKAGE_NAME) {
    throw new DeployError('artifact-invalid', `the deploy artifact is ${identity.name}, not ${PACKAGE_NAME}`, 65, { path: artifactPath })
  }
  const entries = packageArtifactEntries(bytes)
  const stageDir = join(stageRoot, expectedSha256)
  const packageRoot = join(stageDir, 'package')
  let restaged = false
  try {
    mkdirSync(stageDir, { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(stageRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) {
      throw new DeployError('stage-unavailable', 'the deploy stage root must be a real owner-only directory', 65, { stage_root: stageRoot })
    }
    if (existsSync(packageRoot) && !stagedTreeMatches(packageRoot, entries)) {
      rmSync(packageRoot, { recursive: true, force: true })
    }
    if (!existsSync(packageRoot)) {
      const temporary = join(stageDir, `package.${process.pid}.tmp`)
      rmSync(temporary, { recursive: true, force: true })
      await extractPackageArtifact(bytes, temporary)
      try {
        renameSync(temporary, packageRoot)
      } catch (error) {
        // A concurrent deploy of the same artifact won the rename; its tree is
        // verified below exactly like ours would have been.
        rmSync(temporary, { recursive: true, force: true })
        if (!existsSync(packageRoot)) throw error
      }
      restaged = true
      if (!stagedTreeMatches(packageRoot, entries)) {
        throw new DeployError('stage-unavailable', 'the deploy stage could not be made equal to the artifact', 65, { stage_root: stageRoot })
      }
    }
  } catch (error) {
    if (error instanceof DeployError) throw error
    throw new DeployError('artifact-invalid', 'the deploy artifact could not be staged for review', 65, {
      path: artifactPath,
      reason: boundedString(error instanceof Error ? error.message : String(error), MAX_MESSAGE_CHARS),
    })
  }
  return {
    packageRoot,
    artifact: {
      path: artifactPath,
      sha256: expectedSha256,
      name: identity.name,
      version: identity.version,
      staged_root: packageRoot,
      restaged,
    },
  }
}

/**
 * The engine is this repository's own operations plane, or an explicitly
 * selected installed copy of it. Its identity is bound into every receipt.
 * @param {string} engineRoot
 */
function resolveEngine(engineRoot) {
  const launcher = join(engineRoot, 'bin', 'dsh-runtime-kit-launch.js')
  const cli = join(engineRoot, 'bin', 'dsh-runtime-kit.js')
  let manifest
  try {
    manifest = plainRecord(JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8')))
  } catch {
    manifest = undefined
  }
  if (manifest === undefined || manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string'
    || !existsSync(launcher) || !existsSync(cli)) {
    throw new DeployError('engine-unavailable', `${engineRoot} is not an installed ${PACKAGE_NAME} tree with the operations engine`, 70, { engine_root: engineRoot })
  }
  return { root: engineRoot, version: manifest.version, launcher, cli }
}

/**
 * @param {DeployScope} scope
 * @param {string | undefined} packageRoot
 * @param {ReturnType<typeof resolveEngine>} engine
 * @param {{execPath: string, env: NodeJS.ProcessEnv}} io
 */
function runEngine(scope, packageRoot, engine, io) {
  const { launcher, cli } = engine
  const args = [
    launcher, '--runtime-root', scope.runtimeRoot, '--',
    io.execPath, cli, scope.operation, '--profile', scope.profile,
    ...(packageRoot === undefined ? [] : ['--package', packageRoot]),
    ...(scope.phase === 'repair' ? ['--repair'] : []),
    ...(scope.apply ? ['--apply', '--expected-plan-digest', /** @type {string} */ (scope.expectedPlanDigest)] : []),
    '--format', 'json',
  ]
  /** @type {Record<string, string>} */
  const env = {}
  for (const [key, value] of Object.entries(io.env)) {
    if (value === undefined || key === 'DSH_HOME' || key.startsWith('DSH_RUNTIME_KIT_')) continue
    env[key] = value
  }
  env.DSH_HOME = scope.dshHome
  env.DSH_RUNTIME_KIT_DSH_BIN = scope.dshBin
  if (scope.agentHookBin !== undefined) env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN = scope.agentHookBin
  if (scope.agentDocsBin !== undefined) env.DSH_RUNTIME_KIT_AGENT_DOCS_BIN = scope.agentDocsBin
  const result = spawnSync(io.execPath, args, {
    cwd: engine.root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_ENGINE_STDOUT_BYTES,
    timeout: ENGINE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.error !== undefined) {
    throw new DeployError('engine-unavailable', `the operations engine could not be run: ${result.error.message}`, 70)
  }
  const exitCode = result.status ?? 70
  const stderrTail = boundedString(result.stderr.slice(-MAX_STDERR_TAIL_CHARS), MAX_STDERR_TAIL_CHARS)
  /** @type {unknown} */
  let envelope
  try {
    envelope = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    throw new DeployError('engine-output-invalid', 'the operations engine returned no JSON envelope', 70, {
      exit_code: exitCode,
      signal: result.signal ?? undefined,
      stderr_tail: stderrTail,
    })
  }
  const record = plainRecord(envelope)
  if (record === undefined || record.schema_version !== ENGINE_OUTPUT_SCHEMA || typeof record.ok !== 'boolean') {
    throw new DeployError('engine-output-invalid', 'the operations engine returned an unrecognized envelope', 70, { exit_code: exitCode })
  }
  return { envelope: record, exitCode }
}

/**
 * Keep only the identity-bearing engine fields; never copy raw command output,
 * environment, or unbounded plan bodies into a deploy receipt.
 * @param {DeployScope} scope @param {Record<string, unknown>} envelope @param {number} exitCode
 */
function engineSummary(scope, envelope, exitCode) {
  const data = plainRecord(envelope.data) ?? {}
  /** @type {Record<string, unknown>} */
  const summary = { schema_version: ENGINE_OUTPUT_SCHEMA, ok: envelope.ok, exit_code: exitCode }
  if (scope.operation === 'doctor' && scope.phase === 'doctor') {
    summary.status = data.status
    const activation = plainRecord(data.activation)
    if (activation !== undefined) summary.activation = activation.status
    const lifecycle = plainRecord(data.lifecycle)
    if (lifecycle !== undefined) {
      summary.lifecycle = { declared: lifecycle.declared, schema_version: lifecycle.schema_version }
    }
    return summary
  }
  summary.mode = data.mode
  if (typeof data.plan_digest === 'string') summary.plan_digest = data.plan_digest
  const plan = plainRecord(data.plan)
  if (plan !== undefined) {
    if (typeof plan.action === 'string') summary.action = plan.action
    if (typeof plan.operation === 'string') summary.operation = plan.operation
    const target = plainRecord(plan.target)
    summary.target = target === undefined
      ? null
      : {
          kind: target.kind,
          expected_version: target.expected_version,
          artifact_sha256: target.artifact_sha256,
          installed_sha256: target.installed_sha256,
        }
    const lifecycle = plainRecord(plan.lifecycle)
    if (lifecycle !== undefined) summary.lifecycle_sha256 = lifecycle.sha256
  }
  return summary
}

/** @param {string} path @param {unknown} value */
function writeReceipt(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(value, undefined, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } catch (error) {
    throw new DeployError('receipt-write-failed', `cannot write the deploy receipt: ${error instanceof Error ? error.message : String(error)}`, 70, { path })
  }
}

/**
 * @param {string[]} [argv]
 * @param {{env?: NodeJS.ProcessEnv, stdout?: {write: (text: string) => unknown}, execPath?: string, projectRoot?: string}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env
  const stdout = io.stdout ?? process.stdout
  const execPath = io.execPath ?? process.execPath
  const projectRoot = io.projectRoot ?? resolve(import.meta.dirname, '..', '..')
  const startedAt = new Date().toISOString()
  /** @type {DeployScope | undefined} */
  let scope
  /** @type {Awaited<ReturnType<typeof stageArtifact>> | undefined} */
  let staged
  try {
    const parsed = parseScope(argv, env)
    if (parsed.help) {
      stdout.write(USAGE)
      return 0
    }
    scope = parsed.scope
    const selectedEngine = resolveEngine(scope.engineRoot ?? projectRoot)
    if (scope.artifactPath !== undefined) {
      staged = await stageArtifact(scope.artifactPath, /** @type {string} */ (scope.artifactSha256), scope.stageRoot)
    }
    const { envelope, exitCode } = runEngine(scope, staged?.packageRoot, selectedEngine, { execPath, env })
    const engine = {
      root: selectedEngine.root,
      version: selectedEngine.version,
      ...engineSummary(scope, envelope, exitCode),
    }
    if (envelope.ok !== true) {
      const error = plainRecord(envelope.error)
      if (error !== undefined) {
        throw new DeployError('engine-refused', `the operations engine refused ${scope.phase}: ${boundedString(error.message, MAX_MESSAGE_CHARS) ?? 'no message'}`, exitCode === 0 ? 70 : exitCode, {
          phase: scope.phase,
          mode: scope.mode,
          engine: {
            root: selectedEngine.root,
            version: selectedEngine.version,
            code: typeof error.code === 'string' ? error.code : 'unknown',
            message: boundedString(error.message, MAX_MESSAGE_CHARS),
            exit_code: exitCode,
            ...(boundedDetails(error.details) === undefined ? {} : { details: boundedDetails(error.details) }),
          },
        })
      }
      throw new DeployError('profile-unhealthy', `${scope.profile} is not healthy; see the doctor report`, exitCode === 0 ? 65 : exitCode, {
        phase: scope.phase,
        mode: scope.mode,
        engine,
      })
    }
    const data = plainRecord(envelope.data) ?? {}
    /** @type {Record<string, unknown>} */
    const receipt = {
      schema_version: RECEIPT_SCHEMA,
      ok: true,
      phase: scope.phase,
      mode: scope.mode,
      scope: scope.scope,
      ...(scope.authorizedBy === undefined ? {} : { authorized_by: scope.authorizedBy }),
      profile: scope.profile,
      dsh_home: scope.dshHome,
      runtime_root: scope.runtimeRoot,
      dsh_bin: scope.dshBin,
      ...(scope.agentHookBin === undefined ? {} : { agent_hook_bin: scope.agentHookBin }),
      ...(scope.agentDocsBin === undefined ? {} : { agent_docs_bin: scope.agentDocsBin }),
      ...(staged === undefined ? {} : { stage_root: scope.stageRoot }),
      artifact: staged?.artifact ?? null,
      ...(typeof data.plan_digest === 'string' ? { plan_digest: data.plan_digest } : {}),
      engine,
      ...(scope.mode === 'preview' && typeof data.plan_digest === 'string'
        ? { resume: { apply_argv: [...scope.resumeArgv, '--apply', '--expected-plan-digest', data.plan_digest] } }
        : {}),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    }
    if (scope.receiptPath !== undefined) writeReceipt(scope.receiptPath, receipt)
    stdout.write(`${JSON.stringify({ schema_version: OUTPUT_SCHEMA, ok: true, data: receipt })}\n`)
    return 0
  } catch (error) {
    const normalized = error instanceof DeployError
      ? error
      : new DeployError('engine-unavailable', error instanceof Error ? error.message : String(error), 70)
    const failure = {
      code: normalized.code,
      message: boundedString(normalized.message, MAX_MESSAGE_CHARS),
      details: normalized.details,
    }
    if (scope?.receiptPath !== undefined && normalized.code !== 'receipt-write-failed') {
      try {
        writeReceipt(scope.receiptPath, {
          schema_version: RECEIPT_SCHEMA,
          ok: false,
          phase: scope.phase,
          mode: scope.mode,
          scope: scope.scope,
          profile: scope.profile,
          dsh_home: scope.dshHome,
          runtime_root: scope.runtimeRoot,
          artifact: staged?.artifact ?? null,
          error: failure,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      } catch {}
    }
    stdout.write(`${JSON.stringify({ schema_version: OUTPUT_SCHEMA, ok: false, error: failure })}\n`)
    return normalized.exitCode
  }
}
