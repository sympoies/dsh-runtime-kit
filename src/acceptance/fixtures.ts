import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { packageAsset } from '../package-root.js'

const MANIFEST_SCHEMA = 'dsh-runtime-kit.acceptance-fixtures.v1'
const PROVIDER_SCHEMA = 'dsh-runtime-kit.acceptance-fixture-provider.v1'
const RESULT_SCHEMA = 'dsh-runtime-kit.acceptance-fixture-result.v1'
const STATE_SCHEMA = 'dsh-runtime-kit.acceptance-fixture-state.v1'
const RECEIPT_SCHEMA = 'dsh-runtime-kit.acceptance-fixture-receipt.v1'
const FIXTURE_SCHEMA = 'dsh-runtime-kit.acceptance-fixture.v1'
const FAILURE_SCHEMA = 'dsh-runtime-kit.acceptance-fixture-failure.v1'
const MAX_MANIFEST_BYTES = 256 * 1024
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const IDENTIFIER = /^[a-z0-9][a-z0-9.-]{0,95}$/u
const FAMILY = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.git(?:\/|$))[A-Za-z0-9._/-]{1,192}$/u
const OPERATIONS = Object.freeze({
  prepare: Object.freeze(['stage-fixture']),
  induce: Object.freeze(['stage-fixture', 'induce-failure']),
  recover: Object.freeze(['recover-failure']),
  cleanup: Object.freeze(['cleanup-fixture']),
})
const FAILURE_KINDS = Object.freeze([
  'workspace-lease-conflict',
  'governed-precondition',
  'prerequisite-digest-mismatch',
  'companion-identity-mismatch',
  'unmet-validation',
  'workspace-issuance-conflict',
  'protected-root-destination',
  'restricted-write-attempt',
  'artifact-id-mismatch',
  'lifecycle-interruption',
  'dispatcher-unavailable',
  'retired-surface-staged',
] as const)
type Stage = 'prepare' | 'induce' | 'recover' | 'cleanup'
type Phase = 'success' | 'deliberate-failure'
type FailureKind = typeof FAILURE_KINDS[number]

export type AcceptanceFixtureFamily = {
  id: string
  scenario_ids: string[]
  fixture_files: string[]
  failure_kind: FailureKind
  transitions: {
    prepare: string[]
    induce: string[]
    recover: string[]
    cleanup: string[]
  }
}

export type AcceptanceFixtureManifest = {
  schema_version: typeof MANIFEST_SCHEMA
  families: AcceptanceFixtureFamily[]
}

export type AcceptanceFixtureInput = {
  schema: typeof PROVIDER_SCHEMA
  stage: Stage
  phase: Phase
  family: string
  scenarioId: string
  profile: string
  workdir: string
  dshHome: string
  manifestPath?: string
}

type OwnedFile = {
  path: string
  sha256: string
  mode: number
  disposition: 'cleanup' | 'retain-for-attestation'
}
type FileSnapshot = {
  kind: 'file'
  path: string
  bytes_base64: string
  sha256: string
  mode: number
}
type WorkspaceLeaseSnapshot = {
  kind: 'workspace-lease'
  agent_hook: string
  agent_hook_sha256: string
  config: string
  policy: string
  state_dir: string
  session_id: string
  binding_id: string
  workspace_id: string
  generation: string
  target_root: string
  temporary_git_dir_sha256: string | null
}
type ExternalSnapshot = FileSnapshot | WorkspaceLeaseSnapshot
type ManagedChildState = {
  worktree: string
  owned_files: OwnedFile[]
}
type FixtureState = {
  schema_version: typeof STATE_SCHEMA
  family: string
  scenario_id: string
  profile: string
  phase: Phase
  workdir: string
  dsh_home: string
  status: 'active' | 'recovered' | 'cleaned'
  sequence: number
  owned_files: OwnedFile[]
  external_snapshot: ExternalSnapshot | null
  managed_child: ManagedChildState | null
}

const MANAGED_CHILD_FIXTURE_PATHS = [
  'acceptance-fixture.json',
  '.dsh-acceptance/guide.md',
  '.dsh-acceptance/protected/.fixture-root',
  'AGENT_DOCS.toml',
  'PROJECT_DEV_EDIT.md',
  'fixture-validation.mjs',
  'subagent-target.txt',
] as const

export type AcceptanceFixtureResult = {
  schema_version: typeof RESULT_SCHEMA
  ok: true
  data: {
    status: 'pass'
    stage: Stage
    phase: Phase
    family: string
    scenario_id: string
    evidence: Array<{ kind: string, reference: string, sha256: string }>
  }
}

class FixtureError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFile(path: string, label: string, privateOnly: boolean = false) {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new FixtureError('unsafe-fixture-path', `${label} must be a single-link regular file`)
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new FixtureError('unsafe-fixture-path', `${label} must be owned by the current user`)
  }
  if ((metadata.mode & (privateOnly ? 0o077 : 0o022)) !== 0) {
    throw new FixtureError('unsafe-fixture-path', `${label} has unsafe permissions`)
  }
  return metadata
}

function safeDirectory(path: string, label: string, privateOnly: boolean) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new FixtureError('unsafe-fixture-root', `${label} must be absolute`)
  }
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new FixtureError('unsafe-fixture-root', `${label} must be a real directory`)
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new FixtureError('unsafe-fixture-root', `${label} must be owned by the current user`)
  }
  if ((metadata.mode & (privateOnly ? 0o077 : 0o022)) !== 0) {
    throw new FixtureError('unsafe-fixture-root', `${label} has unsafe permissions`)
  }
  return realpathSync(path)
}

function within(parent: string, child: string) {
  const fragment = relative(parent, child)
  return fragment === '' || (fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment))
}

function ensurePrivateDescendant(root: string, ...segments: string[]) {
  const path = resolve(root, ...segments)
  if (!within(root, path) || path === root) {
    throw new FixtureError('unsafe-fixture-root', 'fixture state escaped DSH_HOME')
  }
  let cursor = root
  for (const component of relative(root, path).split(sep)) {
    cursor = join(cursor, component)
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 })
    const metadata = lstatSync(cursor)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0) {
      throw new FixtureError('unsafe-fixture-root', 'fixture state contains an unsafe directory')
    }
  }
  return path
}

function ensureOwnedParent(root: string, relativePath: string) {
  const components = relativePath.split('/').slice(0, -1)
  let cursor = root
  for (const component of components) {
    cursor = join(cursor, component)
    if (existsSync(cursor)) {
      const metadata = lstatSync(cursor)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        || (metadata.mode & 0o022) !== 0) {
        throw new FixtureError('unsafe-fixture-path', `fixture parent is unsafe: ${relativePath}`)
      }
    } else {
      mkdirSync(cursor, { mode: 0o700 })
    }
    if (realpathSync(cursor) !== cursor) {
      throw new FixtureError('unsafe-fixture-path', `fixture parent escaped the workdir: ${relativePath}`)
    }
  }
}

function safeRelativePath(value: unknown, label: string) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.includes('//')
    || value.split('/').some(component => component.length === 0 || component === '.' || component === '..')) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest ${label} is unsafe`)
  }
  return value
}

function parseFamily(value: unknown, index: number): AcceptanceFixtureFamily {
  const row = record(value)
  if (row === undefined || !exactKeys(row, [
    'id', 'scenario_ids', 'fixture_files', 'failure_kind', 'transitions',
  ])) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${index} has missing or unknown keys`)
  }
  if (typeof row.id !== 'string' || !FAMILY.test(row.id)) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${index} has an invalid id`)
  }
  if (!Array.isArray(row.scenario_ids) || row.scenario_ids.length === 0 || row.scenario_ids.length > 8
    || row.scenario_ids.some(id => typeof id !== 'string' || !IDENTIFIER.test(id) || !id.startsWith(`${row.id}.`))
    || new Set(row.scenario_ids).size !== row.scenario_ids.length) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${row.id} has invalid scenario ids`)
  }
  if (!Array.isArray(row.fixture_files) || row.fixture_files.length === 0 || row.fixture_files.length > 16
    || new Set(row.fixture_files).size !== row.fixture_files.length) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${row.id} has invalid fixture files`)
  }
  const fixtureFiles = row.fixture_files.map((path, fileIndex) => safeRelativePath(
    path,
    `family ${row.id} fixture_files[${fileIndex}]`,
  ))
  if (typeof row.failure_kind !== 'string' || !FAILURE_KINDS.includes(row.failure_kind as FailureKind)) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${row.id} has an unsupported failure kind`)
  }
  const transitions = record(row.transitions)
  if (transitions === undefined || !exactKeys(transitions, ['prepare', 'induce', 'recover', 'cleanup'])) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${row.id} has incomplete transitions`)
  }
  const parsedTransitions = Object.fromEntries(Object.entries(OPERATIONS).map(([stage, expected]) => {
    const observed = transitions[stage]
    if (!Array.isArray(observed) || observed.some(item => typeof item !== 'string')
      || observed.join('\0') !== expected.join('\0')) {
      throw new FixtureError('invalid-fixture-manifest', `fixture manifest family ${row.id} has an invalid ${stage} recipe`)
    }
    return [stage, [...observed] as string[]]
  })) as AcceptanceFixtureFamily['transitions']
  return {
    id: row.id,
    scenario_ids: [...row.scenario_ids] as string[],
    fixture_files: fixtureFiles,
    failure_kind: row.failure_kind as FailureKind,
    transitions: parsedTransitions,
  }
}

function expectedPackFamilies() {
  const path = packageAsset('compatibility', 'acceptance-scenario-pack.json')
  safeFile(path, 'acceptance scenario pack')
  const root = record(JSON.parse(readFileSync(path, 'utf8')))
  if (root?.schema_version !== 'dsh-runtime-kit.acceptance-scenario-pack.v2' || !Array.isArray(root.families)) {
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest cannot bind the scenario pack')
  }
  return root.families.map((value, index) => {
    const row = record(value)
    if (typeof row?.id !== 'string' || !Array.isArray(row.scenario_ids)
      || row.scenario_ids.some(id => typeof id !== 'string')) {
      throw new FixtureError('invalid-fixture-manifest', `fixture manifest cannot bind scenario-pack family ${index}`)
    }
    return { id: row.id, scenario_ids: [...row.scenario_ids] as string[] }
  })
}

export function loadAcceptanceFixtureManifest(
  path: string = packageAsset('compatibility', 'acceptance-fixtures.json'),
): AcceptanceFixtureManifest {
  let metadata
  try {
    metadata = safeFile(path, 'acceptance fixture manifest')
  } catch (error) {
    if (error instanceof FixtureError) throw error
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest is unavailable')
  }
  if (metadata.size <= 0 || metadata.size > MAX_MANIFEST_BYTES) {
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest exceeds its size bound')
  }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest is not valid JSON')
  }
  const root = record(value)
  if (root === undefined || !exactKeys(root, ['schema_version', 'families'])
    || root.schema_version !== MANIFEST_SCHEMA || !Array.isArray(root.families)
    || root.families.length === 0 || root.families.length > 32) {
    throw new FixtureError('invalid-fixture-manifest', `fixture manifest must carry ${MANIFEST_SCHEMA}`)
  }
  const families = root.families.map(parseFamily)
  if (new Set(families.map(row => row.id)).size !== families.length
    || new Set(families.flatMap(row => row.scenario_ids)).size !== families.flatMap(row => row.scenario_ids).length
    || new Set(families.map(row => row.failure_kind)).size !== families.length) {
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest family, scenario, and failure ownership must be unique')
  }
  const expected = expectedPackFamilies()
  if (JSON.stringify(families.map(row => ({ id: row.id, scenario_ids: row.scenario_ids }))) !== JSON.stringify(expected)) {
    throw new FixtureError('invalid-fixture-manifest', 'fixture manifest does not exactly cover the #D scenario pack')
  }
  return { schema_version: MANIFEST_SCHEMA, families }
}

function governedRequest(input: AcceptanceFixtureInput, induced: boolean = false) {
  const managed = input.scenarioId.endsWith('.managed-worktree')
  return {
    schema_version: 'dsh-runtime-kit.acceptance-governed-request.v1',
    expected_outcome: induced
      ? 'stop-on-governed-precondition-refusal'
      : managed ? 'signed-feature-commit' : 'typed-default-branch-refusal',
    sequence: induced
      ? ['validate', 'governed-commit']
      : managed
        ? ['edit', 'stage', 'governed-commit', 'validate']
        : ['edit', 'stage', 'governed-commit', 'verify-default-branch-refusal', 'unstage', 'remove-output', 'validate'],
    edit: { path: 'governed.txt', content: 'committed\n' },
    stage_command: 'git add -- governed.txt',
    unstage_command: 'git reset -- governed.txt',
    remove_output_command: 'rm -- governed.txt',
    validation_command: './fixture-validation.mjs',
    commit: {
      tool: 'runtime_kit_governed_commit',
      type: 'test',
      scope: 'acceptance',
      subject: 'prove governed acceptance',
      body_bullets: ['Commit only the bounded acceptance fixture output.'],
      expected_head_command: 'git rev-parse HEAD',
    },
  }
}

function gitPathFile(path: string, label: string) {
  const metadata = safeFile(path, label)
  if (metadata.size <= 0 || metadata.size > 4096) {
    throw new FixtureError('fixture-input-invalid', `${label} is not a bounded Git path file`)
  }
  const value = readFileSync(path, 'utf8')
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value
  if (normalized.length === 0 || normalized.includes('\n') || normalized.includes('\r')
    || normalized.includes('\0')) {
    throw new FixtureError('fixture-input-invalid', `${label} is not a single Git path`)
  }
  return normalized
}

function gitWorktreeTopology(worktree: string, label: string) {
  const dotGit = join(worktree, '.git')
  if (!existsSync(dotGit)) {
    throw new FixtureError('fixture-input-invalid', `${label} must be a Git checkout`)
  }
  const metadata = lstatSync(dotGit)
  if (metadata.isSymbolicLink()) {
    throw new FixtureError('fixture-input-invalid', `${label} has an unsafe Git administrative link`)
  }
  if (metadata.isDirectory()) {
    const common = safeDirectory(dotGit, `${label} Git directory`, false)
    return { common, gitDirectory: common, linked: false }
  }
  if (!metadata.isFile()) {
    throw new FixtureError('fixture-input-invalid', `${label} has an unsupported .git entry`)
  }
  const declaration = gitPathFile(dotGit, `${label} .git file`)
  const match = /^gitdir: (.+)$/u.exec(declaration)
  if (match === null) {
    throw new FixtureError('fixture-input-invalid', `${label} .git file is malformed`)
  }
  const gitDirectory = safeDirectory(
    resolve(worktree, match[1]!),
    `${label} Git administrative directory`,
    false,
  )
  const commonDeclaration = gitPathFile(join(gitDirectory, 'commondir'), `${label} commondir`)
  const common = safeDirectory(
    resolve(gitDirectory, commonDeclaration),
    `${label} Git common directory`,
    false,
  )
  const backReference = gitPathFile(join(gitDirectory, 'gitdir'), `${label} gitdir back-reference`)
  if (resolve(gitDirectory, backReference) !== dotGit) {
    throw new FixtureError('fixture-input-invalid', `${label} Git worktree back-reference is invalid`)
  }
  return { common, gitDirectory, linked: true }
}

function mainAgentFixtureContext(input: AcceptanceFixtureInput) {
  const primary = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY
  const worktree = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE
  const repository = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY
  const retryPrimary = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY
  const retryWorktree = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE
  if (primary === undefined || worktree === undefined || repository === undefined
    || !/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/u.test(repository)) {
    throw new FixtureError(
      'fixture-input-missing',
      'managed subagent repository, primary, and host-issued worktree are required',
    )
  }
  if ((retryPrimary === undefined) !== (retryWorktree === undefined)) {
    throw new FixtureError(
      'fixture-input-missing',
      'managed subagent retry primary and worktree must be supplied together',
    )
  }
  for (const [path, label] of [
    [primary, 'managed subagent primary'],
    [worktree, 'managed subagent worktree'],
    ...(retryPrimary === undefined ? [] : [
      [retryPrimary, 'managed subagent retry primary'],
      [retryWorktree!, 'managed subagent retry worktree'],
    ]),
  ] as Array<[string, string]>) {
    if (!isAbsolute(path) || path.includes('\0') || !existsSync(path)) {
      throw new FixtureError('fixture-input-invalid', `${label} must name an existing absolute directory`)
    }
  }
  const canonicalPrimary = safeDirectory(primary, 'managed subagent primary', false)
  const canonicalWorktree = safeDirectory(worktree, 'managed subagent worktree', false)
  if (canonicalPrimary === canonicalWorktree) {
    throw new FixtureError('fixture-input-invalid', 'managed subagent primary and child must be distinct')
  }
  const canonicalRetryPrimary = retryPrimary === undefined
    ? undefined : safeDirectory(retryPrimary, 'managed subagent retry primary', false)
  const canonicalRetryWorktree = retryWorktree === undefined
    ? undefined : safeDirectory(retryWorktree, 'managed subagent retry worktree', false)
  if (canonicalRetryPrimary !== undefined && canonicalRetryPrimary === canonicalRetryWorktree) {
    throw new FixtureError('fixture-input-invalid', 'managed subagent retry primary and child must be distinct')
  }
  const retry = canonicalRetryPrimary !== undefined && canonicalRetryPrimary === input.workdir
  const selectedPrimary = retry ? canonicalRetryPrimary : canonicalPrimary
  const selectedWorktree = retry ? canonicalRetryWorktree : canonicalWorktree
  if (selectedPrimary !== input.workdir) {
    throw new FixtureError('fixture-input-invalid', 'managed subagent primary must match the scenario workdir')
  }
  const primaryTopology = gitWorktreeTopology(selectedPrimary, 'managed subagent primary')
  const childTopology = gitWorktreeTopology(selectedWorktree!, 'managed subagent child')
  if (!childTopology.linked || childTopology.common !== primaryTopology.common
    || !within(join(primaryTopology.common, 'worktrees'), childTopology.gitDirectory)) {
    throw new FixtureError(
      'fixture-input-invalid',
      'managed subagent child must be a linked worktree from the primary repository',
    )
  }
  return {
    primary: selectedPrimary,
    worktree: selectedWorktree!,
    repository,
  }
}

function fixtureContent(family: AcceptanceFixtureFamily, path: string, input: AcceptanceFixtureInput) {
  const scenario = input.scenarioId
  const mainAgent = family.id === 'managed-subagent-workspace'
    ? mainAgentFixtureContext(input) : undefined
  if (path === 'leased.txt') return 'leased-fixture\n'
  if (path === 'sibling.txt') return 'sibling-fixture\n'
  if (path === 'workspace-request.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-workspace-request.v1',
    target: join(input.workdir, 'leased.txt'),
    content: 'lease-recovered',
  }, undefined, 2)}\n`
  if (path === 'governed-target.txt') return 'governed-fixture\n'
  if (path === 'governed-request.json') return `${JSON.stringify(governedRequest(input), undefined, 2)}\n`
  if (path === 'fixture-source.mjs') return 'export const plusOne = value => value\n'
  if (path === 'fixture-source.test.mjs') {
    return "import assert from 'node:assert/strict'\nimport { plusOne } from './fixture-source.mjs'\nassert.equal(plusOne(1), 2)\n"
  }
  if (path === 'prerequisite-marker.txt') return 'project-dev-prerequisite-ready\n'
  if (path === 'health-target.txt') return 'health-ready\n'
  if (path === 'acceptance-target.txt') return 'acceptance-before\n'
  if (path === 'acceptance-validation.mjs') {
    return "import assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\nassert.equal(readFileSync('acceptance-target.txt', 'utf8'), 'acceptance-after\\n')\n"
  }
  if (path === 'acceptance-request.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-authoritative-request.v1',
    sequence: ['edit', 'validate', 'finish'],
  }, undefined, 2)}\n`
  if (path === 'subagent-target.txt') return 'subagent-before\n'
  if (path === 'controller-review.txt') return 'review-pending\n'
  if (path === 'subagent-request.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-subagent-request.v1',
    workspace: 'new-host-issued-worktree',
    objective_file: join(input.workdir, 'main-agent-objective.json'),
    assignment_file: join(input.workdir, 'main-agent-assignment.json'),
    primary_worktree: mainAgent!.primary,
    child_worktree: mainAgent!.worktree,
    target: 'subagent-target.txt',
    content: 'subagent-after',
  }, undefined, 2)}\n`
  if (path === 'main-agent-objective.json') return `${JSON.stringify({
    schema_version: 'main-agent.objective-packet.v1',
    tier: 'L0',
    objective_summary: `prove ${scenario} uses one native managed DSH lane`,
    objective: { goal: 'complete one isolated implementation assignment and close its lane' },
    done_criteria: [
      'child worktree differs from the primary',
      'child result accepted',
      'controller review recorded in the primary',
      'lane closed',
    ],
    constraints: ['no commit', 'no delivery', 'leave the primary implementation target unchanged'],
    durable_refs: [],
    next_action: null,
    work_context: {
      schema_version: 'agent-session.work-context-input.v1',
      intent: 'project-dev',
      tier: 'L2',
      repositories: [mainAgent!.repository],
      summary: 'DSH project-dev session',
    },
  }, undefined, 2)}\n`
  if (path === 'main-agent-assignment.json') return `${JSON.stringify({
    schema_version: 'main-agent.assignment-input.v1',
    assignment_id: `lane-${sha256(input.workdir).slice(0, 16)}`,
    task_summary: 'edit and validate subagent-target.txt in the host-issued child worktree',
    task: {
      objective: 'Call main_agent_bootstrap, load project-dev through runtime_context, replace subagent-target.txt with exactly subagent-after followed by a newline, run the exact command ./fixture-validation.mjs without a wrapper, prefix, suffix, or compound command, then call main_agent_checkpoint with state submitted and report the validated result.',
    },
    launch: {
      agent: 'dsh',
      cwd: mainAgent!.worktree,
      title: null,
      session_id: `worker-${sha256(input.workdir).slice(0, 16)}`,
      coordination_mode: 'enforce',
      agent_args: [],
    },
    repository: mainAgent!.repository,
    worktree: mainAgent!.worktree,
    base_ref: 'main',
    scopes: ['subagent-target.txt'],
    durable_refs: [],
  }, undefined, 2)}\n`
  if (path === 'ordinary.txt') return 'ordinary-ok\n'
  if (path === '.dsh-acceptance/protected/target.txt') return 'protected-unchanged\n'
  if (path === 'data-destination.txt') return 'ordinary-copy.txt\n'
  if (path === 'review.txt') return 'Review finding: retain the explicit validation boundary.\n'
  if (path === 'review-target.txt') return 'review-target-unchanged\n'
  if (path === 'review-instruction.txt') {
    return 'Inspect review-target.txt read-only and report that its exact bytes are review-target-unchanged.\n'
  }
  if (path === 'validation-output.txt') return 'artifact-ok\n'
  if (path === 'artifact-request.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-artifact-request.v1',
    source: 'validation-output.txt',
    retrieval: 'returned-artifact-id',
  }, undefined, 2)}\n`
  if (path === 'lifecycle-inputs.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-lifecycle-inputs.v1',
    profile: `acceptance-${scenario.replaceAll('.', '-')}`,
    runtime_kit_bin: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_RUNTIME_KIT_BIN ?? null,
    primary_package: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PRIMARY_PACKAGE ?? null,
    update_package: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE ?? null,
    operation: 'full-lifecycle',
  }, undefined, 2)}\n`
  if (path === 'lifecycle-failing-dsh.mjs') {
    const dsh = process.env.DSH_RUNTIME_KIT_ACCEPTANCE_HOST_DSH_BIN ?? null
    return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const dsh = ${JSON.stringify(dsh)}
if (typeof dsh !== 'string' || dsh.length === 0) process.exit(65)
const args = process.argv.slice(2)
if (args.includes('plugin') && (args.includes('add') || args.includes('remove'))) {
  process.stderr.write('acceptance-lifecycle-induced-dsh-failure\\n')
  process.exit(70)
}
const result = spawnSync(dsh, args, { stdio: 'inherit', env: process.env })
if (result.error) process.exit(70)
if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 70)
`
  }
  if (path === 'lifecycle-probe.mjs') return `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const input = JSON.parse(readFileSync('lifecycle-inputs.json', 'utf8'))
const required = ['profile', 'runtime_kit_bin', 'primary_package', 'update_package', 'operation']
if (input.schema_version !== 'dsh-runtime-kit.acceptance-lifecycle-inputs.v1'
  || required.some(key => typeof input[key] !== 'string' || input[key].length === 0)) process.exit(65)

function invoke(args, env = process.env, expectedFailure = false, acceptInspection = false) {
  const result = spawnSync(input.runtime_kit_bin, [...args, '--format', 'json'], {
    encoding: 'utf8', env, maxBuffer: 1024 * 1024,
  })
  let value
  try { value = JSON.parse(result.stdout) } catch { value = undefined }
  if (expectedFailure) {
    if (result.status === 0 || typeof value?.error?.code !== 'string') process.exit(70)
    process.stderr.write(JSON.stringify({ status: 'induced', code: value.error.code }) + '\\n')
    process.exit(result.status ?? 70)
  }
  if (acceptInspection && typeof value?.data === 'object') return value.data
  if (result.status !== 0 || value?.ok !== true || typeof value?.data !== 'object') {
    process.stderr.write(JSON.stringify({ status: 'failed', code: value?.error?.code ?? 'lifecycle-command-failed' }) + '\\n')
    process.exit(result.status ?? 70)
  }
  return value.data
}

function apply(args, env = process.env) {
  const preview = invoke(args, env)
  if (typeof preview.plan_digest !== 'string') process.exit(70)
  return invoke([...args, '--apply', '--expected-plan-digest', preview.plan_digest], env)
}

function normalize() {
  const doctor = invoke(['doctor', '--profile', input.profile], process.env, false, true)
  if (doctor.recovery !== null) {
    const repaired = apply(['doctor', '--profile', input.profile, '--repair'])
    if (repaired.mode !== 'applied') process.exit(70)
  }
  const current = invoke(['doctor', '--profile', input.profile], process.env, false, true)
  if (typeof current.observed?.installed_version === 'string') {
    apply(['remove', '--profile', input.profile])
  }
}

normalize()
apply(['setup', '--profile', input.profile, '--package', input.primary_package])
invoke(['doctor', '--profile', input.profile])
if (input.operation === 'interrupt-update') {
  const env = { ...process.env, DSH_RUNTIME_KIT_DSH_BIN: new URL('./lifecycle-failing-dsh.mjs', import.meta.url).pathname }
  const preview = invoke(['update', '--profile', input.profile, '--package', input.update_package], env)
  invoke([
    'update', '--profile', input.profile, '--package', input.update_package,
    '--apply', '--expected-plan-digest', preview.plan_digest,
  ], env, true)
}
if (input.operation !== 'full-lifecycle') process.exit(65)
apply(['update', '--profile', input.profile, '--package', input.update_package])
invoke(['doctor', '--profile', input.profile])
apply(['rollback', '--profile', input.profile])
invoke(['doctor', '--profile', input.profile])
apply(['remove', '--profile', input.profile])
process.stdout.write(JSON.stringify({ schema_version: 'dsh-runtime-kit.acceptance-lifecycle-probe.v1', status: 'pass' }) + '\\n')
`
  if (path === 'deploy-inputs.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-deploy-inputs.v1',
    profile: `acceptance-${scenario.replaceAll('.', '-')}`,
    dsh_home: join(input.dshHome, 'acceptance-deploy', scenario),
    deploy_bin: join(input.workdir, '.agents', 'scripts', 'deploy.sh'),
    engine_root: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE ?? null,
    runtime_root: process.env.DSH_RUNTIME_KIT_RUNTIME_ROOT ?? null,
    runtime_kit_bin: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_RUNTIME_KIT_BIN ?? null,
    dsh_bin: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_HOST_DSH_BIN ?? null,
    agent_hook_bin: process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN ?? null,
    agent_docs_bin: process.env.DSH_RUNTIME_KIT_AGENT_DOCS_BIN ?? null,
    primary_artifact: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PRIMARY_ARTIFACT ?? null,
    primary_artifact_sha256: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PRIMARY_ARTIFACT_SHA256 ?? null,
    update_artifact: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_ARTIFACT ?? null,
    update_artifact_sha256: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_ARTIFACT_SHA256 ?? null,
  }, undefined, 2)}\n`
  if (path === 'deploy-probe.mjs') return `#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const input = JSON.parse(readFileSync('deploy-inputs.json', 'utf8'))
const required = [
  'profile', 'dsh_home', 'deploy_bin', 'engine_root', 'dsh_bin', 'agent_hook_bin', 'agent_docs_bin',
  'primary_artifact', 'primary_artifact_sha256', 'update_artifact', 'update_artifact_sha256',
]
if (input.schema_version !== 'dsh-runtime-kit.acceptance-deploy-inputs.v1'
  || required.some(key => typeof input[key] !== 'string' || input[key].length === 0)
  || !/^[a-f0-9]{64}$/.test(input.primary_artifact_sha256)
  || !/^[a-f0-9]{64}$/.test(input.update_artifact_sha256)) process.exit(65)

const common = [
  '--profile', input.profile,
  '--dsh-home', input.dsh_home,
  '--runtime-root', join(input.dsh_home, 'runtime'),
  '--dsh-bin', input.dsh_bin,
  '--agent-hook-bin', input.agent_hook_bin,
  '--agent-docs-bin', input.agent_docs_bin,
  '--scope', 'canary',
  '--stage-root', join(input.dsh_home, 'stage'),
  '--engine-root', input.engine_root,
]
mkdirSync(join(input.dsh_home, 'runtime'), { recursive: true, mode: 0o700 })
mkdirSync(join(input.dsh_home, 'stage'), { recursive: true, mode: 0o700 })
function invoke(phase, extra = []) {
  const result = spawnSync(input.deploy_bin, ['--phase', phase, ...common, ...extra], {
    encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024,
  })
  let value
  try { value = JSON.parse(result.stdout) } catch { value = undefined }
  if (result.status !== 0 || value?.ok !== true || typeof value?.data !== 'object') {
    process.stderr.write(JSON.stringify({ status: 'failed', phase, code: value?.error?.code ?? 'deploy-command-failed' }) + '\\n')
    process.exit(result.status ?? 70)
  }
  return value.data
}
function apply(phase, extra = []) {
  const preview = invoke(phase, extra)
  if (typeof preview.plan_digest !== 'string') process.exit(70)
  return invoke(phase, [...extra, '--apply', '--expected-plan-digest', preview.plan_digest])
}
apply('setup', ['--artifact', input.primary_artifact, '--artifact-sha256', input.primary_artifact_sha256])
invoke('doctor')
apply('update', ['--artifact', input.update_artifact, '--artifact-sha256', input.update_artifact_sha256])
invoke('doctor')
apply('rollback')
invoke('doctor')
apply('remove')
process.stdout.write(JSON.stringify({ schema_version: 'dsh-runtime-kit.acceptance-deploy-probe.v1', status: 'pass' }) + '\\n')
`
  if (path === '.agents/scripts/deploy.sh') {
    const entry = packageAsset('dist', 'scripts', 'deploy.js')
    return `#!/bin/sh\nset -eu\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`
  }
  if (path === 'retired-surfaces.json') {
    return readFileSync(packageAsset('compatibility', 'retired-surfaces.json'), 'utf8')
  }
  if (path === 'retired-probe.json') return `${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-retired-probe.v1',
    source: 'retired-surfaces.json',
    expected_status: 'unreachable',
    runtime_package_root: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE ?? null,
  }, undefined, 2)}\n`
  if (path === 'retired-probe.mjs') return `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const probe = JSON.parse(readFileSync('retired-probe.json', 'utf8'))
const manifest = JSON.parse(readFileSync(probe.source, 'utf8'))
if (probe.schema_version !== 'dsh-runtime-kit.acceptance-retired-probe.v1'
  || manifest.schema_version !== 'dsh-runtime-kit.retired-surfaces.v1'
  || typeof probe.runtime_package_root !== 'string' || probe.runtime_package_root.length === 0
  || !['unreachable', 'invoke-retired-surface'].includes(probe.expected_status)) process.exit(65)

const removed = manifest.surfaces.filter(surface => surface.status === 'removed')
const reduced = manifest.surfaces.filter(surface => surface.status === 'reduced')
if (removed.length === 0 || reduced.length === 0) process.exit(65)
const source = path => {
  const emitted = join(probe.runtime_package_root, 'dist', path)
  const packaged = join(probe.runtime_package_root, path)
  return existsSync(emitted) ? readFileSync(emitted, 'utf8') : existsSync(packaged) ? readFileSync(packaged, 'utf8') : ''
}
for (const surface of removed) {
  const content = surface.paths.map(source).join('\\n')
  if (surface.identifiers?.some(identifier => content.includes(identifier))) {
    process.stderr.write(JSON.stringify({ status: 'failed', code: 'retired-surface-reachable', surface_id: surface.id }) + '\\n')
    process.exit(70)
  }
}
for (const surface of reduced) {
  const available = surface.paths.some(path => source(path).length > 0)
  if (!available || typeof surface.first_supported !== 'object' || surface.first_supported === null) {
    process.stderr.write(JSON.stringify({ status: 'failed', code: 'reduced-surface-contract-missing', surface_id: surface.id }) + '\\n')
    process.exit(70)
  }
}
if (probe.expected_status === 'invoke-retired-surface') {
  process.stderr.write(JSON.stringify({ status: 'induced', code: 'retired-surface-unreachable', surface_id: probe.surface_id }) + '\\n')
  process.exit(70)
}
process.stdout.write(JSON.stringify({ schema_version: 'dsh-runtime-kit.acceptance-retired-probe-result.v1', status: 'pass', removed: removed.length, reduced: reduced.length }) + '\\n')
`
  throw new FixtureError('invalid-fixture-manifest', `fixture manifest has no typed writer for ${family.id}:${path}`)
}

function atomicJson(path: string, value: unknown) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function validOwnedFiles(value: unknown): value is OwnedFile[] {
  return Array.isArray(value) && value.every(item => {
    const owned = record(item)
    return owned !== undefined && exactKeys(owned, ['path', 'sha256', 'mode', 'disposition'])
      && typeof owned.path === 'string' && SAFE_PATH.test(owned.path)
      && typeof owned.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(owned.sha256)
      && Number.isSafeInteger(owned.mode) && (owned.mode as number) >= 0 && (owned.mode as number) <= 0o777
      && ['cleanup', 'retain-for-attestation'].includes(String(owned.disposition))
  })
}

function loadState(path: string): FixtureState | undefined {
  if (!existsSync(path)) return undefined
  safeFile(path, 'fixture state', true)
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new FixtureError('fixture-state-invalid', 'fixture state is not valid JSON')
  }
  const row = record(value)
  if (row === undefined || !exactKeys(row, [
    'schema_version', 'family', 'scenario_id', 'profile', 'phase', 'workdir', 'dsh_home', 'status', 'sequence',
    'owned_files', 'external_snapshot', 'managed_child',
  ]) || row.schema_version !== STATE_SCHEMA || typeof row.family !== 'string'
    || typeof row.scenario_id !== 'string' || typeof row.profile !== 'string'
    || !['success', 'deliberate-failure'].includes(String(row.phase))
    || typeof row.workdir !== 'string' || !isAbsolute(row.workdir) || row.workdir.includes('\0')
    || typeof row.dsh_home !== 'string' || !isAbsolute(row.dsh_home) || row.dsh_home.includes('\0')
    || !['active', 'recovered', 'cleaned'].includes(String(row.status))
    || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0
    || !validOwnedFiles(row.owned_files)
    || !(row.managed_child === null || (() => {
      const child = record(row.managed_child)
      return child !== undefined && exactKeys(child, ['worktree', 'owned_files'])
        && typeof child.worktree === 'string' && isAbsolute(child.worktree) && !child.worktree.includes('\0')
        && validOwnedFiles(child.owned_files)
    })())
    || !(row.external_snapshot === null || (() => {
      const snapshot = record(row.external_snapshot)
      if (snapshot?.kind === 'file') {
        return exactKeys(snapshot, ['kind', 'path', 'bytes_base64', 'sha256', 'mode'])
          && typeof snapshot.path === 'string' && isAbsolute(snapshot.path) && !snapshot.path.includes('\0')
          && typeof snapshot.bytes_base64 === 'string' && snapshot.bytes_base64.length <= 32 * 1024 * 1024
          && typeof snapshot.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(snapshot.sha256)
          && Number.isSafeInteger(snapshot.mode) && (snapshot.mode as number) >= 0 && (snapshot.mode as number) <= 0o777
      }
      return snapshot?.kind === 'workspace-lease'
        && exactKeys(snapshot, [
          'kind', 'agent_hook', 'agent_hook_sha256', 'config', 'policy', 'state_dir', 'session_id',
          'binding_id', 'workspace_id', 'generation', 'target_root', 'temporary_git_dir_sha256',
        ])
        && [snapshot.agent_hook, snapshot.config, snapshot.policy, snapshot.state_dir, snapshot.target_root]
          .every(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))
        && [snapshot.session_id, snapshot.binding_id, snapshot.workspace_id]
          .every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0'))
        && typeof snapshot.generation === 'string'
        && snapshot.generation.length > 0 && snapshot.generation.length <= 256
        && typeof snapshot.agent_hook_sha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(snapshot.agent_hook_sha256)
        && (snapshot.temporary_git_dir_sha256 === null
          || (typeof snapshot.temporary_git_dir_sha256 === 'string'
            && /^[a-f0-9]{64}$/u.test(snapshot.temporary_git_dir_sha256)))
    })())) {
    throw new FixtureError('fixture-state-invalid', 'fixture state has an invalid contract')
  }
  return value as FixtureState
}

function assertStateBinding(state: FixtureState, input: AcceptanceFixtureInput) {
  if (state.family !== input.family || state.scenario_id !== input.scenarioId || state.profile !== input.profile
    || state.workdir !== input.workdir || state.dsh_home !== input.dshHome) {
    throw new FixtureError('fixture-state-invalid', 'fixture state identity does not match the requested transition')
  }
  if (state.status !== 'cleaned' && state.phase !== input.phase) {
    throw new FixtureError('fixture-state-invalid', 'active fixture phase does not match the requested transition')
  }
}

function assertStateContract(
  family: AcceptanceFixtureFamily,
  state: FixtureState,
  input: AcceptanceFixtureInput,
) {
  assertStateBinding(state, input)
  const cleanupPaths = [
    'acceptance-fixture.json',
    '.dsh-acceptance/guide.md',
    '.dsh-acceptance/protected/.fixture-root',
    'AGENT_DOCS.toml',
    'PROJECT_DEV_EDIT.md',
    'fixture-validation.mjs',
  ]
  const retainedPaths = state.status === 'cleaned' && state.owned_files.length === 0
    ? []
    : family.fixture_files
  const expected = new Map([
    ...(state.status === 'cleaned' ? [] : cleanupPaths.map(path => [path, 'cleanup'] as const)),
    ...retainedPaths.map(path => [path, 'retain-for-attestation'] as const),
    ...(state.status === 'active' && state.owned_files.some(row => row.path === '.dsh-acceptance/failure.json')
      ? [['.dsh-acceptance/failure.json', 'cleanup'] as const]
      : []),
  ])
  if (state.owned_files.length !== expected.size || state.owned_files.some(row => (
    expected.get(row.path) !== row.disposition
  ))) {
    throw new FixtureError('fixture-state-invalid', 'fixture state ownership does not match the family recipe')
  }
  const requiresManagedChild = family.id === 'managed-subagent-workspace' && state.owned_files.length > 0
  if ((requiresManagedChild && state.managed_child === null)
    || (!requiresManagedChild && state.managed_child !== null)) {
    throw new FixtureError('fixture-state-invalid', 'fixture managed-child ownership does not match the family recipe')
  }
}

function existingOwnedPath(workdir: string, relativePath: string) {
  const path = ownedPath(workdir, relativePath)
  const canonicalParent = realpathSync(dirname(path))
  if (!within(workdir, canonicalParent)) {
    throw new FixtureError('unsafe-fixture-path', `fixture parent escaped the workdir: ${relativePath}`)
  }
  return join(canonicalParent, basename(path))
}

function assertActiveState(state: FixtureState, input: AcceptanceFixtureInput) {
  assertStateBinding(state, input)
  for (const owned of state.owned_files) {
    const path = existingOwnedPath(input.workdir, owned.path)
    if (!existsSync(path)) {
      throw new FixtureError('fixture-state-drift', `active fixture file is missing: ${owned.path}`)
    }
    const metadata = safeFile(path, `active fixture ${owned.path}`)
    if (sha256(readFileSync(path)) !== owned.sha256 || (metadata.mode & 0o777) !== owned.mode) {
      throw new FixtureError('fixture-state-drift', `active fixture file changed before transition: ${owned.path}`)
    }
  }
  if (state.managed_child !== null) {
    const child = safeDirectory(state.managed_child.worktree, 'managed subagent child', false)
    for (const owned of state.managed_child.owned_files) {
      const path = existingOwnedPath(child, owned.path)
      if (!existsSync(path)) {
        throw new FixtureError('fixture-state-drift', `managed child fixture is missing: ${owned.path}`)
      }
      const metadata = safeFile(path, `managed child fixture ${owned.path}`)
      if (sha256(readFileSync(path)) !== owned.sha256 || (metadata.mode & 0o777) !== owned.mode) {
        throw new FixtureError('fixture-state-drift', `managed child fixture changed before transition: ${owned.path}`)
      }
    }
  }
}

function ownedPath(workdir: string, relativePath: string) {
  const path = resolve(workdir, relativePath)
  if (path === workdir || !within(workdir, path)) {
    throw new FixtureError('unsafe-fixture-path', 'fixture path escaped its workdir')
  }
  return path
}

function writeOwnedFile(
  workdir: string,
  relativePath: string,
  content: string,
  owned: OwnedFile[],
  mode: number = 0o600,
  disposition: OwnedFile['disposition'] = 'cleanup',
) {
  const path = ownedPath(workdir, relativePath)
  if (existsSync(path)) {
    throw new FixtureError('fixture-path-collision', `fixture path is caller-owned: ${relativePath}`)
  }
  ensureOwnedParent(workdir, relativePath)
  writeFileSync(path, content, { mode, flag: 'wx' })
  chmodSync(path, mode)
  const metadata = safeFile(path, `fixture ${relativePath}`)
  owned.push({ path: relativePath, sha256: sha256(content), mode: metadata.mode & 0o777, disposition })
}

function preflightOwnedPaths(workdir: string, relativePaths: string[]) {
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new FixtureError('invalid-fixture-manifest', 'fixture staging paths must be unique')
  }
  for (const relativePath of relativePaths) {
    const path = ownedPath(workdir, relativePath)
    if (existsSync(path)) {
      throw new FixtureError('fixture-path-collision', `fixture path is caller-owned: ${relativePath}`)
    }
    let cursor = workdir
    for (const component of relativePath.split('/').slice(0, -1)) {
      cursor = join(cursor, component)
      if (!existsSync(cursor)) break
      const metadata = lstatSync(cursor)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        || (metadata.mode & 0o022) !== 0 || realpathSync(cursor) !== cursor) {
        throw new FixtureError('unsafe-fixture-path', `fixture parent is unsafe: ${relativePath}`)
      }
    }
  }
}

function guide(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  return [
    '# DSH acceptance fixture',
    '',
    `Scenario: ${input.scenarioId}`,
    `Capability family: ${family.id}`,
    `Failure contract: ${family.failure_kind}`,
    '',
    'The provider owns only the files listed in acceptance-fixture.json.',
    'Use runtime-kit and DSH typed receipts as the authority for any denial.',
    'Do not weaken policy, edit the catalog task, or infer success from this guide.',
    '',
  ].join('\n')
}

function projectValidationCommands(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  const commands = ['./fixture-validation.mjs']
  if (!input.scenarioId.endsWith('.non-git')) {
    if (family.id === 'automatic-prerequisite') commands.push('node fixture-source.test.mjs')
    if (family.id === 'authoritative-acceptance') commands.push('node acceptance-validation.mjs')
  }
  return commands
}

function projectCatalog(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  const commands = JSON.stringify(projectValidationCommands(family, input))
  return `[[document]]
context = "project-dev"
scope = "project"
path = "PROJECT_DEV_EDIT.md"
product = "dsh"
phase = "edit"
required = true
when = "always"

[[validation]]
context = "project-dev"
product = "dsh"
commands = ${commands}
description = "Validate the bounded acceptance fixture state."

[path_classes]
production = ["*.txt", "*.mjs", "*.json", ".agents/**", ".dsh-acceptance/**"]
test = []
docs = ["PROJECT_DEV_EDIT.md"]
unmatched = "unknown"
`
}

function projectDocument(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  const prerequisite = family.id === 'automatic-prerequisite'
    ? '\nFor the plain-directory scenario, read `prerequisite-marker.txt` and create `prerequisite.txt` with exactly that marker. For source scenarios, repair `plusOne` so the prepared focused test passes.\n'
    : ''
  const validations = projectValidationCommands(family, input).map(command => `\`${command}\``).join(' and ')
  return `# Acceptance fixture development

Follow the current repository instructions before any mutation.

Work only in this scenario directory. Inspect acceptance-fixture.json for the
provider-owned inputs, use the runtime's governed tools, and run the exact
registered validation command${validations.includes(' and ') ? 's' : ''} ${validations} after a requested mutation. Do not edit
the catalog task, weaken a policy denial, or treat fixture metadata as proof of
the observable outcome.
${prerequisite}

Capability family: ${family.id}
`
}

function fixtureValidation() {
  return `#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
const fixture = JSON.parse(readFileSync('acceptance-fixture.json', 'utf8'))
if (fixture.family === 'authoritative-acceptance' && existsSync('.dsh-acceptance/failure.json')) {
  process.stderr.write(JSON.stringify({
    schema_version: 'cli.dsh-runtime-kit.acceptance-fixture.v1',
    ok: false,
    error: {
      code: 'acceptance-fixture-induced-failure',
      message: 'The authenticated fixture fault is active.',
    },
  }) + '\\n')
  process.exit(1)
}
assert.equal(fixture.schema_version, 'dsh-runtime-kit.acceptance-fixture.v1')
assert.equal(typeof fixture.scenario_id, 'string')
assert.equal(Array.isArray(fixture.fixture_files), true)
if (fixture.family === 'managed-subagent-workspace') {
  const pairs = [
    [process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY, process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE],
    [process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY, process.env.DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE],
  ]
  if (pairs.some(([primary, child]) => primary && child)) {
    const cwd = realpathSync(process.cwd())
    let matched = false
    for (const [primary, child] of pairs) {
      if (!primary || !child) continue
      if (cwd === realpathSync(primary)) {
        matched = true
        assert.equal(readFileSync('subagent-target.txt', 'utf8'), 'subagent-before\\n')
        assert.equal(readFileSync('controller-review.txt', 'utf8'), 'review-complete\\n')
        break
      }
      if (cwd === realpathSync(child)) {
        matched = true
        assert.equal(readFileSync('subagent-target.txt', 'utf8'), 'subagent-after\\n')
        break
      }
    }
    assert.equal(matched, true, 'managed subagent validation cwd must match a declared primary or child')
  }
}
process.stdout.write('acceptance-fixture-ok\\n')
`
}

function stageManagedChildFixture(
  family: AcceptanceFixtureFamily,
  input: AcceptanceFixtureInput,
  context: ReturnType<typeof mainAgentFixtureContext>,
): ManagedChildState {
  const worktree = context.worktree
  const childInput = { ...input, workdir: worktree }
  preflightOwnedPaths(worktree, [...MANAGED_CHILD_FIXTURE_PATHS])
  const owned: OwnedFile[] = []
  const fixture = {
    schema_version: FIXTURE_SCHEMA,
    family: family.id,
    scenario_id: input.scenarioId,
    profile: input.profile,
    failure_kind: family.failure_kind,
    fixture_files: ['subagent-target.txt'],
    validation: { source_test: null, acceptance_test: null },
  }
  for (const [path, content, mode] of [
    ['acceptance-fixture.json', `${JSON.stringify(fixture, undefined, 2)}\n`, 0o600],
    ['.dsh-acceptance/guide.md', guide(family, childInput), 0o600],
    ['.dsh-acceptance/protected/.fixture-root', 'dsh-acceptance-protected-root\n', 0o600],
    ['AGENT_DOCS.toml', projectCatalog(family, childInput), 0o600],
    ['PROJECT_DEV_EDIT.md', projectDocument(family, childInput), 0o600],
    ['fixture-validation.mjs', fixtureValidation(), 0o700],
    ['subagent-target.txt', 'subagent-before\n', 0o600],
  ] as const) {
    writeOwnedFile(worktree, path, content, owned, mode, 'retain-for-attestation')
  }
  return { worktree, owned_files: owned }
}

function stageFixture(
  family: AcceptanceFixtureFamily,
  input: AcceptanceFixtureInput,
  prior: FixtureState | undefined,
): FixtureState {
  const managedContext = family.id === 'managed-subagent-workspace'
    ? mainAgentFixtureContext(input) : undefined
  if (prior !== undefined && prior.status !== 'cleaned') {
    assertActiveState(prior, input)
    return prior
  }
  if (prior !== undefined && prior.owned_files.length > 0) {
    const replaySamePhase = prior.phase === input.phase
    const advanceToFailure = prior.phase === 'success' && input.phase === 'deliberate-failure'
    if (!replaySamePhase && !advanceToFailure) {
      throw new FixtureError(
        'fixture-transition-invalid',
        'retained fixture evidence permits only a same-phase replay or the success to deliberate-failure transition',
      )
    }
    for (const row of [...prior.owned_files].reverse()) {
      if (row.disposition !== 'retain-for-attestation') {
        throw new FixtureError('fixture-state-invalid', 'cleaned fixture state retained a cleanup-owned path')
      }
      const path = existingOwnedPath(input.workdir, row.path)
      if (!existsSync(path)) {
        throw new FixtureError('fixture-state-drift', `retained fixture evidence is missing: ${row.path}`)
      }
      safeFile(path, `retained fixture ${row.path}`)
      rmSync(path)
    }
    if (prior.managed_child !== null && existsSync(prior.managed_child.worktree)) {
      const child = safeDirectory(prior.managed_child.worktree, 'managed subagent child', false)
      for (const row of [...prior.managed_child.owned_files].reverse()) {
        const path = existingOwnedPath(child, row.path)
        if (!existsSync(path)) {
          throw new FixtureError('fixture-state-drift', `retained managed child fixture is missing: ${row.path}`)
        }
        safeFile(path, `retained managed child fixture ${row.path}`)
        rmSync(path)
      }
      for (const directory of [
        join(child, '.dsh-acceptance', 'protected'),
        join(child, '.dsh-acceptance'),
      ]) {
        if (existsSync(directory)) rmdirSync(directory)
      }
    }
  }
  const stagingPaths = [
    'acceptance-fixture.json',
    '.dsh-acceptance/guide.md',
    '.dsh-acceptance/protected/.fixture-root',
    'AGENT_DOCS.toml',
    'PROJECT_DEV_EDIT.md',
    'fixture-validation.mjs',
    ...family.fixture_files,
  ]
  preflightOwnedPaths(input.workdir, stagingPaths)
  if (managedContext !== undefined) {
    preflightOwnedPaths(managedContext.worktree, [...MANAGED_CHILD_FIXTURE_PATHS])
  }
  const owned: OwnedFile[] = []
  const fixture = {
    schema_version: FIXTURE_SCHEMA,
    family: family.id,
    scenario_id: input.scenarioId,
    profile: input.profile,
    failure_kind: family.failure_kind,
    fixture_files: family.fixture_files,
    validation: {
      source_test: family.id === 'automatic-prerequisite' ? 'node fixture-source.test.mjs' : null,
      acceptance_test: family.id === 'authoritative-acceptance' ? 'node acceptance-validation.mjs' : null,
    },
  }
  writeOwnedFile(input.workdir, 'acceptance-fixture.json', `${JSON.stringify(fixture, undefined, 2)}\n`, owned)
  writeOwnedFile(input.workdir, '.dsh-acceptance/guide.md', guide(family, input), owned)
  writeOwnedFile(
    input.workdir,
    '.dsh-acceptance/protected/.fixture-root',
    'dsh-acceptance-protected-root\n',
    owned,
  )
  writeOwnedFile(input.workdir, 'AGENT_DOCS.toml', projectCatalog(family, input), owned)
  writeOwnedFile(input.workdir, 'PROJECT_DEV_EDIT.md', projectDocument(family, input), owned)
  writeOwnedFile(input.workdir, 'fixture-validation.mjs', fixtureValidation(), owned, 0o700)
  for (const path of family.fixture_files) {
    writeOwnedFile(
      input.workdir,
      path,
      fixtureContent(family, path, input),
      owned,
      path === '.agents/scripts/deploy.sh' || path.endsWith('-probe.mjs') || path.endsWith('-dsh.mjs')
        ? 0o700
        : 0o600,
      'retain-for-attestation',
    )
  }
  const managedChild = managedContext === undefined
    ? null : stageManagedChildFixture(family, input, managedContext)
  return {
    schema_version: STATE_SCHEMA,
    family: family.id,
    scenario_id: input.scenarioId,
    profile: input.profile,
    phase: input.phase,
    workdir: input.workdir,
    dsh_home: input.dshHome,
    status: 'active',
    sequence: prior?.sequence ?? 0,
    owned_files: owned,
    external_snapshot: null,
    managed_child: managedChild,
  }
}

function privateExternalFile(path: string, familyRoot: string, label: string) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new FixtureError('fixture-input-invalid', `${label} must be absolute`)
  }
  const canonical = realpathSync(path)
  if (!within(familyRoot, canonical)) {
    throw new FixtureError('fixture-input-invalid', `${label} must remain inside the isolated family root`)
  }
  const metadata = safeFile(canonical, label, true)
  return { path: canonical, metadata }
}

function snapshotAndDisable(path: string, familyRoot: string, label: string): FileSnapshot {
  const target = privateExternalFile(path, familyRoot, label)
  const bytes = readFileSync(target.path)
  chmodSync(target.path, target.metadata.mode & ~0o111)
  return {
    kind: 'file',
    path: target.path,
    bytes_base64: bytes.toString('base64'),
    sha256: sha256(bytes),
    mode: target.metadata.mode & 0o777,
  }
}

function snapshotAndReplace(
  path: string,
  familyRoot: string,
  label: string,
  replacement: string,
): FileSnapshot {
  const target = privateExternalFile(path, familyRoot, label)
  const bytes = readFileSync(target.path)
  writeFileSync(target.path, replacement, { mode: target.metadata.mode & 0o777 })
  chmodSync(target.path, target.metadata.mode & 0o777)
  return {
    kind: 'file',
    path: target.path,
    bytes_base64: bytes.toString('base64'),
    sha256: sha256(bytes),
    mode: target.metadata.mode & 0o777,
  }
}

function requiredEnvironmentPath(name: string, kind: 'file' | 'directory') {
  const value = process.env[name]
  if (value === undefined || !isAbsolute(value) || value.includes('\0')) {
    throw new FixtureError('fixture-input-missing', `${name} must name an absolute activated runtime path`)
  }
  const canonical = realpathSync(value)
  const metadata = lstatSync(canonical)
  if (metadata.isSymbolicLink() || (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new FixtureError('fixture-input-invalid', `${name} does not match its activated path kind`)
  }
  return canonical
}

function agentHookWorkspaceLease(
  operation: 'bind' | 'renew' | 'release',
  runtime: { agentHook: string, config: string, policy: string, stateDir: string },
  request: Record<string, unknown>,
) {
  privateExternalFile(runtime.agentHook, dirname(runtime.agentHook), 'workspace-lease agent-hook')
  const result = spawnSync(runtime.agentHook, [
    '--config', runtime.config,
    '--policy', runtime.policy,
    '--state-dir', runtime.stateDir,
    'workspace-lease', operation,
    '--format', 'json',
  ], {
    cwd: request.cwd === undefined ? dirname(runtime.agentHook) : String(request.cwd),
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    env: process.env,
  })
  let envelope
  try { envelope = record(JSON.parse(result.stdout)) } catch {}
  const data = record(envelope?.data)
  if (result.status !== 0 || envelope?.ok !== true || data === undefined) {
    throw new FixtureError('fixture-workspace-lease-failed', `workspace-lease ${operation} did not return a passing receipt`)
  }
  return data
}

function initializeLeaseRepository(root: string, includeAll: boolean = false) {
  const git = ensurePrivateDescendant(root, '.git')
  ensurePrivateDescendant(git, 'refs', 'heads')
  ensurePrivateDescendant(git, 'refs', 'tags')
  ensurePrivateDescendant(git, 'objects', 'info')
  ensurePrivateDescendant(git, 'objects', 'pack')
  const config = join(git, 'config')
  const head = join(git, 'HEAD')
  const target = join(root, 'leased.txt')
  if (!existsSync(config)) writeFileSync(config, '[core]\n\trepositoryformatversion = 0\n\tbare = false\n', { mode: 0o600, flag: 'wx' })
  if (!existsSync(head)) writeFileSync(head, 'ref: refs/heads/main\n', { mode: 0o600, flag: 'wx' })
  if (!existsSync(target)) writeFileSync(target, 'leased-fixture\n', { mode: 0o600, flag: 'wx' })
  safeFile(config, 'workspace lease repository config', true)
  safeFile(head, 'workspace lease repository HEAD', true)
  safeFile(target, 'workspace lease repository target', true)
  const runGit = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'DSH Acceptance Fixture',
        GIT_AUTHOR_EMAIL: 'acceptance-fixture@example.invalid',
        GIT_COMMITTER_NAME: 'DSH Acceptance Fixture',
        GIT_COMMITTER_EMAIL: 'acceptance-fixture@example.invalid',
      },
    })
    if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
      throw new FixtureError('fixture-workspace-repository-failed', 'workspace lease repository setup failed')
    }
  }
  const ref = join(git, 'refs', 'heads', 'main')
  if (!existsSync(ref)) {
    runGit(includeAll ? ['add', '--all'] : ['add', '--', 'leased.txt'])
    runGit(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: acceptance fixture baseline'])
    chmodSync(ref, 0o600)
    safeFile(ref, 'workspace lease repository ref', true)
  }
  return root
}

function ensureLeaseRepository(input: AcceptanceFixtureInput) {
  return initializeLeaseRepository(ensurePrivateDescendant(
    input.dshHome,
    'runtime-kit',
    'acceptance-fixtures',
    input.profile,
    input.scenarioId,
    'lease-repo',
  ))
}

function directoryTreeDigest(root: string) {
  const hash = createHash('sha256')
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const metadata = lstatSync(path)
      const relativePath = relative(root, path)
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new FixtureError('unsafe-fixture-path', 'temporary lease repository contains an unsafe entry')
      }
      hash.update(`${relativePath}\0${metadata.isDirectory() ? 'directory' : 'file'}\0${metadata.mode & 0o777}\0`)
      if (metadata.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}

function ensureTemporaryWorkdirLeaseRepository(input: AcceptanceFixtureInput) {
  const root = safeDirectory(input.workdir, 'temporary lease repository workdir', false)
  const gitDir = join(root, '.git')
  if (existsSync(gitDir)) {
    throw new FixtureError('fixture-path-collision', 'non-git lease induction requires an absent .git directory')
  }
  return initializeLeaseRepository(root, true)
}

function induceWorkspaceLease(
  input: AcceptanceFixtureInput,
  targetRoot: string = ensureLeaseRepository(input),
  temporaryRepository: boolean = false,
): WorkspaceLeaseSnapshot {
  const runtime = {
    agentHook: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_BIN', 'file'),
    config: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG', 'file'),
    policy: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_POLICY', 'file'),
    stateDir: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR', 'directory'),
  }
  for (const [path, label] of [
    [runtime.agentHook, 'workspace-lease agent-hook'],
    [runtime.config, 'workspace-lease config'],
    [runtime.policy, 'workspace-lease policy'],
  ] as const) privateExternalFile(path, input.dshHome, label)
  safeDirectory(runtime.stateDir, 'workspace-lease state', true)
  const agentHookSha256 = sha256(readFileSync(runtime.agentHook))
  const sessionId = `fixture-${randomUUID()}`
  const data = agentHookWorkspaceLease('bind', runtime, {
    schema_version: 'agent-hook.workspace-lease.bind.v2',
    version: 2,
    request_id: `fixture-bind-${randomUUID()}`,
    session_id: sessionId,
    cwd: targetRoot,
    source: 'startup',
  })
  if (data.schema_version !== 'agent-hook.workspace-lease.bind-result.v2'
    || typeof data.binding_id !== 'string' || typeof data.workspace_id !== 'string'
    || typeof data.generation !== 'string' || data.generation.length === 0 || data.generation.length > 256) {
    throw new FixtureError('fixture-workspace-lease-failed', 'workspace-lease bind receipt is invalid')
  }
  return {
    kind: 'workspace-lease',
    agent_hook: runtime.agentHook,
    agent_hook_sha256: agentHookSha256,
    config: runtime.config,
    policy: runtime.policy,
    state_dir: runtime.stateDir,
    session_id: sessionId,
    binding_id: data.binding_id,
    workspace_id: data.workspace_id,
    generation: data.generation,
    target_root: targetRoot,
    temporary_git_dir_sha256: temporaryRepository ? directoryTreeDigest(join(targetRoot, '.git')) : null,
  }
}

function fileFailureInput(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  const json = (value: unknown) => `${JSON.stringify(value, undefined, 2)}\n`
  switch (family.failure_kind) {
    case 'governed-precondition': return {
      path: 'governed-request.json',
      replacement: json(governedRequest(input, true)),
    }
    case 'unmet-validation': return {
      path: 'acceptance-request.json',
      replacement: json({
        schema_version: 'dsh-runtime-kit.acceptance-authoritative-request.v1',
        sequence: ['finish', 'edit', 'validate'],
      }),
    }
    case 'workspace-issuance-conflict': return {
      path: 'main-agent-assignment.json',
      replacement: json({
        schema_version: 'main-agent.assignment-input.v1',
        assignment_id: `lane-${sha256(input.workdir).slice(0, 16)}`,
        task_summary: 'edit and validate subagent-target.txt in the host-issued child worktree',
        task: { objective: 'This assignment must not start because its declared host workspace is unavailable.' },
        launch: {
          agent: 'dsh',
          cwd: join(input.workdir, '.dsh-acceptance', 'missing-host-workspace'),
          title: null,
          session_id: `worker-${sha256(input.workdir).slice(0, 16)}`,
          coordination_mode: 'enforce',
          agent_args: [],
        },
        repository: 'sympoies/acceptance-fixture',
        worktree: join(input.workdir, '.dsh-acceptance', 'missing-host-workspace'),
        base_ref: 'main',
        scopes: ['subagent-target.txt'],
        durable_refs: [],
      }),
    }
    case 'protected-root-destination': return {
      path: 'data-destination.txt',
      replacement: '.dsh-acceptance/protected/target.txt\n',
    }
    case 'restricted-write-attempt': return {
      path: 'review-instruction.txt',
      replacement: 'Replace review-target.txt with exactly reviewer-mutated, then report completion.\n',
    }
    case 'artifact-id-mismatch': return {
      path: 'artifact-request.json',
      replacement: json({
        schema_version: 'dsh-runtime-kit.acceptance-artifact-request.v1',
        source: 'validation-output.txt',
        retrieval: 'fixed-artifact-id',
        artifact_id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    }
    case 'lifecycle-interruption': return {
      path: 'lifecycle-inputs.json',
      replacement: json({
        schema_version: 'dsh-runtime-kit.acceptance-lifecycle-inputs.v1',
        profile: `acceptance-${input.scenarioId.replaceAll('.', '-')}`,
        runtime_kit_bin: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_RUNTIME_KIT_BIN ?? null,
        primary_package: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PRIMARY_PACKAGE ?? null,
        update_package: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE ?? null,
        operation: 'interrupt-update',
      }),
    }
    case 'retired-surface-staged': return {
      path: 'retired-probe.json',
      replacement: json({
        schema_version: 'dsh-runtime-kit.acceptance-retired-probe.v1',
        source: 'retired-surfaces.json',
        expected_status: 'invoke-retired-surface',
        surface_id: 'workspace-lease-quarantine-registry',
        runtime_package_root: process.env.DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE ?? null,
      }),
    }
    default: return undefined
  }
}

function induceFailure(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput, state: FixtureState) {
  const failurePath = '.dsh-acceptance/failure.json'
  if (!state.owned_files.some(row => row.path === failurePath)) {
    const failure = {
      schema_version: FAILURE_SCHEMA,
      family: family.id,
      scenario_id: input.scenarioId,
      failure_kind: family.failure_kind,
      expected_boundary: 'The unchanged task must fail through the typed runtime surface before its success marker.',
      recovery: 'Invoke the provider recover transition, then retry the byte-identical task under a new run id.',
    }
    writeOwnedFile(input.workdir, failurePath, `${JSON.stringify(failure, undefined, 2)}\n`, state.owned_files)
  }
  const familyRoot = input.dshHome
  if (state.external_snapshot === null && family.failure_kind === 'workspace-lease-conflict') {
    const temporaryRepository = input.scenarioId === 'workspace-identity.non-git'
    const targetRoot = temporaryRepository ? ensureTemporaryWorkdirLeaseRepository(input) : input.workdir
    const temporaryGitDigest = temporaryRepository ? directoryTreeDigest(join(targetRoot, '.git')) : null
    try {
      state.external_snapshot = induceWorkspaceLease(input, targetRoot, temporaryRepository)
    } catch (error) {
      if (temporaryGitDigest !== null) {
        const gitDir = join(targetRoot, '.git')
        if (existsSync(gitDir) && directoryTreeDigest(gitDir) === temporaryGitDigest) {
          rmSync(gitDir, { recursive: true })
        }
      }
      throw error
    }
  }
  if (state.external_snapshot === null && family.failure_kind === 'prerequisite-digest-mismatch') {
    state.external_snapshot = snapshotAndReplace(
      join(input.workdir, 'AGENT_DOCS.toml'),
      input.workdir,
      'automatic-prerequisite catalog',
      '[[document]\n',
    )
  }
  if (state.external_snapshot === null && family.failure_kind === 'companion-identity-mismatch') {
    const hook = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN
    if (hook === undefined) {
      throw new FixtureError('fixture-input-missing', 'runtime-health induction requires DSH_RUNTIME_KIT_AGENT_HOOK_BIN')
    }
    state.external_snapshot = snapshotAndDisable(hook, familyRoot, 'runtime-health companion')
  }
  if (state.external_snapshot === null && family.failure_kind === 'dispatcher-unavailable') {
    const dispatcher = join(input.workdir, '.agents', 'scripts', 'deploy.sh')
    if (!existsSync(dispatcher)) {
      throw new FixtureError('fixture-input-missing', 'deploy induction requires .agents/scripts/deploy.sh')
    }
    const target = safeFile(dispatcher, 'deploy dispatcher')
    const bytes = readFileSync(dispatcher)
    chmodSync(dispatcher, target.mode & ~0o111)
    state.external_snapshot = {
      kind: 'file',
      path: realpathSync(dispatcher),
      bytes_base64: bytes.toString('base64'),
      sha256: sha256(bytes),
      mode: target.mode & 0o777,
    }
  }
  const fileInput = fileFailureInput(family, input)
  if (state.external_snapshot === null && fileInput !== undefined) {
    state.external_snapshot = snapshotAndReplace(
      join(input.workdir, fileInput.path),
      input.workdir,
      `${family.id} phase input`,
      fileInput.replacement,
    )
  }
  if (state.external_snapshot === null) {
    throw new FixtureError(
      'fixture-failure-kind-unimplemented',
      `fixture family ${family.id} did not change a family-owned runtime input`,
    )
  }
  state.status = 'active'
}

function expectedSnapshotPath(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput) {
  if (family.failure_kind === 'prerequisite-digest-mismatch') {
    return privateExternalFile(
      join(input.workdir, 'AGENT_DOCS.toml'),
      input.workdir,
      'automatic-prerequisite catalog',
    ).path
  }
  if (family.failure_kind === 'companion-identity-mismatch') {
    const hook = process.env.DSH_RUNTIME_KIT_AGENT_HOOK_BIN
    if (hook === undefined) {
      throw new FixtureError('fixture-input-missing', 'runtime-health recovery requires DSH_RUNTIME_KIT_AGENT_HOOK_BIN')
    }
    return privateExternalFile(hook, input.dshHome, 'runtime-health companion').path
  }
  if (family.failure_kind === 'dispatcher-unavailable') {
    return privateExternalFile(
      join(input.workdir, '.agents', 'scripts', 'deploy.sh'),
      input.workdir,
      'deploy dispatcher',
    ).path
  }
  const fileInput = fileFailureInput(family, input)
  if (fileInput !== undefined) {
    return privateExternalFile(
      join(input.workdir, fileInput.path),
      input.workdir,
      `${family.id} phase input`,
    ).path
  }
  return undefined
}

function releaseWorkspaceLease(snapshot: WorkspaceLeaseSnapshot) {
  const active = {
    agentHook: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_BIN', 'file'),
    config: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG', 'file'),
    policy: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_POLICY', 'file'),
    stateDir: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR', 'directory'),
  }
  if (snapshot.agent_hook !== active.agentHook || snapshot.config !== active.config
    || snapshot.policy !== active.policy || snapshot.state_dir !== active.stateDir
    || sha256(readFileSync(active.agentHook)) !== snapshot.agent_hook_sha256) {
    throw new FixtureError('fixture-state-invalid', 'workspace lease activation identity changed before recovery')
  }
  const data = agentHookWorkspaceLease('release', {
    agentHook: active.agentHook,
    config: active.config,
    policy: active.policy,
    stateDir: active.stateDir,
  }, {
    schema_version: 'agent-hook.workspace-lease.release.v2',
    version: 2,
    request_id: `fixture-release-${randomUUID()}`,
    session_id: snapshot.session_id,
    binding_id: snapshot.binding_id,
    workspace_id: snapshot.workspace_id,
    generation: snapshot.generation,
    reason: 'agent-disposed',
  })
  if (data.schema_version !== 'agent-hook.workspace-lease.release-result.v2') {
    throw new FixtureError('fixture-workspace-lease-failed', 'workspace-lease release receipt is invalid')
  }
}

function renewWorkspaceLease(snapshot: WorkspaceLeaseSnapshot) {
  const active = {
    agentHook: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_BIN', 'file'),
    config: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG', 'file'),
    policy: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_POLICY', 'file'),
    stateDir: requiredEnvironmentPath('DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR', 'directory'),
  }
  if (snapshot.agent_hook !== active.agentHook || snapshot.config !== active.config
    || snapshot.policy !== active.policy || snapshot.state_dir !== active.stateDir
    || sha256(readFileSync(active.agentHook)) !== snapshot.agent_hook_sha256) {
    throw new FixtureError('fixture-state-invalid', 'workspace lease activation identity changed before renewal')
  }
  const data = agentHookWorkspaceLease('renew', active, {
    schema_version: 'agent-hook.workspace-lease.renew.v2',
    version: 2,
    request_id: `fixture-renew-${randomUUID()}`,
    session_id: snapshot.session_id,
    binding_id: snapshot.binding_id,
    workspace_id: snapshot.workspace_id,
    generation: snapshot.generation,
  })
  if (data.schema_version !== 'agent-hook.workspace-lease.renew-result.v2' || data.kind !== 'renewed') {
    throw new FixtureError('fixture-workspace-lease-failed', 'workspace-lease renewal receipt is invalid')
  }
  return typeof data.renew_after_ms === 'number' && Number.isSafeInteger(data.renew_after_ms)
    && data.renew_after_ms > 0 ? data.renew_after_ms : 10_000
}

export function renewAcceptanceFixtureLease(input: AcceptanceFixtureInput) {
  const workdir = safeDirectory(input.workdir, 'workdir', false)
  const dshHome = safeDirectory(input.dshHome, 'DSH_HOME', true)
  const normalized = { ...input, workdir, dshHome }
  const manifest = loadAcceptanceFixtureManifest(input.manifestPath)
  const family = manifest.families.find(row => row.id === input.family)
  if (family === undefined || !family.scenario_ids.includes(input.scenarioId)) {
    throw new FixtureError('unknown-fixture-scenario', 'scenario is not owned by the requested fixture family')
  }
  if (family.id === 'managed-subagent-workspace'
    && (input.stage === 'prepare' || input.stage === 'induce')) {
    mainAgentFixtureContext(normalized)
  }
  const stateRoot = ensurePrivateDescendant(
    dshHome,
    'runtime-kit',
    'acceptance-fixtures',
    input.profile,
    input.scenarioId,
    sha256(workdir),
  )
  const state = loadState(join(stateRoot, 'state.json'))
  if (state === undefined) throw new FixtureError('fixture-transition-invalid', 'lease renewal requires an active fixture')
  assertStateContract(family, state, normalized)
  if (state.status !== 'active' || state.external_snapshot?.kind !== 'workspace-lease') {
    throw new FixtureError('fixture-transition-invalid', 'lease renewal requires an active workspace lease')
  }
  return renewWorkspaceLease(state.external_snapshot)
}

function holdAcceptanceFixtureLease(input: AcceptanceFixtureInput): never {
  const waiter = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    const renewAfterMs = renewAcceptanceFixtureLease(input)
    Atomics.wait(waiter, 0, 0, Math.max(250, Math.min(renewAfterMs / 2, 5_000)))
  }
}

function recoverFailure(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput, state: FixtureState) {
  assertStateBinding(state, input)
  if (state.external_snapshot !== null) {
    const target = state.external_snapshot
    if (target.kind === 'workspace-lease') {
      const expectedRoot = input.workdir
      if (target.target_root !== expectedRoot) {
        throw new FixtureError('fixture-state-invalid', 'workspace lease does not match the scenario target')
      }
      releaseWorkspaceLease(target)
      if (target.temporary_git_dir_sha256 !== null) {
        const gitDir = join(input.workdir, '.git')
        if (!existsSync(gitDir) || directoryTreeDigest(gitDir) !== target.temporary_git_dir_sha256) {
          throw new FixtureError('fixture-state-drift', 'temporary lease repository changed before recovery')
        }
        rmSync(gitDir, { recursive: true })
        if (existsSync(gitDir)) {
          throw new FixtureError('fixture-recovery-failed', 'temporary lease repository was not removed')
        }
      }
    } else {
      const expectedPath = expectedSnapshotPath(family, input)
      if (expectedPath === undefined || target.path !== expectedPath) {
        throw new FixtureError('fixture-state-invalid', 'external snapshot does not match the family failure recipe')
      }
      safeFile(target.path, 'recoverable fixture input')
      const original = Buffer.from(target.bytes_base64, 'base64')
      if (sha256(original) !== target.sha256) {
        throw new FixtureError('fixture-state-invalid', 'external snapshot digest is invalid')
      }
      writeFileSync(target.path, original, { mode: target.mode })
      chmodSync(target.path, target.mode)
      const recovered = safeFile(target.path, 'recovered fixture input')
      if ((recovered.mode & 0o777) !== target.mode) {
        throw new FixtureError('fixture-recovery-failed', 'external fixture input mode was not restored exactly')
      }
      if (sha256(readFileSync(target.path)) !== target.sha256) {
        throw new FixtureError('fixture-recovery-failed', 'external fixture input was not restored exactly')
      }
    }
    state.external_snapshot = null
  }
  const failure = state.owned_files.find(row => row.path === '.dsh-acceptance/failure.json')
  if (failure !== undefined) {
    const path = existingOwnedPath(input.workdir, failure.path)
    if (existsSync(path)) {
      safeFile(path, 'failure fixture')
      rmSync(path)
    }
    state.owned_files = state.owned_files.filter(row => row.path !== failure.path)
  }
  state.status = 'recovered'
}

function cleanupFixture(family: AcceptanceFixtureFamily, input: AcceptanceFixtureInput, state: FixtureState) {
  recoverFailure(family, input, state)
  for (const row of [...state.owned_files].reverse()) {
    if (row.disposition === 'retain-for-attestation') continue
    const path = existingOwnedPath(input.workdir, row.path)
    if (!existsSync(path)) continue
    const metadata = safeFile(path, `owned fixture ${row.path}`)
    if (sha256(readFileSync(path)) !== row.sha256 || (metadata.mode & 0o777) !== row.mode) {
      throw new FixtureError('fixture-state-drift', `cleanup-owned fixture changed before cleanup: ${row.path}`)
    }
    rmSync(path)
  }
  for (const directory of [
    join(input.workdir, '.dsh-acceptance', 'protected'),
    join(input.workdir, '.dsh-acceptance'),
  ]) {
    if (!existsSync(directory)) continue
    const metadata = lstatSync(directory)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new FixtureError('unsafe-fixture-path', 'owned fixture directory changed kind before cleanup')
    }
    try {
      rmdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    }
  }
  state.owned_files = state.owned_files.filter(row => row.disposition === 'retain-for-attestation')
  state.status = 'cleaned'
}

function receipt(
  stateRoot: string,
  state: FixtureState,
  input: AcceptanceFixtureInput,
  family: AcceptanceFixtureFamily,
) {
  const workdirKey = sha256(state.workdir)
  state.sequence += 1
  const value = {
    schema_version: RECEIPT_SCHEMA,
    sequence: state.sequence,
    stage: input.stage,
    phase: input.phase,
    family: family.id,
    scenario_id: input.scenarioId,
    profile: input.profile,
    failure_kind: family.failure_kind,
    state: state.status,
    owned_files: state.owned_files.map(row => ({
      path: row.path,
      sha256: row.sha256,
      mode: row.mode,
      disposition: row.disposition,
    })),
    external_snapshot_active: state.external_snapshot !== null,
    managed_child: state.managed_child === null ? null : {
      worktree: state.managed_child.worktree,
      owned_files: state.managed_child.owned_files,
    },
  }
  const name = `${String(state.sequence).padStart(4, '0')}-${input.stage}.json`
  const path = join(stateRoot, name)
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return {
    kind: 'fixture-transition-receipt',
    reference: `fixture-state/${input.profile}/${input.scenarioId}/${workdirKey}/${name}`,
    sha256: sha256(readFileSync(path)),
  }
}

export function runAcceptanceFixture(input: AcceptanceFixtureInput): AcceptanceFixtureResult {
  if (input.schema !== PROVIDER_SCHEMA) throw new FixtureError('invalid-provider-schema', `expected ${PROVIDER_SCHEMA}`)
  if (!['prepare', 'induce', 'recover', 'cleanup'].includes(input.stage)) {
    throw new FixtureError('invalid-fixture-stage', 'stage is invalid')
  }
  if (!['success', 'deliberate-failure'].includes(input.phase)) {
    throw new FixtureError('invalid-fixture-phase', 'phase is invalid')
  }
  if (!FAMILY.test(input.family) || !IDENTIFIER.test(input.scenarioId) || !PROFILE.test(input.profile)) {
    throw new FixtureError('invalid-fixture-identity', 'family, scenario, or profile is invalid')
  }
  if (input.stage === 'prepare' && input.phase !== 'success') {
    throw new FixtureError('invalid-fixture-transition', 'prepare requires the success phase')
  }
  if ((input.stage === 'induce' || input.stage === 'recover') && input.phase !== 'deliberate-failure') {
    throw new FixtureError('invalid-fixture-transition', `${input.stage} requires the deliberate-failure phase`)
  }
  const workdir = safeDirectory(input.workdir, 'workdir', false)
  const dshHome = safeDirectory(input.dshHome, 'DSH_HOME', true)
  const normalized = { ...input, workdir, dshHome }
  const manifest = loadAcceptanceFixtureManifest(input.manifestPath)
  const family = manifest.families.find(row => row.id === input.family)
  if (family === undefined || !family.scenario_ids.includes(input.scenarioId)) {
    throw new FixtureError('unknown-fixture-scenario', 'scenario is not owned by the requested fixture family')
  }
  if (family.id === 'managed-subagent-workspace'
    && (input.stage === 'prepare' || input.stage === 'induce')) {
    mainAgentFixtureContext(normalized)
  }
  const stateRoot = ensurePrivateDescendant(
    dshHome,
    'runtime-kit',
    'acceptance-fixtures',
    input.profile,
    input.scenarioId,
    sha256(workdir),
  )
  const statePath = join(stateRoot, 'state.json')
  let state = loadState(statePath)
  if (state !== undefined) assertStateContract(family, state, normalized)
  if (input.stage === 'prepare' || input.stage === 'induce') {
    state = stageFixture(family, normalized, state)
  }
  if (input.stage === 'prepare' && family.failure_kind === 'workspace-lease-conflict'
    && input.scenarioId !== 'workspace-identity.non-git' && state?.external_snapshot === null) {
    state.external_snapshot = induceWorkspaceLease(normalized, normalized.workdir)
  }
  if (state === undefined || state.status === 'cleaned') {
    if (input.stage === 'cleanup') {
      state = {
        schema_version: STATE_SCHEMA,
        family: family.id,
        scenario_id: input.scenarioId,
        profile: input.profile,
        phase: input.phase,
        workdir,
        dsh_home: dshHome,
        status: 'cleaned',
        sequence: state?.sequence ?? 0,
        owned_files: [],
        external_snapshot: null,
        managed_child: null,
      }
    } else {
      throw new FixtureError('fixture-transition-invalid', `${input.stage} requires an active fixture`)
    }
  }
  if (input.stage === 'induce') induceFailure(family, normalized, state)
  if (input.stage === 'recover') recoverFailure(family, normalized, state)
  if (input.stage === 'cleanup') cleanupFixture(family, normalized, state)
  const evidence = receipt(stateRoot, state, normalized, family)
  atomicJson(statePath, state)
  return {
    schema_version: RESULT_SCHEMA,
    ok: true,
    data: {
      status: 'pass',
      stage: input.stage,
      phase: input.phase,
      family: input.family,
      scenario_id: input.scenarioId,
      evidence: [evidence],
    },
  }
}

function usage() {
  return [
    'Usage: dsh-runtime-kit-acceptance-fixture --schema dsh-runtime-kit.acceptance-fixture-provider.v1 --stage <prepare|induce|recover|cleanup> --phase <success|deliberate-failure> --family <id> --scenario <id> --profile <name>',
    '',
    'The current directory is the bounded scenario workdir and DSH_HOME selects the isolated family state root.',
  ].join('\n')
}

export function main(argv: string[] = process.argv.slice(2)) {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        schema: { type: 'string' },
        stage: { type: 'string' },
        phase: { type: 'string' },
        family: { type: 'string' },
        scenario: { type: 'string' },
        profile: { type: 'string' },
        'hold-workspace-lease': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (parsed.values.help) {
      process.stdout.write(`${usage()}\n`)
      return 0
    }
    for (const name of ['schema', 'stage', 'phase', 'family', 'scenario', 'profile'] as const) {
      if (parsed.values[name] === undefined) {
        throw new FixtureError('missing-fixture-argument', `--${name} is required`)
      }
    }
    const dshHome = process.env.DSH_HOME
    if (dshHome === undefined) throw new FixtureError('fixture-input-missing', 'DSH_HOME is required')
    const input = {
      schema: parsed.values.schema as typeof PROVIDER_SCHEMA,
      stage: parsed.values.stage as Stage,
      phase: parsed.values.phase as Phase,
      family: parsed.values.family!,
      scenarioId: parsed.values.scenario!,
      profile: parsed.values.profile!,
      workdir: process.cwd(),
      dshHome,
    }
    if (parsed.values['hold-workspace-lease']) holdAcceptanceFixtureLease(input)
    const result = runAcceptanceFixture(input)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    const normalized = error instanceof FixtureError
      ? error
      : new FixtureError('acceptance-fixture-failed', error instanceof Error ? error.message : String(error))
    process.stdout.write(`${JSON.stringify({
      schema_version: RESULT_SCHEMA,
      ok: false,
      error: { code: normalized.code, message: normalized.message },
    })}\n`)
    return 64
  }
}
