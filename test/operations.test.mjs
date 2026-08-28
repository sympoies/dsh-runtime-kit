import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const cli = join(projectRoot, 'bin', 'dsh-runtime-kit.js')
const commandSupervisor = join(projectRoot, 'src', 'operations', 'supervise-command.mjs')

const sha256 = value => createHash('sha256').update(value).digest('hex')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function normalizeExecutableModes(root) {
  const stat = lstatSync(root)
  if (stat.isDirectory()) {
    for (const name of readdirSync(root)) normalizeExecutableModes(join(root, name))
  } else if (stat.isFile() && (stat.mode & 0o111) !== 0) {
    chmodSync(root, 0o755)
  }
}

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
      if (existsSync(join(home, 'normalize-installed-executable-modes'))) {
        normalizeExecutableModes(installed)
      }
      if (existsSync(join(home, 'normalize-bundled-installed-tree'))) {
        const bundled = join(installed, 'node_modules', 'fixture-dependency')
        if (existsSync(join(bundled, 'CHANGELOG.md'))) {
          rmSync(join(bundled, 'CHANGELOG.md'))
        }
        const bin = join(installed, 'node_modules', '.bin')
        mkdirSync(bin, { recursive: true })
        symlinkSync('../fixture-dependency/bin.js', join(bin, 'fixture-dependency'))
      }
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
  manifest.unrelated = { forged: true }
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\\nimporters:\\n  .: {}\\npackages:\\n  unrelated@1.0.0:\\n    resolution: {integrity: forged}\\nsnapshots:\\n  unrelated@1.0.0: {}\\n")
}
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\\n')
if (verb === 'add' && existsSync(join(home, 'generate-owned-lockfile'))) {
  const spec = manifest.dependencies[packageName]
  const lockKey = packageName + '@' + spec
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const lockLines = [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: false',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    "      '" + packageName + "':",
    '        specifier: ' + spec,
    '        version: ' + spec,
    '',
    'packages:',
    '',
    "  '" + lockKey + "':",
    '    resolution: {integrity: fixture, tarball: ' + spec + '}',
    '    version: ' + installedManifest.version,
    '',
    'snapshots:',
    '',
    "  '" + lockKey + "': {}",
    '',
  ]
  const mutationPath = join(home, 'generated-owned-lock-mutation')
  if (existsSync(mutationPath)) {
    const mutation = readFileSync(mutationPath, 'utf8').trim()
    if (mutation === 'second-owned-root') {
      lockLines.splice(lockLines.indexOf('snapshots:'), 0,
        "  '" + packageName + "@forged':",
        '    resolution: {integrity: forged, tarball: ' + spec + '}',
        '')
      lockLines.push("  '" + packageName + "@forged': {}", '')
    } else if (mutation === 'attached-dependency') {
      lockLines.splice(lockLines.indexOf('snapshots:'), 0,
        "  'unrelated@1.0.0':",
        '    resolution: {integrity: forged}',
        '')
      const snapshot = lockLines.indexOf("  '" + lockKey + "': {}")
      lockLines.splice(snapshot, 1,
        "  '" + lockKey + "':",
        '    dependencies:',
        '      unrelated: 1.0.0',
        "  'unrelated@1.0.0': {}")
    } else if (mutation === 'unrelated-importer') {
      lockLines.splice(lockLines.indexOf('packages:'), 0, '  other: {}', '')
    } else if (mutation === 'unrelated-setting') {
      lockLines.splice(lockLines.indexOf('importers:'), 0, '  injected: true', '')
    } else if (mutation === 'unrelated-package') {
      lockLines.splice(lockLines.indexOf('snapshots:'), 0,
        "  'unrelated@1.0.0':",
        '    resolution: {integrity: forged}',
        '')
    } else if (mutation === 'unrelated-snapshot') {
      lockLines.push("  'unrelated@1.0.0': {}", '')
    } else if (mutation === 'unrelated-metadata') {
      lockLines.push('metadata:', '  injected: true', '')
    }
  }
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), lockLines.join('\\n'))
}
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
process.stdout.write('agent-docs 1.27.17 (v1.27.17, test)\\n')
`)
  chmodSync(agentDocs, 0o755)
  return { commandDir, dsh, pnpm, agentHook, agentDocs }
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

function pathWithoutSetsid(subject) {
  const path = join(subject.root, 'portable-command-bin')
  mkdirSync(path)
  cpSync(process.execPath, join(path, 'node'))
  chmodSync(join(path, 'node'), 0o755)
  return path
}

function applyPlan(subject, args, extraEnv = {}) {
  const preview = run(subject, args, extraEnv)
  assert.equal(preview.status, 0, preview.stderr)
  assert.equal(preview.value.data.mode, 'dry-run')
  const applied = run(subject, [
    ...args, '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
  ], extraEnv)
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
  return { preview: preview.value.data, applied: applied.value.data }
}

test('POSIX command containment does not depend on an external setsid executable', () => {
  if (process.platform === 'win32') return
  const subject = fixture()
  try {
    const portablePath = pathWithoutSetsid(subject)
    const result = run(subject, ['doctor', '--profile', 'work'], { PATH: portablePath })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.value.ok, true)
    assert.equal(result.value.data.dsh.ok, true)
  } finally {
    subject.cleanup()
  }
})

test('a governed command cannot start before its process group is published', () => {
  if (process.platform === 'win32') return
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-command-gate-'))
  const sentinel = join(root, 'command-started')
  const readOnlyControl = openSync('/dev/null', 'r')
  try {
    const result = spawnSync(process.execPath, [
      commandSupervisor,
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'started')",
      sentinel,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_RUNTIME_KIT_SUPERVISOR_TIMEOUT_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe', readOnlyControl],
    })
    assert.notEqual(result.status, 0, result.stderr)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    assert.equal(existsSync(sentinel), false)
  } finally {
    closeSync(readOnlyControl)
    rmSync(root, { recursive: true, force: true })
  }
})

function interruptCollateralUpdate(subject) {
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
  applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
  const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
  const activationPath = join(subject.runtimeRoot, 'activation.json')
  const expected = {
    state: JSON.parse(readFileSync(statePath, 'utf8')),
    activation: readFileSync(activationPath, 'utf8'),
    manifest: readFileSync(join(subject.profileDir, 'package.json'), 'utf8'),
    lockfile: readFileSync(lockfile, 'utf8'),
  }
  const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
  writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
  writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
  const interrupted = run(subject, [
    'update', '--profile', 'work', '--package', subject.v2,
    '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
  ])
  assert.notEqual(interrupted.status, 0)
  unlinkSync(join(subject.home, 'collateral-profile-mutation'))
  unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  const doctor = run(subject, ['doctor', '--profile', 'work'])
  assert.equal(doctor.value.data.recovery.action, 'restore-collateral')
  return { statePath, activationPath, lockfile, expected }
}

function assertExactPriorInstall(subject, recovery) {
  const state = JSON.parse(readFileSync(recovery.statePath, 'utf8'))
  const installed = JSON.parse(readFileSync(join(
    subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json',
  ), 'utf8'))
  assert.equal(installed.version, '1.0.0')
  assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), recovery.expected.manifest)
  assert.equal(readFileSync(recovery.lockfile, 'utf8'), recovery.expected.lockfile)
  assert.equal(readFileSync(recovery.activationPath, 'utf8'), recovery.expected.activation)
  assert.deepEqual(state.current, recovery.expected.state.current)
  assert.deepEqual(state.previous, recovery.expected.state.previous)
  assert.deepEqual(state.last_applied, recovery.expected.state.last_applied)
  assert.equal(state.pending, null)
}

function assertPrivateAtomicTemporary(directory, targetName) {
  const prefix = `.${targetName}.dsh-runtime-kit-atomic.`
  const names = readdirSync(directory).filter(name => name.startsWith(prefix) && name.endsWith('.tmp'))
  assert.equal(names.length, 1)
  const stat = lstatSync(join(directory, names[0]))
  assert.equal(stat.isFile(), true)
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(stat.mode & 0o077, 0)
  assert.equal(stat.nlink, 1)
  if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid())
}

function activationAssetSets(subject) {
  const root = join(subject.runtimeRoot, 'assets')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

function activationAssetInventory(subject) {
  const assetsRoot = join(subject.runtimeRoot, 'assets')
  if (!existsSync(assetsRoot)) return []
  const inventory = []
  const visit = (path, relativePath) => {
    const stat = lstatSync(path)
    inventory.push({
      path: relativePath,
      type: stat.isDirectory() ? 'directory' : 'file',
      mode: stat.mode & 0o777,
      sha256: stat.isFile() ? sha256(readFileSync(path)) : null,
    })
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name))
    }
  }
  for (const name of readdirSync(assetsRoot).sort()) visit(join(assetsRoot, name), name)
  return inventory
}

function makeAssetTreeOwnerOnly(root) {
  const stat = lstatSync(root)
  chmodSync(root, stat.isDirectory() ? 0o700 : 0o600)
  if (stat.isDirectory()) {
    for (const name of readdirSync(root)) makeAssetTreeOwnerOnly(join(root, name))
  }
}

function mutateFileSameLength(path) {
  const mutated = Buffer.from(readFileSync(path))
  assert.ok(mutated.length > 0)
  mutated[0] ^= 1
  writeFileSync(path, mutated, { mode: 0o600 })
  return mutated
}

function installConfigCommentBypass(subject, assetDigest, label) {
  const assetRoot = join(subject.runtimeRoot, 'assets', assetDigest)
  const policyPath = join(assetRoot, 'agent-hook', 'policy.toml')
  const configPath = join(assetRoot, 'agent-hook', 'config.toml')
  const expectedDigest = sha256(readFileSync(policyPath))
  const alternatePath = join(subject.root, `alternate-${label}-policy.toml`)
  writeFileSync(alternatePath, `schema_version = "dsh.policy.v1"\n# alternate ${label}\n`, { mode: 0o600 })
  const alternateDigest = sha256(readFileSync(alternatePath))
  const config = `schema_version = "agent-hook.config.v1"

[policy]
path = ${JSON.stringify(alternatePath)}
digest = "sha256:${alternateDigest}"
# path = ${JSON.stringify(policyPath)}
# digest = "sha256:${expectedDigest}"
`
  writeFileSync(configPath, config, { mode: 0o600 })
  return { alternatePath, config, configPath }
}

function activationForTarget(target, profile = 'work') {
  return {
    schema_version: 'dsh-runtime-kit.activation.v1',
    profile,
    package_version: target.expected_version,
    package_artifact_sha256: target.artifact_sha256,
    package_installed_sha256: target.installed_sha256,
    asset_set_sha256: target.assets.asset_set_sha256,
    assets: {
      policy_sha256: target.assets.policy_sha256,
      catalog_sha256: target.assets.catalog_sha256,
      document_sha256: target.assets.document_sha256,
    },
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

function legacyTarget(target) {
  const { assets: _assets, ...legacy } = target
  return legacy
}

function legacySnapshot(snapshot) {
  const {
    runtime_root: _runtimeRoot,
    activation_digest: _activationDigest,
    target,
    ...legacy
  } = snapshot
  return { ...legacy, target: legacyTarget(target) }
}

function legacyPlan(plan) {
  const {
    runtime_root: _runtimeRoot,
    toolchain: _toolchain,
    target,
    ...legacy
  } = plan
  return {
    ...legacy,
    schema_version: 'dsh-runtime-kit.operations-plan.v1',
    target: target === null ? null : legacyTarget(target),
  }
}

function legacyReceipt(receipt) {
  if (receipt === null) return null
  const plan = legacyPlan(receipt.plan)
  return { ...receipt, plan, plan_digest: sha256(stableJson(plan)) }
}

function writeLegacyTerminalState(subject) {
  const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  const legacy = {
    schema_version: 'dsh-runtime-kit.operations-state.v1',
    profile: 'work',
    current: current.current === null ? null : legacySnapshot(current.current),
    previous: current.previous === null ? null : legacySnapshot(current.previous),
    last_applied: legacyReceipt(current.last_applied),
    pending: null,
  }
  writeJson(statePath, legacy)
  rmSync(subject.runtimeRoot, { recursive: true, force: true })
  mkdirSync(subject.runtimeRoot, { mode: 0o700 })
  return { statePath, legacy }
}

test('base operations-state v1 migrates explicitly before update rollback and remove', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const { statePath } = writeLegacyTerminalState(subject)

    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.status, 65)
    assert.equal(diagnosed.value.data.recovery.action, 'migrate-v1')
    const preview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(preview.value.data.plan.schema_version, 'dsh-runtime-kit.operations-plan.v2')
    assert.equal(preview.value.data.plan.action, 'migrate-v1')
    const migrated = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(state.schema_version, 'dsh-runtime-kit.operations-state.v2')
    assert.equal(state.current.installed_version, '2.0.0')
    assert.equal(state.previous.installed_version, '1.0.0')
    assert.equal(state.current.runtime_root, subject.runtimeRoot)
    assert.match(state.current.target.assets.asset_set_sha256, /^[0-9a-f]{64}$/)
    assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), true)

    applyPlan(subject, ['rollback', '--profile', 'work'])
    assert.equal(
      JSON.parse(readFileSync(statePath, 'utf8')).current.installed_version,
      '1.0.0',
    )
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    applyPlan(subject, ['remove', '--profile', 'work'])
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).current, null)
  } finally {
    subject.cleanup()
  }
})

test('legacy migration rejects a retained previous receipt whose installed digest is not bound to its artifact', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const { statePath, legacy } = writeLegacyTerminalState(subject)
    legacy.previous.installed_digest = 'f'.repeat(64)
    writeJson(statePath, legacy)
    const before = readFileSync(statePath)

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(rejected.status, 65, `${rejected.stdout}\n${rejected.stderr}`)
    assert.equal(rejected.value.error.code, 'artifact-drift')
    assert.deepEqual(readFileSync(statePath), before)
    assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), false)
  } finally {
    subject.cleanup()
  }
})

test('removed base v1 state migrates without recreating package or activation state', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['remove', '--profile', 'work'])
    const { statePath } = writeLegacyTerminalState(subject)
    const preview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(preview.value.data.plan.action, 'migrate-v1')
    const migrated = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(migrated.status, 0, migrated.stderr)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(state.schema_version, 'dsh-runtime-kit.operations-state.v2')
    assert.equal(state.current, null)
    assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), false)
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)
  } finally {
    subject.cleanup()
  }
})

test('legacy pending state stays unchanged behind an actionable non-destructive recovery error', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const current = JSON.parse(readFileSync(statePath, 'utf8'))
    const next = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
    assert.equal(next.status, 0, next.stderr)
    const plan = legacyPlan(next.value.data.plan)
    const target = legacyTarget(next.value.data.plan.target)
    const legacy = {
      schema_version: 'dsh-runtime-kit.operations-state.v1',
      profile: 'work',
      current: legacySnapshot(current.current),
      previous: null,
      last_applied: legacyReceipt(current.last_applied),
      pending: {
        operation: 'update',
        plan_digest: sha256(stableJson(plan)),
        target,
        plan,
        phase: 'prepared',
        started_at: new Date().toISOString(),
      },
    }
    writeJson(statePath, legacy)
    rmSync(subject.runtimeRoot, { recursive: true, force: true })
    mkdirSync(subject.runtimeRoot, { mode: 0o700 })
    const before = readFileSync(statePath, 'utf8')

    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.status, 65)
    assert.equal(diagnosed.value.data.recovery.action, 'legacy-pending')
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 65)
    assert.equal(repair.value.error.code, 'legacy-pending-recovery-unsupported')
    assert.match(repair.value.error.message, /exact base CLI|backup/u)
    assert.equal(readFileSync(statePath, 'utf8'), before)
    assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), false)
  } finally {
    subject.cleanup()
  }
})

test('managed operations reject a supplied runtime root that differs from persisted receipts', () => {
  for (const operation of ['update', 'rollback', 'remove']) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      if (operation === 'rollback') {
        applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
      }
      const alternateRoot = join(subject.root, `alternate-${operation}`)
      mkdirSync(alternateRoot, { mode: 0o700 })
      const args = operation === 'update'
        ? ['update', '--profile', 'work', '--package', subject.v2]
        : [operation, '--profile', 'work']
      const rejected = run(subject, args, {
        DSH_RUNTIME_KIT_RUNTIME_ROOT: alternateRoot,
      })
      assert.equal(rejected.status, 65, operation)
      assert.equal(rejected.value.error.code, 'runtime-root-drift', operation)
      assert.equal(existsSync(join(subject.runtimeRoot, 'activation.json')), true)
      assert.equal(existsSync(join(alternateRoot, 'activation.json')), false)
    } finally {
      subject.cleanup()
    }
  }
})

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

test('setup accepts a profile whose manifest is initially absent', () => {
  const subject = fixture()
  try {
    unlinkSync(join(subject.profileDir, 'package.json'))

    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])

    const manifest = JSON.parse(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { '@sympoies/dsh-runtime-kit': manifest.dependencies['@sympoies/dsh-runtime-kit'] })
    assert.deepEqual(manifest.dsh.profile.bundles, ['@sympoies/dsh-runtime-kit'])
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)
  } finally {
    subject.cleanup()
  }
})

test('manifest-less setup still rejects mutation of a pre-existing lockfile', () => {
  const subject = fixture()
  try {
    unlinkSync(join(subject.profileDir, 'package.json'))
    const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
    const before = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
    writeFileSync(lockfile, before)
    writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')

    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])

    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'native-dsh-collateral-mutation')
    assert.equal(readFileSync(lockfile, 'utf8'), before)
    assert.equal(existsSync(join(subject.profileDir, 'package.json')), false)
  } finally {
    subject.cleanup()
  }
})

test('setup accepts a newly generated lockfile containing only the owned package', () => {
  const subject = fixture()
  try {
    const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
    assert.equal(existsSync(lockfile), false)
    writeFileSync(join(subject.home, 'generate-owned-lockfile'), '')

    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])

    assert.equal(existsSync(lockfile), true)
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)
  } finally {
    subject.cleanup()
  }
})

for (const mutation of [
  'second-owned-root',
  'attached-dependency',
  'unrelated-importer',
  'unrelated-setting',
  'unrelated-package',
  'unrelated-snapshot',
  'unrelated-metadata',
]) {
  test(`setup rejects a generated owned lockfile with ${mutation}`, () => {
    const subject = fixture()
    try {
      const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
      const manifestBefore = readFileSync(join(subject.profileDir, 'package.json'), 'utf8')
      assert.equal(existsSync(lockfile), false)
      writeFileSync(join(subject.home, 'generate-owned-lockfile'), '')
      writeFileSync(join(subject.home, 'generated-owned-lock-mutation'), mutation)

      const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const rejected = run(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])

      assert.equal(rejected.status, 65)
      assert.equal(rejected.value.error.code, 'native-dsh-collateral-mutation')
      assert.equal(existsSync(lockfile), false)
      assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), manifestBefore)
    } finally {
      subject.cleanup()
    }
  })
}

test('clean-profile recovery does not clear while a newly created manifest remains', () => {
  const subject = fixture()
  try {
    unlinkSync(join(subject.profileDir, 'package.json'))
    const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
    const before = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
    writeFileSync(lockfile, before)
    writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], {
      NODE_ENV: 'test',
      DSH_RUNTIME_KIT_TEST_FAULT_POINT: 'restore-profile:package.json:before-unlink',
    })
    assert.equal(interrupted.status, null)
    assert.equal(interrupted.signal, 'SIGKILL')
    unlinkSync(join(subject.home, 'collateral-profile-mutation'))

    // Model an interrupted restoration whose pre-existing control file was
    // restored while the DSH-created manifest still remained.
    writeFileSync(lockfile, before)
    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.value.data.recovery.action, 'restore-collateral')

    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const converged = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(converged.status, 65)
    assert.equal(converged.value.error.code, 'native-dsh-collateral-mutation')
    assert.equal(existsSync(join(subject.profileDir, 'package.json')), false)
    assert.equal(readFileSync(lockfile, 'utf8'), before)
  } finally {
    subject.cleanup()
  }
})

test('setup accepts package-manager normalization of owner-only executable modes', () => {
  const subject = fixture()
  try {
    const executable = join(subject.v1, 'runtime-command.sh')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(join(subject.home, 'normalize-installed-executable-modes'), '')

    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])

    const installed = join(subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'runtime-command.sh')
    assert.equal(lstatSync(executable).mode & 0o777, 0o700)
    assert.equal(lstatSync(installed).mode & 0o777, 0o755)
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)
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

test('operations bind the exact reviewed DSH rc.8 toolchain identity', () => {
  const subject = fixture()
  try {
    const source = readFileSync(subject.dsh, 'utf8')
    assert.match(source, /console\.log\('0\.1\.0-rc\.7'\)/)
    writeFileSync(subject.dsh, source.replace(
      "console.log('0.1.0-rc.7')",
      "console.log('0.1.0-rc.8')",
    ))
    chmodSync(subject.dsh, 0o755)

    const setup = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(setup.preview.plan.toolchain.dsh.version, '0.1.0-rc.8')
    assert.equal(
      setup.preview.plan.toolchain.dsh.source_revision,
      '141eb6fef83422698aef7a981029e843e8161534',
    )
    assert.equal(run(subject, ['doctor', '--profile', 'work']).value.data.dsh.version, '0.1.0-rc.8')
  } finally {
    subject.cleanup()
  }

  const unknown = fixture()
  try {
    const source = readFileSync(unknown.dsh, 'utf8')
    writeFileSync(unknown.dsh, source.replace(
      "console.log('0.1.0-rc.7')",
      "console.log('0.1.0-rc.9')",
    ))
    chmodSync(unknown.dsh, 0o755)
    const rejected = run(unknown, ['setup', '--profile', 'work', '--package', unknown.v1])
    assert.equal(rejected.status, 70)
    assert.equal(rejected.value.error.code, 'command-unavailable')
  } finally {
    unknown.cleanup()
  }
})

test('apply rejects DSH or pnpm tool replacement after preview before profile mutation', () => {
  for (const executable of ['dsh', 'pnpm']) {
    const subject = fixture()
    try {
      const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const original = readFileSync(subject[executable], 'utf8')
      const comment = executable === 'dsh' ? '// toolchain replacement' : '# toolchain replacement'
      writeFileSync(subject[executable], `${original}\n${comment}\n`)
      chmodSync(subject[executable], 0o755)
      const rejected = run(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.equal(rejected.status, 65, `${executable}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(rejected.value.error.code, 'plan-drift')
      assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
    } finally {
      subject.cleanup()
    }
  }
})

test('operations reject toolchain executables reached through an untrusted writable directory', () => {
  const subject = fixture()
  try {
    chmodSync(subject.root, 0o755)
    chmodSync(subject.commandDir, 0o777)
    const rejected = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(rejected.status, 70, `${rejected.stdout}\n${rejected.stderr}`)
    assert.equal(rejected.value.error.code, 'command-unavailable')
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

test('activation assets retain only current and rollback sets across updates and removal', () => {
  const subject = fixture()
  try {
    const v3 = stageBundle(subject.root, '3.0.0')
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    applyPlan(subject, ['update', '--profile', 'work', '--package', v3])
    const state = JSON.parse(readFileSync(join(subject.home, 'runtime-kit', 'state', 'work.json'), 'utf8'))
    assert.deepEqual(
      activationAssetSets(subject),
      [state.current.target.assets.asset_set_sha256, state.previous.target.assets.asset_set_sha256].sort(),
    )

    applyPlan(subject, ['remove', '--profile', 'work'])
    assert.deepEqual(activationAssetSets(subject), [])
  } finally {
    subject.cleanup()
  }
})

test('a pre-pending staging crash is collected by the next authenticated apply', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const before = JSON.parse(readFileSync(statePath, 'utf8'))
    const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const interrupted = run(subject, [
      'update', '--profile', 'work', '--package', subject.v2,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], {
      NODE_ENV: 'test',
      DSH_RUNTIME_KIT_TEST_FAULT_POINT: 'after-stage-activation-assets',
    })
    assert.equal(interrupted.status, null)
    assert.equal(interrupted.signal, 'SIGKILL')
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), before)
    assert.equal(activationAssetSets(subject).length, 2)

    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.deepEqual(activationAssetSets(subject), [before.current.target.assets.asset_set_sha256])
  } finally {
    subject.cleanup()
  }
})

test('one runtime root cannot be shared by different DSH homes', () => {
  const owner = fixture()
  const contender = fixture()
  try {
    applyPlan(owner, ['setup', '--profile', 'work', '--package', owner.v1])
    contender.runtimeRoot = owner.runtimeRoot
    const preview = run(contender, ['setup', '--profile', 'work', '--package', contender.v1])
    assert.equal(preview.status, 0, preview.stderr)
    const rejected = run(contender, [
      'setup', '--profile', 'work', '--package', contender.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'runtime-root-owner-mismatch')
    assert.equal(run(owner, ['doctor', '--profile', 'work']).status, 0)
  } finally {
    owner.cleanup()
    contender.cleanup()
  }
})

test('doctor adopts an exact ownerless v2 runtime root only for its originating DSH home', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    const rootLockPath = join(subject.runtimeRoot, '.dsh-runtime-kit.lock')
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const unrelatedArtifact = join(
      subject.home, 'runtime-kit', 'artifacts', `${'0'.repeat(64)}.tgz`,
    )
    writeFileSync(unrelatedArtifact, 'must remain untouched', { mode: 0o600 })
    const before = {
      state: readFileSync(statePath, 'utf8'),
      activation: readFileSync(activationPath, 'utf8'),
      assets: activationAssetSets(subject),
      unrelatedArtifact: readFileSync(unrelatedArtifact, 'utf8'),
    }
    unlinkSync(ownerPath)
    unlinkSync(rootLockPath)
    assert.equal(existsSync(ownerPath), false)
    assert.equal(existsSync(rootLockPath), false)

    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.status, 65)
    assert.equal(diagnosed.value.data.recovery.action, 'adopt-owner')
    const preview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(preview.value.data.plan.action, 'adopt-owner')
    const adopted = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(adopted.status, 0, `${adopted.stdout}\n${adopted.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(ownerPath, 'utf8')), {
      schema_version: 'dsh-runtime-kit.runtime-root-owner.v1',
      dsh_home: realpathSync(subject.home),
    })
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
    assert.deepEqual(activationAssetSets(subject), before.assets)
    assert.equal(readFileSync(unrelatedArtifact, 'utf8'), before.unrelatedArtifact)
    assert.equal(lstatSync(rootLockPath).isFile(), true)
    assert.equal(lstatSync(rootLockPath).mode & 0o077, 0)
    assert.equal(run(subject, ['doctor', '--profile', 'work']).status, 0)

    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    assert.equal(JSON.parse(readFileSync(join(
      subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json',
    ), 'utf8')).version, '2.0.0')
    applyPlan(subject, ['remove', '--profile', 'work'])
    const removedState = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(removedState.current, null)
    assert.equal(removedState.pending, null)
    assert.equal(existsSync(activationPath), false)
    assert.deepEqual(activationAssetSets(subject), [])
    assert.equal(existsSync(ownerPath), true)
    assert.equal(existsSync(rootLockPath), true)
  } finally {
    subject.cleanup()
  }
})

test('ownerless runtime-root adoption rejects cross-home and inexact candidates', () => {
  for (const scenario of [
    'cross-home', 'unmanaged', 'drifted', 'missing-set', 'extra-set', 'staging-set',
  ]) {
    const subject = fixture()
    const contender = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
      unlinkSync(ownerPath)
      let operator = subject
      if (scenario === 'cross-home') {
        contender.runtimeRoot = subject.runtimeRoot
        operator = contender
      } else if (scenario === 'unmanaged') {
        rmSync(join(subject.home, 'runtime-kit', 'state'), { recursive: true, force: true })
      } else if (scenario === 'drifted') {
        const activation = JSON.parse(readFileSync(join(subject.runtimeRoot, 'activation.json'), 'utf8'))
        writeFileSync(
          join(subject.runtimeRoot, activation.agent_hook.policy),
          '# activation drift\n',
          { mode: 0o600 },
        )
      } else {
        const assetSet = JSON.parse(
          readFileSync(join(subject.runtimeRoot, 'activation.json'), 'utf8'),
        ).asset_set_sha256
        const assetsRoot = join(subject.runtimeRoot, 'assets')
        if (scenario === 'missing-set') {
          rmSync(join(assetsRoot, assetSet), { recursive: true, force: true })
        } else if (scenario === 'extra-set') {
          mkdirSync(join(assetsRoot, '0'.repeat(64)), { mode: 0o700 })
        } else {
          mkdirSync(join(assetsRoot, `.${assetSet}.interrupted`), { mode: 0o700 })
        }
      }
      const before = readdirSync(subject.runtimeRoot).sort()
      const rejected = run(operator, ['doctor', '--profile', 'work', '--repair'])
      assert.equal(rejected.status, 65, `${scenario}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(existsSync(ownerPath), false, scenario)
      assert.deepEqual(readdirSync(subject.runtimeRoot).sort(), before, scenario)
    } finally {
      subject.cleanup()
      contender.cleanup()
    }
  }
})

test('ownerless adoption binds one phase-consistent actual and activation provenance', () => {
  for (const scenario of ['prepared-current-pending', 'native-applied-pending-current']) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const activationPath = join(subject.runtimeRoot, 'activation.json')
      const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
      const rootLockPath = join(subject.runtimeRoot, '.dsh-runtime-kit.lock')
      const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
      writeFileSync(join(subject.home, 'fail-after-mutation'), '')
      const interrupted = run(subject, [
        'update', '--profile', 'work', '--package', subject.v2,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.equal(interrupted.status, 70)
      unlinkSync(join(subject.home, 'fail-after-mutation'))
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.pending.phase, 'prepared')

      if (scenario === 'native-applied-pending-current') {
        state.pending.phase = 'native-applied'
        writeJson(statePath, state)
      } else {
        const restored = spawnSync(subject.dsh, [
          'plugin', '--profile', 'work', 'add', '--save-exact', state.current.dependency_spec,
        ], {
          encoding: 'utf8',
          env: { ...process.env, DSH_HOME: subject.home },
        })
        assert.equal(restored.status, 0, restored.stderr)
        writeJson(activationPath, activationForTarget(state.pending.target))
      }
      unlinkSync(ownerPath)
      unlinkSync(rootLockPath)
      const before = {
        state: readFileSync(statePath, 'utf8'),
        activation: readFileSync(activationPath, 'utf8'),
        assets: activationAssetSets(subject),
      }

      const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
      if (scenario === 'native-applied-pending-current') {
        assert.equal(repair.status, 0, repair.stderr)
        assert.equal(repair.value.data.plan.adoption.observed_actual_source, 'pending')
        assert.equal(repair.value.data.plan.adoption.observed_activation_source, 'current')
        assert.equal(repair.value.data.plan.adoption.pending_phase, 'native-applied')
        assert.equal(repair.value.data.plan.adoption.pending_action, 'update')
        const adopted = run(subject, [
          'doctor', '--profile', 'work', '--repair', '--apply',
          '--expected-plan-digest', repair.value.data.plan_digest,
        ])
        assert.equal(adopted.status, 0, adopted.stderr)
        assert.equal(existsSync(ownerPath), true)
      } else {
        assert.equal(repair.status, 65, repair.stderr)
        assert.equal(repair.value.error.code, 'runtime-root-owner-missing')
        assert.equal(existsSync(ownerPath), false)
      }
      assert.equal(readFileSync(statePath, 'utf8'), before.state)
      assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
      assert.deepEqual(activationAssetSets(subject), before.assets)
    } finally {
      subject.cleanup()
    }
  }
})

test('ownerless adoption rejects authenticated asset drift after preview before claiming', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    const rootLockPath = join(subject.runtimeRoot, '.dsh-runtime-kit.lock')
    unlinkSync(ownerPath)
    unlinkSync(rootLockPath)
    const preview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(preview.status, 0, preview.stderr)
    const activation = JSON.parse(readFileSync(activationPath, 'utf8'))
    const policyPath = join(subject.runtimeRoot, activation.agent_hook.policy)
    writeFileSync(policyPath, `${readFileSync(policyPath, 'utf8')}# post-preview drift\n`)
    const before = {
      state: readFileSync(statePath, 'utf8'),
      activation: readFileSync(activationPath, 'utf8'),
      policy: readFileSync(policyPath, 'utf8'),
    }

    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65, rejected.stderr)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
    assert.equal(readFileSync(policyPath, 'utf8'), before.policy)
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption rejects an inactive retained asset changed before preview', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const retainedPolicy = join(
      subject.runtimeRoot,
      'assets',
      state.previous.target.assets.asset_set_sha256,
      'agent-hook',
      'policy.toml',
    )
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
    const mutated = mutateFileSameLength(retainedPolicy)
    const before = {
      state: readFileSync(statePath, 'utf8'),
      activation: readFileSync(activationPath, 'utf8'),
    }

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(rejected.status, 65, rejected.stdout)
    assert.equal(rejected.value.error.code, 'activation-asset-inventory-invalid')
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
    assert.deepEqual(readFileSync(retainedPolicy), mutated)
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption rejects a comment-hidden alternate active policy config', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const bypass = installConfigCommentBypass(
      subject,
      state.current.target.assets.asset_set_sha256,
      'active',
    )
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(rejected.status, 65, rejected.stdout)
    assert.equal(rejected.value.error.code, 'runtime-root-owner-missing')
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(bypass.configPath, 'utf8'), bypass.config)
    assert.equal(existsSync(bypass.alternatePath), true)
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption rejects a comment-hidden alternate inactive policy config', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const bypass = installConfigCommentBypass(
      subject,
      state.previous.target.assets.asset_set_sha256,
      'inactive',
    )
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(rejected.status, 65, rejected.stdout)
    assert.equal(rejected.value.error.code, 'activation-asset-inventory-invalid')
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(bypass.configPath, 'utf8'), bypass.config)
    assert.equal(existsSync(bypass.alternatePath), true)
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption apply rejects inactive retained asset drift after preview', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const retainedDigest = state.previous.target.assets.asset_set_sha256
    const retainedRoot = join(
      subject.runtimeRoot,
      'assets',
      retainedDigest,
    )
    const reviewedExtra = join(retainedRoot, 'reviewed-extra')
    writeFileSync(reviewedExtra, 'tree-digest-a', { mode: 0o600 })
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))

    const preview = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(preview.status, 0, preview.stderr)
    const retainedEvidence = preview.value.data.plan.adoption.retained_asset_sets
      .find(entry => entry.digest === retainedDigest)
    assert.match(retainedEvidence.tree_sha256, /^[0-9a-f]{64}$/)
    const mutated = mutateFileSameLength(reviewedExtra)
    const before = {
      state: readFileSync(statePath, 'utf8'),
      activation: readFileSync(activationPath, 'utf8'),
    }
    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65, rejected.stdout)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
    assert.deepEqual(readFileSync(reviewedExtra), mutated)
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption preserves an authenticated previous set for rollback', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2])
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))

    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 0, repair.stderr)
    const adopted = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(adopted.status, 0, adopted.stderr)
    applyPlan(subject, ['rollback', '--profile', 'work'])
    const state = JSON.parse(readFileSync(
      join(subject.home, 'runtime-kit', 'state', 'work.json'),
      'utf8',
    ))
    assert.equal(state.current.target.expected_version, '1.0.0')
    assert.equal(
      JSON.parse(readFileSync(join(subject.runtimeRoot, 'activation.json'), 'utf8')).asset_set_sha256,
      state.current.target.assets.asset_set_sha256,
    )
  } finally {
    subject.cleanup()
  }
})

test('ownerless adoption enumerates exact terminal and interrupted remove states', () => {
  const removed = fixture()
  try {
    applyPlan(removed, ['setup', '--profile', 'work', '--package', removed.v1])
    const orphanDigest = activationAssetSets(removed)[0]
    const orphanBackup = join(removed.root, 'pre-owner-remove-assets')
    cpSync(join(removed.runtimeRoot, 'assets', orphanDigest), orphanBackup, { recursive: true })
    applyPlan(removed, ['remove', '--profile', 'work'])
    const statePath = join(removed.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(removed.runtimeRoot, 'activation.json')
    const ownerPath = join(removed.runtimeRoot, '.dsh-runtime-kit-owner.json')
    const orphanPath = join(removed.runtimeRoot, 'assets', orphanDigest)
    cpSync(orphanBackup, orphanPath, { recursive: true })
    makeAssetTreeOwnerOnly(orphanPath)
    unlinkSync(ownerPath)
    unlinkSync(join(removed.runtimeRoot, '.dsh-runtime-kit.lock'))
    assert.equal(existsSync(activationPath), false)
    assert.deepEqual(activationAssetSets(removed), [orphanDigest])
    const before = {
      state: readFileSync(statePath, 'utf8'),
      assets: activationAssetInventory(removed),
    }

    const repair = run(removed, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 0, repair.stderr)
    assert.equal(repair.value.data.plan.adoption.observed_actual_source, 'absent')
    assert.equal(repair.value.data.plan.adoption.observed_activation_source, 'absent')
    assert.equal(repair.value.data.plan.adoption.pending_phase, null)
    assert.equal(repair.value.data.plan.adoption.pending_action, 'remove')
    const [orphanEvidence] = repair.value.data.plan.adoption.reviewed_orphan_asset_sets
    assert.deepEqual(repair.value.data.plan.adoption.reviewed_orphan_asset_sets, [{
      digest: orphanDigest,
      bytes: orphanEvidence.bytes,
      tree_sha256: orphanEvidence.tree_sha256,
    }])
    assert.ok(orphanEvidence.bytes > 0)
    assert.match(orphanEvidence.tree_sha256, /^[0-9a-f]{64}$/)
    const adopted = run(removed, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(adopted.status, 0, adopted.stderr)
    assert.equal(existsSync(ownerPath), true)
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.deepEqual(activationAssetInventory(removed), before.assets)
    applyPlan(removed, ['setup', '--profile', 'work', '--package', removed.v2])
    assert.equal(activationAssetSets(removed).includes(orphanDigest), false)
    applyPlan(removed, ['remove', '--profile', 'work'])
  } finally {
    removed.cleanup()
  }

  const scenarios = [
    { name: 'prepared-current-current', phase: 'prepared', actual: 'current', activation: 'current', valid: true },
    { name: 'prepared-absent-current', phase: 'prepared', actual: 'absent', activation: 'current', valid: true },
    { name: 'native-applied-absent-current', phase: 'native-applied', actual: 'absent', activation: 'current', valid: true },
    { name: 'native-applied-absent-absent', phase: 'native-applied', actual: 'absent', activation: 'absent', valid: true },
    { name: 'prepared-current-absent', phase: 'prepared', actual: 'current', activation: 'absent', valid: false },
  ]
  for (const scenario of scenarios) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const activationPath = join(subject.runtimeRoot, 'activation.json')
      const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
      const preview = run(subject, ['remove', '--profile', 'work'])
      writeFileSync(join(subject.home, 'fail-after-mutation'), '')
      const interrupted = run(subject, [
        'remove', '--profile', 'work', '--apply',
        '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.equal(interrupted.status, 70, `${scenario.name}: ${interrupted.stderr}`)
      unlinkSync(join(subject.home, 'fail-after-mutation'))
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.equal(state.pending.operation, 'remove')
      assert.equal(state.pending.phase, 'prepared')
      if (scenario.actual === 'current') {
        const restored = spawnSync(subject.dsh, [
          'plugin', '--profile', 'work', 'add', '--save-exact', state.current.dependency_spec,
        ], {
          encoding: 'utf8',
          env: { ...process.env, DSH_HOME: subject.home },
        })
        assert.equal(restored.status, 0, `${scenario.name}: ${restored.stderr}`)
      }
      state.pending.phase = scenario.phase
      writeJson(statePath, state)
      if (scenario.activation === 'absent') unlinkSync(activationPath)
      unlinkSync(ownerPath)
      unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
      const before = {
        state: readFileSync(statePath, 'utf8'),
        activation: existsSync(activationPath) ? readFileSync(activationPath, 'utf8') : null,
        assets: activationAssetSets(subject),
      }

      const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
      if (scenario.valid) {
        assert.equal(repair.status, 0, `${scenario.name}: ${repair.stderr}`)
        assert.equal(repair.value.data.plan.adoption.observed_actual_source, scenario.actual)
        assert.equal(repair.value.data.plan.adoption.observed_activation_source, scenario.activation)
        assert.equal(repair.value.data.plan.adoption.pending_phase, scenario.phase)
        assert.equal(repair.value.data.plan.adoption.pending_action, 'remove')
        const adopted = run(subject, [
          'doctor', '--profile', 'work', '--repair', '--apply',
          '--expected-plan-digest', repair.value.data.plan_digest,
        ])
        assert.equal(adopted.status, 0, `${scenario.name}: ${adopted.stderr}`)
        assert.equal(existsSync(ownerPath), true)
      } else {
        assert.equal(repair.status, 65, `${scenario.name}: ${repair.stderr}`)
        assert.equal(repair.value.error.code, 'runtime-root-owner-missing')
        assert.equal(existsSync(ownerPath), false)
      }
      assert.equal(readFileSync(statePath, 'utf8'), before.state)
      assert.equal(
        existsSync(activationPath) ? readFileSync(activationPath, 'utf8') : null,
        before.activation,
      )
      assert.deepEqual(activationAssetSets(subject), before.assets)
    } finally {
      subject.cleanup()
    }
  }
})

test('terminal ownerless adoption rejects an asset retained by another profile', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const installedState = JSON.parse(readFileSync(statePath, 'utf8'))
    const retainedDigest = installedState.current.target.assets.asset_set_sha256
    const orphanBackup = join(subject.root, 'globally-retained-assets')
    cpSync(join(subject.runtimeRoot, 'assets', retainedDigest), orphanBackup, { recursive: true })
    applyPlan(subject, ['remove', '--profile', 'work'])
    const retainedPath = join(subject.runtimeRoot, 'assets', retainedDigest)
    cpSync(orphanBackup, retainedPath, { recursive: true })
    makeAssetTreeOwnerOnly(retainedPath)
    const removedState = JSON.parse(readFileSync(statePath, 'utf8'))
    writeJson(join(subject.home, 'profiles', 'other', 'package.json'), {
      name: 'dsh-profile-other',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    })
    const otherStatePath = join(subject.home, 'runtime-kit', 'state', 'other.json')
    writeJson(otherStatePath, {
      ...removedState,
      profile: 'other',
      current: installedState.current,
      last_applied: null,
    })
    chmodSync(otherStatePath, 0o600)
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
    const before = {
      work: readFileSync(statePath, 'utf8'),
      other: readFileSync(otherStatePath, 'utf8'),
      assets: activationAssetInventory(subject),
    }

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(rejected.status, 65, rejected.stderr)
    assert.equal(rejected.value.error.code, 'runtime-root-owner-missing', rejected.stdout)
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(statePath, 'utf8'), before.work)
    assert.equal(
      readFileSync(otherStatePath, 'utf8'),
      before.other,
    )
    assert.deepEqual(activationAssetInventory(subject), before.assets)
  } finally {
    subject.cleanup()
  }
})

test('terminal ownerless adoption rejects unsafe orphan inventories', () => {
  const scenarios = [
    { name: 'unmanaged-name', code: 'activation-asset-inventory-invalid' },
    { name: 'staging-name', code: 'activation-asset-inventory-invalid' },
    { name: 'symlink-member', code: 'activation-asset-inventory-invalid' },
    { name: 'over-count', code: 'activation-asset-retention-limit' },
  ]
  for (const scenario of scenarios) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const orphanDigest = activationAssetSets(subject)[0]
      const orphanBackup = join(subject.root, 'unsafe-orphan-backup')
      cpSync(join(subject.runtimeRoot, 'assets', orphanDigest), orphanBackup, { recursive: true })
      applyPlan(subject, ['remove', '--profile', 'work'])
      const assetsRoot = join(subject.runtimeRoot, 'assets')
      const orphanPath = join(assetsRoot, orphanDigest)
      cpSync(orphanBackup, orphanPath, { recursive: true })
      makeAssetTreeOwnerOnly(orphanPath)
      if (scenario.name === 'unmanaged-name') {
        writeFileSync(join(assetsRoot, 'unmanaged'), 'unmanaged', { mode: 0o600 })
      } else if (scenario.name === 'staging-name') {
        mkdirSync(join(assetsRoot, `.${orphanDigest}.staging`), { mode: 0o700 })
      } else if (scenario.name === 'symlink-member') {
        symlinkSync(join(subject.root, 'outside'), join(orphanPath, 'unsafe-link'))
      } else {
        for (let index = 1; index <= 16; index += 1) {
          const digest = index.toString(16).padStart(64, '0')
          const extra = join(assetsRoot, digest)
          cpSync(orphanBackup, extra, { recursive: true })
          makeAssetTreeOwnerOnly(extra)
        }
      }
      const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
      unlinkSync(ownerPath)
      unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const before = {
        state: readFileSync(statePath, 'utf8'),
        names: readdirSync(assetsRoot).sort(),
      }

      const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
      assert.equal(rejected.status, 65, `${scenario.name}: ${rejected.stderr}`)
      assert.equal(rejected.value.error.code, scenario.code, `${scenario.name}: ${rejected.stdout}`)
      assert.equal(existsSync(ownerPath), false)
      assert.equal(readFileSync(statePath, 'utf8'), before.state)
      assert.deepEqual(readdirSync(assetsRoot).sort(), before.names)
      if (scenario.name === 'symlink-member') {
        assert.equal(lstatSync(join(orphanPath, 'unsafe-link')).isSymbolicLink(), true)
      }
    } finally {
      subject.cleanup()
    }
  }
})

test('locked ownerless revalidation preserves non-evidence typed failures', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 0, repair.stderr)
    const before = {
      state: readFileSync(statePath, 'utf8'),
      activation: readFileSync(activationPath, 'utf8'),
      assets: activationAssetSets(subject),
    }

    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ], {
      NODE_ENV: 'test',
      DSH_RUNTIME_KIT_TEST_FAULT_POINT: 'ownerless-adoption-revalidation-infrastructure',
    })
    assert.equal(rejected.status, 70, rejected.stderr)
    assert.equal(rejected.value.error.code, 'command-supervisor-failed')
    assert.deepEqual(rejected.value.error.details, {
      point: 'ownerless-adoption-revalidation-infrastructure',
    })
    assert.equal(existsSync(ownerPath), false)
    assert.equal(readFileSync(statePath, 'utf8'), before.state)
    assert.equal(readFileSync(activationPath, 'utf8'), before.activation)
    assert.deepEqual(activationAssetSets(subject), before.assets)
  } finally {
    subject.cleanup()
  }
})

test('a drifted apply cannot claim an unowned runtime root', () => {
  const first = fixture()
  const rightful = fixture()
  try {
    const preview = run(first, ['setup', '--profile', 'work', '--package', first.v1])
    assert.equal(preview.status, 0, preview.stderr)
    const rejected = run(first, [
      'setup', '--profile', 'work', '--package', first.v1,
      '--apply', '--expected-plan-digest', '0'.repeat(64),
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(existsSync(join(first.runtimeRoot, '.dsh-runtime-kit-owner.json')), false)

    rightful.runtimeRoot = first.runtimeRoot
    applyPlan(rightful, ['setup', '--profile', 'work', '--package', rightful.v1])
    assert.equal(run(rightful, ['doctor', '--profile', 'work']).status, 0)
  } finally {
    first.cleanup()
    rightful.cleanup()
  }
})

test('activation asset retention rejects more than the configured live-set bound', () => {
  const subject = fixture()
  try {
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const stateDir = join(subject.home, 'runtime-kit', 'state')
    const current = JSON.parse(readFileSync(join(stateDir, 'work.json'), 'utf8')).current
    for (let index = 0; index < 16; index += 1) {
      const assets = {
        catalog_sha256: sha256(`catalog-${index}`),
        document_sha256: sha256(`document-${index}`),
        policy_sha256: sha256(`policy-${index}`),
      }
      const profile = `retained-${index}`
      const statePath = join(stateDir, `${profile}.json`)
      writeJson(statePath, {
        schema_version: 'dsh-runtime-kit.operations-state.v2',
        profile,
        current: {
          ...structuredClone(current),
          target: {
            ...structuredClone(current.target),
            assets: { ...assets, asset_set_sha256: sha256(JSON.stringify(assets)) },
          },
        },
        previous: null,
        last_applied: null,
        pending: null,
      })
      chmodSync(statePath, 0o600)
    }
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const rejected = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'activation-asset-retention-limit')
    assert.equal(JSON.parse(readFileSync(join(subject.runtimeRoot, 'activation.json'), 'utf8')).package_version, '1.0.0')
  } finally {
    subject.cleanup()
  }
})

test('activation retention rejects oversized and malformed retained sets without receipt drift', () => {
  for (const scenario of ['oversized', 'malformed']) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const activationPath = join(subject.runtimeRoot, 'activation.json')
      const stateBefore = readFileSync(statePath, 'utf8')
      const activationBefore = readFileSync(activationPath, 'utf8')
      const assetSet = JSON.parse(activationBefore).asset_set_sha256
      const retainedRoot = join(subject.runtimeRoot, 'assets', assetSet)
      if (scenario === 'oversized') {
        writeFileSync(
          join(retainedRoot, 'oversized'),
          Buffer.alloc((4 * 1024 * 1024) + (64 * 1024) + 1),
          { mode: 0o600 },
        )
      } else {
        symlinkSync(join(subject.privateRoot, 'must-survive.txt'), join(retainedRoot, 'malformed'))
      }
      const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      assert.equal(preview.status, 0, preview.stderr)
      const rejected = run(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.equal(rejected.status, 65, `${scenario}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(
        rejected.value.error.code,
        scenario === 'oversized'
          ? 'activation-asset-retention-limit'
          : 'activation-asset-inventory-invalid',
      )
      assert.equal(readFileSync(statePath, 'utf8'), stateBefore, scenario)
      assert.equal(readFileSync(activationPath, 'utf8'), activationBefore, scenario)
    } finally {
      subject.cleanup()
    }
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

    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const ownerPath = join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json')
    unlinkSync(ownerPath)
    unlinkSync(join(subject.runtimeRoot, '.dsh-runtime-kit.lock'))
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 0, repair.stderr)
    const repairedWithoutSetsid = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ], { PATH: subject.commandDir })
    assert.equal(repairedWithoutSetsid.status, 0, repairedWithoutSetsid.stderr)
    assert.equal(repairedWithoutSetsid.value.ok, true)
    assert.equal(existsSync(ownerPath), true)
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
      version: '1.27.17',
      catalog: join(subject.agentDocsHome, 'AGENT_DOCS.toml'),
      state_home: subject.agentDocsStateHome,
    })

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.13 (v1.27.13, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const old = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(old.status, 65)
    assert.equal(old.value.data.agent_docs.ok, false)
    assert.match(old.value.data.agent_docs.error, /supported range 1\.27\.17 through 1\.27\.22/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.22 (v1.27.22, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const validatedCurrent = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(validatedCurrent.status, 0, validatedCurrent.stderr)
    assert.equal(validatedCurrent.value.data.agent_docs.version, '1.27.22')

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.12 (v1.27.12, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const retiredCandidate = run(subject, ['doctor', '--profile', 'work'], {
      DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: 'authoritative-finish-line-acceptance',
    })
    assert.equal(retiredCandidate.status, 65)
    assert.match(retiredCandidate.value.data.agent_docs.error, /compatibility candidate is invalid/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.11 (v1.27.11, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const substitutedCandidate = run(subject, ['doctor', '--profile', 'work'], {
      DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: 'authoritative-finish-line-acceptance',
    })
    assert.equal(substitutedCandidate.status, 65)
    assert.match(
      substitutedCandidate.value.data.agent_docs.error,
      /compatibility candidate is invalid/,
    )

    const unknownCandidate = run(subject, ['doctor', '--profile', 'work'], {
      DSH_RUNTIME_KIT_NILS_COMPATIBILITY_CANDIDATE: 'unknown-candidate',
    })
    assert.equal(unknownCandidate.status, 65)
    assert.equal(unknownCandidate.value.data.agent_docs.ok, false)
    assert.match(unknownCandidate.value.data.agent_docs.error, /compatibility candidate is invalid/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.17 (v1.27.17, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const validatedLatest = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(validatedLatest.status, 0, validatedLatest.stderr)
    assert.equal(validatedLatest.value.data.agent_docs.version, '1.27.17')

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.23 (v1.27.23, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const newer = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(newer.status, 65)
    assert.equal(newer.value.data.agent_docs.ok, false)
    assert.match(newer.value.data.agent_docs.error, /supported range 1\.27\.17 through 1\.27\.22/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.17 (v1.27.17, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)

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

test('doctor requires the validated nils release for every reviewed DSH row', () => {
  const subject = fixture()
  try {
    writeFileSync(subject.dsh, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('0.1.1-rc.2\\n')
`)
    chmodSync(subject.dsh, 0o755)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.13 (v1.27.13, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)

    const oldNils = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(oldNils.status, 65, oldNils.stderr)
    assert.equal(oldNils.value.data.status, 'needs-attention')
    assert.deepEqual(oldNils.value.data.dsh, { ok: true, version: '0.1.1-rc.2' })
    assert.equal(oldNils.value.data.agent_docs.ok, false)
    assert.match(oldNils.value.data.agent_docs.error, /supported range 1\.27\.17 through 1\.27\.22/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.12 (v1.27.12, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const previousNils = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(previousNils.status, 65, previousNils.stderr)
    assert.equal(previousNils.value.data.status, 'needs-attention')
    assert.equal(previousNils.value.data.agent_docs.ok, false)
    assert.match(previousNils.value.data.agent_docs.error, /supported range 1\.27\.17 through 1\.27\.22/)

    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.17 (v1.27.17, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const currentNils = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(currentNils.status, 0, currentNils.stderr)
    assert.equal(currentNils.value.data.status, 'healthy')
    assert.equal(currentNils.value.data.agent_docs.version, '1.27.17')

    writeFileSync(subject.dsh, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('0.1.0-rc.8\\n')
`)
    chmodSync(subject.dsh, 0o755)
    writeFileSync(subject.agentDocs, `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== '--version') process.exit(91)
process.stdout.write('agent-docs 1.27.13 (v1.27.13, test)\\n')
`)
    chmodSync(subject.agentDocs, 0o755)
    const retained = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(retained.status, 65, retained.stderr)
    assert.equal(retained.value.data.status, 'needs-attention')
    assert.deepEqual(retained.value.data.dsh, { ok: true, version: '0.1.0-rc.8' })
    assert.equal(retained.value.data.agent_docs.ok, false)
    assert.match(retained.value.data.agent_docs.error, /supported range 1\.27\.17 through 1\.27\.22/)
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

test('doctor restores and rejects supervisor-loss recovery with unrelated profile collateral', () => {
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
    writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.notEqual(interrupted.status, 0)
    unlinkSync(join(subject.home, 'collateral-profile-mutation'))
    unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)

    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.value.data.recovery.action, 'restore-collateral')
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'native-dsh-collateral-mutation')
    assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), manifestBefore)
    assert.equal(readFileSync(lockfile, 'utf8'), lockfileBefore)
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)
    assert.equal(JSON.parse(readFileSync(join(subject.home, 'runtime-kit/state/work.json'))).pending, null)
  } finally {
    subject.cleanup()
  }
})

test('doctor repair rejects current provider topology overlapping persisted pending roots', () => {
  const cases = [
    {
      name: 'explicit equality',
      roots(subject) {
        const runtime = join(subject.root, 'persisted-equal')
        return { runtime, provider: runtime, environment: { CODEX_HOME: runtime } }
      },
    },
    {
      name: 'explicit provider ancestor',
      roots(subject) {
        const provider = join(subject.root, 'persisted-parent')
        return { runtime: join(provider, 'runtime'), provider, environment: { CLAUDE_CONFIG_DIR: provider } }
      },
    },
    {
      name: 'explicit provider descendant',
      roots(subject) {
        const runtime = join(subject.root, 'persisted-parent-of-provider')
        const provider = join(runtime, 'provider')
        return { runtime, provider, environment: { CODEX_HOME: provider } }
      },
    },
    {
      name: 'explicit symlink alias',
      roots(subject) {
        const runtime = join(subject.root, 'persisted-alias-target')
        const provider = join(subject.root, 'persisted-provider-alias')
        return { runtime, provider, aliasTarget: runtime, environment: { CLAUDE_CONFIG_DIR: provider } }
      },
    },
    {
      name: 'default Codex home',
      roots(subject) {
        const userHome = join(subject.root, 'persisted-default-user')
        const runtime = join(userHome, '.codex')
        return { runtime, provider: runtime, environment: { HOME: userHome } }
      },
    },
  ]
  for (const entry of cases) {
    const subject = fixture()
    try {
      const { runtime, provider, aliasTarget, environment } = entry.roots(subject)
      mkdirSync(runtime, { recursive: true, mode: 0o700 })
      if (aliasTarget !== undefined) symlinkSync(aliasTarget, provider, 'dir')
      else mkdirSync(provider, { recursive: true, mode: 0o700 })
      const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1], {
        DSH_RUNTIME_KIT_RUNTIME_ROOT: runtime,
      })
      writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
      const interrupted = run(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ], { DSH_RUNTIME_KIT_RUNTIME_ROOT: runtime })
      assert.notEqual(interrupted.status, 0, entry.name)
      unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      const sentinel = join(aliasTarget ?? provider, 'provider-sentinel')
      writeFileSync(sentinel, `unchanged: ${entry.name}`)

      const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'], {
        DSH_RUNTIME_KIT_RUNTIME_ROOT: runtime,
        ...environment,
      })
      assert.equal(rejected.status, 65, `${entry.name}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(rejected.value.error.code, 'unsafe-repair-runtime-root')
      assert.equal(readFileSync(sentinel, 'utf8'), `unchanged: ${entry.name}`)
      assert.notEqual(JSON.parse(readFileSync(join(
        subject.home, 'runtime-kit', 'state', 'work.json',
      ), 'utf8')).pending, null)
    } finally {
      subject.cleanup()
    }
  }
})

test('doctor repair validates persisted previous roots against current provider topology', () => {
  const subject = fixture()
  try {
    const previousRoot = join(subject.root, 'previous-runtime')
    const currentRoot = join(subject.root, 'current-runtime')
    mkdirSync(previousRoot, { mode: 0o700 })
    mkdirSync(currentRoot, { mode: 0o700 })
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1], {
      DSH_RUNTIME_KIT_RUNTIME_ROOT: currentRoot,
    })
    applyPlan(subject, ['update', '--profile', 'work', '--package', subject.v2], {
      DSH_RUNTIME_KIT_RUNTIME_ROOT: currentRoot,
    })
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.previous.runtime_root = previousRoot
    writeJson(statePath, state)
    const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v1], {
      DSH_RUNTIME_KIT_RUNTIME_ROOT: currentRoot,
    })
    writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
    const interrupted = run(subject, [
      'update', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ], { DSH_RUNTIME_KIT_RUNTIME_ROOT: currentRoot })
    assert.notEqual(interrupted.status, 0)
    unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    const sentinel = join(previousRoot, 'provider-sentinel')
    writeFileSync(sentinel, 'previous provider bytes')

    const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'], {
      DSH_RUNTIME_KIT_RUNTIME_ROOT: currentRoot,
      CODEX_HOME: previousRoot,
    })
    assert.equal(rejected.status, 65, `${rejected.stdout}\n${rejected.stderr}`)
    assert.equal(rejected.value.error.code, 'unsafe-repair-runtime-root')
    assert.equal(readFileSync(sentinel, 'utf8'), 'previous provider bytes')
  } finally {
    subject.cleanup()
  }
})

test('doctor repair validates roots before collateral restoration or remove finalization', () => {
  for (const recoveryKind of ['restore-collateral', 'remove']) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const operation = recoveryKind === 'restore-collateral' ? 'update' : 'remove'
      const args = operation === 'update'
        ? [operation, '--profile', 'work', '--package', subject.v2]
        : [operation, '--profile', 'work']
      const preview = run(subject, args)
      if (recoveryKind === 'restore-collateral') {
        writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
      }
      writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
      const interrupted = run(subject, [
        ...args, '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.notEqual(interrupted.status, 0)
      if (recoveryKind === 'restore-collateral') {
        unlinkSync(join(subject.home, 'collateral-profile-mutation'))
      }
      unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      const doctor = run(subject, ['doctor', '--profile', 'work'])
      assert.equal(
        doctor.value.data.recovery.action,
        recoveryKind === 'restore-collateral' ? 'restore-collateral' : 'finalize',
      )
      assert.equal(doctor.value.data.recovery.pending.operation, operation)
      const sentinel = join(subject.runtimeRoot, `provider-${recoveryKind}`)
      writeFileSync(sentinel, `unchanged: ${recoveryKind}`)

      const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'], {
        CLAUDE_CONFIG_DIR: subject.runtimeRoot,
      })
      assert.equal(rejected.status, 65, `${recoveryKind}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(rejected.value.error.code, 'unsafe-repair-runtime-root')
      assert.equal(readFileSync(sentinel, 'utf8'), `unchanged: ${recoveryKind}`)
      assert.notEqual(JSON.parse(readFileSync(join(
        subject.home, 'runtime-kit', 'state', 'work.json',
      ), 'utf8')).pending, null)
    } finally {
      subject.cleanup()
    }
  }
})

test('doctor repair plan binds current provider topology across preview and apply', () => {
  const subject = fixture()
  try {
    const preview = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
    const interrupted = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.notEqual(interrupted.status, 0)
    unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)

    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`)
    assert.ok(repair.value.data.plan.runtime_root_topology)
    const provider = join(subject.root, 'new-safe-provider-home')
    mkdirSync(provider, { mode: 0o700 })
    const sentinel = join(provider, 'provider-sentinel')
    writeFileSync(sentinel, 'unchanged')
    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ], { CODEX_HOME: provider })
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'plan-drift')
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged')
    assert.notEqual(JSON.parse(readFileSync(join(
      subject.home, 'runtime-kit', 'state', 'work.json',
    ), 'utf8')).pending, null)
  } finally {
    subject.cleanup()
  }
})

test('collateral update recovery restores the exact prior package activation and state', () => {
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
    applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
    const activationPath = join(subject.runtimeRoot, 'activation.json')
    const stateBefore = JSON.parse(readFileSync(statePath, 'utf8'))
    const activationBefore = readFileSync(activationPath, 'utf8')
    const activationBeforeValue = JSON.parse(activationBefore)
    const manifestBefore = readFileSync(join(subject.profileDir, 'package.json'), 'utf8')
    const lockfileBefore = readFileSync(lockfile, 'utf8')

    const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
    writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
    writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
    const interrupted = run(subject, [
      'update', '--profile', 'work', '--package', subject.v2,
      '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
    ])
    assert.notEqual(interrupted.status, 0)
    unlinkSync(join(subject.home, 'collateral-profile-mutation'))
    unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)

    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.value.data.recovery.action, 'restore-collateral')
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const rejected = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ])
    assert.equal(rejected.status, 65)
    assert.equal(rejected.value.error.code, 'native-dsh-collateral-mutation')

    const stateAfter = JSON.parse(readFileSync(statePath, 'utf8'))
    const activationAfter = readFileSync(activationPath, 'utf8')
    const installedManifest = JSON.parse(readFileSync(join(
      subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json',
    ), 'utf8'))
    assert.equal(installedManifest.version, '1.0.0')
    assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), manifestBefore)
    assert.equal(readFileSync(lockfile, 'utf8'), lockfileBefore)
    assert.equal(activationAfter, activationBefore)
    assert.equal(JSON.parse(activationAfter).asset_set_sha256, activationBeforeValue.asset_set_sha256)
    assert.deepEqual(stateAfter.current, stateBefore.current)
    assert.deepEqual(stateAfter.previous, stateBefore.previous)
    assert.deepEqual(stateAfter.last_applied, stateBefore.last_applied)
    assert.equal(stateAfter.pending, null)
    const healthy = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
    assert.equal(healthy.value.data.observed.installed_version, '1.0.0')
    assert.equal(healthy.value.data.observed.installed_digest, stateBefore.current.installed_digest)
  } finally {
    subject.cleanup()
  }
})

test('doctor repair survives interruption during an atomic profile snapshot replacement', () => {
  const subject = fixture()
  try {
    const recovery = interruptCollateralUpdate(subject)
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const crashed = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ], {
      NODE_ENV: 'test',
      DSH_RUNTIME_KIT_TEST_FAULT_POINT: 'restore-profile:package.json',
    })
    assert.equal(crashed.status, null)
    assert.equal(crashed.signal, 'SIGKILL')
    const retained = JSON.parse(readFileSync(recovery.statePath, 'utf8'))
    assert.notEqual(retained.pending, null)
    assertPrivateAtomicTemporary(subject.profileDir, 'package.json')

    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.value.data.recovery.action, 'restore-collateral')
    const retry = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const converged = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', retry.value.data.plan_digest,
    ])
    assert.equal(converged.status, 65)
    assert.equal(converged.value.error.code, 'native-dsh-collateral-mutation')
    assertExactPriorInstall(subject, recovery)
    assert.equal(
      readdirSync(subject.profileDir).some(name => name.includes('.dsh-runtime-kit-atomic.')),
      false,
    )
  } finally {
    subject.cleanup()
  }
})

test('doctor repair converges after interruption before or after removing collateral lockfile state', () => {
  for (const [faultPoint, expectedPresentAfterCrash, expectedAction, expectedStatus] of [
    ['restore-profile:pnpm-lock.yaml:before-unlink', true, 'restore-collateral', 65],
    ['restore-profile:pnpm-lock.yaml:after-unlink', false, 'clear', 0],
  ]) {
    const subject = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const activationPath = join(subject.runtimeRoot, 'activation.json')
      const expected = {
        state: JSON.parse(readFileSync(statePath, 'utf8')),
        activation: readFileSync(activationPath, 'utf8'),
        manifest: readFileSync(join(subject.profileDir, 'package.json'), 'utf8'),
      }
      const lockfile = join(subject.profileDir, 'pnpm-lock.yaml')
      assert.equal(existsSync(lockfile), false)
      const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
      writeFileSync(join(subject.home, 'collateral-profile-mutation'), '')
      writeFileSync(join(subject.home, 'kill-supervisor-after-mutation'), '')
      const interrupted = run(subject, [
        'update', '--profile', 'work', '--package', subject.v2,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.notEqual(interrupted.status, 0)
      unlinkSync(join(subject.home, 'collateral-profile-mutation'))
      unlinkSync(join(subject.home, 'kill-supervisor-after-mutation'))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      assert.equal(existsSync(lockfile), true)

      const doctor = run(subject, ['doctor', '--profile', 'work'])
      assert.equal(doctor.value.data.recovery.action, 'restore-collateral')
      const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
      const crashed = run(subject, [
        'doctor', '--profile', 'work', '--repair', '--apply',
        '--expected-plan-digest', repair.value.data.plan_digest,
      ], {
        NODE_ENV: 'test',
        DSH_RUNTIME_KIT_TEST_FAULT_POINT: faultPoint,
      })
      assert.equal(crashed.status, null, faultPoint)
      assert.equal(crashed.signal, 'SIGKILL', faultPoint)
      assert.notEqual(JSON.parse(readFileSync(statePath, 'utf8')).pending, null)
      assert.equal(existsSync(lockfile), expectedPresentAfterCrash, faultPoint)

      const diagnosed = run(subject, ['doctor', '--profile', 'work'])
      assert.equal(diagnosed.value.data.recovery.action, expectedAction)
      const retry = run(subject, ['doctor', '--profile', 'work', '--repair'])
      const converged = run(subject, [
        'doctor', '--profile', 'work', '--repair', '--apply',
        '--expected-plan-digest', retry.value.data.plan_digest,
      ])
      assert.equal(converged.status, expectedStatus)
      if (expectedStatus === 65) {
        assert.equal(converged.value.error.code, 'native-dsh-collateral-mutation')
      }
      assert.equal(existsSync(lockfile), false)
      assert.equal(readFileSync(join(subject.profileDir, 'package.json'), 'utf8'), expected.manifest)
      assert.equal(readFileSync(activationPath, 'utf8'), expected.activation)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      assert.deepEqual(state.current, expected.state.current)
      assert.deepEqual(state.previous, expected.state.previous)
      assert.deepEqual(state.last_applied, expected.state.last_applied)
      assert.equal(state.pending, null)
      assert.equal(JSON.parse(readFileSync(join(
        subject.profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit', 'package.json',
      ), 'utf8')).version, '1.0.0')
    } finally {
      subject.cleanup()
    }
  }
})

test('doctor repair survives interruption during the final atomic state replacement', () => {
  const subject = fixture()
  try {
    const recovery = interruptCollateralUpdate(subject)
    const repair = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const crashed = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', repair.value.data.plan_digest,
    ], {
      NODE_ENV: 'test',
      DSH_RUNTIME_KIT_TEST_FAULT_POINT: 'restore-state',
    })
    assert.equal(crashed.status, null)
    assert.equal(crashed.signal, 'SIGKILL')
    const retained = JSON.parse(readFileSync(recovery.statePath, 'utf8'))
    assert.notEqual(retained.pending, null)
    assertPrivateAtomicTemporary(dirname(recovery.statePath), 'work.json')

    const diagnosed = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(diagnosed.value.data.recovery.action, 'clear')
    const retry = run(subject, ['doctor', '--profile', 'work', '--repair'])
    const converged = run(subject, [
      'doctor', '--profile', 'work', '--repair', '--apply',
      '--expected-plan-digest', retry.value.data.plan_digest,
    ])
    assert.equal(converged.status, 0, `${converged.stdout}\n${converged.stderr}`)
    assertExactPriorInstall(subject, recovery)
    assert.equal(
      readdirSync(dirname(recovery.statePath)).some(name => name.includes('.dsh-runtime-kit-atomic.')),
      false,
    )
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

test('installed identity excludes only package-manager-owned bundled dependency materialization', () => {
  const subject = fixture()
  try {
    const manifestPath = join(subject.v1, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies = { 'fixture-dependency': '1.0.0' }
    manifest.bundledDependencies = ['fixture-dependency']
    writeJson(manifestPath, manifest)
    const dependency = join(subject.v1, 'node_modules', 'fixture-dependency')
    mkdirSync(dependency, { recursive: true })
    writeJson(join(dependency, 'package.json'), {
      name: 'fixture-dependency',
      version: '1.0.0',
      bin: { 'fixture-dependency': 'bin.js' },
    })
    writeFileSync(join(dependency, 'index.js'), 'export const value = 1\n')
    writeFileSync(join(dependency, 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    writeFileSync(join(dependency, 'CHANGELOG.md'), 'reviewed dependency bytes\n')

    const stale = run(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.equal(stale.status, 0, stale.stderr)
    writeFileSync(join(dependency, 'index.js'), 'export const value = 2\n')
    const sourceDrift = run(subject, [
      'setup', '--profile', 'work', '--package', subject.v1,
      '--apply', '--expected-plan-digest', stale.value.data.plan_digest,
    ])
    assert.equal(sourceDrift.status, 65)
    assert.equal(sourceDrift.value.error.code, 'plan-drift')
    assert.equal(existsSync(join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')), false)

    writeFileSync(join(subject.home, 'normalize-bundled-installed-tree'), '')
    const installed = applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
    assert.match(installed.preview.plan.target.artifact_sha256, /^[a-f0-9]{64}$/)
    assert.match(installed.preview.plan.target.installed_sha256, /^[a-f0-9]{64}$/)

    const installedRoot = join(subject.profileDir, 'node_modules/@sympoies/dsh-runtime-kit')
    assert.equal(existsSync(join(installedRoot, 'node_modules/.bin/fixture-dependency')), true)
    writeFileSync(join(installedRoot, 'forged.js'), 'unreviewed plugin-owned bytes\n')
    const doctor = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(doctor.status, 65)
    assert.equal(doctor.value.data.owned_status, 'drift')
    const replay = run(subject, [
      'setup', '--profile', 'work',
      '--apply', '--expected-plan-digest', installed.preview.plan_digest,
    ])
    assert.equal(replay.status, 65)
    assert.equal(replay.value.error.code, 'owned-state-drift')
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

test('all operations reject DSH homes overlapping provider homes without provider mutation', () => {
  const subject = fixture()
  const providerRoot = join(subject.root, 'provider-home')
  const providerChild = join(providerRoot, 'nested-dsh')
  const dshParent = join(subject.root, 'dsh-parent')
  const nestedProvider = join(dshParent, 'provider-child')
  const userHome = join(subject.root, 'user-home')
  const defaultClaude = join(userHome, '.claude')
  const alias = join(subject.root, 'provider-alias')
  for (const path of [providerRoot, providerChild, dshParent, nestedProvider, userHome, defaultClaude]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  symlinkSync(defaultClaude, alias, 'dir')
  const sentinel = join(providerRoot, 'sentinel')
  writeFileSync(sentinel, 'unchanged')
  const cases = [
    ['setup', providerRoot, { CODEX_HOME: providerRoot }],
    ['update', providerChild, { CLAUDE_CONFIG_DIR: providerRoot }],
    ['remove', dshParent, { CODEX_HOME: nestedProvider }],
    ['doctor', join(alias, 'intermediate'), { HOME: userHome }],
    ['setup', join(userHome, '.codex'), { HOME: userHome }],
  ]
  try {
    for (const [operation, dshHome, environment] of cases) {
      const args = operation === 'setup'
        ? [operation, '--profile', 'work', '--package', subject.v1]
        : [operation, '--profile', 'work']
      const rejected = run(subject, args, { ...environment, DSH_HOME: dshHome })
      assert.equal(rejected.status, 65, `${operation}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(rejected.value.error.code, 'unsafe-dsh-home')
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged')
    assert.deepEqual(readdirSync(providerRoot).sort(), ['nested-dsh', 'sentinel'])
  } finally {
    subject.cleanup()
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

    const unknownToolchain = structuredClone(original)
    unknownToolchain.pending.plan.toolchain.dsh.version = '0.1.0-rc.9'
    unknownToolchain.pending.plan.toolchain.dsh.source_revision = null
    unknownToolchain.pending.plan_digest = sha256(stableJson(unknownToolchain.pending.plan))
    writeJson(statePath, unknownToolchain)
    chmodSync(statePath, 0o600)
    const unknownToolchainRejected = run(subject, ['doctor', '--profile', 'work'])
    assert.equal(unknownToolchainRejected.status, 65)
    assert.equal(unknownToolchainRejected.value.error.code, 'invalid-operations-state')
  } finally {
    subject.cleanup()
  }
})

test('doctor repair rejects malformed and foreign-home pending roots without mutation', () => {
  for (const scenario of ['malformed', 'foreign-home']) {
    const subject = fixture()
    const foreign = fixture()
    try {
      applyPlan(subject, ['setup', '--profile', 'work', '--package', subject.v1])
      applyPlan(foreign, ['setup', '--profile', 'work', '--package', foreign.v1])
      writeFileSync(join(subject.home, 'fail-after-mutation'), '')
      const preview = run(subject, ['update', '--profile', 'work', '--package', subject.v2])
      const interrupted = run(subject, [
        'update', '--profile', 'work', '--package', subject.v2,
        '--apply', '--expected-plan-digest', preview.value.data.plan_digest,
      ])
      assert.equal(interrupted.status, 70)
      unlinkSync(join(subject.home, 'fail-after-mutation'))

      const statePath = join(subject.home, 'runtime-kit', 'state', 'work.json')
      const activationPath = join(subject.runtimeRoot, 'activation.json')
      const foreignActivationPath = join(foreign.runtimeRoot, 'activation.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (scenario === 'malformed') {
        state.pending.plan_digest = 'invalid'
      } else {
        state.pending.plan.runtime_root = realpathSync(foreign.runtimeRoot)
        state.pending.plan_digest = sha256(stableJson(state.pending.plan))
      }
      writeJson(statePath, state)
      chmodSync(statePath, 0o600)
      const before = {
        state: readFileSync(statePath, 'utf8'),
        activation: readFileSync(activationPath, 'utf8'),
        foreignActivation: readFileSync(foreignActivationPath, 'utf8'),
        owner: readFileSync(join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json'), 'utf8'),
        foreignOwner: readFileSync(join(foreign.runtimeRoot, '.dsh-runtime-kit-owner.json'), 'utf8'),
      }
      const rejected = run(subject, ['doctor', '--profile', 'work', '--repair'])
      assert.equal(rejected.status, 65, `${scenario}: ${rejected.stdout}\n${rejected.stderr}`)
      assert.equal(
        rejected.value.error.code,
        scenario === 'malformed' ? 'invalid-operations-state' : 'unsafe-repair-runtime-root',
      )
      assert.equal(readFileSync(statePath, 'utf8'), before.state, scenario)
      assert.equal(readFileSync(activationPath, 'utf8'), before.activation, scenario)
      assert.equal(readFileSync(foreignActivationPath, 'utf8'), before.foreignActivation, scenario)
      assert.equal(
        readFileSync(join(subject.runtimeRoot, '.dsh-runtime-kit-owner.json'), 'utf8'),
        before.owner,
        scenario,
      )
      assert.equal(
        readFileSync(join(foreign.runtimeRoot, '.dsh-runtime-kit-owner.json'), 'utf8'),
        before.foreignOwner,
        scenario,
      )
    } finally {
      subject.cleanup()
      foreign.cleanup()
    }
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

test('native DSH mutations preserve only explicit offline package-manager intent', () => {
  for (const expected of [
    {
      name: 'enabled',
      environment: { NPM_CONFIG_OFFLINE: 'true', PNPM_OFFLINE: 'true' },
      observed: { argument: true, npm: 'true', pnpm: 'true' },
    },
    {
      name: 'invalid-values-removed',
      environment: { NPM_CONFIG_OFFLINE: 'false', PNPM_OFFLINE: 'yes' },
      observed: { argument: false, npm: '<absent>', pnpm: '<absent>' },
    },
  ]) {
    const subject = fixture()
    try {
      const observedPath = join(subject.home, `offline-environment-${expected.name}.json`)
      const dsh = join(subject.root, `offline-aware-dsh-${expected.name}.mjs`)
      writeFileSync(dsh, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('0.1.0-rc.7\\n')
  process.exit(0)
}
const observed = {
  argument: args.includes('--offline'),
  npm: process.env.NPM_CONFIG_OFFLINE ?? '<absent>',
  pnpm: process.env.PNPM_OFFLINE ?? '<absent>',
}
writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(observed))
const expected = args[3] === 'remove'
  ? { ...${JSON.stringify(expected.observed)}, argument: false }
  : ${JSON.stringify(expected.observed)}
if (JSON.stringify(observed) !== JSON.stringify(expected)) process.exit(79)
const result = spawnSync(${JSON.stringify(realpathSync(subject.dsh))}, args, {
  env: process.env,
  stdio: 'inherit',
})
process.exit(result.status ?? 70)
`)
      chmodSync(dsh, 0o755)
      applyPlan(subject, [
        'setup', '--profile', 'work', '--package', subject.v1,
      ], {
        ...expected.environment,
        DSH_RUNTIME_KIT_DSH_BIN: dsh,
      })
      assert.deepEqual(JSON.parse(readFileSync(observedPath, 'utf8')), expected.observed)
      applyPlan(subject, ['remove', '--profile', 'work'], {
        ...expected.environment,
        DSH_RUNTIME_KIT_DSH_BIN: dsh,
      })
      assert.deepEqual(JSON.parse(readFileSync(observedPath, 'utf8')), {
        ...expected.observed,
        argument: false,
      })
    } finally {
      subject.cleanup()
    }
  }
})
