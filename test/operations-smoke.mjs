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
const packageV1 = resolve(process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1)
const packageV2 = resolve(process.env.DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2)
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
