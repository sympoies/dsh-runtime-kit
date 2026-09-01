import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DshTuiPatchError,
  manageDshTuiPatch,
  validateDshTuiPatchManifest,
} from '../src/compat/dsh-tui-patch.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = value => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-tui-patch-'))
  const packageRoot = join(root, 'package')
  const targetPath = 'lib/types/history.js'
  const patchPath = 'patches/test.patch'
  const manifestBytes = `${JSON.stringify({
    name: '@deepseek-harness-tui/dsh-tui',
    version: '0.9.3-test',
  }, null, 2)}\n`
  const before = "export const historyLock = 'blocking'\n"
  const after = "export const historyLock = 'nonblocking'\n"
  const patch = [
    `diff --git a/${targetPath} b/${targetPath}`,
    'index 1111111..2222222 100644',
    `--- a/${targetPath}`,
    `+++ b/${targetPath}`,
    '@@ -1 +1 @@',
    "-export const historyLock = 'blocking'",
    "+export const historyLock = 'nonblocking'",
    '',
  ].join('\n')
  await mkdir(join(packageRoot, dirname(targetPath)), { recursive: true })
  await mkdir(join(root, dirname(patchPath)), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), manifestBytes)
  await writeFile(join(packageRoot, targetPath), before)
  await writeFile(join(root, patchPath), patch)
  const manifest = {
    schema_version: 'dsh-runtime-kit.dsh-tui-patches.v1',
    package_name: '@deepseek-harness-tui/dsh-tui',
    patches: [{
      id: 'nonblocking-history-lock-v1',
      path: patchPath,
      sha256: sha256(patch),
      targets: {
        [targetPath]: {
          before_sha256: sha256(before),
          after_sha256: sha256(after),
        },
      },
      validated_releases: {
        '0.9.3-test': {
          package_json_sha256: sha256(manifestBytes),
        },
      },
    }],
  }
  return { root, packageRoot, targetPath, patchPath, before, after, patch, manifest }
}

const manage = (value, action) => manageDshTuiPatch({
  action,
  packageRoot: value.packageRoot,
  patchRoot: value.root,
  manifest: value.manifest,
  gitBin: '/usr/bin/git',
})

test('the DSH TUI patch lifecycle applies, checks, and reverses one exact release', async () => {
  const value = await fixture()
  try {
    assert.equal(validateDshTuiPatchManifest(value.manifest).patches.length, 1)
    const applied = await manage(value, 'apply')
    assert.equal(applied.before, 'pristine')
    assert.equal(applied.after, 'patched')
    assert.equal(await readFile(join(value.packageRoot, value.targetPath), 'utf8'), value.after)
    assert.equal((await manage(value, 'apply')).changed, false)
    assert.equal((await manage(value, 'check')).after, 'patched')
    assert.equal((await manage(value, 'reverse')).after, 'pristine')
    assert.equal(await readFile(join(value.packageRoot, value.targetPath), 'utf8'), value.before)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the DSH TUI patch fails closed on package, target, and artifact drift', async () => {
  for (const scenario of ['package', 'target', 'artifact']) {
    const value = await fixture()
    try {
      if (scenario === 'package') {
        await writeFile(join(value.packageRoot, 'package.json'), '{"name":"substituted"}\n')
      } else if (scenario === 'target') {
        await writeFile(join(value.packageRoot, value.targetPath), 'drifted\n')
      } else {
        await writeFile(join(value.root, value.patchPath), `${value.patch}# drift\n`)
      }
      await assert.rejects(
        manage(value, 'apply'),
        error => error instanceof DshTuiPatchError,
        scenario,
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('the DSH TUI patch rejects target symlinks before mutation', async () => {
  const value = await fixture()
  try {
    const outside = join(value.root, 'outside.js')
    await writeFile(outside, value.before)
    await rm(join(value.packageRoot, value.targetPath))
    await symlink(outside, join(value.packageRoot, value.targetPath))
    await assert.rejects(
      manage(value, 'apply'),
      error => error instanceof DshTuiPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_TUI_PATCH_TARGET_INVALID',
    )
    assert.equal(await readFile(outside, 'utf8'), value.before)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the checked-in beta.4 patch keeps upstream async history and removes only remaining rc.2 drift', async () => {
  const manifest = JSON.parse(await readFile(
    join(projectRoot, 'compatibility', 'dsh-tui-patches.json'),
    'utf8',
  ))
  const validated = validateDshTuiPatchManifest(manifest)
  const patch = validated.patches[0]
  const bytes = await readFile(join(projectRoot, patch.path))
  assert.equal(sha256(bytes), patch.sha256)
  assert.deepEqual(Object.keys(patch.validated_releases), ['0.10.0-beta.4'])
  assert.deepEqual(Object.keys(patch.targets), [
    'cordis.patch.yml',
    'lib/types/history.js',
  ])
  const additions = bytes.toString('utf8').split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n')
  assert.match(additions, /lstat/u)
  assert.match(additions, /chmod/u)
  assert.match(additions, /lstatSync/u)
  assert.match(additions, /chmodSync/u)
  assert.match(additions, /prepareHistoryStorageSync/u)
  assert.match(additions, /process\.getuid/u)
  assert.match(additions, /0o700/u)
  assert.match(additions, /0o600/u)
  assert.doesNotMatch(bytes.toString('utf8'), /Atomics\.wait|sleepSync/u)
  assert.doesNotMatch(additions, /(?:mkdir|rm)Sync/u)
  const removals = bytes.toString('utf8').split('\n')
    .filter(line => line.startsWith('-') && !line.startsWith('---'))
    .join('\n')
  assert.match(removals, /plugin-package-inventory-deepseek/u)
})
