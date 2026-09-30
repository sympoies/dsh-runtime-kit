import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createDshHistoryModuleResolver } from '../dist/src/compat/dsh-history-profile.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY_BIN = join(ROOT, 'dist/bin/dsh-runtime-kit-history.js')
const V4_FIXTURE = join(ROOT, 'test/fixtures/dsh-history-v4/sessions')

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

// The committed fixture was written by DSH's own JSONL backend (session format
// v4, zstd). Reading it needs a real installed DSH profile, which the routine
// gate does not stage; name one to run this row against it.
const INSTALLED_PROFILE = process.env.DSH_RUNTIME_KIT_HISTORY_PROFILE_ROOT
test('reads a DSH v4 session store read-only through an installed profile', {
  skip: INSTALLED_PROFILE === undefined && 'set DSH_RUNTIME_KIT_HISTORY_PROFILE_ROOT to an installed DSH 0.1.7-rc.1 or 0.2.0-rc.2 profile',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-history-v4-'))
  try {
    const root = join(workspace, 'sessions')
    await cp(V4_FIXTURE, root, { recursive: true })
    const before = await digestTree(root)
    const profileArgs = ['--profile-root', INSTALLED_PROFILE!]

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
