import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  DshBuildClosureError,
  digestDshBuildClosure,
} from '../dist/src/acceptance/dsh-build.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-build-'))
  const tools = join(root, 'packages', 'core', 'tools', 'lib')
  const agent = join(root, 'packages', 'core', 'agent', 'lib')
  await mkdir(tools, { recursive: true })
  await mkdir(agent, { recursive: true })
  await writeFile(join(tools, 'index.js'), 'export const tool = 1\n')
  await writeFile(join(agent, 'index.js'), 'export const agent = 1\n')
  return { root, tools, agent }
}

function hostNativeBinary() {
  const platform = `${process.platform}-${process.arch}`
  if (process.platform === 'linux') {
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    const libc = report.header.glibcVersionRuntime ? 'glibc' : 'musl'
    return { platform, libc, path: `bin/${libc}/system.node` }
  }
  return { platform, path: 'bin/system.node' }
}

async function addNativeSystemFixture(root: string) {
  const binary = hostNativeBinary()
  const packageRoot = join(root, 'native', 'system', 'packages', binary.platform)
  const binaryPath = join(packageRoot, binary.path)
  await mkdir(dirname(binaryPath), { recursive: true })
  await writeFile(join(packageRoot, 'prebuilds.json'), JSON.stringify({
    platform: binary.platform,
    binaries: [{
      tool: 'flock',
      kind: 'node-api',
      napi: 8,
      ...(binary.libc === undefined ? {} : { libc: binary.libc }),
      path: binary.path,
    }],
  }))
  await writeFile(binaryPath, 'native-addon-v1')
  return binaryPath
}

test('DSH build closure binds every generated lib file, including non-tools packages', async () => {
  const value = await fixture()
  try {
    const baseline = await digestDshBuildClosure(value.root)
    assert.equal(baseline.file_count, 2)

    await writeFile(join(value.agent, 'index.js'), 'export const agent = 2\n')
    const mutated = await digestDshBuildClosure(value.root)
    assert.notEqual(mutated.sha256, baseline.sha256)

    await writeFile(join(value.agent, 'extra.js'), 'export const extra = true\n')
    const added = await digestDshBuildClosure(value.root)
    assert.notEqual(added.sha256, mutated.sha256)
    assert.equal(added.file_count, 3)

    await rm(join(value.agent, 'extra.js'))
    const removed = await digestDshBuildClosure(value.root)
    assert.equal(removed.sha256, mutated.sha256)

    await chmod(join(value.agent, 'index.js'), 0o700)
    const modeChanged = await digestDshBuildClosure(value.root)
    assert.notEqual(modeChanged.sha256, removed.sha256)
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('DSH build closure rejects symlinks within generated lib output', async () => {
  const value = await fixture()
  try {
    await symlink(join(value.tools, 'index.js'), join(value.agent, 'linked.js'))
    await assert.rejects(
      digestDshBuildClosure(value.root),
      error => error instanceof DshBuildClosureError,
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})

test('DSH build closure requires and binds the current-host native system addon', async () => {
  const value = await fixture()
  try {
    const native = await addNativeSystemFixture(value.root)
    const baseline = await digestDshBuildClosure(value.root)
    assert.equal(baseline.file_count, 3)

    await writeFile(native, 'native-addon-v2')
    const mutated = await digestDshBuildClosure(value.root)
    assert.notEqual(mutated.sha256, baseline.sha256)

    await rm(native)
    await assert.rejects(
      digestDshBuildClosure(value.root),
      (error: unknown) => error instanceof DshBuildClosureError
        && error.code === 'DSH_RUNTIME_KIT_DSH_NATIVE_ARTIFACT_INVALID',
    )
  } finally {
    await rm(value.root, { recursive: true, force: true })
  }
})
