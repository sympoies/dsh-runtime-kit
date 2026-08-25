import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

const root = new URL('..', import.meta.url).pathname
const inventoryPath = join(root, 'policy', 'runtime-rule-parity.yaml')
const task32PolicyPath = join(root, 'policy', 'dsh-runtime-kit-v1.toml')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function loadInventory() {
  return parse(readFileSync(inventoryPath, 'utf8'))
}

function filesUnder(path) {
  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const candidate = join(path, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(candidate))
    else if (entry.isFile()) files.push(candidate)
  }
  return files
}

test('policy parity freezes the exact 101-rule source with distinct legacy counters', () => {
  const inventory = loadInventory()
  assert.equal(inventory.schema_version, 'dsh-runtime-kit.runtime-rule-parity.v1')
  assert.deepEqual(inventory.source.counts, {
    rules: 101,
    handler_capability_registrations: 69,
    handler_ids: 22,
    legacy_registrations: 67,
    legacy_handler_ids: 21,
  })
  assert.match(inventory.source.commit, /^[0-9a-f]{40}$/)
  assert.match(inventory.source.manifest_sha256, /^[0-9a-f]{64}$/)
  assert.equal(inventory.rules.length, 101)
  assert.equal(new Set(inventory.rules.map((rule) => rule.id)).size, 101)
  assert.equal(new Set(inventory.rules.map((rule) => rule.source_digest)).size, 101)
  const handlerRules = inventory.rules.filter((rule) => rule.source_key.startsWith('handler:'))
  const legacyRules = inventory.rules.filter((rule) => rule.legacy)
  assert.equal(handlerRules.length, inventory.source.counts.handler_capability_registrations)
  assert.equal(new Set(handlerRules.map((rule) => rule.source_key)).size, inventory.source.counts.handler_ids)
  assert.equal(legacyRules.length, inventory.source.counts.legacy_registrations)
  assert.equal(new Set(legacyRules.map((rule) => rule.source_key)).size, inventory.source.counts.legacy_handler_ids)
  assert.deepEqual(
    handlerRules.filter((rule) => !rule.legacy).map((rule) => rule.source_key),
    ['handler:user-prompt-agent-memory', 'handler:user-prompt-agent-memory'],
  )
})

test('every source row resolves to one completed migration with active implementation and test owners', () => {
  const inventory = loadInventory()
  const groups = new Map(inventory.capability_groups.map((group) => [group.id, group]))
  assert.equal(groups.size, inventory.capability_groups.length)
  assert.equal([...groups.values()].filter((group) => group.disposition === 'nils-capability').length, 22)
  assert.equal([...groups.values()].filter((group) => group.disposition === 'dsh-native').length, 3)
  assert.equal([...groups.values()].filter((group) => group.disposition === 'provider-obsolete').length, 1)

  for (const group of groups.values()) {
    assert.ok(['nils-capability', 'dsh-native', 'provider-obsolete'].includes(group.disposition), group.id)
    assert.ok(['implemented', 'retired'].includes(group.status), group.id)
    assert.match(group.migration_task, /^(2\.[123]|3\.[1234])$/, group.id)
    assert.ok(Array.isArray(group.source_keys) && group.source_keys.length > 0, group.id)
    assert.equal(new Set(group.source_keys).size, group.source_keys.length, group.id)
    if (group.disposition === 'provider-obsolete') {
      assert.equal(group.status, 'retired', group.id)
      assert.ok(group.retirement_evidence?.length > 0, group.id)
      assert.ok(group.replacement_groups?.length > 0, group.id)
      assert.equal(group.implementation_owner, null, group.id)
      assert.deepEqual(group.test_owners, [], group.id)
    } else {
      assert.equal(group.status, 'implemented', group.id)
      assert.match(group.implementation_owner, /^(nils-cli|dsh-runtime-kit):/)
      assert.ok(group.test_owners.length > 0, group.id)
      assert.ok(group.test_owners.every((owner) => /^(nils-cli|dsh-runtime-kit):/.test(owner)), group.id)
    }
  }

  assert.equal(
    new Map(inventory.capability_groups.map((group) => [group.id, group.migration_task])).size,
    inventory.capability_groups.length,
  )

  const retiredSourceKeys = [...groups.values()]
    .filter((group) => group.disposition === 'provider-obsolete')
    .flatMap((group) => group.source_keys)
  assert.deepEqual(retiredSourceKeys, ['handler:block-claude-coauthor-trailer'])
  for (const group of groups.values()) {
    for (const replacement of group.replacement_groups ?? []) {
      assert.equal(groups.has(replacement), true, `${group.id} replacement ${replacement}`)
      assert.notEqual(groups.get(replacement).disposition, 'provider-obsolete', replacement)
    }
  }

  const sourceKeyOwners = new Map()
  for (const group of groups.values()) {
    for (const sourceKey of group.source_keys) {
      assert.equal(sourceKeyOwners.has(sourceKey), false, `duplicate source key ${sourceKey}`)
      sourceKeyOwners.set(sourceKey, group.id)
    }
  }

  for (const rule of inventory.rules) {
    assert.deepEqual(Object.keys(rule).sort(), [
      'events',
      'id',
      'legacy',
      'matcher',
      'products',
      'source_digest',
      'source_key',
    ])
    assert.equal(sourceKeyOwners.has(rule.source_key), true, rule.id)
    assert.match(rule.source_digest, /^[0-9a-f]{64}$/)
    assert.ok(rule.products.length > 0, rule.id)
    assert.ok(rule.events.length > 0, rule.id)
  }
  assert.deepEqual(
    new Set(inventory.rules.map((rule) => rule.source_key)),
    new Set(sourceKeyOwners.keys()),
  )
})

test('the production package tree contains no retired handler executable', () => {
  const inventory = loadInventory()
  const handlerIds = new Set(
    inventory.capability_groups
      .flatMap(group => group.source_keys)
      .filter(key => key.startsWith('handler:'))
      .map(key => key.slice('handler:'.length)),
  )
  const forbiddenBasenames = new Set(
    [...handlerIds].flatMap(id => [`${id}.py`, `${id}.sh`]),
  )
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packagedFiles = manifest.files.flatMap(relative => {
    const path = join(root, relative)
    try {
      return filesUnder(path)
    } catch {
      return [path]
    }
  })
  const leaked = packagedFiles
    .map(path => path.slice(path.lastIndexOf('/') + 1))
    .filter(name => forbiddenBasenames.has(name))
  assert.deepEqual(leaked, [])
})

test('the checked-in legacy registration snapshot is exact and bound to the inventory', () => {
  const inventory = loadInventory()
  const fixture = readFileSync(join(root, 'policy', 'legacy-registrations.tsv'), 'utf8')
  const lines = fixture.trimEnd().split('\n')
  assert.equal(lines[0], '# agent-runtime-kit.legacy-hook-registrations.v1')
  assert.equal(lines.length - 1, 67)
  assert.equal(sha256(fixture), inventory.source.legacy_registrations_sha256)

  const projected = inventory.rules
    .filter((rule) => rule.legacy)
    .map((rule) => [rule.products[0], rule.events[0], rule.matcher ?? '-', rule.source_key.slice('handler:'.length)].join('\t'))
  assert.deepEqual(projected, lines.slice(1))
})

test('the packaged Task 3.2 through 3.4 policy selects every implemented typed capability at its native boundaries', () => {
  const policy = readFileSync(task32PolicyPath, 'utf8')
  const expected = [
    'owner-unclaimed',
    'semantic-conflict',
    'operation-lifecycle',
    'agent-scope-lock-guard',
    'block-direct-git-commit',
    'block-direct-git-worktree',
    'block-direct-pr-create',
    'block-direct-python',
    'block-unsafe-default-delivery',
    'checkout-lease-guard',
    'pre-edit-intent-gate',
    'semantic-commit-body-gate',
    'block-project-memory-write',
    'forge-label-reminder',
    'mcp-secret-scan',
    'memory-write-principle-reminder',
    'portable-paths-scan',
    'skill-usage-reminder',
    'stop-pre-pr-reminder',
    'operation-lifecycle',
    'user-prompt-agent-memory',
    'agent-activity',
  ]
  const selected = [...policy.matchAll(
    /capability = \{ id = "dsh\.policy\.v1", group = "([a-z0-9-]+)" \}/g,
  )].map(match => match[1])

  assert.deepEqual(selected, expected)
  assert.doesNotMatch(policy, /runtime-kit\.handler\.v1|\.py\b|agent-runtime-kit/)
  const inventory = new Map(loadInventory().capability_groups.map(group => [group.id, group]))
  for (const id of selected) {
    assert.ok(['3.2', '3.3', '3.4'].includes(inventory.get(id)?.migration_task), id)
    assert.equal(inventory.get(id)?.status, 'implemented', id)
  }
})
