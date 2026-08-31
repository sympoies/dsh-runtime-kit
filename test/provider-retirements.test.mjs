// @ts-check

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const execute = promisify(execFile)
const RETIRED_SURFACE = /(?:claude|anthropic).*(?:provider|co.?author(?:ship)?[-_ ]?trailer)|(?:provider|co.?author(?:ship)?[-_ ]?trailer).*(?:claude|anthropic)/i

function assertNoRetiredRuntimeSurface(path, content) {
  assert.doesNotMatch(content, RETIRED_SURFACE, path)
}

async function filesBelow(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await filesBelow(child))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

test('the shipped DSH runtime has no Claude provider or automatic Claude coauthor-trailer surface', async () => {
  assert.throws(
    () => assertNoRetiredRuntimeSurface(
      'index.js',
      "registerProvider('claude'); enableCoauthorTrailer()",
    ),
  )
  const paths = [
    join(ROOT, 'index.js'),
    join(ROOT, 'policy.js'),
    ...await filesBelow(join(ROOT, 'src')),
    ...await filesBelow(join(ROOT, 'skills')),
    ...await filesBelow(join(ROOT, 'scripts')),
  ]
  for (const path of paths) {
    const content = await readFile(path, 'utf8')
    assert.doesNotMatch(content, /co-authored-by\s*:\s*claude/i, path)
    assert.doesNotMatch(content, /noreply@anthropic\.com/i, path)
  }
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(
    Object.keys({ ...packageJson.dependencies, ...packageJson.peerDependencies })
      .some(name => name.startsWith('@anthropic/')),
    false,
  )

  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-retirement-'))
  try {
    const packed = JSON.parse((await execute(
      'npm',
      ['pack', '--json', '--pack-destination', temporary],
      { cwd: ROOT },
    )).stdout)[0]
    const tarball = join(temporary, packed.filename)
    const runtimeArtifacts = packed.files
      .map(file => file.path)
      .filter(path => path === 'index.js'
        || path === 'policy.js'
        || path === 'package.json'
        || path === 'cordis.patch.yml'
        || path.startsWith('src/')
        || path.startsWith('compatibility/'))
      .filter(path => /\.(?:js|json|mjs|ya?ml)$/.test(path))
    assert.ok(runtimeArtifacts.includes('cordis.patch.yml'))
    assert.ok(runtimeArtifacts.includes('package.json'))
    for (const path of runtimeArtifacts) {
      const extracted = await execute('tar', ['-xOf', tarball, `package/${path}`])
      assertNoRetiredRuntimeSurface(path, extracted.stdout)
    }

    await execute(
      'npm',
      ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', tarball],
      { cwd: temporary },
    )
    const requireFromInstall = createRequire(join(temporary, 'consumer.cjs'))
    const runtime = await import(pathToFileURL(
      requireFromInstall.resolve('@sympoies/dsh-runtime-kit'),
    ).href)
    assert.deepEqual(runtime.inject, [
      'agents',
      'invariants',
      'llm',
      'sandboxPolicy',
      'sessions',
      'shell',
      'shellEnv',
      'skills',
      'subprocess',
      'tools',
    ])
    assert.equal(runtime.inject.includes('llm'), true)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
