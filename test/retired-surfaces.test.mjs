// @ts-check

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const INVENTORY = join(ROOT, 'compatibility', 'retired-surfaces.json')
const OWNERS = new Set(['dsh', 'nils-cli', 'runtime-kit'])
const STATUSES = new Set(['removed', 'reduced', 'retained'])
const CATEGORIES = new Set([
  'workspace-identity',
  'prerequisite-evidence',
  'runtime-health',
  'finish-line',
  'data-policy',
  'reviewer-authority',
  'artifacts',
  'profile-lifecycle',
  'compatibility',
])
// Normative documents must describe the shipped architecture; history keeps
// its own record.
const HISTORICAL_DOCS = new Set(['docs/migration.md', 'docs/test-first-evidence.md'])
const RETIRED_RELEASE_NAMES = /\b(?:rc\.7|rc\.8|0\.1\.0-rc\.[0-9]+)\b/u

/** @param {string} path */
function filesBelow(path) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...filesBelow(child))
    else if (entry.isFile()) files.push(child)
  }
  return files
}

function shippedSources() {
  return [
    join(ROOT, 'index.js'),
    join(ROOT, 'policy.js'),
    join(ROOT, 'cordis.patch.yml'),
    join(ROOT, 'package.json'),
    ...filesBelow(join(ROOT, 'src')),
    ...filesBelow(join(ROOT, 'skills')),
    ...filesBelow(join(ROOT, 'agent-docs')),
    ...filesBelow(join(ROOT, 'agents')),
    ...filesBelow(join(ROOT, 'policy')),
    ...filesBelow(join(ROOT, 'scripts')),
    ...filesBelow(join(ROOT, 'bin')),
  ]
}

function normativeDocs() {
  return [
    join(ROOT, 'README.md'),
    join(ROOT, 'DEVELOPMENT.md'),
    ...filesBelow(join(ROOT, 'docs')).filter(path => {
      const rel = relative(ROOT, path)
      return rel.endsWith('.md') && !rel.startsWith('docs/devlog/') && !rel.startsWith('docs/plans/')
        && !HISTORICAL_DOCS.has(rel)
    }),
  ]
}

function inventory() {
  assert.equal(existsSync(INVENTORY), true, 'compatibility/retired-surfaces.json must exist')
  return JSON.parse(readFileSync(INVENTORY, 'utf8'))
}

test('the retired-surfaces inventory maps every surface to one owner, first supported versions, a window, and a rollback path', () => {
  const value = inventory()
  assert.equal(value.schema_version, 'dsh-runtime-kit.retired-surfaces.v1')
  assert.equal(typeof value.tracker, 'string')
  assert.ok(Array.isArray(value.surfaces) && value.surfaces.length > 0)
  const ids = new Set()
  for (const surface of value.surfaces) {
    assert.match(surface.id, /^[a-z][a-z0-9-]{2,63}$/u)
    assert.equal(ids.has(surface.id), false, `duplicate id ${surface.id}`)
    ids.add(surface.id)
    assert.ok(CATEGORIES.has(surface.category), `${surface.id}: category ${surface.category}`)
    assert.ok(STATUSES.has(surface.status), `${surface.id}: status ${surface.status}`)
    assert.equal(typeof surface.summary, 'string')
    assert.ok(Array.isArray(surface.paths) && surface.paths.length > 0, `${surface.id}: paths`)
    assert.ok(OWNERS.has(surface.replacement?.owner), `${surface.id}: replacement.owner`)
    assert.equal(typeof surface.replacement?.contract, 'string', `${surface.id}: replacement.contract`)
    assert.equal(typeof surface.first_supported?.runtime_kit, 'string', `${surface.id}: first_supported.runtime_kit`)
    assert.equal(typeof surface.first_supported?.nils_cli, 'string', `${surface.id}: first_supported.nils_cli`)
    assert.equal(typeof surface.compatibility_window, 'string', `${surface.id}: compatibility_window`)
    assert.equal(typeof surface.rollback, 'string', `${surface.id}: rollback`)
    if (surface.status === 'retained') {
      assert.equal(typeof surface.rationale, 'string', `${surface.id}: retained surfaces need a rationale`)
    } else {
      assert.ok(Array.isArray(surface.identifiers), `${surface.id}: identifiers`)
    }
  }
})

test('the recorded minimum supported versions are the compatibility manifests, not a parallel declaration', () => {
  const value = inventory()
  const nils = JSON.parse(readFileSync(join(ROOT, 'compatibility', 'nils-cli.json'), 'utf8'))
  const dsh = JSON.parse(readFileSync(join(ROOT, 'compatibility', 'dsh.json'), 'utf8'))
  // Every native contract the accepted children require ships in 1.27.37.
  assert.equal(nils.minimum_supported_release, '1.27.37')
  assert.equal(value.minimum_supported.nils_cli, nils.minimum_supported_release)
  assert.deepEqual(value.minimum_supported.dsh, Object.keys(dsh.validated_releases).sort())
  assert.match(value.minimum_supported.runtime_kit, /^[0-9a-f]{40}$/u)
  const row = `\`${nils.minimum_supported_release}\` minimum; exactly validated through \`${nils.validated_release}\``
  for (const doc of ['README.md', 'docs/compatibility.md']) {
    assert.ok(readFileSync(join(ROOT, doc), 'utf8').includes(row), `${doc} must state: ${row}`)
  }
})

test('no shipped file carries an active registration, config key, or branch for a removed surface', () => {
  const value = inventory()
  const removed = value.surfaces.filter(surface => surface.status === 'removed')
  assert.ok(removed.length > 0)
  const sources = shippedSources().filter(path => path !== INVENTORY)
  for (const surface of removed) {
    for (const path of surface.removed_files ?? []) {
      assert.equal(existsSync(join(ROOT, path)), false, `${surface.id}: ${path} must be deleted`)
    }
    for (const identifier of surface.identifiers) {
      const pattern = new RegExp(`\\b${identifier.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')
      for (const path of sources) {
        assert.doesNotMatch(readFileSync(path, 'utf8'), pattern, `${surface.id}: ${identifier} still appears in ${relative(ROOT, path)}`)
      }
      for (const path of normativeDocs()) {
        assert.doesNotMatch(readFileSync(path, 'utf8'), pattern, `${surface.id}: ${identifier} still documented in ${relative(ROOT, path)}`)
      }
    }
  }
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(existsSync(join(ROOT, 'src', 'artifacts', 'memory-provider.js')), false)
  assert.equal(packageJson.files.includes('test/helpers'), false, 'test helpers never ship')
})

test('normative documentation names only the supported DSH releases', () => {
  const dsh = JSON.parse(readFileSync(join(ROOT, 'compatibility', 'dsh.json'), 'utf8'))
  const supported = Object.keys(dsh.validated_releases)
  for (const path of normativeDocs()) {
    const content = readFileSync(path, 'utf8')
    const stale = content.match(RETIRED_RELEASE_NAMES)
    assert.equal(stale, null, `${relative(ROOT, path)} names retired release ${stale?.[0]}; supported: ${supported.join(', ')}`)
  }
})
