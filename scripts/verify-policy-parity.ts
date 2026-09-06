#!/usr/bin/env node

import { PACKAGE_ROOT } from '../src/package-root.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

interface ManifestRule {
  id: string
  products: unknown
  events: unknown
  matcher: unknown
  legacy_handler: string | null
  capability: {
    id: string
    handler_id?: string
    reason_code?: string
  }
}

interface Manifest {
  schema_version: string
  rules: ManifestRule[]
}

interface CapabilityGroup {
  id: string
  disposition: string
  migration_task: string
}

interface RuntimeRuleParity {
  schema_version: string
  source: {
    repository: string
    commit: string
    manifest: string
    manifest_schema: string
    manifest_sha256: string
    legacy_registrations: string
    legacy_registrations_sha256: string
    counts: unknown
  }
  capability_groups: CapabilityGroup[]
  rules: unknown[]
}

interface NilsCapabilityGroup {
  id: string
  migration_task: string
}

interface NilsFixture {
  schema_version: string
  capabilities: NilsCapabilityGroup[]
}

const packageRoot = PACKAGE_ROOT
const sourceRootArgument = process.argv[2] ?? process.env.AGENT_RUNTIME_KIT_SOURCE_ROOT
const nilsRootArgument = process.argv[3] ?? process.env.NILS_CLI_SOURCE_ROOT
if (sourceRootArgument === undefined || sourceRootArgument === '') {
  process.stderr.write('usage: node dist/scripts/verify-policy-parity.js /path/to/agent-runtime-kit\n')
  process.exit(64)
}
const sourceRoot = resolve(sourceRootArgument)

const parity: RuntimeRuleParity = parse(
  readFileSync(resolve(packageRoot, 'policy/runtime-rule-parity.yaml'), 'utf8'),
)
assert.equal(parity.schema_version, 'dsh-runtime-kit.runtime-rule-parity.v1')
const git = (...args: string[]): string => execFileSync('git', ['-C', sourceRoot, ...args], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
const repositoryIdentity = (value: string): string => value.trim()
  .replace(/^git@github\.com:/, 'https://github.com/')
  .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
  .replace(/\.git$/, '')

assert.equal(
  repositoryIdentity(git('remote', 'get-url', 'origin')),
  repositoryIdentity(parity.source.repository),
  'legacy source repository identity mismatched',
)
git('cat-file', '-e', `${parity.source.commit}^{commit}`)
const manifestRaw = git('show', `${parity.source.commit}:${parity.source.manifest}`)
const registrationsRaw = git(
  'show',
  `${parity.source.commit}:${parity.source.legacy_registrations}`,
)
const manifest: Manifest = parse(manifestRaw)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object'
)
const stable = (value: unknown): unknown => Array.isArray(value)
  ? value.map(stable)
  : isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value
const sourceKey = (rule: ManifestRule): string => rule.capability.handler_id === undefined
  ? `reason:${rule.capability.reason_code}`
  : `handler:${rule.capability.handler_id}`

assert.equal(sha256(manifestRaw), parity.source.manifest_sha256, 'legacy rule source drifted')
assert.equal(
  sha256(registrationsRaw),
  parity.source.legacy_registrations_sha256,
  'legacy registration source drifted',
)
assert.equal(manifest.schema_version, parity.source.manifest_schema)
const handlerRules = manifest.rules.filter(
  (rule) => rule.capability.id === 'runtime-kit.handler.v1',
)
const legacyRules = manifest.rules.filter((rule) => rule.legacy_handler !== null)
const derivedCounts = {
  rules: manifest.rules.length,
  handler_capability_registrations: handlerRules.length,
  handler_ids: new Set(handlerRules.map((rule) => rule.capability.handler_id)).size,
  legacy_registrations: legacyRules.length,
  legacy_handler_ids: new Set(legacyRules.map((rule) => rule.legacy_handler)).size,
}
assert.deepEqual(derivedCounts, parity.source.counts, 'legacy source counters drifted')
assert.deepEqual(
  handlerRules
    .filter((rule) => rule.legacy_handler === null)
    .map((rule) => rule.capability.handler_id),
  ['user-prompt-agent-memory', 'user-prompt-agent-memory'],
  'handler-capability and legacy subsets no longer differ by the two memory rows',
)
assert.deepEqual(
  manifest.rules.map((rule) => ({
    id: rule.id,
    products: rule.products,
    events: rule.events,
    matcher: rule.matcher,
    source_key: sourceKey(rule),
    legacy: rule.legacy_handler !== null,
    source_digest: sha256(JSON.stringify(stable(rule))),
  })),
  parity.rules,
)
assert.equal(
  registrationsRaw,
  readFileSync(resolve(packageRoot, 'policy/legacy-registrations.tsv'), 'utf8'),
  'checked-in legacy registration fixture drifted',
)

if (nilsRootArgument !== undefined && nilsRootArgument !== '') {
  const nilsFixture: NilsFixture = JSON.parse(readFileSync(resolve(
    nilsRootArgument,
    'crates/agent-hook/tests/fixtures/dsh-policy-capability-groups.v1.json',
  ), 'utf8'))
  assert.equal(nilsFixture.schema_version, 'agent-hook.dsh-policy-capability-groups.v1')
  const parityGroups = new Map(
    parity.capability_groups.map((group): [string, CapabilityGroup] => [group.id, group]),
  )
  const nilsGroups = new Map(
    nilsFixture.capabilities.map((group): [string, NilsCapabilityGroup] => [group.id, group]),
  )
  assert.equal(
    nilsGroups.size,
    nilsFixture.capabilities.length,
    'nils capability-group schema contains duplicate ids',
  )
  for (const group of nilsFixture.capabilities) {
    const parityGroup = parityGroups.get(group.id)
    assert.ok(parityGroup !== undefined, `nils capability group ${group.id} is unknown`)
    assert.equal(
      group.migration_task,
      parityGroup.migration_task,
      `nils capability group ${group.id} changed migration task`,
    )
  }
  for (const group of parity.capability_groups.filter(
    (candidate: CapabilityGroup) => candidate.disposition === 'nils-capability',
  )) {
    assert.notEqual(
      nilsGroups.get(group.id),
      undefined,
      `active nils capability group ${group.id} is missing from the nils schema`,
    )
  }
}

process.stdout.write(`policy parity verified: ${parity.rules.length} rules from ${parity.source.commit}\n`)
