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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { scenarioFailureDiagnostic } from '../src/acceptance/contract.js'
import { DEPLOY_ERROR_CODES } from '../src/deploy/index.js'

const projectRoot = resolve(import.meta.dirname, '..')
const dispatcher = join(projectRoot, '.agents', 'scripts', 'deploy.sh')

const sha256 = value => createHash('sha256').update(value).digest('hex')

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

// One declared package fixture per version, packed into an immutable tarball
// the way a release artifact would be. The dispatcher must accept only that
// tarball plus its exact digest.
function stageBundle(root, version) {
  const dir = join(root, `bundle-${version}`)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), {
    name: '@sympoies/dsh-runtime-kit',
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' }, lifecycle: './compatibility/profile-lifecycle.json' },
  })
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  writeJson(join(dir, 'compatibility', 'dsh.json'), {
    schema_version: 'dsh-runtime-kit.dsh-compatibility.v1',
    validated_releases: {
      '0.1.2-rc.1': { ref: 'refs/tags/dsh-v0.1.2-rc.1', revision: 'a'.repeat(40), cordis: '4.0.2' },
    },
  })
  writeJson(join(dir, 'compatibility', 'nils-cli.json'), {
    schema_version: 'dsh-runtime-kit.nils-compatibility.v1',
    minimum_supported_release: '1.27.17',
    validated_release: '1.27.37',
  })
  writeJson(
    join(dir, 'compatibility', 'profile-lifecycle.json'),
    JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'profile-lifecycle.json'), 'utf8')),
  )
  mkdirSync(join(dir, 'policy'))
  mkdirSync(join(dir, 'agent-docs'))
  writeFileSync(join(dir, 'policy', 'dsh-runtime-kit-v1.toml'), `schema_version = "dsh.policy.v1"\n# asset ${version}\n`)
  writeFileSync(join(dir, 'agent-docs', 'AGENT_DOCS.toml'), `schema_version = "agent-docs.catalog.v1"\n# asset ${version}\n`)
  writeFileSync(join(dir, 'agent-docs', 'PROJECT_DEV_EDIT.md'), `# DSH project-dev ${version}\n`)
  return dir
}

function realNpm() {
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .map(directory => join(directory, 'npm'))
    .find(candidate => existsSync(candidate))
  assert.ok(found, 'test fixture could not resolve npm')
  return realpathSync(found)
}

function packBundle(root, dir) {
  const destination = join(root, 'artifacts')
  mkdirSync(destination, { recursive: true })
  const packed = spawnSync(realNpm(), [
    'pack', '--ignore-scripts', '--json', '--pack-destination', destination, dir,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(root, 'npm-cache') },
  })
  assert.equal(packed.status, 0, packed.stderr)
  const [row] = JSON.parse(packed.stdout)
  const path = join(destination, row.filename)
  return { path, sha256: sha256(readFileSync(path)) }
}

function stageFakeCommands(root) {
  const commandDir = join(root, 'bin')
  mkdirSync(commandDir)
  const npm = join(commandDir, 'npm')
  writeFileSync(npm, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const result = spawnSync(${JSON.stringify(realNpm())}, process.argv.slice(2), { env: process.env, stdio: 'inherit' })
process.exit(result.status ?? 70)
`)
  chmodSync(npm, 0o755)
  const pnpm = join(commandDir, 'pnpm')
  writeFileSync(pnpm, '#!/bin/sh\nprintf \'11.7.0\\n\'\n')
  chmodSync(pnpm, 0o755)

  // Minimal released-DSH stand-in: reports the pinned version and performs the
  // pnpm-forwarder profile mutation from a retained tarball.
  const dsh = join(root, 'fake-dsh.mjs')
  writeFileSync(dsh, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(join(dirname(process.argv[1]), 'dsh-calls.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] === '--version') { console.log('0.1.2-rc.1'); process.exit(0) }
if (args[0] === '--profile' && args[2] === '--dump-default-config') { console.log('[]'); process.exit(0) }
const home = process.env.DSH_HOME
if (!home || args[0] !== 'plugin' || args[1] !== '--profile') process.exit(91)
const profile = args[2]
const verb = args[3]
const profileDir = join(home, 'profiles', profile)
mkdirSync(profileDir, { recursive: true })
const manifestPath = join(profileDir, 'package.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
const packageName = '@sympoies/dsh-runtime-kit'
const installed = join(profileDir, 'node_modules', '@sympoies', 'dsh-runtime-kit')
if (verb === 'add') {
  const spec = args.at(-1)
  const archive = spec.replace(/^(?:file|link):/, '')
  if (!archive.endsWith('.tgz')) process.exit(94)
  manifest.dependencies[packageName] = spec
  if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
  rmSync(installed, { recursive: true, force: true })
  mkdirSync(installed, { recursive: true })
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', installed, '--strip-components=1'])
  if (extracted.status !== 0) process.exit(95)
} else if (verb === 'remove') {
  delete manifest.dependencies[packageName]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(value => value !== packageName)
  rmSync(installed, { recursive: true, force: true })
} else process.exit(93)
writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\\n')
`)
  chmodSync(dsh, 0o755)

  const agentHook = join(root, 'fake-agent-hook.mjs')
  writeFileSync(agentHook, `#!/usr/bin/env node
if (!process.argv.includes('doctor')) process.exit(91)
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
process.stdout.write('agent-docs 1.27.37 (v1.27.37, test)\\n')
`)
  chmodSync(agentDocs, 0o755)
  return { commandDir, dsh, agentHook, agentDocs }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-deploy-'))
  const userHome = join(root, 'user-home')
  mkdirSync(userHome, { mode: 0o700 })
  mkdirSync(join(userHome, '.claude'), { mode: 0o700 })
  const dshHome = join(root, 'dsh-home')
  mkdirSync(join(dshHome, 'profiles', 'canary'), { recursive: true, mode: 0o700 })
  writeJson(join(dshHome, 'profiles', 'canary', 'package.json'), {
    name: 'dsh-profile-canary',
    private: true,
    dependencies: { 'unrelated-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['unrelated-bundle'] } },
  })
  const runtimeRoot = join(root, 'dsh-runtime')
  mkdirSync(runtimeRoot, { mode: 0o700 })
  const commands = stageFakeCommands(root)
  const v1 = packBundle(root, stageBundle(root, '1.0.0'))
  const v2 = packBundle(root, stageBundle(root, '2.0.0'))
  return {
    root,
    userHome,
    dshHome,
    runtimeRoot,
    v1,
    v2,
    ...commands,
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

function scopeArgs(subject, phase, extra = []) {
  return [
    '--phase', phase,
    '--profile', 'canary',
    '--dsh-home', subject.dshHome,
    '--runtime-root', subject.runtimeRoot,
    '--dsh-bin', subject.dsh,
    '--agent-hook-bin', subject.agentHook,
    '--agent-docs-bin', subject.agentDocs,
    ...extra,
  ]
}

function deploy(subject, args, extraEnv = {}) {
  const result = spawnSync(dispatcher, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      PATH: `${subject.commandDir}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
      HOME: subject.userHome,
      XDG_CACHE_HOME: join(subject.root, 'cache'),
      // Ambient runtime-kit and DSH selection must never leak into a deploy.
      DSH_HOME: join(subject.root, 'ambient-dsh-home'),
      DSH_RUNTIME_KIT_DSH_BIN: '/nonexistent/ambient-dsh',
      DSH_RUNTIME_KIT_RUNTIME_ROOT: join(subject.root, 'ambient-runtime-root'),
      ...extraEnv,
    },
  })
  let value
  try { value = JSON.parse(result.stdout) } catch { value = undefined }
  return { ...result, value }
}

function artifactArgs(artifact) {
  return ['--artifact', artifact.path, '--artifact-sha256', artifact.sha256]
}

function stagedRoot(subject, artifact) {
  return join(subject.root, 'cache', 'dsh-runtime-kit', 'deploy-stage', artifact.sha256, 'package')
}

function profileManifest(subject) {
  return readFileSync(join(subject.dshHome, 'profiles', 'canary', 'package.json'), 'utf8')
}

function dshCalls(subject) {
  const path = join(subject.root, 'dsh-calls.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

test('the repository owns one executable deploy dispatcher whose --help mutates nothing', () => {
  assert.equal(existsSync(dispatcher), true, 'no project-local implementation: .agents/scripts/deploy.sh')
  assert.notEqual(statSync(dispatcher).mode & 0o111, 0, 'deploy.sh must be executable')
  const subject = fixture()
  try {
    const before = profileManifest(subject)
    const result = deploy(subject, ['--help'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /--phase <setup\|doctor\|update\|rollback\|remove\|repair>/u)
    assert.match(result.stdout, /--apply --expected-plan-digest/u)
    assert.equal(profileManifest(subject), before)
    assert.deepEqual(readdirSync(subject.runtimeRoot), [])
    assert.deepEqual(dshCalls(subject), [])
    assert.equal(existsSync(join(subject.dshHome, 'runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('the shared meta:deploy dispatcher reaches the script through agent-run when it is installed', t => {
  const agentRun = (process.env.PATH ?? '')
    .split(delimiter)
    .map(directory => join(directory, 'agent-run'))
    .find(candidate => existsSync(candidate))
  if (agentRun === undefined) {
    // The hosted package matrix has no nils agent-run; the direct executable
    // contract above still holds and the dispatcher path is proven locally.
    t.skip('agent-run is not on PATH')
    return
  }
  const result = spawnSync(agentRun, ['exec', '--cwd', projectRoot, '--', './.agents/scripts/deploy.sh', '--help'], {
    encoding: 'utf8',
    env: process.env,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /--phase <setup\|doctor\|update\|rollback\|remove\|repair>/u)
})

test('missing or ambiguous deploy scope fails typed before any engine or profile mutation', () => {
  const subject = fixture()
  try {
    const before = profileManifest(subject)
    const cases = [
      [[], 'missing-phase'],
      [['--phase', 'install'], 'invalid-phase'],
      [scopeArgs(subject, 'setup', artifactArgs(subject.v1)).filter((value, index, all) => !(value === '--profile' || all[index - 1] === '--profile')), 'missing-profile'],
      [scopeArgs(subject, 'setup', artifactArgs(subject.v1)).filter((value, index, all) => !(value === '--dsh-home' || all[index - 1] === '--dsh-home')), 'missing-dsh-home'],
      [scopeArgs(subject, 'setup', artifactArgs(subject.v1)).filter((value, index, all) => !(value === '--runtime-root' || all[index - 1] === '--runtime-root')), 'missing-runtime-root'],
      [scopeArgs(subject, 'setup', artifactArgs(subject.v1)).filter((value, index, all) => !(value === '--dsh-bin' || all[index - 1] === '--dsh-bin')), 'missing-dsh-bin'],
      [scopeArgs(subject, 'setup'), 'missing-artifact'],
      [scopeArgs(subject, 'setup', ['--artifact', subject.v1.path]), 'missing-artifact-sha256'],
      [scopeArgs(subject, 'setup', ['--artifact', subject.v1.path, '--artifact-sha256', 'not-a-digest']), 'invalid-artifact-sha256'],
      [scopeArgs(subject, 'doctor', artifactArgs(subject.v1)), 'unexpected-artifact'],
      [scopeArgs(subject, 'rollback', artifactArgs(subject.v1)), 'unexpected-artifact'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--apply']), 'expected-plan-digest-required'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--expected-plan-digest', 'a'.repeat(64)]), 'unexpected-plan-digest'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--dsh-home', 'relative/home']), 'invalid-dsh-home'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--runtime-root', 'relative/root']), 'invalid-runtime-root'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--runtime-root', join(subject.root, 'absent-runtime-root')]), 'invalid-runtime-root'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--runtime-root', join(subject.userHome, '.claude')]), 'invalid-runtime-root'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--scope', 'production']), 'invalid-scope'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--receipt', 'relative/receipt.json']), 'invalid-receipt-path'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--stage-root', 'relative/stage']), 'invalid-stage-root'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--engine-root', 'relative/engine']), 'invalid-engine-root'],
      [scopeArgs(subject, 'doctor', ['--apply', '--expected-plan-digest', 'a'.repeat(64)]), 'invalid-arguments'],
      [scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--unknown-flag']), 'invalid-arguments'],
    ]
    for (const [args, code] of cases) {
      const result = deploy(subject, args)
      assert.equal(result.status, 64, `${code}: ${result.stdout}\n${result.stderr}`)
      assert.equal(result.value?.ok, false, code)
      assert.equal(result.value?.error?.code, code)
      assert.equal(typeof result.value?.error?.message, 'string')
    }
    assert.equal(profileManifest(subject), before)
    assert.deepEqual(dshCalls(subject), [])
    assert.deepEqual(readdirSync(subject.runtimeRoot), [])
    assert.equal(existsSync(join(subject.dshHome, 'runtime-kit')), false)
  } finally {
    subject.cleanup()
  }
})

test('an artifact whose digest or structure does not match is refused before staging or mutation', () => {
  const subject = fixture()
  try {
    const before = profileManifest(subject)
    const mismatch = deploy(subject, scopeArgs(subject, 'setup', ['--artifact', subject.v1.path, '--artifact-sha256', subject.v2.sha256]))
    assert.equal(mismatch.status, 65, `${mismatch.stdout}\n${mismatch.stderr}`)
    assert.equal(mismatch.value.error.code, 'artifact-digest-mismatch')
    assert.equal(mismatch.value.error.details.expected_sha256, subject.v2.sha256)
    assert.equal(mismatch.value.error.details.actual_sha256, subject.v1.sha256)

    const missing = deploy(subject, scopeArgs(subject, 'setup', ['--artifact', join(subject.root, 'absent.tgz'), '--artifact-sha256', subject.v1.sha256]))
    assert.equal(missing.status, 65)
    assert.equal(missing.value.error.code, 'artifact-unreadable')

    const bogus = join(subject.root, 'bogus.tgz')
    writeFileSync(bogus, 'not a tarball')
    const invalid = deploy(subject, scopeArgs(subject, 'setup', ['--artifact', bogus, '--artifact-sha256', sha256('not a tarball')]))
    assert.equal(invalid.status, 65)
    assert.equal(invalid.value.error.code, 'artifact-invalid')

    assert.equal(profileManifest(subject), before)
    assert.deepEqual(dshCalls(subject), [])
    assert.deepEqual(readdirSync(subject.runtimeRoot), [])
    assert.equal(existsSync(join(subject.dshHome, 'runtime-kit')), false)
    assert.equal(existsSync(join(subject.root, 'cache')), false, 'a refused artifact is never staged')
  } finally {
    subject.cleanup()
  }
})

test('canary scope refuses the primary DSH home and primary scope requires recorded authority', () => {
  const subject = fixture()
  try {
    const primaryHome = join(subject.userHome, '.dsh')
    mkdirSync(join(primaryHome, 'profiles', 'canary'), { recursive: true, mode: 0o700 })
    const implicitCanary = deploy(subject, scopeArgs(subject, 'doctor', ['--dsh-home', primaryHome]))
    assert.equal(implicitCanary.status, 64, `${implicitCanary.stdout}\n${implicitCanary.stderr}`)
    assert.equal(implicitCanary.value.error.code, 'primary-home-requires-primary-scope')

    const ambient = deploy(subject, scopeArgs(subject, 'doctor', ['--dsh-home', join(subject.root, 'ambient-dsh-home')]))
    assert.equal(ambient.status, 64)
    assert.equal(ambient.value.error.code, 'primary-home-requires-primary-scope')

    const unauthorized = deploy(subject, scopeArgs(subject, 'doctor', ['--dsh-home', primaryHome, '--scope', 'primary']))
    assert.equal(unauthorized.status, 64)
    assert.equal(unauthorized.value.error.code, 'primary-scope-unauthorized')

    const blankAuthority = deploy(subject, scopeArgs(subject, 'doctor', ['--dsh-home', primaryHome, '--scope', 'primary', '--authorized-by', '   ']))
    assert.equal(blankAuthority.status, 64)
    assert.equal(blankAuthority.value.error.code, 'primary-scope-unauthorized')

    const unauthorizedCanary = deploy(subject, scopeArgs(subject, 'doctor', ['--authorized-by', 'maintainer']))
    assert.equal(unauthorizedCanary.status, 64)
    assert.equal(unauthorizedCanary.value.error.code, 'unexpected-authorized-by')

    // An aliased home is still the live home: HOME reached through a symlink
    // and a default DSH home that does not exist yet must not slip past the
    // canary guard on the lexical path.
    const realHome = join(subject.root, 'real-home')
    mkdirSync(realHome, { mode: 0o700 })
    symlinkSync(realHome, join(subject.root, 'link-home'), 'dir')
    const aliased = deploy(subject, scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--dsh-home', join(realHome, '.dsh')]), {
      HOME: join(subject.root, 'link-home'),
      DSH_HOME: '/nonexistent/other',
    })
    assert.equal(aliased.status, 64, `${aliased.stdout}\n${aliased.stderr}`)
    assert.equal(aliased.value.error.code, 'primary-home-requires-primary-scope')
    assert.equal(existsSync(join(realHome, '.dsh')), false)

    assert.deepEqual(dshCalls(subject), [])
    assert.equal(existsSync(join(primaryHome, 'runtime-kit')), false)

    // Primary scope with a named authority is the one path into the live home;
    // the identity is trimmed and recorded, and the resume vector keeps it.
    const primary = deploy(subject, scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--dsh-home', primaryHome, '--scope', 'primary', '--authorized-by', '  maintainer ']))
    assert.equal(primary.status, 0, `${primary.stdout}\n${primary.stderr}`)
    assert.equal(primary.value.data.scope, 'primary')
    assert.equal(primary.value.data.authorized_by, 'maintainer')
    assert.equal(primary.value.data.dsh_home, primaryHome)
    assert.equal(primary.value.data.mode, 'preview')
    assert.deepEqual(primary.value.data.resume.apply_argv.slice(-9, -5), ['--scope', 'primary', '--authorized-by', '  maintainer '])
  } finally {
    subject.cleanup()
  }
})

test('doctor on a profile without an activation is a typed profile-unhealthy result', () => {
  const subject = fixture()
  try {
    const receiptPath = join(subject.root, 'receipts', 'doctor.json')
    const unhealthy = deploy(subject, scopeArgs(subject, 'doctor', ['--receipt', receiptPath]))
    assert.equal(unhealthy.status, 65, `${unhealthy.stdout}\n${unhealthy.stderr}`)
    assert.equal(unhealthy.value.ok, false)
    assert.equal(unhealthy.value.error.code, 'profile-unhealthy')
    assert.equal(unhealthy.value.error.details.phase, 'doctor')
    assert.equal(unhealthy.value.error.details.mode, 'inspect')
    assert.equal(typeof unhealthy.value.error.details.engine.status, 'string')
    assert.notEqual(unhealthy.value.error.details.engine.status, 'healthy')
    assert.equal(unhealthy.value.error.details.engine.exit_code, 65)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.ok, false)
    assert.equal(receipt.error.code, 'profile-unhealthy')
  } finally {
    subject.cleanup()
  }
})

test('the stage root must be owner-only and drifted or foreign stage content is rebuilt from the artifact', () => {
  const subject = fixture()
  try {
    const open = join(subject.root, 'open-stage')
    mkdirSync(open, { mode: 0o755 })
    const refused = deploy(subject, scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--stage-root', open]))
    assert.equal(refused.status, 65, `${refused.stdout}\n${refused.stderr}`)
    assert.equal(refused.value.error.code, 'stage-unavailable')
    assert.equal(refused.value.error.details.stage_root, open)
    assert.deepEqual(dshCalls(subject), [])

    // A symlink planted where the digest stage or its package entry belongs
    // must not redirect extraction or cleanup; it is refused, not followed.
    const stageRootDefault = join(subject.root, 'cache', 'dsh-runtime-kit', 'deploy-stage')
    mkdirSync(stageRootDefault, { recursive: true, mode: 0o700 })
    const elsewhere = join(subject.root, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    writeFileSync(join(elsewhere, 'keep.txt'), 'must survive\n')
    symlinkSync(elsewhere, join(stageRootDefault, subject.v1.sha256), 'dir')
    const redirected = deploy(subject, scopeArgs(subject, 'setup', artifactArgs(subject.v1)))
    assert.equal(redirected.status, 65, `${redirected.stdout}\n${redirected.stderr}`)
    assert.equal(redirected.value.error.code, 'stage-unavailable')
    assert.deepEqual(readdirSync(elsewhere), ['keep.txt'])
    rmSync(join(stageRootDefault, subject.v1.sha256))
    mkdirSync(join(stageRootDefault, subject.v1.sha256), { mode: 0o700 })
    symlinkSync(elsewhere, join(stageRootDefault, subject.v1.sha256, 'package'), 'dir')
    const redirectedPackage = deploy(subject, scopeArgs(subject, 'setup', artifactArgs(subject.v1)))
    assert.equal(redirectedPackage.status, 65, `${redirectedPackage.stdout}\n${redirectedPackage.stderr}`)
    assert.equal(redirectedPackage.value.error.code, 'stage-unavailable')
    assert.deepEqual(readdirSync(elsewhere), ['keep.txt'])
    rmSync(join(stageRootDefault, subject.v1.sha256, 'package'))
    assert.deepEqual(dshCalls(subject), [])

    const preview = deploy(subject, scopeArgs(subject, 'setup', artifactArgs(subject.v1)))
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`)
    const staged = stagedRoot(subject, subject.v1)
    writeFileSync(join(staged, 'extra.js'), 'planted\n')
    const applied = deploy(subject, preview.value.data.resume.apply_argv)
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
    assert.equal(applied.value.data.artifact.restaged, true)
    assert.equal(existsSync(join(staged, 'extra.js')), false)
    assert.equal(applied.value.data.plan_digest, preview.value.data.plan_digest)
  } finally {
    subject.cleanup()
  }
})

test('deploy drives the digest-reviewed lifecycle through the engine and emits resumable receipts', () => {
  const subject = fixture()
  try {
    const receiptPath = join(subject.root, 'receipts', 'setup-preview.json')
    const preview = deploy(subject, scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--receipt', receiptPath]))
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`)
    assert.equal(preview.value.schema_version, 'cli.dsh-runtime-kit.deploy.v1')
    assert.equal(preview.value.ok, true)
    const receipt = preview.value.data
    assert.equal(receipt.schema_version, 'dsh-runtime-kit.deploy-receipt.v1')
    assert.equal(receipt.phase, 'setup')
    assert.equal(receipt.mode, 'preview')
    assert.equal(receipt.scope, 'canary')
    assert.equal(receipt.profile, 'canary')
    assert.equal(receipt.dsh_home, subject.dshHome)
    assert.equal(receipt.runtime_root, subject.runtimeRoot)
    assert.deepEqual(receipt.artifact, {
      path: subject.v1.path,
      sha256: subject.v1.sha256,
      name: '@sympoies/dsh-runtime-kit',
      version: '1.0.0',
      staged_root: stagedRoot(subject, subject.v1),
      restaged: true,
    })
    assert.equal(receipt.stage_root, join(subject.root, 'cache', 'dsh-runtime-kit', 'deploy-stage'))
    assert.equal(statSync(receipt.stage_root).mode & 0o777, 0o700)
    assert.match(receipt.plan_digest, /^[a-f0-9]{64}$/u)
    assert.equal(receipt.engine.schema_version, 'cli.dsh-runtime-kit.operations.v1')
    assert.equal(receipt.engine.root, projectRoot)
    assert.equal(receipt.engine.version, JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version)
    assert.equal(receipt.engine.ok, true)
    assert.equal(receipt.engine.mode, 'dry-run')
    assert.equal(receipt.engine.exit_code, 0)
    assert.equal(receipt.engine.target.expected_version, '1.0.0')
    // The resume vector pins the stage root that was defaulted from the
    // environment, so it applies the same plan under any environment.
    assert.deepEqual(receipt.resume.apply_argv, [
      ...scopeArgs(subject, 'setup', artifactArgs(subject.v1)),
      '--stage-root', receipt.stage_root,
      '--apply', '--expected-plan-digest', receipt.plan_digest,
    ])
    // Preview touched neither the profile nor the runtime root.
    assert.deepEqual(dshCalls(subject).filter(args => args[0] === 'plugin'), [])
    assert.deepEqual(readdirSync(subject.runtimeRoot), [])
    const persisted = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.deepEqual(persisted, receipt)
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(receiptPath)).mode & 0o777, 0o700)

    // Tampering with the stage between preview and apply cannot reach the
    // engine: the stage is rebuilt from the authenticated bytes, so the reviewed
    // plan digest still binds exactly the artifact that was previewed.
    writeFileSync(join(stagedRoot(subject, subject.v1), 'cordis.patch.yml'), '- tampered: true\n')
    const applied = deploy(subject, receipt.resume.apply_argv, { XDG_CACHE_HOME: join(subject.root, 'another-cache') })
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`)
    assert.equal(applied.value.data.mode, 'apply')
    assert.equal(applied.value.data.engine.mode, 'applied')
    assert.equal(applied.value.data.plan_digest, receipt.plan_digest)
    assert.equal(applied.value.data.artifact.restaged, true)
    assert.equal(readFileSync(join(stagedRoot(subject, subject.v1), 'cordis.patch.yml'), 'utf8'), '[]\n')
    assert.equal(applied.value.data.resume, undefined)
    const manifest = JSON.parse(profileManifest(subject))
    assert.equal(manifest.dsh.profile.bundles.includes('@sympoies/dsh-runtime-kit'), true)
    assert.equal(manifest.dependencies['unrelated-plugin'], '1.0.0')

    const doctor = deploy(subject, scopeArgs(subject, 'doctor'))
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`)
    assert.equal(doctor.value.data.mode, 'inspect')
    assert.equal(doctor.value.data.engine.status, 'healthy')
    assert.equal(doctor.value.data.plan_digest, undefined)

    const updatePreview = deploy(subject, scopeArgs(subject, 'update', artifactArgs(subject.v2)))
    assert.equal(updatePreview.status, 0, `${updatePreview.stdout}\n${updatePreview.stderr}`)
    assert.equal(updatePreview.value.data.artifact.restaged, true)
    const updated = deploy(subject, updatePreview.value.data.resume.apply_argv)
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`)
    assert.equal(updated.value.data.artifact.restaged, false, 'an intact stage is reused')
    assert.equal(updated.value.data.engine.target.expected_version, '2.0.0')

    const rollbackPreview = deploy(subject, scopeArgs(subject, 'rollback'))
    assert.equal(rollbackPreview.status, 0, `${rollbackPreview.stdout}\n${rollbackPreview.stderr}`)
    assert.equal(rollbackPreview.value.data.artifact, null)
    const rolledBack = deploy(subject, rollbackPreview.value.data.resume.apply_argv)
    assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`)
    assert.equal(rolledBack.value.data.engine.target.expected_version, '1.0.0')

    // A healthy profile has nothing to repair; the engine's typed refusal is
    // surfaced unchanged rather than rewritten by the dispatcher.
    const repairPreview = deploy(subject, scopeArgs(subject, 'repair'))
    assert.equal(repairPreview.status, 64, `${repairPreview.stdout}\n${repairPreview.stderr}`)
    assert.equal(repairPreview.value.error.code, 'engine-refused')
    assert.equal(repairPreview.value.error.details.engine.code, 'repair-not-required')
    assert.equal(repairPreview.value.error.details.mode, 'preview')
    assert.equal(repairPreview.value.error.details.phase, 'repair')

    const removePreview = deploy(subject, scopeArgs(subject, 'remove'))
    assert.equal(removePreview.status, 0, `${removePreview.stdout}\n${removePreview.stderr}`)
    const removed = deploy(subject, removePreview.value.data.resume.apply_argv)
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`)
    const after = JSON.parse(profileManifest(subject))
    assert.equal(after.dsh.profile.bundles.includes('@sympoies/dsh-runtime-kit'), false)
    assert.equal(after.dependencies['unrelated-plugin'], '1.0.0')
    assert.equal(existsSync(join(subject.root, 'ambient-dsh-home')), false)
    assert.equal(existsSync(join(subject.root, 'ambient-runtime-root')), false)
  } finally {
    subject.cleanup()
  }
})

test('an explicit engine root must be an installed runtime-kit tree carrying the operations engine', () => {
  const subject = fixture()
  try {
    const before = profileManifest(subject)
    const missing = deploy(subject, scopeArgs(subject, 'doctor', ['--engine-root', join(subject.root, 'not-an-engine')]))
    assert.equal(missing.status, 70, `${missing.stdout}\n${missing.stderr}`)
    assert.equal(missing.value.error.code, 'engine-unavailable')
    const foreign = join(subject.root, 'foreign-engine')
    mkdirSync(join(foreign, 'bin'), { recursive: true })
    writeJson(join(foreign, 'package.json'), { name: 'someone-else', version: '1.0.0' })
    writeFileSync(join(foreign, 'bin', 'dsh-runtime-kit.js'), '')
    writeFileSync(join(foreign, 'bin', 'dsh-runtime-kit-launch.js'), '')
    const wrongPackage = deploy(subject, scopeArgs(subject, 'doctor', ['--engine-root', foreign]))
    assert.equal(wrongPackage.status, 70)
    assert.equal(wrongPackage.value.error.code, 'engine-unavailable')
    assert.equal(profileManifest(subject), before)
    assert.deepEqual(dshCalls(subject), [])

    // The checkout itself is an acceptable explicit engine root.
    const explicit = deploy(subject, scopeArgs(subject, 'setup', [...artifactArgs(subject.v1), '--engine-root', projectRoot]))
    assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`)
    assert.equal(explicit.value.data.engine.root, projectRoot)
    assert.deepEqual(explicit.value.data.resume.apply_argv.slice(-3, -2), ['--apply'])
  } finally {
    subject.cleanup()
  }
})

test('every dispatcher code is a public acceptance cause code and the source declares no other', () => {
  const source = readFileSync(join(projectRoot, 'src', 'deploy', 'index.js'), 'utf8')
  const declared = new Set([...source.matchAll(/new DeployError\(\s*['"]([a-z][a-z0-9-]*)['"]/gu)].map(match => match[1]))
  for (const literal of [...source.matchAll(/usage\(\s*['"]([a-z][a-z0-9-]*)['"]/gu)]) declared.add(literal[1])
  assert.deepEqual([...declared].sort(), [...DEPLOY_ERROR_CODES])
  for (const code of [...DEPLOY_ERROR_CODES, 'command-failed']) {
    const causeCode = `DSH_DEPLOY_${code.replaceAll('-', '_').toUpperCase()}`
    assert.deepEqual(scenarioFailureDiagnostic(JSON.stringify({
      schema_version: 'dsh-runtime-kit.acceptance-scenario-diagnostic.v1',
      ok: false,
      producer: 'operations',
      step: 'deploy-dispatcher',
      cause_code: causeCode,
    })), {
      scenario_producer: 'operations',
      scenario_step: 'deploy-dispatcher',
      scenario_cause_code: causeCode,
    })
  }
})

test('engine refusals surface as bounded typed receipts with the engine exit code', () => {
  const subject = fixture()
  try {
    const stale = deploy(subject, scopeArgs(subject, 'setup', [
      ...artifactArgs(subject.v1), '--apply', '--expected-plan-digest', 'b'.repeat(64),
    ]))
    assert.notEqual(stale.status, 0)
    assert.equal(stale.value.ok, false)
    assert.equal(stale.value.error.code, 'engine-refused')
    assert.equal(stale.value.error.details.engine.code, 'plan-drift')
    assert.equal(stale.value.error.details.engine.exit_code, stale.status)
    assert.equal(stale.value.error.details.phase, 'setup')
    assert.equal(stale.value.error.details.mode, 'apply')
    assert.ok(stale.stdout.length < 16 * 1024, 'deploy output must stay bounded')
    const manifest = JSON.parse(profileManifest(subject))
    assert.equal(manifest.dsh.profile.bundles.includes('@sympoies/dsh-runtime-kit'), false)

    // A failed phase still leaves a persisted, bounded failure receipt for resume.
    const receiptPath = join(subject.root, 'receipts', 'failed.json')
    const failed = deploy(subject, scopeArgs(subject, 'setup', [
      ...artifactArgs(subject.v1), '--apply', '--expected-plan-digest', 'b'.repeat(64), '--receipt', receiptPath,
    ]))
    assert.notEqual(failed.status, 0)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert.equal(receipt.schema_version, 'dsh-runtime-kit.deploy-receipt.v1')
    assert.equal(receipt.ok, false)
    assert.equal(receipt.phase, 'setup')
    assert.equal(receipt.mode, 'apply')
    assert.equal(receipt.error.code, 'engine-refused')
    assert.equal(receipt.error.details.engine.code, 'plan-drift')
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600)
  } finally {
    subject.cleanup()
  }
})
