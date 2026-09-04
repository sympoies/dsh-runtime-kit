import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT ?? '')
const agentHookBin = resolve(process.env.AGENT_HOOK_BIN ?? '')
const agentDocsBin = resolve(process.env.AGENT_DOCS_BIN ?? '')
assert.notEqual(process.env.DSH_SOURCE_ROOT, undefined, 'set DSH_SOURCE_ROOT')
assert.notEqual(process.env.AGENT_HOOK_BIN, undefined, 'set AGENT_HOOK_BIN')
assert.notEqual(process.env.AGENT_DOCS_BIN, undefined, 'set AGENT_DOCS_BIN')
assert.notEqual(
  process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1,
  undefined,
  'set DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1',
)
assert.notEqual(
  process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2,
  undefined,
  'set DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2',
)
assert.notEqual(
  process.env.DSH_RUNTIME_KIT_DEPLOY_DISPATCHER,
  undefined,
  'set DSH_RUNTIME_KIT_DEPLOY_DISPATCHER to the repository-owned .agents/scripts/deploy.sh',
)
const packageV1 = resolve(process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1)
const packageV2 = resolve(process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2)
const deployDispatcher = resolve(process.env.DSH_RUNTIME_KIT_DEPLOY_DISPATCHER)
const dshCompatibility = JSON.parse(
  readFileSync(join(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
)
const pinnedDshVersion = dshCompatibility.channels?.pinned?.version
assert.match(pinnedDshVersion, /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-operations-smoke-'))
const userHome = join(temporaryRoot, 'home')
const dshHome = join(temporaryRoot, 'dsh-home')
const codexHome = join(userHome, '.codex')
const claudeHome = join(userHome, '.claude')
const configHome = join(temporaryRoot, 'config')
const stateHome = join(temporaryRoot, 'state')
const runtimeRoot = join(temporaryRoot, 'dsh-runtime')
const cli = join(projectRoot, 'bin', 'dsh-runtime-kit.js')
const launcher = join(projectRoot, 'bin', 'dsh-runtime-kit-launch.js')
mkdirSync(dshHome, { mode: 0o700 })
mkdirSync(runtimeRoot, { mode: 0o700 })

function stageProviderSentinel(root, provider) {
  for (const directory of ['hooks', 'skills', 'sessions']) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(root, directory, `${provider}-only.txt`),
      `${provider}:${directory}:must-remain-untouched\n`,
      { mode: 0o600 },
    )
  }
}

function assertProviderSentinel(root, provider) {
  assert.deepEqual(readdirSync(root).sort(), ['hooks', 'sessions', 'skills'])
  for (const directory of ['hooks', 'skills', 'sessions']) {
    assert.deepEqual(readdirSync(join(root, directory)), [`${provider}-only.txt`])
    assert.equal(
      readFileSync(join(root, directory, `${provider}-only.txt`), 'utf8'),
      `${provider}:${directory}:must-remain-untouched\n`,
    )
  }
}

stageProviderSentinel(codexHome, 'codex')
stageProviderSentinel(claudeHome, 'claude')

const policy = readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')
const policyPath = join(temporaryRoot, 'policy.toml')
const agentHookConfig = join(configHome, 'agent-hook', 'config.toml')
const agentHookStateDir = join(stateHome, 'agent-hook-dsh')
const agentDocsHome = join(temporaryRoot, 'agent-docs')
const agentDocsStateHome = join(stateHome, 'agent-docs-dsh')
const policyDigest = createHash('sha256').update(policy).digest('hex')
mkdirSync(join(configHome, 'agent-hook'), { recursive: true })
mkdirSync(stateHome, { recursive: true })
mkdirSync(agentDocsHome, { recursive: true, mode: 0o700 })
mkdirSync(agentDocsStateHome, { recursive: true, mode: 0o700 })
writeFileSync(policyPath, policy, { mode: 0o600 })
writeFileSync(agentHookConfig, `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(policyPath)}
digest = "sha256:${policyDigest}"
`, { mode: 0o600 })
for (const name of ['AGENT_DOCS.toml', 'PROJECT_DEV_EDIT.md']) {
  writeFileSync(
    join(agentDocsHome, name),
    readFileSync(join(projectRoot, 'agent-docs', name)),
    { mode: 0o600 },
  )
}

function stageUnrelatedBundle(name, version) {
  const dir = join(temporaryRoot, `${name.replace(/[^a-z]/gi, '-')}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return dir
}

const requiredRuntimeSurfaces = [
  'index.js',
  'cordis.patch.yml',
  'bin/dsh-runtime-kit.js',
  'src/policy/index.js',
  'policy/dsh-runtime-kit-v1.toml',
  'test/smoke.mjs',
]

function assertRuntimePackage(root, version) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@sympoies/dsh-runtime-kit')
  assert.equal(manifest.version, version)
  for (const relative of requiredRuntimeSurfaces) {
    assert.equal(existsSync(join(root, relative)), true, `${relative} must be installed`)
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result
}

function upstreamStatus() {
  const result = spawnSync('git', ['status', '--short'], { cwd: dshRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

/** @param {ReturnType<typeof spawnSync>} result */
function operationFailure(result) {
  let parsed
  try { parsed = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '') } catch {}
  const code = parsed !== null
    && typeof parsed === 'object'
    && parsed.ok === false
    && parsed.error !== null
    && typeof parsed.error === 'object'
    && typeof parsed.error.code === 'string'
    && /^[a-z][a-z0-9-]{0,47}$/u.test(parsed.error.code)
    ? `DSH_OPERATIONS_${parsed.error.code.replaceAll('-', '_').toUpperCase()}`
    : 'DSH_OPERATIONS_COMMAND_FAILED'
  const exitStatus = parsed !== null
    && typeof parsed === 'object'
    && parsed.error !== null
    && typeof parsed.error === 'object'
    && parsed.error.details !== null
    && typeof parsed.error.details === 'object'
    && Number.isSafeInteger(parsed.error.details.exit_code)
    && parsed.error.details.exit_code >= 1
    && parsed.error.details.exit_code <= 255
    ? parsed.error.details.exit_code
    : undefined
  return {
    code: /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : 'DSH_OPERATIONS_COMMAND_FAILED',
    exitStatus,
  }
}

function operation(args) {
  const result = spawnSync(process.execPath, [
    launcher,
    '--runtime-root', runtimeRoot,
    '--',
    process.execPath, cli, ...args, '--format', 'json',
  ], {
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      DSH_RUNTIME_KIT_DSH_BIN: wrapper,
      DSH_RUNTIME_KIT_AGENT_HOOK_BIN: agentHookBin,
      DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: agentHookConfig,
      DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: policyPath,
      DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: agentHookStateDir,
      DSH_RUNTIME_KIT_AGENT_DOCS_BIN: agentDocsBin,
      DSH_RUNTIME_KIT_AGENT_DOCS_HOME: agentDocsHome,
      DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: agentDocsStateHome,
      DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: privateRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const failure = operationFailure(result)
    const error = /** @type {Error & {code:string,operationExitStatus?:number}} */ (new Error('runtime-kit operation failed'))
    error.code = failure.code
    error.operationExitStatus = failure.exitStatus
    throw error
  }
  return JSON.parse(result.stdout).data
}

function assertDshProfileIsolation() {
  const profileManifest = readFileSync(
    join(dshHome, 'profiles', 'operations-smoke', 'package.json'),
    'utf8',
  )
  assert.doesNotMatch(profileManifest, /agent-runtime-kit/u)
}

function apply(args) {
  const preview = operation(args)
  assert.equal(preview.mode, 'dry-run')
  return operation([...args, '--apply', '--expected-plan-digest', preview.plan_digest])
}

/**
 * Drive the repository-owned generic deploy dispatcher exactly as the shared
 * `meta:deploy` skill does: the script, an explicit scope, and no ambient DSH or
 * runtime-kit selection. The engine is this packed candidate (`--engine-root`),
 * because the candidate checkout the dispatcher lives in carries no installed
 * dependencies inside the acceptance sandbox.
 * @param {string[]} args
 */
function deploy(args) {
  // A replayed resume vector already carries its engine root; add it only to
  // freshly built scopes so the receipt's argv is exercised as published.
  const argv = args.includes('--engine-root') ? args : [...args, '--engine-root', projectRoot]
  const result = spawnSync('/bin/sh', [deployDispatcher, ...argv], {
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? userHome,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: join(temporaryRoot, 'cache'),
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      ...Object.fromEntries(['NPM_CONFIG_OFFLINE', 'npm_config_offline', 'PNPM_OFFLINE']
        .filter(name => process.env[name] !== undefined)
        .map(name => [name, /** @type {string} */ (process.env[name])])),
    },
    encoding: 'utf8',
  })
  let parsed
  try { parsed = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '') } catch {}
  if (result.status !== 0) {
    const code = parsed !== null
      && typeof parsed === 'object'
      && parsed.ok === false
      && parsed.error !== null
      && typeof parsed.error === 'object'
      && typeof parsed.error.code === 'string'
      && /^[a-z][a-z0-9-]{0,47}$/u.test(parsed.error.code)
      ? `DSH_DEPLOY_${parsed.error.code.replaceAll('-', '_').toUpperCase()}`
      : 'DSH_DEPLOY_COMMAND_FAILED'
    const error = /** @type {Error & {code:string,operationExitStatus?:number,deploy?:unknown}} */ (new Error('deploy dispatcher failed'))
    error.code = code
    error.deploy = parsed
    if (Number.isSafeInteger(result.status) && result.status >= 1 && result.status <= 255) {
      error.operationExitStatus = result.status
    }
    throw error
  }
  assert.equal(parsed?.schema_version, 'cli.dsh-runtime-kit.deploy.v1')
  assert.equal(parsed.ok, true)
  return parsed.data
}

function deployScope(phase, extra = [], target = { profile: 'operations-smoke', runtimeRoot }) {
  return [
    '--phase', phase,
    '--profile', target.profile,
    '--dsh-home', dshHome,
    '--runtime-root', target.runtimeRoot,
    '--dsh-bin', wrapper,
    '--agent-hook-bin', agentHookBin,
    '--agent-docs-bin', agentDocsBin,
    '--stage-root', join(temporaryRoot, 'deploy-stage'),
    ...extra,
  ]
}

function packArtifact(source, label) {
  const destination = join(temporaryRoot, `deploy-artifact-${label}`)
  mkdirSync(destination, { mode: 0o700 })
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination, source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_CACHE: join(temporaryRoot, `deploy-npm-cache-${label}`),
    },
  })
  assert.equal(packed.status, 0, packed.stderr)
  const rows = JSON.parse(packed.stdout)
  assert.equal(rows.length, 1)
  const path = join(destination, rows[0].filename)
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

const wrapper = join(temporaryRoot, 'dsh-wrapper.mjs')
const dshCli = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const dshCli = ${JSON.stringify(dshCli)}
const result = spawnSync(process.execPath, [dshCli, ...process.argv.slice(2)], {
  cwd: ${JSON.stringify(dshRoot)},
  env: process.env,
  stdio: 'inherit',
})
process.exitCode = result.status ?? 1
`)
chmodSync(wrapper, 0o755)

const privateRoot = join(temporaryRoot, 'private-skills')
mkdirSync(privateRoot)
writeFileSync(join(privateRoot, 'must-survive.txt'), 'private')

const unrelated = stageUnrelatedBundle('unrelated-bundle', '1.0.0')
assertRuntimePackage(packageV1, '0.0.0-acceptance.1')
assertRuntimePackage(packageV2, '0.0.0-acceptance.2')
const upstreamBefore = upstreamStatus()
let acceptanceStep = 'profile-add'

try {
  run(wrapper, ['plugin', '--profile', 'operations-smoke', 'add', '--save-exact', unrelated], {
    DSH_HOME: dshHome,
  })
  const userPatch = join(dshHome, 'profiles', 'operations-smoke', 'cordis.patch.yml')
  writeFileSync(userPatch, '# user-owned marker\n[]\n')

  acceptanceStep = 'profile-setup'
  apply(['setup', '--profile', 'operations-smoke', '--package', packageV1])
  assertDshProfileIsolation()
  const installedRuntime = join(
    dshHome,
    'profiles',
    'operations-smoke',
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
  )
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')
  acceptanceStep = 'profile-doctor'
  const doctor = operation(['doctor', '--profile', 'operations-smoke'])
  assert.equal(doctor.status, 'healthy')
  assert.equal(doctor.agent_hook.ok, true)
  assert.equal(doctor.agent_docs.ok, true)
  assert.equal(doctor.activation.status, 'activated')
  assert.equal(doctor.agent_docs.catalog.startsWith(`${runtimeRoot}/assets/`), true)
  assert.equal(doctor.dsh.version, pinnedDshVersion)

  acceptanceStep = 'profile-update'
  apply(['update', '--profile', 'operations-smoke', '--package', packageV2])
  assertDshProfileIsolation()
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.2')

  acceptanceStep = 'profile-rollback'
  apply(['rollback', '--profile', 'operations-smoke'])
  assertDshProfileIsolation()
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')

  acceptanceStep = 'lifecycle-declaration'
  const lifecycleDoctor = operation(['doctor', '--profile', 'operations-smoke'])
  assert.equal(lifecycleDoctor.status, 'healthy')
  assert.equal(lifecycleDoctor.lifecycle.declared, true)
  assert.equal(lifecycleDoctor.lifecycle.schema_version, 'dsh-runtime-kit.profile-lifecycle.v1')
  assert.equal(lifecycleDoctor.lifecycle.dsh_releases.includes(pinnedDshVersion), true)
  assert.deepEqual(lifecycleDoctor.lifecycle.migrations, {
    declared: ['operations-state-v1-to-v2'],
    pending: [],
  })
  for (const [surface, status] of Object.entries({
    ...lifecycleDoctor.lifecycle.surfaces.owned,
    ...lifecycleDoctor.lifecycle.surfaces.generated,
  })) {
    assert.equal(status, 'present', `${surface} must be present after rollback`)
  }

  acceptanceStep = 'lifecycle-incompatible-package'
  const incompatiblePackage = join(temporaryRoot, 'operation-package-incompatible')
  cpSync(packageV2, incompatiblePackage, { recursive: true })
  const incompatibleCompatibility = JSON.parse(
    readFileSync(join(incompatiblePackage, 'compatibility', 'dsh.json'), 'utf8'),
  )
  incompatibleCompatibility.validated_releases = {
    '0.0.1-never': { ref: 'refs/tags/dsh-v0.0.1-never', revision: 'a'.repeat(40), cordis: '4.0.2' },
  }
  writeFileSync(
    join(incompatiblePackage, 'compatibility', 'dsh.json'),
    `${JSON.stringify(incompatibleCompatibility, undefined, 2)}\n`,
  )
  const profileManifestPath = join(dshHome, 'profiles', 'operations-smoke', 'package.json')
  const manifestBeforeRefusal = readFileSync(profileManifestPath)
  const stateBeforeRefusal = readFileSync(join(dshHome, 'runtime-kit', 'state', 'operations-smoke.json'))
  let refusal
  try {
    operation(['update', '--profile', 'operations-smoke', '--package', incompatiblePackage])
  } catch (error) {
    refusal = error
  }
  assert.equal(refusal?.code, 'DSH_OPERATIONS_PACKAGE_INCOMPATIBLE_DSH')
  assert.deepEqual(readFileSync(profileManifestPath), manifestBeforeRefusal)
  assert.deepEqual(
    readFileSync(join(dshHome, 'runtime-kit', 'state', 'operations-smoke.json')),
    stateBeforeRefusal,
  )
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')

  // The repository-owned generic deploy dispatcher must reach the same
  // digest-reviewed engine from an immutable packed artifact, refuse a
  // mismatched artifact before any mutation, and persist resumable receipts.
  acceptanceStep = 'deploy-dispatcher'
  const deployArtifact = packArtifact(packageV2, 'v2')
  const receiptRoot = join(temporaryRoot, 'deploy-receipts')
  const manifestBeforeDeployRefusal = readFileSync(profileManifestPath)
  const stateBeforeDeployRefusal = readFileSync(join(dshHome, 'runtime-kit', 'state', 'operations-smoke.json'))
  let deployRefusal
  try {
    deploy(deployScope('update', [
      '--artifact', deployArtifact.path,
      '--artifact-sha256', 'f'.repeat(64),
      '--receipt', join(receiptRoot, 'refused.json'),
    ]))
  } catch (error) {
    deployRefusal = error
  }
  assert.equal(deployRefusal?.code, 'DSH_DEPLOY_ARTIFACT_DIGEST_MISMATCH')
  assert.equal(deployRefusal?.operationExitStatus, 65)
  assert.deepEqual(readFileSync(profileManifestPath), manifestBeforeDeployRefusal)
  assert.deepEqual(readFileSync(join(dshHome, 'runtime-kit', 'state', 'operations-smoke.json')), stateBeforeDeployRefusal)
  assert.equal(existsSync(join(temporaryRoot, 'deploy-stage')), false, 'a refused artifact is never staged')
  assert.equal(JSON.parse(readFileSync(join(receiptRoot, 'refused.json'), 'utf8')).error.code, 'artifact-digest-mismatch')
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')

  const deployPreview = deploy(deployScope('update', [
    '--artifact', deployArtifact.path,
    '--artifact-sha256', deployArtifact.sha256,
    '--receipt', join(receiptRoot, 'update-preview.json'),
  ]))
  assert.equal(deployPreview.schema_version, 'dsh-runtime-kit.deploy-receipt.v1')
  assert.equal(deployPreview.mode, 'preview')
  assert.equal(deployPreview.scope, 'canary')
  assert.equal(deployPreview.engine.root, projectRoot)
  assert.equal(deployPreview.engine.mode, 'dry-run')
  assert.equal(deployPreview.artifact.sha256, deployArtifact.sha256)
  assert.match(deployPreview.plan_digest, /^[a-f0-9]{64}$/u)
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')
  const deployApplied = deploy([...deployPreview.resume.apply_argv, '--receipt', join(receiptRoot, 'update-apply.json')])
  assert.equal(deployApplied.mode, 'apply')
  assert.equal(deployApplied.engine.mode, 'applied')
  assert.equal(deployApplied.plan_digest, deployPreview.plan_digest)
  assertDshProfileIsolation()
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.2')

  const deployDoctor = deploy(deployScope('doctor'))
  assert.equal(deployDoctor.mode, 'inspect')
  assert.equal(deployDoctor.engine.status, 'healthy')

  const deployRollbackPreview = deploy(deployScope('rollback'))
  assert.equal(deployRollbackPreview.artifact, null)
  const deployRolledBack = deploy([...deployRollbackPreview.resume.apply_argv, '--receipt', join(receiptRoot, 'rollback-apply.json')])
  assert.equal(deployRolledBack.engine.mode, 'applied')
  assertDshProfileIsolation()
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')
  for (const name of ['refused.json', 'update-preview.json', 'update-apply.json', 'rollback-apply.json']) {
    assert.equal(statSync(join(receiptRoot, name)).mode & 0o777, 0o600, `${name} must be owner-only`)
  }

  // A profile DSH has never initialized: setup creates it through the native
  // mutation and remove must leave DSH's own base composition behind. pnpm
  // drops the emptied dependencies object here, which the collateral
  // classifier must treat as the runtime-kit removal it is.
  acceptanceStep = 'deploy-fresh-profile'
  const freshProfileDir = join(dshHome, 'profiles', 'deploy-fresh')
  const freshRuntimeRoot = join(temporaryRoot, 'dsh-runtime-fresh')
  mkdirSync(freshRuntimeRoot, { mode: 0o700 })
  const freshScope = (phase, extra = []) => deployScope(phase, extra, { profile: 'deploy-fresh', runtimeRoot: freshRuntimeRoot })
  assert.equal(existsSync(freshProfileDir), false)
  const freshSetup = deploy(freshScope('setup', ['--artifact', deployArtifact.path, '--artifact-sha256', deployArtifact.sha256]))
  assert.equal(freshSetup.mode, 'preview')
  const freshApplied = deploy(freshSetup.resume.apply_argv)
  assert.equal(freshApplied.engine.mode, 'applied')
  const freshManifest = JSON.parse(readFileSync(join(freshProfileDir, 'package.json'), 'utf8'))
  assert.deepEqual(freshManifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@sympoies/dsh-runtime-kit'])
  const freshRemove = deploy(freshScope('remove'))
  assert.equal(freshRemove.engine.action, 'remove')
  const freshRemoved = deploy(freshRemove.resume.apply_argv)
  assert.equal(freshRemoved.engine.mode, 'applied')
  const freshAfter = JSON.parse(readFileSync(join(freshProfileDir, 'package.json'), 'utf8'))
  assert.deepEqual(freshAfter.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  assert.equal(freshAfter.dependencies?.['@sympoies/dsh-runtime-kit'], undefined)

  acceptanceStep = 'profile-remove'
  apply(['remove', '--profile', 'operations-smoke'])
  const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'operations-smoke', 'package.json')))
  assert.equal(manifest.dependencies['@sympoies/dsh-runtime-kit'], undefined)
  assert.equal(manifest.dependencies['unrelated-bundle'] !== undefined, true)
  assert.equal(manifest.dsh.profile.bundles.includes('unrelated-bundle'), true)
  assert.equal(manifest.dsh.profile.bundles.includes('@sympoies/dsh-runtime-kit'), false)
  assert.equal(readFileSync(userPatch, 'utf8'), '# user-owned marker\n[]\n')
  assert.equal(readFileSync(join(privateRoot, 'must-survive.txt'), 'utf8'), 'private')
  assertProviderSentinel(codexHome, 'codex')
  assertProviderSentinel(claudeHome, 'claude')

  acceptanceStep = 'final-verification'
  const upstreamAfter = upstreamStatus()
  assert.equal(upstreamAfter, upstreamBefore)
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    ok: true,
    producer: 'operations',
    scenarios: [
      { id: 'bootstrap', status: 'passed', producer: 'operations', evidence: ['operations:full-package-setup-update-rollback-remove'] },
      {
        id: 'inspect',
        status: 'passed',
        producer: 'operations',
        evidence: [
          'doctor:healthy',
          'lifecycle:declared-and-bound',
          'lifecycle:surfaces-present-after-rollback',
          'lifecycle:incompatible-dsh-refused-before-mutation',
          'deploy:dispatcher-update-doctor-rollback-through-engine',
          'deploy:artifact-digest-mismatch-refused-before-mutation',
          'deploy:receipts-persisted-owner-only',
          'deploy:fresh-profile-setup-and-remove-through-engine',
          'upstream:patch-state-unchanged',
          'coexistence:dsh-agent-runtime-kit-zero-dependency',
          'coexistence:codex-claude-wiring-untouched',
        ],
      },
    ],
    dshVersion: doctor.dsh.version,
    setupUpdateRollbackRemove: true,
    unrelatedProfileStatePreserved: true,
    privateSkillsPreserved: true,
    upstreamPatchStateUnchanged: true,
  })}\n`)
} catch (error) {
  const causeCode = error !== null
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : 'UNCLASSIFIED'
  const diagnostic = {
    schema_version: 'dsh-runtime-kit.acceptance-scenario-diagnostic.v1',
    ok: false,
    producer: 'operations',
    step: acceptanceStep,
    cause_code: causeCode,
  }
  if (error !== null
    && typeof error === 'object'
    && 'operationExitStatus' in error
    && Number.isSafeInteger(error.operationExitStatus)
    && error.operationExitStatus >= 1
    && error.operationExitStatus <= 255) {
    diagnostic.operation_exit_status = error.operationExitStatus
  }
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`)
  process.exitCode = 1
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
