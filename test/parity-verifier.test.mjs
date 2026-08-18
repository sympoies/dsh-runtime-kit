// @ts-check

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parse, stringify } from 'yaml'

import { verifyParitySource } from '../scripts/check-rule-parity-source.mjs'

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
