// @ts-check

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { parse } from 'yaml'

const INVENTORY_URL = new URL('../policy/rule-parity.yaml', import.meta.url)
const EXPECTED_RULE_ID_DIGEST = 'sha256:089d67c5b3dc4de422b3e89500b92fe5ee5db4b989a9d690edc6385d13f5a671'
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

function ruleIdDigest(rules) {
  const bytes = `${rules.map(rule => rule.id).sort().join('\n')}\n`
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function assertFrozenDispositions(inventory) {
  assert.equal(inventory.capabilities.length, EXPECTED_DISPOSITIONS.size)
  const actual = new Map(inventory.capabilities.map(capability => [
    capability.source_capability,
    [
      capability.target_capability,
      capability.status,
      capability.owner,
      capability.retirement_evidence,
    ].filter(value => value !== undefined),
  ]))
  assert.deepEqual(actual, EXPECTED_DISPOSITIONS)
}

test('the frozen parity inventory exhaustively maps the legacy runtime source', async () => {
  const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))

  assert.equal(inventory.schema_version, 'dsh-runtime-kit.rule-parity.v1')
  assert.deepEqual(inventory.source, {
    repository: 'github.com/sympoies/agent-runtime-kit',
    commit: '79d6b93f9df812e9cfd151ee03fc3d0ce44a0081',
    path: 'manifests/hook-rules.yaml',
    file_digest: 'sha256:5a7a571152fb1397b4243cb50c25a0812792a31bd3492a3e7d29a347f121849e',
    normalized_rule_id_digest: EXPECTED_RULE_ID_DIGEST,
    rule_count: 101,
    legacy_handler_count: 21,
    legacy_registration_count: 67,
    relocated_capability_count: 1,
    runtime_handler_or_relocated_count: 22,
  })
  assert.equal(inventory.rules.length, 101)
  assert.equal(new Set(inventory.rules.map(rule => rule.id)).size, 101)
  assert.equal(ruleIdDigest(inventory.rules), EXPECTED_RULE_ID_DIGEST)
  assertFrozenDispositions(inventory)

  const capabilities = new Map(
    inventory.capabilities.map(capability => [capability.source_capability, capability]),
  )
  for (const capability of inventory.capabilities) {
    assert.match(capability.target_capability, /^[a-z0-9][a-z0-9.-]+\.v1$/)
    assert.ok(['implemented', 'in-progress', 'planned', 'retired'].includes(capability.status))
    assert.match(capability.owner, /^(dsh-runtime-kit|nils-cli|dsh-runtime-kit \+ nils-cli)$/)
    assert.ok(Array.isArray(capability.test_owners) && capability.test_owners.length > 0)
    if (capability.status === 'retired') {
      assert.deepEqual(capability.retirement_evidence, {
        test_owner: 'test/provider-retirements.test.mjs',
        assertion: 'the shipped DSH runtime has no Claude provider or automatic Claude coauthor-trailer surface',
      })
      assert.ok(capability.test_owners.includes(capability.retirement_evidence.test_owner))
    }
  }
  for (const rule of inventory.rules) {
    assert.ok(capabilities.has(rule.source_capability), `unmapped source capability: ${rule.id}`)
    assert.deepEqual(rule.target_capability, capabilities.get(rule.source_capability).target_capability)
  }
})

test('target dispositions cannot drift together with their rule rows', async () => {
  const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))
  const capability = inventory.capabilities.find(
    candidate => candidate.source_capability === 'block-direct-python',
  )
  capability.target_capability = 'policy.git-delivery.v1'
  for (const rule of inventory.rules) {
    if (rule.source_capability === capability.source_capability) {
      rule.target_capability = capability.target_capability
    }
  }
  assert.throws(
    () => assertFrozenDispositions(inventory),
    /Expected values to be strictly deep-equal/,
  )
})
