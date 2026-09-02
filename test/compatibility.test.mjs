import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import {
  DSH_RC7_OPTIONAL_RUNTIME_SURFACE,
  DSH_RC7_RUNTIME_SURFACE,
  DshCompatibilityError,
  assertDshRc7Runtime,
  inspectDshSource,
  loadDshRc7Runtime,
  validateDshCompatibilityManifest,
} from '../src/compat/contract.js'
import { evaluatePolicyPerformanceBudget } from '../src/compat/performance.js'
import { validateDshPatchManifest } from '../src/compat/dsh-patch.js'
import {
  extractPackageArtifact,
  inspectCanonicalPackageArtifact,
  prepareAuthenticatedPackageScope,
} from '../src/compat/package-artifact.js'
import {
  inspectExactDshCheckoutIdentity,
  inspectSelectedDshCheckoutIdentity,
} from '../src/compat/git-checkout.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(projectRoot, 'compatibility', 'dsh.json')
const run = promisify(execFile)

const sha256 = value => createHash('sha256').update(value).digest('hex')

function tarHeader(path, size) {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header[156] = '0'.charCodeAt(0)
  return header
}

function gzipTar(entries) {
  const parts = []
  for (const [path, bytes] of entries) {
    parts.push(tarHeader(path, bytes.length), bytes)
    const padding = (512 - (bytes.length % 512)) % 512
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function validRuntime() {
  return {
    on() {},
    effect() {},
    provide() {},
    get() {},
    plugin() {},
    invariants: { register() {} },
    llm: { guard() {} },
    agents: { list() { return [] }, get() {} },
    sessions: { get() {}, flush() {} },
    shell: { resolve() {} },
    shellEnv: { collect() {} },
    skills: { register() {} },
    subprocess: { resolveExecutable() {}, spawn() {}, spawnDescriptor() {} },
    tools: {
      bindPrerequisite() {},
      get() {},
      projectForPersistence() {},
      register() {},
      registerTerminalPolicy() {},
      guard() {},
    },
  }
}

test('DSH compatibility manifest enforces a rolling window of exactly three releases', () => {
  const manifest = validateDshCompatibilityManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  )
  assert.equal(manifest.schema_version, 'dsh-runtime-kit.dsh-compatibility.v1')
  assert.equal(manifest.repository, 'https://github.com/deepseek-ai/deepseek-harness')
  assert.deepEqual(Object.keys(manifest.channels).sort(), ['pinned', 'upstream-next'])
  assert.deepEqual(manifest.support_policy, {
    kind: 'rolling-latest-releases',
    maximum_releases: 3,
    promotion: 'add newest release and retire the oldest release in the same change',
  })
  assert.equal(manifest.channels.pinned.version, '0.1.2-alpha.4')
  assert.equal(manifest.channels.pinned.ref, 'refs/tags/dsh-v0.1.2-alpha.4')
  assert.match(manifest.channels.pinned.revision, /^[0-9a-f]{40}$/)
  assert.equal(manifest.channels['upstream-next'].ref, 'refs/heads/master')
  assert.match(manifest.channels['upstream-next'].revision, /^[0-9a-f]{40}$/)
  assert.deepEqual(manifest.validated_releases, {
    '0.1.0-rc.8': {
      ref: 'refs/tags/dsh-v0.1.0-rc.8',
      revision: '141eb6fef83422698aef7a981029e843e8161534',
      cordis: '4.0.1',
    },
    '0.1.1-rc.2': {
      ref: 'refs/tags/dsh-v0.1.1-rc.2',
      revision: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
      cordis: '4.0.1',
    },
    '0.1.2-alpha.4': {
      ref: 'refs/tags/dsh-v0.1.2-alpha.4',
      revision: '4e84901e6471b79ec0338099867ebb4606d12bb5',
      cordis: '4.0.2',
    },
  })
  const patchManifest = validateDshPatchManifest(
    JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'dsh-patches.json'), 'utf8')),
  )
  assert.deepEqual(
    patchManifest.patches[0].validated_releases,
    Object.fromEntries(Object.entries(manifest.validated_releases)
      .map(([version, release]) => [version, { revision: release.revision }])),
  )
  assert.equal(
    manifest.performance.pre_tool.iterations * manifest.performance.pre_tool.batches >= 2_000,
    true,
  )
  assert.equal(manifest.performance.pre_tool.p95_ms > 0, true)
  assert.equal(manifest.performance.pre_tool.retained_heap_bytes > 0, true)
  assert.equal(manifest.performance.pre_tool_subprocess.warmup_iterations > 0, true)
  assert.equal(manifest.performance.pre_tool_subprocess.iterations >= 20, true)
  assert.equal(manifest.performance.pre_tool_subprocess.p95_ms > 0, true)
  assert.equal(manifest.performance.pre_tool_subprocess.max_active_after, 0)
  assert.equal(manifest.performance.pre_tool_subprocess.max_live_children_after, 0)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.warmup_iterations > 0, true)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.iterations >= 20, true)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.subprocesses_per_iteration, 5)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.p95_ms > 0, true)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.max_active_after, 0)
  assert.equal(manifest.performance.tool_lifecycle_subprocess.max_live_children_after, 0)
  assert.deepEqual(manifest.runtime_surface, DSH_RC7_RUNTIME_SURFACE)
  assert.deepEqual(manifest.optional_runtime_surface, DSH_RC7_OPTIONAL_RUNTIME_SURFACE)

  const packageManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  assert.deepEqual(
    packageManifest.peerDependencies,
    Object.fromEntries(Object.entries(manifest.public_packages)
      .map(([name, contract]) => [name, contract.peer])),
  )
  for (const [name, contract] of Object.entries(manifest.public_packages)) {
    assert.equal(packageManifest.peerDependencies[name], contract.peer)
    assert.equal(contract.peer, name === '@deepseek-ai/cordis'
      ? '4.0.1 || 4.0.2'
      : '0.1.0-rc.8 || 0.1.1-rc.2 || 0.1.2-alpha.4')
  }

  const expandedWindow = structuredClone(manifest)
  expandedWindow.support_policy.maximum_releases = 4
  assert.throws(
    () => validateDshCompatibilityManifest(expandedWindow),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const exportDrift = structuredClone(manifest)
  exportDrift.public_packages['@deepseek-ai/dsh-llm'].exports.createUserMessage = 'object'
  assert.throws(
    () => validateDshCompatibilityManifest(exportDrift),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const oneBatch = structuredClone(manifest)
  oneBatch.performance.pre_tool.batches = 1
  oneBatch.performance.pre_tool.iterations = 2_000
  assert.throws(
    () => validateDshCompatibilityManifest(oneBatch),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const missingRealSubprocess = structuredClone(manifest)
  delete missingRealSubprocess.performance.pre_tool_subprocess
  assert.throws(
    () => validateDshCompatibilityManifest(missingRealSubprocess),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const insufficientRealSamples = structuredClone(manifest)
  insufficientRealSamples.performance.pre_tool_subprocess.iterations = 19
  assert.throws(
    () => validateDshCompatibilityManifest(insufficientRealSamples),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const missingLifecycleSubprocess = structuredClone(manifest)
  delete missingLifecycleSubprocess.performance.tool_lifecycle_subprocess
  assert.throws(
    () => validateDshCompatibilityManifest(missingLifecycleSubprocess),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )

  const incompleteLifecycle = structuredClone(manifest)
  incompleteLifecycle.performance.tool_lifecycle_subprocess.subprocesses_per_iteration = 4
  assert.throws(
    () => validateDshCompatibilityManifest(incompleteLifecycle),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
  )
})

test('selected DSH non-workspace runtime dependencies are exact and lockfile-bound', () => {
  const expected = {
    '@standard-schema/spec': '1.1.0',
    chokidar: '5.0.0',
    'js-yaml': '4.1.0',
    yaml: '2.9.0',
    zod: '4.4.3',
  }
  const packageManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'))
  assert.deepEqual(packageManifest.dependencies, expected)
  assert.deepEqual(packageLock.packages[''].dependencies, expected)
  for (const [name, version] of Object.entries(expected)) {
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version)
  }
})

test('peer staging rejects symlinked install ancestors without touching external files', async () => {
  for (const symlinkedComponent of ['node_modules', '@deepseek-ai']) {
    const consumerRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-consumer-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-external-'))
    try {
      const marker = join(externalRoot, 'must-remain.txt')
      await writeFile(marker, 'preserved\n')
      if (symlinkedComponent === 'node_modules') {
        await symlink(externalRoot, join(consumerRoot, 'node_modules'), 'dir')
      } else {
        const nodeModules = join(consumerRoot, 'node_modules')
        await mkdir(nodeModules)
        await symlink(externalRoot, join(nodeModules, '@deepseek-ai'), 'dir')
      }

      await assert.rejects(
        prepareAuthenticatedPackageScope(consumerRoot, '@deepseek-ai'),
        error => error instanceof DshCompatibilityError
          && error.code === 'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
      )
      assert.equal(readFileSync(marker, 'utf8'), 'preserved\n')
    } finally {
      await rm(consumerRoot, { recursive: true, force: true })
      await rm(externalRoot, { recursive: true, force: true })
    }
  }
})

test('peer staging stays descriptor-anchored across an install-scope swap', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-consumer-'))
  const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-external-'))
  let installScope
  try {
    const scopeRoot = join(consumerRoot, 'node_modules', '@deepseek-ai')
    const originalTarget = join(scopeRoot, 'example')
    const externalTarget = join(externalRoot, 'example')
    await mkdir(originalTarget, { recursive: true })
    await mkdir(externalTarget)
    await writeFile(join(originalTarget, 'old.txt'), 'old\n')
    await writeFile(join(externalTarget, 'must-remain.txt'), 'preserved\n')

    installScope = await prepareAuthenticatedPackageScope(consumerRoot, '@deepseek-ai')
    const anchoredTarget = installScope.resolveTarget('example')
    const displacedScope = join(consumerRoot, 'displaced-scope')
    await rename(scopeRoot, displacedScope)
    await symlink(externalRoot, scopeRoot, 'dir')

    await rm(anchoredTarget, { recursive: true })
    const stagedTarget = join(consumerRoot, 'staged-example')
    await mkdir(stagedTarget)
    await writeFile(join(stagedTarget, 'new.txt'), 'new\n')
    await rename(stagedTarget, anchoredTarget)

    assert.equal(readFileSync(join(externalTarget, 'must-remain.txt'), 'utf8'), 'preserved\n')
    assert.equal(readFileSync(join(displacedScope, 'example', 'new.txt'), 'utf8'), 'new\n')
  } finally {
    if (typeof installScope?.close === 'function') await installScope.close()
    await rm(consumerRoot, { recursive: true, force: true })
    await rm(externalRoot, { recursive: true, force: true })
  }
})

test('peer staging eliminates the replaceable staging tree', () => {
  const source = readFileSync(
    join(projectRoot, 'scripts', 'stage-dsh-compatibility-peers.mjs'),
    'utf8',
  )
  assert.doesNotMatch(source, /\bmkdtemp\b/u)
  assert.doesNotMatch(source, /\brename\(/u)
  assert.doesNotMatch(source, /\brm\(/u)
  assert.doesNotMatch(source, /staged\.push\([^)]*\bbytes\b/su)
  assert.match(source, /extractPackageArtifact\(bytes, target\)/u)
})

test('authenticated extraction never follows a swapped package root', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-consumer-'))
  const packageRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-package-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-tarball-'))
  let installScope
  try {
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/example',
      version: '1.0.0',
    })}\n`)
    await mkdir(join(packageRoot, 'lib'))
    await writeFile(join(packageRoot, 'lib', 'index.js'), 'export const value = 1\n')
    const packed = JSON.parse((await run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', artifactRoot,
    ], { cwd: packageRoot, encoding: 'utf8' })).stdout)
    const tarball = readFileSync(join(artifactRoot, packed[0].filename))

    installScope = await prepareAuthenticatedPackageScope(consumerRoot, '@deepseek-ai')
    const anchoredTarget = installScope.resolveTarget('example')
    const visibleTarget = join(consumerRoot, 'node_modules', '@deepseek-ai', 'example')
    const displacedTarget = join(consumerRoot, 'displaced-package')
    await assert.rejects(
      extractPackageArtifact(tarball, anchoredTarget, {
        afterTargetOpened: async () => {
          await rename(visibleTarget, displacedTarget)
          await mkdir(visibleTarget)
          await writeFile(join(visibleTarget, 'must-remain.txt'), 'preserved\n')
        },
      }),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
    )

    assert.equal(readFileSync(join(visibleTarget, 'must-remain.txt'), 'utf8'), 'preserved\n')
    assert.deepEqual(await readdir(visibleTarget), ['must-remain.txt'])
    assert.equal(
      readFileSync(join(displacedTarget, 'lib', 'index.js'), 'utf8'),
      'export const value = 1\n',
    )
  } finally {
    if (typeof installScope?.close === 'function') await installScope.close()
    await rm(consumerRoot, { recursive: true, force: true })
    await rm(packageRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('runtime public-surface preflight returns a typed report or one typed incompatibility', () => {
  assert.deepEqual(assertDshRc7Runtime(validRuntime()), {
    schema_version: 'dsh-runtime-kit.dsh-runtime-report.v1',
    adapter: 'dsh-rolling-v1',
    compatible: true,
  })

  const incompatible = validRuntime()
  delete incompatible.tools.bindPrerequisite
  assert.throws(
    () => assertDshRc7Runtime(incompatible),
    error => {
      assert.equal(error instanceof DshCompatibilityError, true)
      assert.equal(error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
      assert.deepEqual(error.diagnostic.missing, ['tools.bindPrerequisite'])
      assert.equal(error.diagnostic.compatible, false)
      return true
    },
  )

  const missingToolLookup = validRuntime()
  delete missingToolLookup.tools.get
  assert.throws(
    () => assertDshRc7Runtime(missingToolLookup),
    error => {
      assert.equal(error instanceof DshCompatibilityError, true)
      assert.equal(error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
      assert.deepEqual(error.diagnostic.missing, ['tools.get'])
      assert.equal(error.diagnostic.compatible, false)
      return true
    },
  )

  const missingDescriptorSpawn = validRuntime()
  delete missingDescriptorSpawn.subprocess.spawnDescriptor
  assert.throws(
    () => assertDshRc7Runtime(missingDescriptorSpawn),
    error => {
      assert.equal(error instanceof DshCompatibilityError, true)
      assert.equal(error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
      assert.deepEqual(error.diagnostic.missing, ['subprocess.spawnDescriptor'])
      return true
    },
  )

  const missingPlugin = validRuntime()
  delete missingPlugin.plugin
  assert.throws(
    () => assertDshRc7Runtime(missingPlugin),
    error => {
      assert.equal(error instanceof DshCompatibilityError, true)
      assert.equal(error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
      assert.deepEqual(error.diagnostic.missing, ['plugin'])
      return true
    },
  )

  const missingSessionLookup = validRuntime()
  delete missingSessionLookup.sessions.get
  assert.throws(
    () => assertDshRc7Runtime(missingSessionLookup),
    error => {
      assert.equal(error instanceof DshCompatibilityError, true)
      assert.equal(error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
      assert.deepEqual(error.diagnostic.missing, ['sessions.get'])
      return true
    },
  )
})

test('DSH core runtime preflight does not require optional subagent services', () => {
  assert.deepEqual(DSH_RC7_OPTIONAL_RUNTIME_SURFACE, [
    'subagents.start',
    'subagents.getProvider',
    'subagents.configureRoleCapacity',
    'subagents.registerRole',
    'subagents.startRole',
    'subagents.roleOf',
    'subagents.roleStats',
  ])
  assert.equal(DSH_RC7_RUNTIME_SURFACE.some(path => path.startsWith('subagents.')), false)
  assert.equal(assertDshRc7Runtime(validRuntime()).compatible, true)
})

test('package artifact parsing rejects expansion bombs, oversized entries, and entry floods', () => {
  const oneMiB = gzipSync(Buffer.alloc(1024 * 1024))
  const expansionBomb = Buffer.concat(Array.from({ length: 257 }, () => oneMiB))
  assert.throws(
    () => inspectCanonicalPackageArtifact(expansionBomb),
    /artifact.*limit|bounded artifact/i,
  )

  const oversized = gzipSync(Buffer.concat([
    tarHeader('package/huge.bin', 64 * 1024 * 1024 + 1),
    Buffer.alloc(1024),
  ]))
  assert.throws(
    () => inspectCanonicalPackageArtifact(oversized),
    /artifact.*limit|bounded artifact/i,
  )

  const entries = Array.from(
    { length: 16_385 },
    (_, index) => [`package/f-${index}`, Buffer.alloc(0)],
  )
  assert.throws(
    () => inspectCanonicalPackageArtifact(gzipTar(entries)),
    /artifact.*limit|bounded artifact/i,
  )
})

test('runtime values are version-bound and missing or wrong-kind exports stay typed', async () => {
  const modules = {
    '@deepseek-ai/dsh-bash-local': { ENV_OVERRIDES: {} },
    '@deepseek-ai/dsh-llm': { HarnessError: class extends Error {}, createUserMessage() {} },
    '@deepseek-ai/dsh-sandbox': {
      approveEscalation() {},
      canonicalPath() {},
      isNonWideningSandboxEcho() {},
      validateEscalationArgs() {},
    },
    '@deepseek-ai/dsh-skill-filesystem': { apply() {} },
    '@deepseek-ai/dsh-tools': { TOOL_ABORTED: 'ABORTED' },
  }
  const options = overrides => ({
    importModule: async specifier => overrides?.[specifier] ?? modules[specifier],
    packageVersion: async specifier => specifier === '@deepseek-ai/cordis'
      ? '4.0.2'
      : '0.1.2-alpha.4',
  })
  const loaded = await loadDshRc7Runtime(options())
  assert.equal(typeof loaded.createUserMessage, 'function')
  assert.equal(typeof loaded.isNonWideningSandboxEcho, 'function')
  assert.equal(loaded.TOOL_ABORTED, 'ABORTED')

  const rc8 = await loadDshRc7Runtime({
    ...options(),
    packageVersion: async specifier => specifier === '@deepseek-ai/cordis'
      ? '4.0.1'
      : '0.1.0-rc.8',
  })
  assert.deepEqual(new Set(Object.values(rc8.versions)), new Set(['0.1.0-rc.8', '4.0.1']))

  const rc2 = await loadDshRc7Runtime({
    ...options(),
    packageVersion: async specifier => specifier === '@deepseek-ai/cordis'
      ? '4.0.1'
      : '0.1.1-rc.2',
  })
  assert.deepEqual(new Set(Object.values(rc2.versions)), new Set(['0.1.1-rc.2', '4.0.1']))

  const alpha4 = await loadDshRc7Runtime(options())
  assert.deepEqual(new Set(Object.values(alpha4.versions)), new Set(['0.1.2-alpha.4', '4.0.2']))

  for (const [dshVersion, cordisVersion, expectedCordisVersion] of [
    ['0.1.0-rc.8', '4.0.2', '4.0.1'],
    ['0.1.1-rc.2', '4.0.2', '4.0.1'],
    ['0.1.2-alpha.4', '4.0.1', '4.0.2'],
  ]) {
    let invalidCompositionImports = 0
    await assert.rejects(
      loadDshRc7Runtime({
        importModule: async specifier => {
          invalidCompositionImports += 1
          return modules[specifier]
        },
        packageVersion: async specifier => specifier === '@deepseek-ai/cordis'
          ? cordisVersion
          : dshVersion,
      }),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH'
        && error.diagnostic.missing.includes(
          `@deepseek-ai/cordis:version:${expectedCordisVersion}`,
        ),
    )
    assert.equal(invalidCompositionImports, 0)
  }

  await assert.rejects(
    loadDshRc7Runtime(options({
      '@deepseek-ai/dsh-llm': { HarnessError: class extends Error {}, createUserMessage: undefined },
    })),
    error => error instanceof DshCompatibilityError
      && error.code === 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH'
      && error.diagnostic.missing.includes('@deepseek-ai/dsh-llm:createUserMessage:function'),
  )
  await assert.rejects(
    loadDshRc7Runtime({
      ...options(),
      packageVersion: async specifier => specifier === '@deepseek-ai/dsh-tools'
        ? '0.1.0-rc.8'
        : specifier === '@deepseek-ai/cordis'
          ? '4.0.2'
          : '0.1.2-alpha.4',
    }),
    error => error instanceof DshCompatibilityError
      && assert.deepEqual(error.diagnostic, {
        adapter: 'dsh-rolling-v1',
        schema_version: 'dsh-runtime-kit.dsh-compatibility-diagnostic.v1',
        compatible: false,
        code: 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
        missing: ['@deepseek-ai/dsh-tools:version:0.1.2-alpha.4'],
      }) === undefined,
  )

  let importCalls = 0
  await assert.rejects(
    loadDshRc7Runtime({
      importModule: async specifier => {
        importCalls += 1
        return modules[specifier]
      },
      packageVersion: async specifier => specifier === '@deepseek-ai/dsh-subprocess'
        ? '0.1.0-rc.8'
        : specifier === '@deepseek-ai/cordis'
          ? '4.0.2'
          : '0.1.2-alpha.4',
    }),
    error => error instanceof DshCompatibilityError
      && error.diagnostic.adapter === 'dsh-rolling-v1'
      && error.diagnostic.missing.includes(
        '@deepseek-ai/dsh-subprocess:version:0.1.2-alpha.4',
      ),
  )
  assert.equal(importCalls, 0)

  const installed = await loadDshRc7Runtime()
  const installedVersions = new Set(Object.values(installed.versions))
  assert.equal(installedVersions.has('4.0.1') || installedVersions.has('4.0.2'), true)
  assert.equal(installedVersions.size, 2)
  assert.equal(
    ['0.1.0-rc.8', '0.1.1-rc.2', '0.1.2-alpha.4']
      .some(version => installedVersions.has(version)),
    true,
  )
})

test('source inspection validates package versions and required public runtime exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-compat-source-'))
  const external = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-compat-external-'))
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.channels.pinned.revision = '0'.repeat(40)
    manifest.channels['upstream-next'].revision = '1'.repeat(40)
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-root',
      version: manifest.channels.pinned.version,
    })}\n`)
    for (const [name, contract] of Object.entries(manifest.public_packages)) {
      const packageRoot = join(root, contract.path)
      await mkdir(join(packageRoot, 'lib'), { recursive: true })
      const version = contract.version ?? manifest.channels.pinned.version
      await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
        name,
        version,
        type: 'module',
        exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
      })}\n`)
      const entrypoint = `export const identity = ${JSON.stringify(name)}\n`
      const types = 'export declare const identity: string\n'
      await writeFile(join(packageRoot, 'lib', 'index.js'), entrypoint)
      await writeFile(join(packageRoot, 'lib', 'index.d.ts'), types)
      contract.entrypoint_sha256 = sha256(entrypoint)
      contract.types_sha256 = sha256(types)
    }

    const report = await inspectDshSource({
      sourceRoot: root,
      channel: 'pinned',
      revision: '0'.repeat(40),
      clean: true,
      manifest,
    })
    assert.equal(report.compatible, true)
    assert.equal(report.packages.length, Object.keys(manifest.public_packages).length)
    assert.equal('exports' in report.packages[0], false)
    assert.equal('expected_exports' in report.packages[0], true)

    const targetName = '@deepseek-ai/dsh-llm'
    const target = manifest.public_packages[targetName]
    const packageRoot = join(root, target.path)
    await writeFile(join(packageRoot, 'lib', 'index.js'), 'export const changed = true\n')
    await assert.rejects(
      inspectDshSource({
        sourceRoot: root,
        channel: 'pinned',
        revision: '0'.repeat(40),
        clean: true,
        manifest,
      }),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH'
        && error.diagnostic.missing.includes(`${targetName}:built-entrypoint-digest`),
    )

    await writeFile(join(external, 'package.json'), `${JSON.stringify({
      name: targetName,
      version: manifest.channels.pinned.version,
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    })}\n`)
    await writeFile(join(external, 'index.js'), 'export const identity = "external"\n')
    await writeFile(join(external, 'index.d.ts'), 'export declare const identity: string\n')
    await rm(packageRoot, { recursive: true, force: true })
    await symlink(external, packageRoot, 'dir')
    await assert.rejects(
      inspectDshSource({
        sourceRoot: root,
        channel: 'pinned',
        revision: '0'.repeat(40),
        clean: true,
        manifest,
      }),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('selected source-only checkout can be authenticated before its build artifacts exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-source-only-'))
  try {
    await run('/usr/bin/git', ['init', '--quiet', root])
    await writeFile(join(root, 'README.md'), 'source-only fixture\n')
    await run('/usr/bin/git', ['-C', root, 'add', 'README.md'])
    await run('/usr/bin/git', [
      '-c', 'user.name=Acceptance Fixture',
      '-c', 'user.email=acceptance@example.invalid',
      '-C', root,
      'commit', '--quiet', '-m', 'test: source-only fixture',
    ])
    const { stdout } = await run('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    })
    const revision = stdout.trim()
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.channels.pinned.revision = revision

    const report = await inspectSelectedDshCheckoutIdentity({
      sourceRoot: root,
      channel: 'pinned',
      gitBin: '/usr/bin/git',
      manifest,
    })
    assert.equal(report.channel, 'pinned')
    assert.equal(report.revision, revision)
    assert.equal(report.upstream_checkout_clean, true)
    assert.equal('packages' in report, false)

    await writeFile(join(root, 'untracked.txt'), 'must reject\n')
    await assert.rejects(
      inspectSelectedDshCheckoutIdentity({
        sourceRoot: root,
        channel: 'pinned',
        gitBin: '/usr/bin/git',
        manifest,
      }),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('exact release checkout identity rejects tracked and untracked drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-exact-release-'))
  try {
    await run('/usr/bin/git', ['init', '--quiet', root])
    const readme = join(root, 'README.md')
    await writeFile(readme, 'exact release fixture\n')
    await run('/usr/bin/git', ['-C', root, 'add', 'README.md'])
    await run('/usr/bin/git', [
      '-c', 'user.name=Acceptance Fixture',
      '-c', 'user.email=acceptance@example.invalid',
      '-C', root,
      'commit', '--quiet', '-m', 'test: exact release fixture',
    ])
    const { stdout } = await run('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    })
    const expectedRevision = stdout.trim()
    const inspect = () => inspectExactDshCheckoutIdentity({
      sourceRoot: root,
      expectedRevision,
      gitBin: '/usr/bin/git',
    })

    assert.equal((await inspect()).upstream_checkout_clean, true)
    await writeFile(readme, 'tracked drift\n')
    await assert.rejects(
      inspect(),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
    )
    await run('/usr/bin/git', ['-C', root, 'restore', 'README.md'])
    await writeFile(join(root, 'untracked.txt'), 'untracked drift\n')
    await assert.rejects(
      inspect(),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_DIRTY_UPSTREAM',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('performance promotion fails closed on p95, retained heap, or active resources', () => {
  const budget = {
    p95_ms: 5,
    retained_heap_bytes: 1_000,
    retained_growth_bytes: 100,
    max_active_after: 0,
  }
  assert.deepEqual(
    evaluatePolicyPerformanceBudget({
      samplesMs: [1, 2, 2, 3, 4],
      retainedHeapBytes: 512,
      activeAfter: 0,
      liveHandlesAfter: 0,
    }, budget),
    {
      schema_version: 'dsh-runtime-kit.policy-performance.v1',
      status: 'pass',
      samples: 5,
      p95_ms: 4,
      retained_heap_bytes: 512,
      active_after: 0,
      live_handles_after: 0,
      budget,
    },
  )
  for (const measurement of [
    { samplesMs: [1, 6], retainedHeapBytes: 0, activeAfter: 0, liveHandlesAfter: 0 },
    { samplesMs: [1], retainedHeapBytes: 1_001, activeAfter: 0, liveHandlesAfter: 0 },
    {
      samplesMs: [1],
      retainedHeapBytes: 1,
      retainedGrowthBytes: 101,
      activeAfter: 0,
      liveHandlesAfter: 0,
    },
    { samplesMs: [1], retainedHeapBytes: 0, activeAfter: 1, liveHandlesAfter: 0 },
    { samplesMs: [1], retainedHeapBytes: 0, activeAfter: 0, liveHandlesAfter: 1 },
  ]) {
    assert.throws(
      () => evaluatePolicyPerformanceBudget(measurement, budget),
      error => error instanceof DshCompatibilityError
        && error.code === 'DSH_RUNTIME_KIT_PERFORMANCE_BUDGET_EXCEEDED',
    )
  }
})

test('compatibility workflow keeps selected channels and every patch release blocking', () => {
  const workflow = readFileSync(join(projectRoot, '.github', 'workflows', 'compatibility.yml'), 'utf8')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const nils = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))
  assert.match(workflow, /channel: pinned/)
  assert.match(workflow, /channel: upstream-next/)
  assert.match(workflow, new RegExp(manifest.channels.pinned.revision))
  assert.match(workflow, new RegExp(manifest.channels['upstream-next'].revision))
  for (const release of Object.values(manifest.validated_releases)) {
    assert.match(workflow, new RegExp(release.revision))
  }
  assert.match(workflow, /public_contract: false/)
  assert.match(workflow, /if: matrix\.public_contract/)
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/)
  assert.match(workflow, /node: \[24\]/)
  assert.equal(workflow.match(/node: 24/g)?.length, 4)
  assert.doesNotMatch(workflow, /node(?:-version)?: (?:\[)?22/)
  assert.doesNotMatch(workflow, /22\.19\.0/)
  assert.match(workflow, /Rebuild and authenticate unpatched DSH runtime/)
  assert.equal(workflow.match(/Rebuild and authenticate unpatched DSH runtime/g)?.length, 2)
  assert.doesNotMatch(workflow, /Run released native full-host authority smoke/)
  assert.match(
    workflow,
    /Run packed runtime smoke on the patched DSH boundary[\s\S]+DSH_RUNTIME_KIT_SMOKE_FULL_HOST: \$\{\{ matrix\.channel == 'pinned' && '1' \|\| '0' \}\}/,
  )
  assert.match(
    workflow,
    /Run packed runtime smoke on the patched DSH boundary[\s\S]+DSH_RUNTIME_KIT_SMOKE_ACCEPTANCE: \$\{\{ matrix\.channel == 'pinned' && '1' \|\| '0' \}\}/,
  )
  assert.equal(workflow.match(/Run unpatched DSH tools smoke/g)?.length, 2)
  assert.equal(workflow.match(/pnpm run build:lib:host/g)?.length, 6)
  assert.equal(workflow.match(/pnpm run clean\n\s+pnpm run build:lib:host/g)?.length, 4)
  assert.doesNotMatch(workflow, /pnpm run build:lib\n/)
  assert.match(workflow, /digest-dsh-build-closure\.mjs/)
  assert.equal(workflow.match(/pristine-dsh-build-closure\.json/g)?.length, 4)
  assert.equal(workflow.match(/restored-dsh-build-closure\.json/g)?.length, 4)
  assert.doesNotMatch(workflow, /pristine-(?:tools|llm)-build\.sha256/)
  assert.match(workflow, /macos-runtime-health:/)
  assert.match(workflow, /runs-on: macos-15/)
  assert.match(workflow, /nils-cli-v1\.27\.34-x86_64-unknown-linux-gnu\.tar\.gz/)
  assert.match(workflow, /a9c4a88038d66d538605fd1ded630fca342e1025372f24896254f4e34e5916a8/)
  assert.match(workflow, /nils-cli-v1\.27\.34-aarch64-apple-darwin\.tar\.gz/)
  assert.match(workflow, /9abc71134df9bdb04ff0a8d718fe91ad2e034c6f74b47c5af8d23a94735964e2/)
  assert.match(workflow, /DSH_ACCEPTANCE_CANDIDATE_NILS_SOURCE_COMMIT=5e8564357f6deb524e36d1a0cbdcf124f034c3f2/)
  assert.match(workflow, /DSH_ACCEPTANCE_BASELINE_NILS_SOURCE_COMMIT=e6f50a34d68e7a6638eb104e423dcacd116c4071/)
  assert.match(workflow, /nils-cli-v1\.27\.29-x86_64-unknown-linux-gnu\.tar\.gz/)
  assert.match(workflow, /4a169d28032ace8e6d696c9385e3096dbea6e5e1ea17c492b9b0f4094f8b5f21/)
  assert.match(workflow, /nils-cli-v1\.27\.29-aarch64-apple-darwin\.tar\.gz/)
  assert.match(workflow, /5d65f5f7982910d7aa69466e054b9a05cf4453d6ce7aa26df47ad1643bdff5cf/)
  assert.match(workflow, /node --test test\/runtime-health-provider\.test\.mjs/)
  const macosJob = workflow.slice(workflow.indexOf('  macos-runtime-health:'))
  assert.match(macosJob, /node-version: 24/)
  assert.match(
    macosJob,
    new RegExp(`repository: deepseek-ai/deepseek-harness\\n\\s+ref: ${manifest.channels.pinned.revision}`),
  )
  assert.match(
    macosJob,
    new RegExp(`DSH_ACCEPTANCE_DSH_VERSION=${manifest.channels.pinned.version}`),
  )
  assert.match(
    macosJob,
    new RegExp(`DSH_ACCEPTANCE_DSH_REVISION=${manifest.channels.pinned.revision}`),
  )
  assert.match(macosJob, /deepseek-harness\/vendor\/cordis/)
  assert.match(macosJob, /ln -s "\$GITHUB_WORKSPACE\/deepseek-harness\/vendor\/cordis"/)
  assert.doesNotMatch(macosJob, /npm install --no-save[\s\S]{0,200}deepseek-harness\/vendor\/cordis/)
  assert.match(macosJob, /node --test test\/runtime-health-provider\.test\.mjs/)
  assert.match(macosJob, /DSH_RUNTIME_KIT_SMOKE_HEALTH_ONLY: '1'/)
  assert.match(macosJob, /Run packed runtime-health smoke on macOS/)
  assert.doesNotMatch(
    workflow.slice(0, workflow.indexOf('  macos-runtime-health:')),
    /DSH_RUNTIME_KIT_SMOKE_HEALTH_ONLY/,
  )
  assert.match(macosJob, /pnpm dsh --help >\/dev\/null/)
  assert.match(workflow, /npm run --silent check:compatibility/)
  assert.match(workflow, /npm run --silent pack:compatibility-peers/)
  assert.match(workflow, /--channel "\$\{\{ matrix\.channel \}\}"/)
  assert.match(workflow, /--pnpm-bin "\$\(command -v pnpm\)"/)
  assert.match(workflow, /--receipt "\$RUNNER_TEMP\/dsh-peer-pack\.json"/)
  assert.match(workflow, /npm run --silent stage:compatibility-peers/)
  assert.match(workflow, /--action apply/)
  assert.equal(workflow.match(/packages\/core\/tools\/tests\/tools\.spec\.ts/g)?.length, 2)
  assert.match(workflow, /packages\/llm\/llm\/tests\/service\.spec\.ts/)
  assert.equal(
    workflow.match(/packages\/subprocess\/subprocess-local\/tests\/spawn\.spec\.ts/g)?.length,
    2,
  )
  assert.match(
    workflow,
    /Validate patched DSH execution boundary[\s\S]{0,800}pnpm run build:lib:host/,
  )
  assert.match(
    macosJob,
    /Validate Darwin descriptor binding and patched DSH boundary[\s\S]{0,800}pnpm run build:lib:host/,
  )
  assert.match(workflow, /npm run test:smoke/)
  assert.match(workflow, /--action reverse/)
  assert.match(workflow, /npm ci --ignore-scripts --omit=peer/)
  assert.doesNotMatch(workflow, /compatibility-peers\/\*\.tgz/)
  assert.doesNotMatch(workflow, /npm install --offline/)
  assert.match(workflow, /npm run typecheck && npm test/)
  assert.match(workflow, /npm run benchmark:policy/)
  assert.match(workflow, /npm run benchmark:policy:real/)
  assert.match(workflow, /--property=PrivateUsers=yes/)
  assert.match(workflow, /bin\/agent-scope-lock/)
  assert.match(workflow, /compatibility-private-users-git/)
  assert.match(workflow, new RegExp(nils.release.archive.name))
  assert.match(workflow, new RegExp(nils.release.archive.sha256))
  for (const release of Object.values(nils.release.platforms)) {
    assert.match(workflow, new RegExp(release.archive.name))
    assert.match(workflow, new RegExp(release.archive.sha256))
  }
  assert.match(workflow, /AGENT_HOOK_BIN/)
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/)
  assert.equal(
    workflow.match(/fetch-depth: 0/g)?.length,
    3,
    'every dsh-runtime-kit checkout must retain parity evidence history',
  )

  const runtimeSmoke = readFileSync(join(projectRoot, 'test', 'smoke.mjs'), 'utf8')
  assert.match(runtimeSmoke, /DSH_RUNTIME_KIT_SMOKE_FULL_HOST/)
  assert.match(runtimeSmoke, /nativeFullHostAuthorityVerified/)
  assert.match(
    runtimeSmoke,
    /const dataPolicyCandidateEnabled = nilsCandidateFeature !== undefined\s+&& nilsCandidateFeature === nilsCompatibility\.candidate_validation\?\.feature/u,
    'the packed smoke must bind candidate-only data-policy coverage to the reviewed feature',
  )
  assert.match(
    runtimeSmoke,
    /if \(dataPolicyCandidateEnabled\) \{\s+resetCheckoutLease\(\)\s+const dataPolicyBoot/u,
    'released nils-cli smoke must not execute the candidate-only data-policy scenario',
  )
  assert.match(
    runtimeSmoke,
    /\.\.\.\(dataPolicyCandidateEnabled\s+\? \[\{\s+id: 'data-policy'/u,
    'only candidate acceptance may report candidate-only data-policy evidence',
  )
  assert.match(
    runtimeSmoke,
    /const attempt = nativeStoreAttempt\(closeoutArgs\)[\s\S]+attempt\.envelope\.error\?\.code, 'coordination-unauthorized'/u,
    'forced-loss closeout may retry only the exact transient authority observation',
  )
  assert.match(
    runtimeSmoke,
    /const retryableRetirementErrors = new Set\(\[\s*'dsh-runtime-plugin-owned',\s*'coordination-unauthorized',\s*\]\)[\s\S]+retryableRetirementErrors\.has\(attempt\.envelope\.error\?\.code\)/u,
    'native lane retirement may retry only the two exact transient ownership observations',
  )
  assert.doesNotMatch(
    runtimeSmoke,
    /lastCloseoutResult = nativeStore\(closeoutArgs\)/u,
    'forced-loss closeout must inspect the typed attempt before retrying',
  )
  for (const capability of [
    'af-unix',
    'af-netlink',
    'host-netns',
    'localhost',
    'systemd-user',
    'docker',
    'supplementary-groups',
  ]) assert.match(runtimeSmoke, new RegExp(capability))
  assert.match(runtimeSmoke, /readlinkSync\('\/proc\/self\/ns\/net'\)/)
  assert.match(runtimeSmoke, /dsh-runtime-kit-full-host:\\\$\{capability\}:failed/)
})

test('peer packer requires an absolute trusted pnpm launcher', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-source-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-artifacts-'))
  const receiptRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-receipt-'))
  try {
    await assert.rejects(
      run(process.execPath, [
        join(projectRoot, 'scripts', 'pack-dsh-compatibility-peers.mjs'),
        '--source-root', sourceRoot,
        '--artifact-root', artifactRoot,
        '--channel', 'pinned',
        '--pnpm-bin', 'pnpm',
        '--receipt', join(receiptRoot, 'receipt.json'),
      ]),
      error => {
        const envelope = JSON.parse(error.stdout)
        return envelope.error?.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID'
      },
    )
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(receiptRoot, { recursive: true, force: true })
  }
})

test('advertised silent compatibility command emits exactly one JSON error envelope', async () => {
  await assert.rejects(
    run('npm', ['run', '--silent', 'check:compatibility', '--', '--format', 'json'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }),
    error => {
      const envelope = JSON.parse(error.stdout)
      return envelope.schema_version === 'dsh-runtime-kit.compatibility-check.v1'
        && envelope.ok === false
        && envelope.error?.code === 'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID'
    },
  )
})

test('peer packer rejects an unselected checkout before producing artifacts', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-artifacts-'))
  const receiptRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-receipt-'))
  const launcherRoot = await mkdtemp(join(tmpdir(), 'dsh-peer-launcher-'))
  const launcher = join(launcherRoot, 'pnpm')
  try {
    await writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await assert.rejects(
      run(process.execPath, [
        join(projectRoot, 'scripts', 'pack-dsh-compatibility-peers.mjs'),
        '--source-root', projectRoot,
        '--artifact-root', artifactRoot,
        '--channel', 'pinned',
        '--pnpm-bin', launcher,
        '--receipt', join(receiptRoot, 'receipt.json'),
      ]),
      error => {
        const envelope = JSON.parse(error.stdout)
        return [
          'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
          'DSH_RUNTIME_KIT_UNSELECTED_DSH_REVISION',
        ].includes(envelope.error?.code)
      },
    )
    assert.deepEqual(await readdir(artifactRoot), [])
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
    await rm(receiptRoot, { recursive: true, force: true })
    await rm(launcherRoot, { recursive: true, force: true })
  }
})
