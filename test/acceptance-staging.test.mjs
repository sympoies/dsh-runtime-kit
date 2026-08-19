import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { extractFreshPackage } from '../src/acceptance/package-staging.js'

test('each acceptance leg is extracted afresh from the authenticated tarball', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-acceptance-staging-'))
  try {
    const source = join(root, 'source')
    const packageRoot = join(source, 'package')
    const tarball = join(root, 'candidate.tgz')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@sympoies/dsh-runtime-kit',
      version: '0.0.0-test',
    }))
    writeFileSync(join(packageRoot, 'marker.txt'), 'authenticated\n')
    const packed = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', source, 'package'], {
      encoding: 'utf8',
    })
    assert.equal(packed.status, 0, packed.stderr)
    const tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')

    const operations = await extractFreshPackage({
      tarball,
      tarballSha256,
      destination: join(root, 'operations'),
      tarBin: '/usr/bin/tar',
      env: { PATH: '/usr/bin:/bin' },
      label: 'operations',
    })
    writeFileSync(join(operations, 'marker.txt'), 'mutated by operations\n')

    const runtime = await extractFreshPackage({
      tarball,
      tarballSha256,
      destination: join(root, 'runtime'),
      tarBin: '/usr/bin/tar',
      env: { PATH: '/usr/bin:/bin' },
      label: 'runtime',
    })
    assert.equal(readFileSync(runtime + '/marker.txt', 'utf8'), 'authenticated\n')
    assert.equal(readFileSync(operations + '/marker.txt', 'utf8'), 'mutated by operations\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
