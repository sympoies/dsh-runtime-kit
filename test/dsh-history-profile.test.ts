import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DSH_HISTORY_PACKAGES } from '../dist/src/compat/dsh-history-adapter.js'
import { createDshHistoryModuleResolver } from '../dist/src/compat/dsh-history-profile.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY_BIN = join(ROOT, 'dist/bin/dsh-runtime-kit-history.js')
const V4_FIXTURE = join(ROOT, 'test/fixtures/dsh-history-v4/sessions')
const HISTORY_RUNTIME_PACKAGES = ['@deepseek-ai/cordis', ...DSH_HISTORY_PACKAGES]

/** Whether the kit's own installation carries every package a history read loads. */
function kitRelativeHistoryPackages(): boolean {
  const require = createRequire(join(ROOT, 'package.json'))
  return HISTORY_RUNTIME_PACKAGES.every(name => {
    try {
      require.resolve(`${name}/package.json`)
      return true
    } catch {
      return false
    }
  })
}

async function writePackage(dir: string, name: string, version: string) {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }))
  await writeFile(join(packageDir, 'index.js'), `export const origin = ${JSON.stringify(name)}\n`)
  return packageDir
}

/**
 * The shape an installed DSH profile has on disk: the history packages DSH
 * hoists into the profile, the DSH installation it boots, and the base bundle
 * that DSH installation carries — which is where the JSONL backend lives.
 */
async function fakeProfile(version: string) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-history-profile-'))
  const profile = join(home, 'profiles', 'workbench')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'workbench',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-title']) {
    await writePackage(profile, name, version)
  }
  const dsh = await writePackage(profile, '@deepseek-ai/dsh', version)
  const base = await writePackage(dsh, '@deepseek-ai/dsh-base', version)
  await writePackage(base, '@deepseek-ai/dsh-session-persistence-jsonl', version)
  return { home, profile }
}

function history(args: string[]) {
  return spawnSync(process.execPath, [HISTORY_BIN, ...args], { encoding: 'utf8' })
}

test('resolves history packages from the profile, its DSH installation, and its bundles', async () => {
  const { home, profile } = await fakeProfile('0.2.0-rc.2')
  try {
    const resolver = createDshHistoryModuleResolver(profile)
    assert.equal(relative(profile, resolver.resolve('@deepseek-ai/dsh-session')),
      join('node_modules/@deepseek-ai/dsh-session/index.js'))
    assert.equal(relative(profile, resolver.resolve('@deepseek-ai/dsh-session-persistence-jsonl')),
      join('node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/index.js'))
    assert.equal(resolver.packageVersion('@deepseek-ai/dsh-session-persistence-jsonl'), '0.2.0-rc.2')
    assert.equal(resolver.packageVersion('@deepseek-ai/dsh-missing'), undefined)
    assert.throws(() => resolver.resolve('@deepseek-ai/dsh-missing'), /cannot resolve @deepseek-ai\/dsh-missing from the DSH profile/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('searches bundles only from the profile and its DSH installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-history-bundles-'))
  try {
    const profile = join(home, 'profile')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'no-installation',
      private: true,
      dsh: { profile: { bundles: ['@fixture/bundle-a', '@fixture/bundle-b', '@fixture/bundle-nested'] } },
    }))
    const bundleA = await writePackage(profile, '@fixture/bundle-a', '1.0.0')
    const bundleB = await writePackage(profile, '@fixture/bundle-b', '1.0.0')
    await writePackage(bundleA, '@fixture/from-a', '1.0.0')
    await writePackage(bundleB, '@fixture/from-b', '2.0.0')
    // Reachable only through bundle-a's own dependencies, so it is not a bundle root.
    const nested = await writePackage(bundleA, '@fixture/bundle-nested', '1.0.0')
    await writePackage(nested, '@fixture/from-nested', '1.0.0')

    const resolver = createDshHistoryModuleResolver(profile)
    assert.equal(resolver.packageVersion('@fixture/from-a'), '1.0.0')
    assert.equal(resolver.packageVersion('@fixture/from-b'), '2.0.0')
    assert.equal(relative(profile, resolver.resolve('@fixture/from-b')),
      join('node_modules/@fixture/bundle-b/node_modules/@fixture/from-b/index.js'))
    assert.equal(resolver.packageVersion('@fixture/from-nested'), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses a relative or package-less profile root', async () => {
  assert.throws(() => createDshHistoryModuleResolver('profiles/workbench'), /profile root must be absolute/)
  const empty = await mkdtemp(join(tmpdir(), 'dsh-history-profile-empty-'))
  try {
    assert.throws(() => createDshHistoryModuleResolver(empty), /profile root has no package.json/)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('reports capabilities for the DSH composition named by --profile-root', async () => {
  const { home, profile } = await fakeProfile('0.2.0-rc.2')
  try {
    const result = history(['capabilities', '--profile-root', profile])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      schema_version: 'dsh-runtime-kit.history.v1',
      data: {
        adapter_schema: 'dsh-runtime-kit.history.v1',
        session_format: 'dsh-session@0.2.0-rc.2',
        operations: ['list', 'summaries', 'messages'],
      },
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses a retired DSH composition and a relative --profile-root', async () => {
  const { home, profile } = await fakeProfile('0.1.6-alpha.2')
  try {
    const retired = history(['capabilities', '--profile-root', profile])
    assert.equal(retired.status, 70)
    assert.equal(retired.stdout, '')
    const relativeRoot = history(['list', '--root', V4_FIXTURE, '--profile-root', 'profiles/workbench'])
    assert.equal(relativeRoot.status, 64)
    assert.match(relativeRoot.stderr, /--profile-root must be absolute/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a kit-relative read without the DSH history packages fails with no output', {
  skip: kitRelativeHistoryPackages() && 'the kit installation carries the DSH history packages',
}, () => {
  for (const args of [['capabilities'], ['list', '--root', V4_FIXTURE, '--compression', 'zstd']]) {
    const result = history(args)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
  }
})

async function digestTree(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      hash.update(relative(root, path))
      if (entry.isDirectory()) await walk(path)
      else hash.update(await readFile(path))
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/** Package directories of a built DSH source checkout, by package name. */
function sourcePackages(sourceRoot: string): Map<string, string> {
  const packages = new Map<string, string>()
  const manifests = [
    ...readdirSync(join(sourceRoot, 'packages')).flatMap(group => {
      try {
        return readdirSync(join(sourceRoot, 'packages', group)).map(name => join(sourceRoot, 'packages', group, name))
      } catch {
        return []
      }
    }),
    ...readdirSync(join(sourceRoot, 'vendor')).map(name => join(sourceRoot, 'vendor', name)),
  ]
  for (const dir of manifests) {
    try {
      const { name } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof name === 'string') packages.set(name, dir)
    } catch {
      // Not a package directory.
    }
  }
  return packages
}

/**
 * A profile whose history packages link into a built DSH source checkout, so
 * each package keeps resolving its own dependencies inside that workspace.
 */
async function linkSourceProfile(sourceRoot: string, into: string): Promise<string> {
  const profile = join(into, 'source-profile')
  await mkdir(join(profile, 'node_modules', '@deepseek-ai'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-history-source-profile', private: true }))
  const packages = sourcePackages(sourceRoot)
  for (const name of HISTORY_RUNTIME_PACKAGES) {
    const dir = packages.get(name)
    assert.ok(dir !== undefined, `the DSH source checkout has no ${name} package`)
    await symlink(dir, join(profile, 'node_modules', ...name.split('/')), 'dir')
  }
  return profile
}

// The committed fixture was written by DSH's own JSONL backend (session format
// v4, zstd). The row reads it through, in order: an installed DSH profile, a
// profile linked into a built DSH source checkout (the compatibility workflow
// sets this for every selected release), or the kit's own installation. It
// skips only when none of them carries the DSH history packages.
const INSTALLED_PROFILE = process.env.DSH_RUNTIME_KIT_HISTORY_PROFILE_ROOT
const SOURCE_ROOT = process.env.DSH_RUNTIME_KIT_HISTORY_SOURCE_ROOT
test('reads a DSH v4 session store read-only', {
  skip: INSTALLED_PROFILE === undefined && SOURCE_ROOT === undefined && !kitRelativeHistoryPackages()
    && 'no DSH profile, built DSH source checkout, or kit installation carries the DSH history packages',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-history-v4-'))
  try {
    const root = join(workspace, 'sessions')
    await cp(V4_FIXTURE, root, { recursive: true })
    const before = await digestTree(root)
    const profileRoot = INSTALLED_PROFILE
      ?? (SOURCE_ROOT === undefined ? undefined : await linkSourceProfile(SOURCE_ROOT, workspace))
    const profileArgs = profileRoot === undefined ? [] : ['--profile-root', profileRoot]

    const listed = history(['list', '--root', root, '--compression', 'zstd', ...profileArgs])
    assert.equal(listed.status, 0, listed.stderr)
    const catalog = JSON.parse(listed.stdout)
    assert.equal(catalog.schema_version, 'dsh-runtime-kit.history.v1')
    assert.deepEqual(catalog.data.map((item: Record<string, unknown>) => [item.provider_session_id, item.cwd, item.created_at]), [
      ['11111111-1111-4111-8111-111111111111', '/fixture/repo', '2026-09-21T14:13:20.000Z'],
    ])

    const summaries = history(['summaries', '--root', root, '--session-id', '11111111-1111-4111-8111-111111111111', ...profileArgs])
    assert.equal(summaries.status, 0, summaries.stderr)
    assert.deepEqual(JSON.parse(summaries.stdout).data, [{
      provider_session_id: '11111111-1111-4111-8111-111111111111',
      title: 'Fixture title',
      first_user_prompt_preview: 'first fixture prompt',
      last_user_prompt_preview: 'latest fixture prompt',
      updated_at: '2026-09-21T14:13:23.000Z',
    }])

    const messages = history(['messages', '--root', root, '--session-id', '11111111-1111-4111-8111-111111111111', ...profileArgs])
    assert.equal(messages.status, 0, messages.stderr)
    assert.deepEqual(JSON.parse(messages.stdout).data.messages.map((message: Record<string, unknown>) => [message.role, message.text]), [
      ['user', 'first fixture prompt'],
      ['assistant', 'fixture answer'],
      ['user', 'latest fixture prompt'],
    ])

    assert.equal(await digestTree(root), before)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
