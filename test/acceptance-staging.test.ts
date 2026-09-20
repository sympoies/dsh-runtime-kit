import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { extractFreshPackage } from '../dist/src/acceptance/package-staging.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('published package bundles the exact runtime dependency closure for offline profile installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-bundled-dependencies-'))
  try {
    const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    assert.deepEqual(
      [...(manifest.bundledDependencies ?? [])].sort(),
      Object.keys(manifest.dependencies).sort(),
    )
    const packed = spawnSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', root,
    ], { cwd: projectRoot, encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const rows = JSON.parse(packed.stdout)
    assert.equal(rows.length, 1)
    const archive = join(root, rows[0].filename)
    const listed = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    const entries = new Set(listed.stdout.split('\n'))
    for (const dependency of Object.keys(manifest.dependencies)) {
      assert.equal(
        entries.has(`package/node_modules/${dependency}/package.json`),
        true,
        `${dependency} must be bundled into the published artifact`,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('each acceptance leg is extracted afresh from the authenticated tarball', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-acceptance-staging-'))
  try {
    const source = join(root, 'source')
    const packageRoot = join(source, 'package')
    const tarball = join(root, 'candidate.tgz')
    mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@sympoies/dsh-runtime-kit',
      version: '0.0.0-test',
      main: './dist/index.js',
      bin: {
        'dsh-runtime-kit': './dist/bin/dsh-runtime-kit.js',
      },
      exports: {
        '.': './dist/index.js',
      },
    }))
    writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export {}\n')
    writeFileSync(join(packageRoot, 'dist', 'bin', 'dsh-runtime-kit.js'), '#!/usr/bin/env node\n')
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

test('acceptance rejects each unavailable or unsafe declared package file', async t => {
  const cases: Array<{
    name: string,
    mutate: (root: string, packageRoot: string) => void,
  }> = [
    {
      name: 'missing main',
      mutate: (_root, packageRoot) => rmSync(join(packageRoot, 'dist', 'index.js')),
    },
    {
      name: 'one missing bin among multiple bins',
      mutate: (_root, packageRoot) => rmSync(join(packageRoot, 'dist', 'bin', 'helper.js')),
    },
    {
      name: 'missing exported subpath',
      mutate: (_root, packageRoot) => rmSync(join(packageRoot, 'dist', 'src', 'lifecycle.js')),
    },
    {
      name: 'directory in place of a declared file',
      mutate: (_root, packageRoot) => {
        rmSync(join(packageRoot, 'dist', 'index.js'))
        mkdirSync(join(packageRoot, 'dist', 'index.js'))
      },
    },
    {
      name: 'symlinked parent directory escaping the package root',
      mutate: (root, packageRoot) => {
        const externalDist = join(root, 'external-dist')
        mkdirSync(join(externalDist, 'bin'), { recursive: true })
        mkdirSync(join(externalDist, 'src'), { recursive: true })
        writeFileSync(join(externalDist, 'index.js'), 'export {}\n')
        writeFileSync(join(externalDist, 'bin', 'dsh-runtime-kit.js'), '#!/usr/bin/env node\n')
        writeFileSync(join(externalDist, 'bin', 'helper.js'), '#!/usr/bin/env node\n')
        writeFileSync(join(externalDist, 'src', 'lifecycle.js'), 'export {}\n')
        rmSync(join(packageRoot, 'dist'), { recursive: true })
        symlinkSync(externalDist, join(packageRoot, 'dist'), 'dir')
      },
    },
    {
      name: 'symlinked package manifest',
      mutate: (root, packageRoot) => {
        const externalManifest = join(root, 'external-package.json')
        writeFileSync(externalManifest, readFileSync(join(packageRoot, 'package.json')))
        rmSync(join(packageRoot, 'package.json'))
        symlinkSync(externalManifest, join(packageRoot, 'package.json'))
      },
    },
  ]

  for (const fixture of cases) await t.test(fixture.name, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-acceptance-entrypoints-'))
    try {
      const source = join(root, 'source')
      const packageRoot = join(source, 'package')
      const tarball = join(root, 'baseline.tgz')
      mkdirSync(join(packageRoot, 'dist', 'bin'), { recursive: true })
      mkdirSync(join(packageRoot, 'dist', 'src'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@sympoies/dsh-runtime-kit',
        version: '0.0.0-test',
        main: './dist/index.js',
        bin: {
          'dsh-runtime-kit': './dist/bin/dsh-runtime-kit.js',
          'dsh-runtime-kit-helper': './dist/bin/helper.js',
        },
        exports: {
          '.': './dist/index.js',
          './lifecycle': './dist/src/lifecycle.js',
        },
      }))
      writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export {}\n')
      writeFileSync(join(packageRoot, 'dist', 'bin', 'dsh-runtime-kit.js'), '#!/usr/bin/env node\n')
      writeFileSync(join(packageRoot, 'dist', 'bin', 'helper.js'), '#!/usr/bin/env node\n')
      writeFileSync(join(packageRoot, 'dist', 'src', 'lifecycle.js'), 'export {}\n')
      fixture.mutate(root, packageRoot)
      const packed = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', source, 'package'], {
        encoding: 'utf8',
      })
      assert.equal(packed.status, 0, packed.stderr)
      const tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')

      await assert.rejects(
        extractFreshPackage({
          tarball,
          tarballSha256,
          destination: join(root, 'baseline'),
          tarBin: '/usr/bin/tar',
          env: { PATH: '/usr/bin:/bin' },
          label: 'rollback baseline',
        }),
        (error: unknown) => {
          assert.equal((error as {code?: unknown}).code, 'DSH_RUNTIME_KIT_ACCEPTANCE_RECEIPT_INVALID')
          assert.match(String((error as Error).message), /declared package file is unavailable/u)
          return true
        },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
