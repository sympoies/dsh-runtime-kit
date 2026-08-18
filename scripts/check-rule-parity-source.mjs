#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const EXPECTED_DISPOSITIONS = new Map(Object.entries({
  'agent-scope-lock-guard': ['policy.edit-scope.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'agent-session.activity.v1': ['coordination.activity.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'agent-session.coordination.v1': ['coordination.coordination.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'agent-session.owner-liveness.v1': ['coordination.owner-liveness.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'agent-session.semantic-conflict.v1': ['coordination.semantic-conflict.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'block-claude-coauthor-trailer': [
    'retirement.provider-claude.v1',
    'retired',
    'dsh-runtime-kit',
    {
      test_owner: 'test/provider-retirements.test.mjs',
      assertion: 'the shipped DSH runtime has no Claude provider or automatic Claude coauthor-trailer surface',
    },
  ],
  'block-direct-git-commit': ['policy.git-delivery.v1', 'planned', 'nils-cli'],
  'block-direct-git-worktree': ['policy.git-delivery.v1', 'planned', 'nils-cli'],
  'block-direct-pr-create': ['policy.git-delivery.v1', 'planned', 'nils-cli'],
  'block-direct-python': ['policy.execution-owner.v1', 'planned', 'nils-cli'],
  'block-project-memory-write': ['policy.memory-boundary.v1', 'planned', 'nils-cli'],
  'block-unsafe-default-delivery': ['policy.git-delivery.v1', 'planned', 'nils-cli'],
  'checkout-lease-guard': ['policy.checkout-lease.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'execution.read-only.v1': ['policy.read-only-ingress.v1', 'implemented', 'nils-cli'],
  'finish-line-record': ['finish-line.enforcement.v1', 'in-progress', 'dsh-runtime-kit + nils-cli'],
  'forge-label-reminder': ['guidance.forge-label.v1', 'planned', 'nils-cli'],
  'mcp-secret-scan': ['policy.secret-egress.v1', 'planned', 'nils-cli'],
  'memory-write-principle-reminder': ['guidance.memory-boundary.v1', 'planned', 'nils-cli'],
  'portable-paths-scan': ['policy.portable-output.v1', 'planned', 'nils-cli'],
  'pre-edit-intent-gate': ['policy.edit-admission.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'semantic-commit-body-gate': ['policy.git-delivery.v1', 'planned', 'nils-cli'],
  'session-start-healthcheck': ['operations.health.v1', 'planned', 'dsh-runtime-kit'],
  'skill-usage-reminder': ['context.skill-routing.v1', 'planned', 'dsh-runtime-kit'],
  'stop-finish-line-gate': ['finish-line.enforcement.v1', 'in-progress', 'dsh-runtime-kit + nils-cli'],
  'stop-pre-pr-reminder': ['delivery.pre-pr.v1', 'planned', 'dsh-runtime-kit + nils-cli'],
  'user-prompt-agent-docs': ['context.selective.v1', 'in-progress', 'dsh-runtime-kit + nils-cli'],
  'user-prompt-agent-memory': ['context.private-profile.v1', 'planned', 'dsh-runtime-kit'],
}))

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function ruleIdDigest(rules) {
  return digest(`${rules.map(rule => rule.id).sort().join('\n')}\n`)
}

export function verifyParityInventory(inventory) {
  assert.equal(inventory.schema_version, 'dsh-runtime-kit.rule-parity.v1')
  assert.ok(Array.isArray(inventory.capabilities))
  assert.ok(Array.isArray(inventory.rules))
  assert.equal(inventory.capabilities.length, EXPECTED_DISPOSITIONS.size)
  assert.equal(
    inventory.rules.length,
    inventory.source.rule_count,
    'inventory rule count does not match its declared source boundary',
  )
  assert.equal(
    new Map(inventory.rules.map(rule => [rule.id, rule])).size,
    inventory.rules.length,
    'inventory rule IDs must be unique',
  )

  const capabilities = new Map(
    inventory.capabilities.map(capability => [capability.source_capability, capability]),
  )
  assert.equal(capabilities.size, EXPECTED_DISPOSITIONS.size)
  for (const [sourceCapability, expected] of EXPECTED_DISPOSITIONS) {
    const capability = capabilities.get(sourceCapability)
    assert.ok(capability, `missing capability disposition: ${sourceCapability}`)
    assert.deepEqual([
      capability.target_capability,
      capability.status,
      capability.owner,
      capability.retirement_evidence ?? null,
    ], expected.length === 4 ? expected : [...expected, null],
    `capability disposition drift: ${sourceCapability}`)
    assert.ok(
      Array.isArray(capability.test_owners) && capability.test_owners.length > 0,
      `missing test owner: ${sourceCapability}`,
    )
    if (capability.retirement_evidence !== undefined) {
      assert.ok(
        capability.test_owners.includes(capability.retirement_evidence.test_owner),
        `retirement test owner is not active: ${sourceCapability}`,
      )
    }
  }
  for (const rule of inventory.rules) {
    const capability = capabilities.get(rule.source_capability)
    assert.ok(capability, `unmapped source capability: ${rule.id}`)
    assert.equal(
      rule.target_capability,
      capability.target_capability,
      `target capability drift: ${rule.id}`,
    )
  }
  return inventory
}

export function verifyParitySource(sourceBytes, inventoryBytes) {
  const source = parse(sourceBytes.toString('utf8'))
  const inventory = verifyParityInventory(parse(inventoryBytes.toString('utf8')))
  assert.equal(source.schema_version, 'agent-runtime-kit.hook-rules.v1')
  assert.equal(digest(sourceBytes), inventory.source.file_digest)
  assert.equal(source.rules.length, inventory.source.rule_count)
  assert.equal(ruleIdDigest(source.rules), inventory.source.normalized_rule_id_digest)

  const legacyHandlers = new Set()
  const relocatedCapabilities = new Set()
  let legacyRegistrations = 0
  for (const rule of source.rules) {
    if (typeof rule.legacy_handler === 'string') {
      legacyHandlers.add(rule.legacy_handler)
      legacyRegistrations += 1
    }
    if (rule.disposition === 'relocated-startup-capability') {
      relocatedCapabilities.add(rule.capability.handler_id ?? rule.capability.id)
    }
  }
  const runtimeHandlers = new Set([...legacyHandlers, ...relocatedCapabilities])
  assert.equal(source.legacy_handler_count, legacyHandlers.size)
  assert.equal(source.legacy_registration_count, legacyRegistrations)
  assert.equal(inventory.source.legacy_handler_count, legacyHandlers.size)
  assert.equal(inventory.source.legacy_registration_count, legacyRegistrations)
  assert.equal(inventory.source.relocated_capability_count, relocatedCapabilities.size)
  assert.equal(inventory.source.runtime_handler_or_relocated_count, runtimeHandlers.size)

  const mapped = new Map(inventory.rules.map(rule => [rule.id, rule]))
  assert.equal(mapped.size, source.rules.length)
  for (const rule of source.rules) {
    const target = mapped.get(rule.id)
    assert.ok(target, `missing parity row: ${rule.id}`)
    assert.equal(
      target.source_capability,
      rule.capability.handler_id ?? rule.capability.id,
      `source capability drift: ${rule.id}`,
    )
  }
  return {
    schema_version: 'dsh-runtime-kit.rule-parity-check.v1',
    ok: true,
    rule_count: source.rules.length,
    rule_id_digest: inventory.source.normalized_rule_id_digest,
    legacy_handler_count: legacyHandlers.size,
    legacy_registration_count: legacyRegistrations,
    relocated_capability_count: relocatedCapabilities.size,
    runtime_handler_or_relocated_count: runtimeHandlers.size,
  }
}

function usage(stream) {
  stream.write('check-rule-parity-source <legacy-hook-rules.yaml>\n')
  stream.write('Verify the frozen dsh-runtime-kit parity inventory against its retained source.\n')
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : await realpath(resolve(process.argv[1])).catch(() => undefined)
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourcePath = process.argv[2]
  if (sourcePath === '--help' || sourcePath === '-h') {
    usage(process.stdout)
  } else if (sourcePath === undefined) {
    usage(process.stderr)
    process.exitCode = 64
  } else {
    const inventoryPath = new URL('../policy/rule-parity.yaml', import.meta.url)
    const [sourceBytes, inventoryBytes] = await Promise.all([
      readFile(resolve(sourcePath)),
      readFile(inventoryPath),
    ])
    const result = verifyParitySource(sourceBytes, inventoryBytes)
    process.stdout.write(`${JSON.stringify({ ...result, source: resolve(sourcePath) })}\n`)
  }
}
