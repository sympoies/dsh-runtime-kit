import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inspectDshTuiPristine } from '../dist/src/compat/dsh-tui-pristine.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const treeHash = (files: Record<string, string>) => {
  const digest = createHash('sha256')
  for (const path of Object.keys(files).sort()) {
    digest.update(path)
    digest.update('\0')
    digest.update(hash(files[path]))
    digest.update('\0')
  }
  return digest.digest('hex')
}

test('pristine TUI inspection accepts the exact package files and rejects a local edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-pristine-'))
  try {
    const packageJson = JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.10.2' })
    await mkdir(join(root, 'lib', 'types'), { recursive: true })
    await writeFile(join(root, 'package.json'), packageJson)
    await writeFile(join(root, 'cordis.patch.yml'), 'published patch')
    await writeFile(join(root, 'lib', 'types', 'history.js'), 'published history')
    await writeFile(join(root, 'lib', 'types', 'channel.js'), 'published channel')
    const publishedFiles = {
      'package.json': packageJson,
      'cordis.patch.yml': 'published patch',
      'lib/types/history.js': 'published history',
      'lib/types/channel.js': 'published channel',
    }
    const manifest = {
      schema_version: 'dsh-runtime-kit.dsh-tui-pristine.v2',
      package_name: '@deepseek-harness-tui/dsh-tui',
      version: '0.10.2',
      file_count: Object.keys(publishedFiles).length,
      tree_sha256: treeHash(publishedFiles),
      installed_file_count: Object.keys(publishedFiles).length,
      installed_tree_sha256: treeHash(publishedFiles),
      files: {
        'package.json': hash(packageJson),
        'cordis.patch.yml': hash('published patch'),
        'lib/types/history.js': hash('published history'),
      },
    }
    assert.deepEqual(inspectDshTuiPristine({ packageRoot: root, manifest }), {
      schema_version: 'dsh-runtime-kit.dsh-tui-pristine-inspection.v2',
      package_name: '@deepseek-harness-tui/dsh-tui',
      version: '0.10.2',
      ok: true,
      status: 'pristine',
    })

    await writeFile(join(root, 'lib', 'types', 'channel.js'), 'local channel patch')
    assert.equal(inspectDshTuiPristine({ packageRoot: root, manifest }).status, 'drift')
    await writeFile(join(root, 'lib', 'types', 'channel.js'), 'published channel')
    await writeFile(join(root, 'lib', 'types', 'unexpected.js'), 'extra code')
    assert.equal(inspectDshTuiPristine({ packageRoot: root, manifest }).status, 'drift')
    await rm(join(root, 'lib', 'types', 'unexpected.js'))

    await writeFile(join(root, 'lib', 'types', 'history.js'), 'local history patch')
    const changed = inspectDshTuiPristine({ packageRoot: root, manifest })
    assert.equal(changed.ok, false)
    assert.equal(changed.status, 'drift')
    assert.equal(changed.path, 'lib/types/history.js')
    await rm(join(root, 'lib', 'types', 'history.js'))
    await symlink(join(root, 'cordis.patch.yml'), join(root, 'lib', 'types', 'history.js'))
    const linked = inspectDshTuiPristine({ packageRoot: root, manifest })
    assert.equal(linked.ok, false)
    assert.equal(linked.status, 'unsupported')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pristine TUI inspection fails closed on a missing package', () => {
  const manifest = {
    schema_version: 'dsh-runtime-kit.dsh-tui-pristine.v2',
    package_name: '@deepseek-harness-tui/dsh-tui',
    version: '0.10.2',
    file_count: 1,
    tree_sha256: hash('fixture tree'),
    installed_file_count: 1,
    installed_tree_sha256: hash('fixture tree'),
    files: { 'package.json': hash('fixture') },
  }
  const result = inspectDshTuiPristine({ packageRoot: '/nonexistent/dsh-tui', manifest })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'absent')
})
