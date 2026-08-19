import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const cli = join(projectRoot, 'bin', 'dsh-runtime-kit.js')

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

function stageBundle(root, version) {
  const dir = join(root, `bundle-${version}`)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), {
    name: '@sympoies/dsh-runtime-kit',
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  mkdirSync(join(dir, 'policy'), { mode: 0o700 })
  mkdirSync(join(dir, 'agent-docs'), { mode: 0o700 })
  writeFileSync(
    join(dir, 'policy', 'dsh-runtime-kit-v1.toml'),
    `schema_version = "dsh.policy.v1"\n# asset ${version}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(dir, 'agent-docs', 'AGENT_DOCS.toml'),
    `schema_version = "agent-docs.catalog.v1"\n# asset ${version}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    join(dir, 'agent-docs', 'PROJECT_DEV_EDIT.md'),
    `# DSH project-dev ${version}\n`,
    { mode: 0o600 },
  )
  return dir
}

function stageFakeCommands(root) {
  const commandDir = join(root, 'bin')
  mkdirSync(commandDir)
  const realNpm = (process.env.PATH ?? '')
    .split(delimiter)
    .map(directory => join(directory, 'npm'))
    .find(candidate => existsSync(candidate))
  assert.ok(realNpm, 'test fixture could not resolve npm')
  const npm = join(commandDir, 'npm')
  writeFileSync(npm, `#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const spec = args.at(-1)
let staged
if (/^@sympoies\\/dsh-runtime-kit@/.test(spec)) {
  const version = spec.slice('@sympoies/dsh-runtime-kit@'.length)
  const countPath = join(process.env.DSH_HOME, 'registry-pack-count')
  const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0
  writeFileSync(countPath, String(count + 1))
  if (existsSync(join(process.env.DSH_HOME, 'registry-expansion-bomb'))) {
    const destination = args[args.indexOf('--pack-destination') + 1]
    const filename = 'registry-expansion-bomb.tgz'
    const member = gzipSync(Buffer.alloc(1024 * 1024))
    writeFileSync(join(destination, filename), Buffer.concat(Array.from({ length: 257 }, () => member)))
    process.stdout.write(JSON.stringify([{ name: '@sympoies/dsh-runtime-kit', version, filename }]))
    process.exit(0)
  }
  staged = mkdtempSync(join(tmpdir(), 'fake-registry-package-'))
  writeFileSync(join(staged, 'package.json'), JSON.stringify({
    name: '@sympoies/dsh-runtime-kit',
    version,
  }) + '\\n')
  mkdirSync(join(staged, 'policy'), { recursive: true })
  mkdirSync(join(staged, 'agent-docs'), { recursive: true })
  writeFileSync(join(staged, 'policy', 'dsh-runtime-kit-v1.toml'), 'schema_version = "dsh.policy.v1"\\n# registry ' + version + '\\n')
  writeFileSync(join(staged, 'agent-docs', 'AGENT_DOCS.toml'), 'schema_version = "agent-docs.catalog.v1"\\n# registry ' + version + '\\n')
  writeFileSync(join(staged, 'agent-docs', 'PROJECT_DEV_EDIT.md'), '# registry ' + version + '\\n')
  args[args.length - 1] = staged
}
const result = spawnSync(${JSON.stringify(realpathSync(realNpm))}, args, {
  env: process.env,
  stdio: 'inherit',
})
if (staged !== undefined) rmSync(staged, { recursive: true, force: true })
process.exit(result.status ?? 70)
`)
  chmodSync(npm, 0o755)

  // The package-only CI jobs intentionally install npm dependencies without
  // provisioning pnpm. Operations binds the selected pnpm identity, so keep
  // this unit fixture hermetic instead of inheriting a developer-host binary.
  const pnpm = join(commandDir, 'pnpm')
  writeFileSync(pnpm, '#!/bin/sh\nprintf \'11.7.0\\n\'\n')
  chmodSync(pnpm, 0o755)

  const dsh = join(root, 'fake-dsh.mjs')
  writeFileSync(dsh, `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('0.1.0-rc.7')
  process.exit(0)
}
const home = process.env.DSH_HOME
if (!home) process.exit(90)
if (existsSync(join(home, 'hang-command'))) {
  if (existsSync(join(home, 'spawn-descendant'))) {
    spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 300)")}, join(home, 'late-descendant')], {
      stdio: 'ignore',
    })
  }
  setInterval(() => {}, 60_000)
}
if (args[0] === '--profile' && args[2] === '--dump-default-config') {
  console.log('[]')
  process.exit(0)
}
if (args[0] !== 'plugin' || args[1] !== '--profile') process.exit(91)
const profile = args[2]
const verb = args[3]
const profileDir = join(home, 'profiles', profile)
mkdirSync(profileDir, { recursive: true })
const manifestPath = join(profileDir, 'package.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
const packageName = '@sympoies/dsh-runtime-kit'
const installed = join(profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit')
if (verb === 'add') {
  const spec = args.at(-1)
  const registry = spec.startsWith(packageName + '@')
  const source = registry ? null : resolve(spec.replace(/^(?:file|link):/, ''))
  const packed = source?.endsWith('.tgz') ?? false
  const packageManifest = registry
    ? { name: packageName, version: spec.slice((packageName + '@').length) }
    : packed
    ? JSON.parse(spawnSync('tar', ['-xOf', source, 'package/package.json'], { encoding: 'utf8' }).stdout)
    : JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  manifest.dependencies[packageName] = spec
  if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
  mkdirSync(dirname(installed), { recursive: true })
  rmSync(installed, { recursive: true, force: true })
  if (!packed && !registry) symlinkSync(source, installed, 'dir')
  else {
    mkdirSync(installed, { recursive: true })
    if (packed) {
      const extracted = spawnSync('tar', ['-xzf', source, '-C', installed, '--strip-components=1'])
      if (extracted.status !== 0) process.exit(94)
    } else writeFileSync(join(installed, 'package.json'), JSON.stringify(packageManifest))
  }
  if (packageManifest.name !== packageName) process.exit(92)
} else if (verb === 'remove') {
  delete manifest.dependencies[packageName]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(value => value !== packageName)
  if (!existsSync(join(home, 'retain-installed-entry'))) {
    rmSync(installed, { recursive: true, force: true })
  }
} else {
  process.exit(93)
}
if (existsSync(join(home, 'collateral-profile-mutation'))) {
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\\nimporters:\\n  .: {}\\npackages:\\n  unrelated@1.0.0:\\n    resolution: {integrity: forged}\\nsnapshots:\\n  unrelated@1.0.0: {}\\n")
}
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\\n')
if (existsSync(join(home, 'block-asset-activation'))) {
  const assets = join(dirname(home), 'dsh-runtime', 'assets')
  rmSync(assets, { recursive: true, force: true })
  writeFileSync(assets, 'activation blocked')
}
if (existsSync(join(home, 'leave-descendant-after-mutation'))) {
  const descendant = spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 300)")}, join(home, 'late-normal-exit')], {
    stdio: 'ignore',
  })
  descendant.unref()
}
if (existsSync(join(home, 'kill-supervisor-after-mutation'))) {
  spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 300)")}, join(home, 'late-supervisor-loss')], {
    stdio: 'ignore',
  })
  process.kill(process.ppid, 'SIGKILL')
  setInterval(() => {}, 60_000)
}
if (existsSync(join(home, 'fail-after-mutation'))) process.exit(70)
if (existsSync(join(home, 'corrupt-after-success'))) writeFileSync(join(installed, 'package.json'), '{')
`)
  chmodSync(dsh, 0o755)

  const agentHook = join(root, 'fake-agent-hook.mjs')
  writeFileSync(agentHook, `#!/usr/bin/env node
import { isAbsolute } from 'node:path'
if (!process.argv.includes('doctor')) process.exit(91)
for (const flag of ['--config', '--policy', '--state-dir']) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !isAbsolute(process.argv[index + 1] ?? '')) process.exit(92)
}
process.stdout.write(JSON.stringify({
  schema_version: 'cli.agent-hook.doctor.v1',
  ok: true,
  data: [{ product: 'dsh', registration_owner: 'dsh-runtime-kit', dispatch_supported: true }],
}) + '\\n')
`)
  chmodSync(agentHook, 0o755)
  const agentDocs = join(root, 'fake-agent-docs.mjs')
  writeFileSync(agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.0 (v1.27.0, test)\\n')
`)
  chmodSync(agentDocs, 0o755)
  return { commandDir, dsh, agentHook, agentDocs }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-operations-'))
  const home = join(root, 'dsh-home')
  const profileDir = join(home, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-work',
    private: true,
    dependencies: { 'unrelated-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['unrelated-bundle'] } },
    unrelated: { keep: true },
  })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# unrelated user config\n[]\n')
  const privateRoot = join(root, 'private-skills')
  const runtimeRoot = join(root, 'dsh-runtime')
  mkdirSync(privateRoot)
  mkdirSync(runtimeRoot, { mode: 0o700 })
  writeFileSync(join(privateRoot, 'must-survive.txt'), 'private')
  const commands = stageFakeCommands(root)
  const agentDocsHome = join(root, 'agent-docs')
  const agentDocsStateHome = join(root, 'agent-docs-state')
  mkdirSync(agentDocsHome, { mode: 0o700 })
  mkdirSync(agentDocsStateHome, { mode: 0o700 })
  writeFileSync(join(agentDocsHome, 'AGENT_DOCS.toml'), '[[document]]\ncontext = "project-dev"\n', { mode: 0o600 })
  return {
    root,
    home,
    profileDir,
    privateRoot,
    runtimeRoot,
    agentDocsHome,
    agentDocsStateHome,
    v1: stageBundle(root, '1.0.0'),
    v2: stageBundle(root, '2.0.0'),
    ...commands,
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

function run(subject, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args, '--format', 'json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_HOME: subject.home,
      DSH_RUNTIME_KIT_DSH_BIN: subject.dsh,
      DSH_RUNTIME_KIT_AGENT_HOOK_BIN: subject.agentHook,
      DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: join(subject.root, 'agent-hook', 'config.toml'),
      DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: join(subject.root, 'agent-hook', 'policy.toml'),
      DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: join(subject.root, 'agent-hook', 'state'),
      DSH_RUNTIME_KIT_AGENT_DOCS_BIN: subject.agentDocs,
      DSH_RUNTIME_KIT_AGENT_DOCS_HOME: subject.agentDocsHome,
      DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: subject.agentDocsStateHome,
      DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: subject.privateRoot,
      DSH_RUNTIME_KIT_RUNTIME_ROOT: subject.runtimeRoot,
      PATH: `${subject.commandDir}${delimiter}${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  })
  let value
  try { value = JSON.parse(result.stdout) } catch { value = undefined }
  return { ...result, value }
}

function applyPlan(subject, args) {
  const preview = run(subject, args)
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(preview.value.data.mode, 'dry-run')
  const applied = run(subject, [...args, '--apply', '--expected-plan-digest', preview.value.data.plan_digest])
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
  return { preview: preview.value.data, applied: applied.value.data }
}

test('setup, update, rollback, and remove preserve unrelated profile and private state', () => {
  const subject = fixture()
  try {
    const before = readFileSync(join(subject.profileDir, 'package.json'), 'utf8')
    const setupPreview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(setupPreview.status, 0, setupPreview.stderr)
    assert.equal(setupPreview.value.data.plan.action, 'install')
    assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), before)
    assert.equal(run(subject, ['setup', '--profile', 'work', '--package', subject.v1, '--apply']).status, 64)

    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const setupReplay = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', setup.preview.plan_digest,
    ])
    assert.equal(setupReplay.status, 0)
    assert.equal(setupReplay.value.data.mode, 'duplicate')
    assert.deepEqual(setupReplay.value.data.plan, setup.preview.plan)

    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    assert.equal(JSON.parse(readFileSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit/package.json'))).version, '2.0.0')

    applyPlan(subject, ['rollback', '--profile', 'work'])
    assert.equal(JSON.parse(readFileSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit/package.json'))).version, '1.0.0')

    applyPlan(subject, ['remove', '--profile', 'work'])
    const after = JSON.parse(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(after.dependencies, { 'unrelated-plugin': '1.0.0' })
    assert.deepEqual(after.dsh.profile.bundles, ['unrelated-bundle'])
    assert.deepEqual(after.unrelated, { keep: true })
    assert.equal(readFileSync(join(subject.profileDir, 'cordis.patch.yml'), 'utf8'), '# unrelated user config\n[]\n')
    assert.equal(readFileSync(join(subject.privateRoot, 'must-survive.txt'), 'utf8'), 'private')
  } finally {
    subject.cleanup()
  }
})

test('operations bind toolchain and activate the exact versioned policy and docs asset set', () => {
  const subject = fixture()
  try {
    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(setup.preview.plan.runtime_root, realpathSync(subject.runtimeRoot))
    assert.equal(setup.preview.plan.toolchain.dsh.version, '0.1.0-rc.7')
    assert.equal(
      setup.preview.plan.toolchain.dsh.source_revision,
      '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
    )
    assert.match(setup.preview.plan.toolchain.dsh.executable_sha256, /^[a-f0-9]{64}$/)
    assert.match(setup.preview.plan.toolchain.pnpm.executable_sha256, /^[a-f0-9]{64}$/)
    assert.match(setup.preview.plan.toolchain.pnpm.version, /^\d+\.\d+\.\d+/)
    assert.match(setup.preview.plan.target.assets.asset_set_sha256, /^[a-f0-9]{64}$/)

    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const first = JSON.parse(readFileSync(activationPath, 'utf8'))
    assert.equal(first.schema_version, 'dsh-runtime-kit.activation.v1')
    assert.equal(first.profile, 'work')
    assert.equal(first.package_version, '1.0.0')
    assert.equal(first.asset_set_sha256, setup.preview.plan.target.assets.asset_set_sha256)
    for (const relative of [
      first.agent_hook.config,
      first.agent_hook.policy,
      first.agent_docs.home,
      first.agent_hook.state,
      first.agent_docs.state,
    ]) {
      assert.equal(resolve(subject.runtimeRoot, relative).startsWith(`${subject.runtimeRoot}/`), true)
    }

    const update = applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const second = JSON.parse(readFileSync(activationPath, 'utf8'))
    assert.equal(second.package_version, '2.0.0')
    assert.notEqual(second.asset_set_sha256, first.asset_set_sha256)
    assert.equal(second.asset_set_sha256, update.preview.plan.target.assets.asset_set_sha256)

    applyPlan(subject, ['rollback', '--profile', 'work'])
    const rolledBack = JSON.parse(readFileSync(activationPath, 'utf8'))
    assert.equal(rolledBack.package_version, '1.0.0')
    assert.equal(rolledBack.asset_set_sha256, first.asset_set_sha256)

    const activePolicy = join(subject.runtimeRoot, rolledBack.agent_hook.policy)
    writeFileSync(activePolicy, `${readFileSync(activePolicy, 'utf8')}# tampered\n`)
    const drifted = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(drifted.status, 65)
    assert.equal(drifted.value.data.status, 'needs-attention')
    assert.equal(drifted.value.data.activation.ok, false)
    assert.match(drifted.value.data.activation.error, /digest|activation/u)
  } finally {
    subject.cleanup()
  }
})

test('apply rejects DSH or pnpm tool replacement after preview before profile mutation', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const original = readFileSync(subject.dsh, 'utf8')
    writeFileSync(subject.dsh, `${original}\n// toolchain replacement\n`)
    chmodSync(subject.dsh, 0o755)
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('doctor finalizes a package mutation interrupted before asset activation', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    writeFileSync(join(subject.home, 'block-asset-activation'), '')
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.notEqual(interrupted.status, 0)
    assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), false)
    unlinkSync(join(subject.home, 'block-asset-activation'))
    rmSync(join(subject.runtimeRoot, 'assets'), { force: true })

    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.value.data.recovery.action, 'finalize')
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const repaired = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(repaired.status, 0, repaired.stderr)
    assert.equal(
      JSON.parse(readFileSync(join(subject.runtimeRoot, 'activation.json'), 'utf8')).package_version,
      '1.0.0',
    )
  } finally {
    subject.cleanup()
  }
})

test('unexpected unrelated profile and lockfile mutations are restored and rejected', () => {
  const subject = fixture()
  try {
    const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
    writeFileSync(lockfile, `lockfileVersion: '9.0'
importers:
  .: {}
packages:
  unrelated@1.0.0:
    resolution: {integrity: preserved}
snapshots:
  unrelated@1.0.0: {}
`)
    const manifestBefore = readFileSync(join(subject.profileDir, 'package.json'), 'utf8')
    const lockfileBefore = readFileSync(lockfile, 'utf8')
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'native-dsh-collateral-mutation')
    assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), manifestBefore)
    assert.equal(readFileSync(lockfile, 'utf8'), lockfileBefore)
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('doctor rejects missing DSH-only agent-hook isolation paths before execution', () => {
  const subject = fixture()
  try {
    const result = run(subject, ['doctor', '--profile', 'work'], {
      DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: '',
    })
    assert.equal(result.status, 65)
    assert.equal(result.value.error.code, 'agent-hook-isolation-invalid')
    assert.match(result.value.error.message, /agentHookConfig is required/)
  } finally {
    subject.cleanup()
  }
})

test('doctor reports DSH-only agent-docs executable, catalog, and state health', () => {
  const subject = fixture()
  try {
    const healthy = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(healthy.status, 0, healthy.stderr)
    assert.equal(healthy.value.data.status, 'healthy')
    assert.deepEqual(healthy.value.data.agent_docs, {
      ok: true,
      version: '1.27.0',
      catalog: join(subject.agentDocsHome, 'AGENT_DOCS.toml'),
      state_home: subject.agentDocsStateHome,
    })

    const absent = run(subject, ['doctor', '--profile', 'work'], {
      DSH_RUNTIME_KIT_AGENT_DOCS_HOME: '',
    })
    assert.equal(absent.status, 65)
    assert.equal(absent.value.data.status, 'needs-attention')
    assert.equal(absent.value.data.agent_docs.ok, false)
    assert.match(absent.value.data.agent_docs.error, /agentDocsHome is required/)

    rmSync(join(subject.agentDocsHome, 'AGENT_DOCS.toml'))
    const missingCatalog = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(missingCatalog.status, 65)
    assert.equal(missingCatalog.value.data.agent_docs.ok, false)
    assert.match(missingCatalog.value.data.agent_docs.error, /catalog/)
  } finally {
    subject.cleanup()
  }
})

test('reviewed plans reject profile drift before invoking DSH', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const manifest = JSON.parse(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'))
    manifest.unrelated.changedAfterPreview = true
    writeJson(join(subject.profileDir, 'package.json'), manifest)
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.match(rejected.value.error.code, /plan-drift/)
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('doctor plans and finalizes an interrupted native DSH mutation', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], (() => {
      writeFileSync(join(subject.home, 'fail-after-mutation'), '')
      return {}
    })())
    assert.equal(interrupted.status, 70)
    unlinkSync(join(subject.home, 'fail-after-mutation'))

    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.status, 65)
    assert.equal(doctor.value.data.recovery.action, 'finalize')
    assert.equal(doctor.value.data.agent_hook.ok, true)

    const repairPreview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repairPreview.status, 0)
    const repaired = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repairPreview.value.data.plan_digest,
    ])
    assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`)
    assert.equal(repaired.value.data.mode, 'applied')
    const healthy = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.equal(healthy.value.data.status, 'healthy')
  } finally {
    subject.cleanup()
  }
})

test('external command deadlines release operation locks after a wedged DSH process', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    writeFileSync(join(subject.home, 'hang-command'), '')
    writeFileSync(join(subject.home, 'spawn-descendant'), '')
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], { DSH_RUNTIME_KIT_COMMAND_TIMEOUT_MS: '100' })
    assert.equal(rejected.status, 70)
    assert.equal(rejected.value.error.code, 'command-timeout')
    unlinkSync(join(subject.home, 'hang-command'))
    unlinkSync(join(subject.home, 'spawn-descendant'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    assert.equal(existsSync(join(subject.home, 'late-descendant')), false)

    const lock = new DatabaseSync(join(subject.home, 'runtime-kit', 'state', 'work.lock'))
    try {
      lock.exec('BEGIN EXCLUSIVE')
      lock.exec('ROLLBACK')
    } finally {
      lock.close()
    }
  } finally {
    subject.cleanup()
  }
})

test('a command that returns with a live descendant is quiesced before locks release', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    writeFileSync(join(subject.home, 'leave-descendant-after-mutation'), '')
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 70)
    assert.equal(rejected.value.error.code, 'command-descendants-left-running')
    unlinkSync(join(subject.home, 'leave-descendant-after-mutation'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    assert.equal(existsSync(join(subject.home, 'late-normal-exit')), false)

    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.value.data.recovery.action, 'finalize')
  } finally {
    subject.cleanup()
  }
})

test('doctor finalizes exact registry setup and update after supervisor loss before the success marker', () => {
  const subject = fixture()
  try {
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    for (const [operation, version] of [['setup', '1.2.3'], ['update', '2.0.0']]) {
      const target = `@sympoies/dsh-runtime-kit@${version}`
      const preview = run(subject, [operation, '--profile', 'work', '--package', target])
      assert.equal(preview.status, 0, preview.stderr)
      writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
      const interrupted = run(subject, [
        operation, '--profile', 'work', '--package', target,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.notEqual(interrupted.status, 0)
      unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      assert.equal(existsSync(join(subject.home, 'late-supervisor-loss')), false)
      const packsBeforeRecovery = readFileSync(join(subject.home, 'registry-pack-count'), 'utf8')

      const pending = JSON.parse(readFileSync(statePath, 'utf8')).pending
      assert.equal(pending.phase, 'prepared')
      const doctor = run(subject, ['doctor', '--profile', 'work'])
      assert.equal(doctor.value.data.recovery.action, 'finalize')
      const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
      const repaired = run(subject, [
        'doctor', '--profile', 'work', '--repair', '--apply',
        '--expected-plan-digest', repair.value.data.plan_digest,
      ])
      assert.equal(repaired.status, 0, repaired.stderr)
      assert.equal(
        readFileSync(join(subject.home, 'registry-pack-count'), 'utf8'),
        packsBeforeRecovery,
      )
    }
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(state.current.installed_version, '2.0.0')
    assert.equal(state.previous.installed_version, '1.2.3')
  } finally {
    subject.cleanup()
  }
})

test('doctor finalizes setup and update after native success but terminal verification failure', () => {
  const subject = fixture()
  try {
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const installed = join(subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit')
    for (const [operation, target, expectedPrevious] of [
      ['setup', subject.v1, null],
      ['update', subject.v2, '1.0.0'],
    ]) {
      const preview = run(subject, [operation, '--profile', 'work', '--package', target])
      writeFileSync(join(subject.home, 'corrupt-after-success'), '')
      const interrupted = run(subject, [
        operation, '--profile', 'work', '--package', target,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.notEqual(interrupted.status, 0)
      unlinkSync(join(subject.home, 'corrupt-after-success'))
      const pending = JSON.parse(readFileSync(statePath, 'utf8')).pending
      assert.equal(pending.phase, 'native-applied')

      rmSync(installed, { recursive: true, force: true })
      mkdirSync(installed, { recursive: true })
      const artifact = join(
        subject.home,
        'runtime-kit',
        'artifacts',
        `${pending.target.artifact_sha256}.tgz`,
      )
      const restored = spawnSync('tar', [
        '-xzf', artifact, '-C', installed, '--strip-components=1',
      ])
      assert.equal(restored.status, 0, restored.stderr?.toString())
      const doctor = run(subject, ['doctor', '--profile', 'work'])
      assert.ok(doctor.value, `${doctor.stdout}\n${doctor.stderr}`)
      assert.ok(doctor.value.data, JSON.stringify(doctor.value))
      assert.equal(doctor.value.data.recovery.action, 'finalize')
      const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
      const repaired = run(subject, [
        'doctor', '--profile', 'work', '--repair', '--apply',
        '--expected-plan-digest', repair.value.data.plan_digest,
      ])
      assert.equal(repaired.status, 0, repaired.stderr)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.current.installed_version, operation === 'setup' ? '1.0.0' : '2.0.0')
      assert.equal(state.previous?.installed_version ?? null, expectedPrevious)
    }
  } finally {
    subject.cleanup()
  }
})

test('duplicate apply rechecks terminal state while holding the profile lock', () => {
  const subject = fixture()
  try {
    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const lockPath = join(subject.home, 'runtime-kit', 'state', 'work.lock')
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
    const lock = new DatabaseSync(lockPath)
    chmodSync(lockPath, 0o600)
    lock.exec('BEGIN EXCLUSIVE')
    try {
      const replay = run(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
        '--apply', '--expected-plan-digest', setup.preview.plan_digest,
      ])
      assert.equal(replay.status, 65)
      assert.equal(replay.value.error.code, 'operations-locked')
    } finally {
      lock.exec('ROLLBACK')
      lock.close()
    }
    const afterRelease = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', setup.preview.plan_digest,
    ])
    assert.equal(afterRelease.status, 0, afterRelease.stderr)
    assert.equal(afterRelease.value.data.mode, 'duplicate')
  } finally {
    subject.cleanup()
  }
})

test('digest-only duplicate replay needs no source but revalidates its bound toolchain', () => {
  const subject = fixture()
  try {
    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    rmSync(subject.v1, { recursive: true, force: true })
    const replay = run(subject, [
      'setup', '--profile', 'work',
      '--apply', '--expected-plan-digest', setup.preview.plan_digest,
    ])
    assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}`)
    assert.equal(replay.value.data.mode, 'duplicate')

    const missingToolchain = run(subject, [
      'setup', '--profile', 'work',
      '--apply', '--expected-plan-digest', setup.preview.plan_digest,
    ], {
      PATH: subject.root,
      DSH_RUNTIME_KIT_DSH_BIN: join(subject.root, 'missing-dsh'),
    })
    assert.equal(missingToolchain.status, 70)
    assert.equal(missingToolchain.value.error.code, 'command-unavailable')
  } finally {
    subject.cleanup()
  }
})

test('duplicate replay rejects a contradictory supplied package target', () => {
  const subject = fixture()
  try {
    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    for (const conflicting of [subject.v2, (() => {
      writeFileSync(join(subject.v1, 'changed.js'), 'changed\n')
      return subject.v1
    })()]) {
      const replay = run(subject, [
        'setup', '--profile', 'work', '--package', conflicting,
        '--apply', '--expected-plan-digest', setup.preview.plan_digest,
      ])
      assert.equal(replay.status, 65)
      assert.equal(replay.value.error.code, 'plan-drift')
    }
  } finally {
    subject.cleanup()
  }
})

test('doctor rejects mutation-only options before invoking diagnostics', () => {
  const subject = fixture()
  try {
    const unavailable = join(subject.root, 'must-not-run')
    for (const args of [
      ['doctor', '--profile', 'work', '--package', subject.v1],
      ['doctor', '--profile', 'work', '--apply', '--expected-plan-digest', 'a'.repeat(64)],
    ]) {
      const rejected = run(subject, args, {
        DSH_RUNTIME_KIT_DSH_BIN: unavailable,
        DSH_RUNTIME_KIT_AGENT_HOOK_BIN: unavailable,
      })
      assert.equal(rejected.status, 64)
      assert.equal(rejected.value.ok, false)
      assert.match(rejected.value.error.code, /^unexpected-/)
    }
  } finally {
    subject.cleanup()
  }
})

test('invalid exact semantic versions are rejected before plan creation', () => {
  const subject = fixture()
  try {
    for (const version of ['01.0.0', '1.0.0-01', '1.0.0-..']) {
      const rejected = run(subject, [
        'setup', '--profile', 'work', '--package', `@sympoies/dsh-runtime-kit@${version}`,
      ])
      assert.equal(rejected.status, 64)
      assert.equal(rejected.value.error.code, 'invalid-package-spec')
      assert.equal(existsSync(join(subject.home, 'runtime-kit')), false)
    }
  } finally {
    subject.cleanup()
  }
})

test('local package content is authenticated by the reviewed plan', () => {
  const subject = fixture()
  try {
    writeFileSync(join(subject.v1, 'runtime.js'), 'export const value = 1\n')
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(preview.status, 0, preview.stderr)
    writeFileSync(join(subject.v1, 'runtime.js'), 'export const value = 2\n')
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('an exact registry target is installed from a reviewed immutable artifact', () => {
  const subject = fixture()
  try {
    const target = '@sympoies/dsh-runtime-kit@1.2.3'
    const applied = applyPlan(subject, ['setup', '--profile', 'work', '--package', target])
    assert.equal(applied.preview.plan.target.kind, 'registry')
    assert.equal(applied.preview.plan.target.expected_version, '1.2.3')
    assert.match(applied.preview.plan.target.artifact_sha256, /^[a-f0-9]{64}$/)
    assert.match(applied.preview.plan.target.installed_sha256, /^[a-f0-9]{64}$/)
    const state = JSON.parse(readFileSync(join(subject.home, 'runtime-kit', 'state', 'work.json'), 'utf8'))
    assert.match(state.current.dependency_spec, /^file:/)
    assert.equal(state.current.target.kind, 'registry')
    assert.equal(readFileSync(join(subject.home, 'registry-pack-count'), 'utf8'), '2')
  } finally {
    subject.cleanup()
  }
})

test('registry expansion bombs are rejected before extraction and release operation locks', () => {
  const subject = fixture()
  try {
    const target = '@sympoies/dsh-runtime-kit@1.2.3'
    const preview = run(subject, ['setup', '--profile', 'work', '--package', target])
    writeFileSync(join(subject.home, 'registry-expansion-bomb'), '')
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', target,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'invalid-package-spec')
    assert.match(rejected.value.error.message, /expansion limits|archive structure/)
    assert.deepEqual(readdirSync(join(subject.home, 'runtime-kit', 'artifacts')), [])

    unlinkSync(join(subject.home, 'registry-expansion-bomb'))
    const applied = run(subject, [
      'setup', '--profile', 'work', '--package', target,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(applied.status, 0, applied.stderr)
  } finally {
    subject.cleanup()
  }
})

test('update on the same local source path installs a newly reviewed artifact', () => {
  const subject = fixture()
  try {
    const runtimePath = join(subject.v1, 'runtime.js')
    writeFileSync(runtimePath, 'export const value = 1\n')
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const before = JSON.parse(readFileSync(statePath, 'utf8'))

    writeFileSync(runtimePath, 'export const value = 2\n')
    const updated = applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v1])
    assert.equal(updated.preview.plan.action, 'update')
    const after = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.notEqual(after.current.target.artifact_sha256, before.current.target.artifact_sha256)
    assert.equal(after.previous.target.artifact_sha256, before.current.target.artifact_sha256)

    writeFileSync(runtimePath, 'export const value = 3\n')
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v1])
    const retained = readdirSync(join(subject.home, 'runtime-kit', 'artifacts'))
      .filter(name => name.endsWith('.tgz'))
    assert.equal(retained.length, 2)

    applyPlan(subject, ['remove', '--profile', 'work'])
    const afterRemove = readdirSync(join(subject.home, 'runtime-kit', 'artifacts'))
      .filter(name => name.endsWith('.tgz'))
    assert.deepEqual(afterRemove, [])
  } finally {
    subject.cleanup()
  }
})

test('doctor and duplicate replay reject same-version installed-byte replacement', () => {
  for (const packageSpec of ['local', 'registry']) {
    const subject = fixture()
    try {
      const target = packageSpec === 'local'
        ? subject.v1
        : '@sympoies/dsh-runtime-kit@1.0.0'
      const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', target])
      writeFileSync(join(
        subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'forged.js',
      ), 'unreviewed bytes\n')
      const doctor = run(subject, ['doctor', '--profile', 'work'])
      assert.equal(doctor.status, 65)
      assert.equal(doctor.value.data.owned_status, 'drift')
      const replay = run(subject, [
        'setup', '--profile', 'work',
        '--apply', '--expected-plan-digest', setup.preview.plan_digest,
      ])
      assert.equal(replay.status, 65)
      assert.equal(replay.value.error.code, 'owned-state-drift')
    } finally {
      subject.cleanup()
    }
  }
})

test('absent profiles cannot escape DSH home through parent or profile symlinks', () => {
  for (const level of ['profiles', 'profile']) {
    const subject = fixture()
    try {
      rmSync(subject.profileDir, { recursive: true, force: true })
      const external = join(subject.root, `external-${level}`)
      mkdirSync(external)
      if (level === 'profiles') {
        rmSync(join(subject.home, 'profiles'), { recursive: true, force: true })
        symlinkSync(external, join(subject.home, 'profiles'), 'dir')
      } else {
        symlinkSync(external, subject.profileDir, 'dir')
      }
      const rejected = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      assert.equal(rejected.status, 65)
      assert.equal(rejected.value.error.code, 'unsafe-profile-tree')
      assert.deepEqual(readdirSync(external), [])
    } finally {
      subject.cleanup()
    }
  }
})

test('remove refuses an intermediate symlink and preserves the external target', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const scope = join(subject.profileDir, 'node_modules', '@sympoies')
    rmSync(scope, { recursive: true, force: true })
    const externalScope = join(subject.root, 'external-scope')
    const externalPackage = join(externalScope, 'dsh-runtime-kit')
    mkdirSync(externalPackage, { recursive: true })
    writeJson(join(externalPackage, 'package.json'), {
      name: '@sympoies/dsh-runtime-kit',
      version: '1.0.0',
    })
    writeFileSync(join(externalPackage, 'must-survive.txt'), 'external')
    symlinkSync(externalScope, scope, 'dir')
    writeFileSync(join(subject.home, 'retain-installed-entry'), '')

    const rejected = run(subject, ['remove', '--profile', 'work'])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'unsafe-profile-tree')
    assert.equal(readFileSync(join(externalPackage, 'must-survive.txt'), 'utf8'), 'external')
  } finally {
    subject.cleanup()
  }
})

test('doctor refuses a forged pending receipt instead of adopting it', () => {
  const subject = fixture()
  try {
    writeFileSync(join(subject.home, 'fail-after-mutation'), '')
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(interrupted.status, 70)
    unlinkSync(join(subject.home, 'fail-after-mutation'))
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const original = JSON.parse(readFileSync(statePath, 'utf8'))
    const forged = structuredClone(original)
    forged.pending.operation = 'forged-operation'
    writeJson(statePath, forged)
    chmodSync(statePath, 0o600)
    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.status, 65)
    assert.equal(doctor.value.error.code, 'invalid-operations-state')

    const mismatchedDigest = structuredClone(original)
    mismatchedDigest.pending.plan.action = 'noop'
    writeJson(statePath, mismatchedDigest)
    chmodSync(statePath, 0o600)
    const digestRejected = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(digestRejected.status, 65)
    assert.equal(digestRejected.value.error.code, 'invalid-operations-state')

    const mismatchedTarget = structuredClone(original)
    mismatchedTarget.pending.target.requested_spec = subject.v2
    writeJson(statePath, mismatchedTarget)
    chmodSync(statePath, 0o600)
    const targetRejected = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(targetRejected.status, 65)
    assert.equal(targetRejected.value.error.code, 'invalid-operations-state')
  } finally {
    subject.cleanup()
  }
})

test('same-version package sources cannot be adopted or recovered as each other', () => {
  const subject = fixture()
  try {
    const other = stageBundle(subject.root, '1.0.0-other')
    const otherManifest = JSON.parse(readFileSync(join(other, 'package.json'), 'utf8'))
    otherManifest.version = '1.0.0'
    writeJson(join(other, 'package.json'), otherManifest)

    const unmanaged = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const installed = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', unmanaged.value.data.plan_digest,
    ])
    assert.equal(installed.status, 0)
    rmSync(join(subject.home, 'runtime-kit'), { recursive: true, force: true })
    const adopt = run(subject, ['setup', '--profile', 'work', '--package', other])
    assert.equal(adopt.status, 65)
    assert.equal(adopt.value.error.code, 'unmanaged-owned-state')
  } finally {
    subject.cleanup()
  }

  const recoverySubject = fixture()
  try {
    const other = stageBundle(recoverySubject.root, '1.0.0-other')
    const otherManifest = JSON.parse(readFileSync(join(other, 'package.json'), 'utf8'))
    otherManifest.version = '1.0.0'
    writeJson(join(other, 'package.json'), otherManifest)
    writeFileSync(join(recoverySubject.home, 'fail-after-mutation'), '')
    const preview = run(recoverySubject, [
      'setup', '--profile', 'work', '--package', recoverySubject.v1,
    ])
    const interrupted = run(recoverySubject, [
      'setup', '--profile', 'work', '--package', recoverySubject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(interrupted.status, 70)
    unlinkSync(join(recoverySubject.home, 'fail-after-mutation'))
    const manifestPath = join(recoverySubject.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@sympoies/dsh-runtime-kit'] = `file:${other}`
    writeJson(manifestPath, manifest)
    const doctor = run(recoverySubject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.status, 65)
    assert.equal(doctor.value.data.recovery.action, 'unknown')
    const repair = run(recoverySubject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 65)
    assert.equal(repair.value.error.code, 'recovery-ambiguous')
  } finally {
    recoverySubject.cleanup()
  }
})

test('subprocesses receive a minimal environment and child stderr cannot echo secrets', () => {
  const subject = fixture()
  try {
    const hostile = join(subject.root, 'hostile-dsh.mjs')
    writeFileSync(hostile, `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.1.0-rc.7\\n')
  process.exit(0)
}
const sentinel = process.env.RUNTIME_KIT_SECRET_SENTINEL ?? '<absent>'
const proxy = process.env.HTTPS_PROXY ?? '<absent>'
process.stderr.write('sentinel=' + sentinel + ';proxy=' + proxy)
process.exit(sentinel === '<absent>' && !proxy.includes('must-not-leak') ? 70 : 71)
`)
    chmodSync(hostile, 0o755)
    const environment = {
      DSH_RUNTIME_KIT_DSH_BIN: hostile,
      RUNTIME_KIT_SECRET_SENTINEL: 'must-not-leak',
      HTTPS_PROXY: 'http://must-not-leak:credential@example.invalid',
    }
    const preview = run(
      subject,
      ['setup', '--profile', 'work', '--package', subject.v1],
      environment,
    )
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], environment)
    assert.equal(rejected.status, 70)
    assert.equal(rejected.value.error.details.exit_code, 70)
    assert.equal(rejected.stdout.includes('must-not-leak'), false)
    assert.equal(rejected.stderr.includes('must-not-leak'), false)
  } finally {
    subject.cleanup()
  }
})
