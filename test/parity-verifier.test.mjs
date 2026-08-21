// @ts-check

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parse, stringify } from 'yaml'

import {
  verifyParityInventory,
  verifyParitySource,
} from '../scripts/check-rule-parity-source.mjs'

const SOURCE_URL = new URL('./fixtures/legacy-hook-rules.yaml', import.meta.url)
const INVENTORY_URL = new URL('../policy/rule-parity.yaml', import.meta.url)

async function fixture() {
  const [sourceBytes, inventoryBytes] = await Promise.all([
    readFile(SOURCE_URL),
    readFile(INVENTORY_URL),
  ])
  return { sourceBytes, inventoryBytes, inventory: parse(inventoryBytes.toString('utf8')) }
}

function bytes(value) {
  return Buffer.from(stringify(value))
}

test('the source verifier derives handler and relocation counters', async () => {
  const valid = await fixture()
  assert.equal(verifyParitySource(valid.sourceBytes, valid.inventoryBytes).rule_count, 101)

  const staleHandlerCount = structuredClone(valid.inventory)
  staleHandlerCount.source.legacy_handler_count += 1
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(staleHandlerCount)),
  )

  const staleRelocation = structuredClone(valid.inventory)
  staleRelocation.source.relocated_capability_count += 1
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(staleRelocation)),
  )
})

test('the public verifier rejects incomplete or internally inconsistent inventories', async () => {
  const valid = await fixture()

  const missingSchema = structuredClone(valid.inventory)
  delete missingSchema.schema_version
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(missingSchema)),
  )

  const missingCapabilities = structuredClone(valid.inventory)
  delete missingCapabilities.capabilities
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(missingCapabilities)),
  )

  const mismatchedTarget = structuredClone(valid.inventory)
  const rule = mismatchedTarget.rules.find(
    candidate => candidate.source_capability === 'block-direct-python',
  )
  rule.target_capability = 'policy.git-delivery.v1'
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(mismatchedTarget)),
  )

  const duplicateTail = structuredClone(valid.inventory)
  duplicateTail.rules.push(structuredClone(duplicateTail.rules[0]))
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(duplicateTail)),
  )

  const conflictingDuplicateHead = structuredClone(valid.inventory)
  conflictingDuplicateHead.rules.unshift({
    ...structuredClone(conflictingDuplicateHead.rules[0]),
    source_capability: 'block-direct-python',
    target_capability: 'policy.execution-owner.v1',
  })
  assert.throws(
    () => verifyParitySource(valid.sourceBytes, bytes(conflictingDuplicateHead)),
  )
})

test('the public inventory verifier freezes provenance, counters, and exact rule IDs', async () => {
  const valid = await fixture()
  const mutations = [
    inventory => { inventory.source.repository = 'github.com/example/drifted-runtime' },
    inventory => { inventory.source.commit = '0'.repeat(40) },
    inventory => { inventory.source.path = 'manifests/other-rules.yaml' },
    inventory => { inventory.source.file_digest = `sha256:${'0'.repeat(64)}` },
    inventory => { inventory.source.normalized_rule_id_digest = `sha256:${'1'.repeat(64)}` },
    inventory => { inventory.source.rule_count += 1 },
    inventory => {
      inventory.test_owner_repositories['nils-cli'].identity = 'github.com/example/fake-nils'
    },
    inventory => {
      inventory.test_owner_repositories['nils-cli'].evidence_commit = '0'.repeat(40)
    },
    inventory => { inventory.rules[0].id = 'runtime.fabricated.registration' },
  ]

  for (const mutate of mutations) {
    const inventory = structuredClone(valid.inventory)
    mutate(inventory)
    assert.throws(() => verifyParityInventory(inventory))
  }
})

test('the public inventory verifier freezes repository-qualified test ownership', async () => {
  const valid = await fixture()
  for (const sourceCapability of valid.inventory.capabilities.map(
    capability => capability.source_capability,
  )) {
    const inventory = structuredClone(valid.inventory)
    const capability = inventory.capabilities.find(
      candidate => candidate.source_capability === sourceCapability,
    )
    capability.test_owners = [{
      repository: 'dsh-runtime-kit',
      path: 'test/fabricated-or-missing.test.mjs',
      state: 'active',
    }]
    assert.throws(
      () => verifyParityInventory(inventory),
      undefined,
      `fabricated test owner passed for ${sourceCapability}`,
    )
  }
})

test('the source digest is stable across LF and CRLF checkout materialization', async () => {
  const valid = await fixture()
  const crlfSource = Buffer.from(
    valid.sourceBytes.toString('utf8').replaceAll('\n', '\r\n'),
  )

  assert.deepEqual(
    verifyParitySource(crlfSource, valid.inventoryBytes),
    verifyParitySource(valid.sourceBytes, valid.inventoryBytes),
  )
})

test('source canonicalization rejects undeclared BOM and lone-CR transformations', async () => {
  const valid = await fixture()
  const bomSource = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    valid.sourceBytes,
  ])
  assert.throws(() => verifyParitySource(bomSource, valid.inventoryBytes))

  const sourceText = valid.sourceBytes.toString('utf8')
  const firstLineFeed = sourceText.indexOf('\n')
  const loneCarriageReturn = Buffer.from(
    `${sourceText.slice(0, firstLineFeed)}\r${sourceText.slice(firstLineFeed + 1)}`,
  )
  assert.throws(
    () => verifyParitySource(loneCarriageReturn, valid.inventoryBytes),
    /unsupported lone CR/,
  )
})
