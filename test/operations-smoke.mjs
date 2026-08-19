import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
assert.notEqual(process.env.DSH_SOURCE_ROOT, undefined, 'set DSH_SOURCE_ROOT')
assert.notEqual(process.env.AGENT_HOOK_BIN, undefined, 'set AGENT_HOOK_BIN')
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

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-operations-smoke-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const configHome = join(temporaryRoot, 'config')
const stateHome = join(temporaryRoot, 'state')
const cli = join(projectRoot, 'bin', 'dsh-runtime-kit.js')
mkdirSync(dshHome, { mode: 0o700 })

const policy = readFileSync(join(projectRoot, 'policy', 'dsh-runtime-kit-v1.toml'), 'utf8')
const policyPath = join(temporaryRoot, 'policy.toml')
const policyDigest = createHash('sha256').update(policy).digest('hex')
mkdirSync(join(configHome, 'agent-hook'), { recursive: true })
mkdirSync(stateHome, { recursive: true })
writeFileSync(policyPath, policy, { mode: 0o600 })
writeFileSync(join(configHome, 'agent-hook', 'config.toml'), `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(policyPath)}
digest = "sha256:${policyDigest}"
`, { mode: 0o600 })

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

function operation(args) {
  const result = run(process.execPath, [cli, ...args, '--format', 'json'], {
    DSH_HOME: dshHome,
    DSH_RUNTIME_KIT_DSH_BIN: wrapper,
    DSH_RUNTIME_KIT_AGENT_HOOK_BIN: agentHookBin,
    DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: privateRoot,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
  })
  return JSON.parse(result.stdout).data
}

function apply(args) {
  const preview = operation(args)
  assert.equal(preview.mode, 'dry-run')
  return operation([...args, '--apply', '--expected-plan-digest', preview.plan_digest])
}

const wrapper = join(temporaryRoot, 'dsh-wrapper.mjs')
writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const result = spawnSync('pnpm', ['dsh', ...process.argv.slice(2)], {
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

try {
  run(wrapper, ['plugin', '--profile', 'operations-smoke', 'add', '--save-exact', unrelated], {
    DSH_HOME: dshHome,
  })
  const userPatch = join(dshHome, 'profiles', 'operations-smoke', 'cordis.patch.yml')
  writeFileSync(userPatch, '# user-owned marker\n[]\n')

  apply(['setup', '--profile', 'operations-smoke', '--package', packageV1])
  const installedRuntime = join(
    dshHome,
    'profiles',
    'operations-smoke',
    'node_modules',
    '@sympoies',
    'dsh-runtime-kit',
  )
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')
  const doctor = operation(['doctor', '--profile', 'operations-smoke'])
  assert.equal(doctor.status, 'healthy')
  assert.equal(doctor.agent_hook.ok, true)
  assert.match(doctor.dsh.version, /0\.1\.0-rc\.7/)

  apply(['update', '--profile', 'operations-smoke', '--package', packageV2])
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.2')

  apply(['rollback', '--profile', 'operations-smoke'])
  assertRuntimePackage(installedRuntime, '0.0.0-acceptance.1')

  apply(['remove', '--profile', 'operations-smoke'])
  const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'operations-smoke', 'package.json')))
  assert.equal(manifest.dependencies['@sympoies/dsh-runtime-kit'], undefined)
  assert.equal(manifest.dependencies['unrelated-bundle'] !== undefined, true)
  assert.equal(manifest.dsh.profile.bundles.includes('unrelated-bundle'), true)
  assert.equal(manifest.dsh.profile.bundles.includes('@sympoies/dsh-runtime-kit'), false)
  assert.equal(readFileSync(userPatch, 'utf8'), '# user-owned marker\n[]\n')
  assert.equal(readFileSync(join(privateRoot, 'must-survive.txt'), 'utf8'), 'private')

  const upstreamAfter = upstreamStatus()
  assert.equal(upstreamBefore, '')
  assert.equal(upstreamAfter, upstreamBefore)
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.acceptance-scenarios.v1',
    ok: true,
    producer: 'operations',
    scenarios: [
      { id: 'bootstrap', status: 'passed', producer: 'operations', evidence: ['operations:full-package-setup-update-rollback-remove'] },
      { id: 'inspect', status: 'passed', producer: 'operations', evidence: ['doctor:healthy', 'upstream:clean'] },
    ],
    dshVersion: doctor.dsh.version,
    setupUpdateRollbackRemove: true,
    unrelatedProfileStatePreserved: true,
    privateSkillsPreserved: true,
    upstreamCheckoutClean: true,
  })}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
