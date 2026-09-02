import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  DshPatchError,
  manageDshPatch,
  validateDshPatchManifest,
} from '../src/compat/dsh-patch.js'

const run = promisify(execFile)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchArtifacts = patch => patch.release_artifacts === undefined
  ? [patch]
  : Object.values(patch.release_artifacts)

test('the checked-in manifest authenticates the checked-in patch artifact', async () => {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
  )
  for (const patch of manifest.patches) {
    for (const artifact of patchArtifacts(patch)) {
      const bytes = await readFile(join(projectRoot, artifact.path))
      assert.equal(sha256(bytes), artifact.sha256, `${patch.id}:${artifact.path}`)
    }
  }
})

test('the checked-in DSH patch preserves the host environment only in danger-full-access mode', async () => {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
  )
  for (const selected of patchArtifacts(manifest.patches[0])) {
    const artifact = await readFile(join(projectRoot, selected.path), 'utf8')
    assert.match(
      artifact,
      /process\.env\.DSH_PERMISSION_MODE === 'danger-full-access'[\s\S]*?\.\.\.process\.env/,
    )
    assert.match(artifact, /inherits the ambient host environment in danger-full-access mode/)
    assert.match(artifact, /keeps scrubbing ambient credentials outside danger-full-access mode/)
  }
})

test('the consolidated native patch adds goal, workspace, and restricted-role boundaries', async () => {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
  )
  assert.equal(manifest.patches.length, 1)
  const patch = manifest.patches[0]
  assert.equal(patch.id, 'native-execution-boundaries-v5')
  assert.deepEqual(
    Object.keys(patch.targets).filter(path => path.startsWith('packages/goal/goal/')).sort(),
    [
      'packages/goal/goal/src/index.ts',
      'packages/goal/goal/tests/goal.spec.ts',
    ],
  )
  assert.deepEqual(
    Object.keys(patch.targets).filter(path => path.startsWith('packages/subagent/subagent/')).sort(),
    [
      'packages/subagent/subagent/README.md',
      'packages/subagent/subagent/README.zh.md',
      'packages/subagent/subagent/src/child-agent.ts',
      'packages/subagent/subagent/src/continuation.ts',
      'packages/subagent/subagent/src/descriptor.ts',
      'packages/subagent/subagent/src/index.ts',
      'packages/subagent/subagent/src/types.ts',
      'packages/subagent/subagent/tests/continuation.spec.ts',
      'packages/subagent/subagent/tests/service.spec.ts',
    ],
  )
  for (const selected of patchArtifacts(patch)) {
    const source = await readFile(join(projectRoot, selected.path), 'utf8')
    assert.match(source, /ctx\.get\('dshAcceptance'\)\?\.assertGoalCompletion\(agent, ref\)/u)
    assert.match(source, /does not mutate goal state when acceptance denies/u)
    assert.match(source, /preserves completion when no acceptance provider is installed/u)
    assert.match(source, /registerContinuableWorkspaceProvider/u)
    assert.match(source, /workspace identity does not match its durable session/u)
    assert.match(source, /rolls back the child when host workspace activation refuses authority/u)
    assert.match(source, /The waterfall runs after definition-owned content finalization/u)
    assert.match(source, /cannot write protected root[\s\S]*FS_SANDBOX_DENIED/u)
    assert.match(source, /cannot enforce protected workspace subroots/u)
    assert.match(source, /tools\/pre-persist/u)
    assert.match(source, /registerTerminalPolicy\(provider: ToolTerminalPolicy\)/u)
    assert.match(source, /Sole terminal data-policy provider/u)
    assert.match(source, /for \(const block of content\)[\s\S]*projectForPersistence/u)
    assert.doesNotMatch(source, /Promise\.all\([\s\S]{0,500}projectForPersistence/u)
    assert.match(source, /startRole\(roleId: string, request: RestrictedRoleStartRequest\)/u)
    assert.match(source, /supportsRestrictedRoles(?:\s*:\s*true|\s*=\s*true)/u)
    assert.match(source, /restricted role .* cannot execute/u)
    assert.match(source, /dsh\.subagent\.restricted-role-receipt\.v1/u)
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-patch-'))
  const sourcePath = 'packages/core/tools/src/index.ts'
  const testPath = 'packages/core/tools/tests/tools.spec.ts'
  const patchPath = 'patches/test.patch'
  const unrelatedPath = 'UNRELATED.md'
  const ignorePath = '.gitignore'
  const beforeSource = 'export const state = "before"\n'
  const afterSource = 'export const state = "after"\n'
  const beforeTest = 'test("before")\n'
  const afterTest = 'test("after")\n'
  const patch = [
    `diff --git a/${sourcePath} b/${sourcePath}`,
    'index 1111111..2222222 100644',
    `--- a/${sourcePath}`,
    `+++ b/${sourcePath}`,
    '@@ -1 +1 @@',
    '-export const state = "before"',
    '+export const state = "after"',
    `diff --git a/${testPath} b/${testPath}`,
    'index 3333333..4444444 100644',
    `--- a/${testPath}`,
    `+++ b/${testPath}`,
    '@@ -1 +1 @@',
    '-test("before")',
    '+test("after")',
    '',
  ].join('\n')
  await mkdir(join(root, 'packages/core/tools/src'), { recursive: true })
  await mkdir(join(root, 'packages/core/tools/tests'), { recursive: true })
  await mkdir(join(root, 'patches'), { recursive: true })
  await writeFile(join(root, sourcePath), beforeSource)
  await writeFile(join(root, testPath), beforeTest)
  await writeFile(join(root, patchPath), patch)
  await writeFile(join(root, unrelatedPath), 'unrelated baseline\n')
  await writeFile(join(root, ignorePath), 'ignored-payload.txt\n')
  await run('/usr/bin/git', ['init', '--quiet'], { cwd: root })
  await run('/usr/bin/git', [
    'add', '--', sourcePath, testPath, patchPath, unrelatedPath, ignorePath,
  ], { cwd: root })
  await run('/usr/bin/git', [
    '-c', 'user.name=DSH patch test',
    '-c', 'user.email=dsh-patch-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root })
  const { stdout } = await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root })
  const revision = stdout.trim()
  const manifest = {
    schema_version: 'dsh-runtime-kit.dsh-patches.v1',
    patches: [{
      id: 'native-execution-boundaries-v2',
      path: patchPath,
      sha256: sha256(patch),
      targets: {
        [sourcePath]: { before_sha256: sha256(beforeSource), after_sha256: sha256(afterSource) },
        [testPath]: { before_sha256: sha256(beforeTest), after_sha256: sha256(afterTest) },
      },
      validated_releases: {
        '0.0.0-test': { revision },
      },
    }],
  }
  return {
    root,
    sourcePath,
    testPath,
    patchPath,
    unrelatedPath,
    beforeSource,
    afterSource,
    patch,
    manifest,
    revision,
  }
}

const manage = (value, action) => manageDshPatch({
  action,
  sourceRoot: value.root,
  patchRoot: value.root,
  manifest: value.manifest,
  gitBin: '/usr/bin/git',
})

test('the DSH patch lifecycle applies and reverses one exact reviewed patch', async () => {
  const value = await fixture()
  try {
    assert.equal(validateDshPatchManifest(value.manifest).patches.length, 1)
    const applied = await manageDshPatch({
      action: 'apply',
      sourceRoot: value.root,
      patchRoot: value.root,
      manifest: value.manifest,
      gitBin: '/usr/bin/git',
    })
    assert.equal(applied.before, 'pristine')
    assert.equal(applied.after, 'patched')
    assert.equal(
      await readFile(join(value.root, value.sourcePath), 'utf8'),
      'export const state = "after"\n',
    )

    const reapplied = await manageDshPatch({
      action: 'apply', sourceRoot: value.root, patchRoot: value.root,
      manifest: value.manifest, gitBin: '/usr/bin/git',
    })
    assert.equal(reapplied.changed, false)
    assert.equal(reapplied.after, 'patched')

    const reversed = await manageDshPatch({
      action: 'reverse', sourceRoot: value.root, patchRoot: value.root,
      manifest: value.manifest, gitBin: '/usr/bin/git',
    })
    assert.equal(reversed.before, 'patched')
    assert.equal(reversed.after, 'pristine')
    assert.equal(reversed.source_checkout_clean, true)
    assert.equal(reversed.runtime_rebuilt, false)
    assert.equal(reversed.upstream_checkout_clean, true)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the patch manifest can bind one target to release-specific before and after hashes', async () => {
  const value = await fixture()
  try {
    const target = value.manifest.patches[0].targets[value.sourcePath]
    value.manifest.patches[0].targets[value.sourcePath] = {
      release_hashes: {
        '0.0.0-test': target,
      },
    }
    assert.doesNotThrow(() => validateDshPatchManifest(value.manifest))
    assert.equal((await manage(value, 'apply')).after, 'patched')
    assert.equal((await manage(value, 'reverse')).after, 'pristine')

    const missingRelease = structuredClone(value.manifest)
    missingRelease.patches[0].targets[value.sourcePath].release_hashes = {
      '0.0.1-foreign': target,
    }
    assert.throws(
      () => validateDshPatchManifest(missingRelease),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the patch manager selects a release-scoped authenticated artifact', async () => {
  const value = await fixture()
  try {
    const patch = value.manifest.patches[0]
    patch.release_artifacts = {
      '0.0.0-test': { path: patch.path, sha256: patch.sha256 },
    }
    delete patch.path
    delete patch.sha256
    assert.doesNotThrow(() => validateDshPatchManifest(value.manifest))
    assert.equal((await manage(value, 'apply')).after, 'patched')
    assert.equal((await manage(value, 'reverse')).after, 'pristine')

    const missing = structuredClone(value.manifest)
    missing.patches[0].release_artifacts = {
      '0.0.1-foreign': Object.values(patch.release_artifacts)[0],
    }
    assert.throws(
      () => validateDshPatchManifest(missing),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the patch manager ignores repository fsmonitor configuration', async () => {
  const value = await fixture()
  try {
    const sentinel = join(value.root, '.git', 'fsmonitor-ran')
    const monitor = join(value.root, '.git', 'fsmonitor-sentinel.sh')
    await writeFile(monitor, `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`)
    await chmod(monitor, 0o755)
    await run('/usr/bin/git', ['config', 'core.fsmonitor', monitor], { cwd: value.root })

    const receipt = await manage(value, 'check')

    assert.equal(receipt.after, 'pristine')
    await assert.rejects(access(sentinel))
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the patch manager rejects substituted and extra-path artifacts before mutation', async () => {
  for (const scenario of ['digest-substitution', 'extra-path']) {
    const value = await fixture()
    try {
      if (scenario === 'digest-substitution') {
        await writeFile(join(value.root, value.patchPath), `${value.patch}# substitution\n`)
      } else {
        const extraPath = value.unrelatedPath
        const extraPatch = [
          value.patch.trimEnd(),
          `diff --git a/${extraPath} b/${extraPath}`,
          'index 5555555..6666666 100644',
          `--- a/${extraPath}`,
          `+++ b/${extraPath}`,
          '@@ -1 +1 @@',
          '-unrelated baseline',
          '+unreviewed extra mutation',
          '',
        ].join('\n')
        await writeFile(join(value.root, value.patchPath), extraPatch)
        value.manifest.patches[0].sha256 = sha256(extraPatch)
      }

      await assert.rejects(
        manage(value, 'apply'),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_ARTIFACT_INVALID',
      )
      assert.equal(await readFile(join(value.root, value.sourcePath), 'utf8'), value.beforeSource)
      assert.equal(
        await readFile(join(value.root, value.unrelatedPath), 'utf8'),
        'unrelated baseline\n',
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('the patch manager rejects partial, missing, unrelated, and reverse-drift states', async () => {
  for (const scenario of ['partial', 'missing', 'untracked', 'tracked', 'reverse-drift']) {
    const value = await fixture()
    try {
      if (scenario === 'partial') {
        await writeFile(join(value.root, value.sourcePath), value.afterSource)
      } else if (scenario === 'missing') {
        await rm(join(value.root, value.sourcePath))
      } else if (scenario === 'untracked') {
        await writeFile(join(value.root, 'UNTRACKED.md'), 'unrelated\n')
      } else if (scenario === 'tracked') {
        await writeFile(join(value.root, value.unrelatedPath), 'tracked drift\n')
      } else {
        await manage(value, 'apply')
        await writeFile(join(value.root, value.sourcePath), 'reverse drift\n')
      }

      await assert.rejects(
        manage(value, scenario === 'reverse-drift' ? 'reverse' : 'check'),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
        scenario,
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('the patch manager rejects index flags that can hide tracked worktree drift', async () => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    const value = await fixture()
    try {
      await run('/usr/bin/git', ['update-index', flag, '--', value.unrelatedPath], {
        cwd: value.root,
      })
      await writeFile(join(value.root, value.unrelatedPath), 'hidden tracked drift\n')

      await assert.rejects(
        manage(value, 'check'),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT'
          && error.diagnostic.flagged_count === 1,
        flag,
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('raw checkout attestation rejects clean-filter and fileMode status bypasses', async () => {
  for (const scenario of ['clean-filter', 'file-mode']) {
    const value = await fixture()
    try {
      if (scenario === 'clean-filter') {
        await writeFile(
          join(value.root, '.git', 'info', 'attributes'),
          `${value.unrelatedPath} filter=hide-drift\n`,
        )
        await run('/usr/bin/git', [
          'config', 'filter.hide-drift.clean',
          "sed 's/hidden tracked drift/unrelated baseline/'",
        ], { cwd: value.root })
        await writeFile(join(value.root, value.unrelatedPath), 'hidden tracked drift\n')
      } else {
        await run('/usr/bin/git', ['config', 'core.fileMode', 'false'], { cwd: value.root })
        await chmod(join(value.root, value.unrelatedPath), 0o755)
      }

      await assert.rejects(
        manage(value, 'check'),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT'
          && error.diagnostic.drift_count === 1,
        scenario,
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('raw checkout attestation rejects staged index drift and local exclude weakening', async () => {
  for (const scenario of ['staged-index', 'local-exclude']) {
    const value = await fixture()
    try {
      if (scenario === 'staged-index') {
        await writeFile(join(value.root, value.unrelatedPath), 'staged drift\n')
        await run('/usr/bin/git', ['add', '--', value.unrelatedPath], { cwd: value.root })
      } else {
        await writeFile(join(value.root, '.git', 'info', 'exclude'), 'private-*\n')
        await writeFile(join(value.root, 'private-hidden.txt'), 'untracked\n')
      }

      await assert.rejects(
        manage(value, 'check'),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
        scenario,
      )
    } finally {
      await rm(value.root, { recursive: true, force: true })
    }
  }
})

test('raw checkout attestation reads repository-local excludes from a linked worktree common dir', async () => {
  const value = await fixture()
  const linked = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-linked-worktree-'))
  await rm(linked, { recursive: true, force: true })
  try {
    await run('/usr/bin/git', ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], {
      cwd: value.root,
    })
    await writeFile(join(value.root, '.git', 'info', 'exclude'), 'private-*.txt\n')
    await writeFile(join(linked, 'private-hidden.txt'), 'untracked\n')

    await assert.rejects(
      manageDshPatch({
        action: 'check', sourceRoot: linked, patchRoot: value.root,
        manifest: value.manifest, gitBin: '/usr/bin/git',
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT'
        && error.diagnostic.local_exclude_count === 1,
    )
  } finally {
    await run('/usr/bin/git', ['worktree', 'remove', '--force', linked], { cwd: value.root })
      .catch(() => undefined)
    await rm(linked, { recursive: true, force: true })
    await rm(value.root, { recursive: true, force: true })
  }
})

test('raw checkout attestation reauthenticates exact patched target bytes after classification', async () => {
  const value = await fixture()
  const fakeRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-racing-git-'))
  try {
    await manage(value, 'apply')
    const fakeGit = join(fakeRoot, 'git-race-sentinel')
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'seen_ls_files=0',
      'for argument in "$@"; do',
      '  if [ "$argument" = "ls-files" ]; then seen_ls_files=1; fi',
      `  if [ "$seen_ls_files" = "1" ] && [ "$argument" = "-s" ]; then printf '%s\\n' 'raced target bytes' > '${join(value.root, value.sourcePath)}'; fi`,
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'))
    await chmod(fakeGit, 0o755)

    await assert.rejects(
      manageDshPatch({
        action: 'check', sourceRoot: value.root, patchRoot: value.root,
        manifest: value.manifest, gitBin: fakeGit,
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT'
        && error.diagnostic.drift_count === 1,
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
    await rm(fakeRoot, { recursive: true, force: true })
  }
})

test('patch apply consumes the authenticated artifact bytes instead of reopening its path', async () => {
  const value = await fixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-patch-artifact-'))
  const fakeRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-patch-swap-'))
  try {
    await mkdir(join(artifactRoot, 'patches'), { recursive: true })
    const artifact = join(artifactRoot, value.patchPath)
    await writeFile(artifact, value.patch)
    const malicious = [
      value.patch.trimEnd(),
      'diff --git a/ignored-payload.txt b/ignored-payload.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/ignored-payload.txt',
      '@@ -0,0 +1 @@',
      '+unauthenticated payload',
      '',
    ].join('\n')
    const maliciousPath = join(fakeRoot, 'malicious.patch')
    await writeFile(maliciousPath, malicious)
    const fakeGit = join(fakeRoot, 'git-artifact-swap')
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  if [ "$argument" = "apply" ]; then',
      `    /usr/bin/cp '${maliciousPath}' '${artifact}'`,
      '    break',
      '  fi',
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'))
    await chmod(fakeGit, 0o755)

    const receipt = await manageDshPatch({
      action: 'apply', sourceRoot: value.root, patchRoot: artifactRoot,
      manifest: value.manifest, gitBin: fakeGit,
    })

    assert.equal(receipt.after, 'patched')
    assert.equal(await readFile(artifact, 'utf8'), malicious)
    await assert.rejects(access(join(value.root, 'ignored-payload.txt')))
  } finally {
    await rm(value.root, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(fakeRoot, { recursive: true, force: true })
  }
})

test('an apply subprocess that closes stdin early returns a typed failure instead of crashing', async () => {
  const value = await fixture()
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-large-patch-'))
  const fakeRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-early-exit-git-'))
  try {
    // Exceed the pipe buffer so an immediate child exit reliably exercises the
    // stdin error path rather than letting end() enqueue the entire artifact.
    const largePatch = Buffer.concat([
      Buffer.from(value.patch),
      Buffer.from(`# authenticated-padding\n${'x'.repeat(8 * 1024 * 1024)}\n`),
    ])
    await mkdir(join(artifactRoot, 'patches'), { recursive: true })
    await writeFile(join(artifactRoot, value.patchPath), largePatch)
    value.manifest.patches[0].sha256 = sha256(largePatch)
    const fakeGit = join(fakeRoot, 'git-early-exit')
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  if [ "$argument" = "apply" ]; then exit 23; fi',
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'))
    await chmod(fakeGit, 0o755)

    await assert.rejects(
      manageDshPatch({
        action: 'apply', sourceRoot: value.root, patchRoot: artifactRoot,
        manifest: value.manifest, gitBin: fakeGit,
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_GIT_FAILED'
        && error.diagnostic.operation === 'apply-check'
        && error.diagnostic.exit_code === 23,
    )

    await writeFile(fakeGit, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  if [ "$argument" = "apply" ]; then exit 0; fi',
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'))
    await assert.rejects(
      manageDshPatch({
        action: 'apply', sourceRoot: value.root, patchRoot: artifactRoot,
        manifest: value.manifest, gitBin: fakeGit,
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_GIT_FAILED'
        && error.diagnostic.operation === 'apply-check'
        && error.diagnostic.exit_code === undefined,
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(fakeRoot, { recursive: true, force: true })
  }
})

test('patch diagnostics redact checkout paths, patch arguments, and untrusted filenames', async () => {
  const value = await fixture()
  const fakeRoot = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-fake-git-'))
  try {
    const sentinelName = 'private-customer-sentinel.txt'
    await writeFile(join(value.root, sentinelName), 'untracked\n')
    await assert.rejects(
      manage(value, 'check'),
      error => {
        assert.ok(error instanceof DshPatchError)
        const diagnostic = JSON.stringify(error.diagnostic)
        assert.doesNotMatch(diagnostic, new RegExp(value.root.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
        assert.doesNotMatch(diagnostic, new RegExp(sentinelName, 'u'))
        assert.equal(error.diagnostic.untracked_count, 1)
        return true
      },
    )

    await rm(join(value.root, sentinelName))
    const fakeGit = join(fakeRoot, 'git-failure-sentinel')
    await writeFile(fakeGit, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  if [ "$argument" = "apply" ]; then exit 9; fi',
      'done',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'))
    await chmod(fakeGit, 0o755)
    await assert.rejects(
      manageDshPatch({
        action: 'apply',
        sourceRoot: value.root,
        patchRoot: value.root,
        manifest: value.manifest,
        gitBin: fakeGit,
      }),
      error => {
        assert.ok(error instanceof DshPatchError)
        assert.equal(error.code, 'DSH_RUNTIME_KIT_DSH_PATCH_GIT_FAILED')
        assert.equal(error.diagnostic.operation, 'apply-check')
        assert.equal(error.diagnostic.exit_code, 9)
        const diagnostic = JSON.stringify(error.diagnostic)
        assert.doesNotMatch(diagnostic, new RegExp(value.root.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
        assert.doesNotMatch(diagnostic, /patches\/test\.patch/u)
        return true
      },
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
    await rm(fakeRoot, { recursive: true, force: true })
  }
})

test('the DSH patch lifecycle rejects content drift and unknown revisions', async () => {
  const value = await fixture()
  try {
    await writeFile(join(value.root, value.sourcePath), 'unreviewed drift\n')
    await assert.rejects(
      manageDshPatch({
        action: 'check', sourceRoot: value.root, patchRoot: value.root,
        manifest: value.manifest, gitBin: '/usr/bin/git',
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_DRIFT',
    )

    await writeFile(join(value.root, value.sourcePath), 'export const state = "before"\n')
    const unknown = structuredClone(value.manifest)
    unknown.patches[0].validated_releases['0.0.0-test'].revision = 'f'.repeat(40)
    await assert.rejects(
      manageDshPatch({
        action: 'check', sourceRoot: value.root, patchRoot: value.root,
        manifest: unknown, gitBin: '/usr/bin/git',
      }),
      error => error instanceof DshPatchError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_REVISION_UNSUPPORTED',
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('the patch entry records an optional authenticated upstream reference', async () => {
  const checked = JSON.parse(
    await readFile(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8'),
  )
  assert.deepEqual(checked.patches[0].upstream_reference, { state: 'not-reported' })
  assert.doesNotThrow(() => validateDshPatchManifest(checked))

  const value = await fixture()
  try {
    const patch = value.manifest.patches[0]
    assert.equal(patch.upstream_reference, undefined)
    assert.equal((await manage(value, 'apply')).after, 'patched')
    assert.equal((await manage(value, 'reverse')).after, 'pristine')

    patch.upstream_reference = {
      state: 'merged',
      url: 'https://github.com/example/upstream/pull/7',
      released_in: '0.2.0',
    }
    assert.doesNotThrow(() => validateDshPatchManifest(value.manifest))
    assert.equal((await manage(value, 'apply')).after, 'patched')
    assert.equal((await manage(value, 'reverse')).after, 'pristine')

    for (const reference of [
      { state: 'unknown-state', url: 'https://github.com/example/upstream/issues/1' },
      { state: 'reported' },
      { state: 'not-reported', url: 'https://github.com/example/upstream/issues/1' },
      { state: 'reported', url: 'http://github.com/example/upstream/issues/1' },
      { state: 'reported', url: 'https://token@github.com/example/upstream/issues/1' },
      { state: 'reported', url: 'https://github.com/example/upstream/issues/1', released_in: '0.2.0' },
      { state: 'reported', url: 'https://github.com/example/upstream/issues/1', note: 'extra' },
      { state: 'merged', url: 'https://github.com/example/upstream/pull/7', released_in: '' },
      { state: 'merged', url: 'https://github.com/example/upstream/pull/7', released_in: 7 },
      [{ state: 'not-reported' }],
      null,
    ]) {
      const invalid = structuredClone(value.manifest)
      invalid.patches[0].upstream_reference = reference
      assert.throws(
        () => validateDshPatchManifest(invalid),
        error => error instanceof DshPatchError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PATCH_MANIFEST_INVALID',
        JSON.stringify(reference),
      )
    }
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
