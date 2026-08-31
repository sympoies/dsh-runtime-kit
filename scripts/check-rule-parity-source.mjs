#!/usr/bin/env node
// @ts-check

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const ACTIVE = 'active'
const PLANNED = 'planned'
const DSH = 'dsh-runtime-kit'
const NILS = 'nils-cli'

function testOwner(repository, path, state) {
  return { repository, path, state }
}

function disposition(targetCapability, status, owner, testOwners, retirementEvidence) {
  return {
    target_capability: targetCapability,
    status,
    owner,
    test_owners: testOwners,
    ...(retirementEvidence === undefined ? {} : { retirement_evidence: retirementEvidence }),
  }
}

const DSH_POLICY = testOwner(DSH, 'test/policy-parity.test.mjs', PLANNED)
const NILS_POLICY = testOwner(NILS, 'crates/agent-hook/tests/dsh_policy.rs', PLANNED)
const DSH_DATA_POLICY = testOwner(DSH, 'test/plugin-contract.test.mjs', ACTIVE)
const NILS_DATA_POLICY = testOwner(NILS, 'crates/agent-hook/tests/dsh_policy.rs', ACTIVE)
const DSH_COORDINATION = testOwner(DSH, 'test/coordination.test.mjs', PLANNED)
const NILS_COORDINATION = testOwner(
  NILS,
  'crates/agent-hook/tests/dsh_coordination.rs',
  PLANNED,
)
const PROVIDER_RETIREMENT = testOwner(DSH, 'test/provider-retirements.test.mjs', ACTIVE)

const EXPECTED_SOURCE = {
  repository: 'github.com/sympoies/agent-runtime-kit',
  commit: '79d6b93f9df812e9cfd151ee03fc3d0ce44a0081',
  path: 'manifests/hook-rules.yaml',
  byte_canonicalization: 'lf-line-endings',
  file_digest: 'sha256:5a7a571152fb1397b4243cb50c25a0812792a31bd3492a3e7d29a347f121849e',
  normalized_rule_id_digest: 'sha256:089d67c5b3dc4de422b3e89500b92fe5ee5db4b989a9d690edc6385d13f5a671',
  rule_count: 101,
  legacy_handler_count: 21,
  legacy_registration_count: 67,
  relocated_capability_count: 1,
  runtime_handler_or_relocated_count: 22,
}

const EXPECTED_OWNER_REPOSITORIES = {
  [DSH]: {
    identity: 'github.com/sympoies/dsh-runtime-kit',
    evidence_commit: '3b4bb380622631cd6cded8af6af1bebcff21732a',
  },
  [NILS]: {
    identity: 'github.com/sympoies/nils-cli',
    evidence_commit: '302715e367edb66dee81589357e7c4abdccb7ba2',
  },
}

const TRUSTED_SQUASH_INTEGRATIONS = {
  [DSH]: {
    evidence_commit: '64bf4388771f3acd13735db0456ebd6ef23f13ab',
    merge_commit: '7bbcee244d0693c32697de86446e3fa037682ac9',
  },
}

const EXPECTED_DISPOSITIONS = new Map(Object.entries({
  'agent-scope-lock-guard': disposition('policy.edit-scope.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_POLICY, NILS_POLICY]),
  'agent-session.activity.v1': disposition('coordination.activity.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_COORDINATION, NILS_COORDINATION]),
  'agent-session.coordination.v1': disposition('coordination.coordination.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_COORDINATION, NILS_COORDINATION]),
  'agent-session.owner-liveness.v1': disposition('coordination.owner-liveness.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_COORDINATION, NILS_COORDINATION]),
  'agent-session.semantic-conflict.v1': disposition('coordination.semantic-conflict.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_COORDINATION, NILS_COORDINATION]),
  'block-claude-coauthor-trailer': disposition(
    'retirement.provider-claude.v1',
    'retired',
    DSH,
    [PROVIDER_RETIREMENT],
    {
      test_owner: PROVIDER_RETIREMENT,
      assertion: 'the shipped DSH runtime has no Claude provider or automatic Claude coauthor-trailer surface',
    },
  ),
  'block-direct-git-commit': disposition('policy.git-delivery.v1', PLANNED, NILS, [NILS_POLICY]),
  'block-direct-git-worktree': disposition('policy.git-delivery.v1', PLANNED, NILS, [NILS_POLICY]),
  'block-direct-pr-create': disposition('policy.git-delivery.v1', PLANNED, NILS, [NILS_POLICY]),
  'block-direct-python': disposition('policy.execution-owner.v1', PLANNED, NILS, [NILS_POLICY]),
  'block-project-memory-write': disposition(
    'policy.memory-boundary.v1',
    'implemented',
    `${DSH} + ${NILS}`,
    [DSH_DATA_POLICY, NILS_DATA_POLICY],
  ),
  'block-unsafe-default-delivery': disposition('policy.git-delivery.v1', PLANNED, NILS, [NILS_POLICY]),
  'checkout-lease-guard': disposition('policy.checkout-lease.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_POLICY, NILS_POLICY]),
  'execution.read-only.v1': disposition('policy.read-only-ingress.v1', 'implemented', NILS, [
    testOwner(NILS, 'crates/agent-hook/tests/read_only_capability.rs', ACTIVE),
    testOwner(NILS, 'crates/agent-hook/tests/dsh_ingress.rs', ACTIVE),
  ]),
  'finish-line-record': disposition('finish-line.enforcement.v1', PLANNED, `${DSH} + ${NILS}`, [
    testOwner(DSH, 'test/finish-line.test.mjs', PLANNED),
    testOwner(NILS, 'crates/agent-hook/tests/finish_line.rs', PLANNED),
  ]),
  'forge-label-reminder': disposition('guidance.forge-label.v1', PLANNED, NILS, [NILS_POLICY]),
  'mcp-secret-scan': disposition(
    'policy.secret-egress.v1',
    'implemented',
    `${DSH} + ${NILS}`,
    [DSH_DATA_POLICY, NILS_DATA_POLICY],
  ),
  'memory-write-principle-reminder': disposition('guidance.memory-boundary.v1', PLANNED, NILS, [NILS_POLICY]),
  'portable-paths-scan': disposition(
    'policy.portable-output.v1',
    'implemented',
    `${DSH} + ${NILS}`,
    [DSH_DATA_POLICY, NILS_DATA_POLICY],
  ),
  'pre-edit-intent-gate': disposition('policy.edit-admission.v1', PLANNED, `${DSH} + ${NILS}`, [DSH_POLICY, NILS_POLICY]),
  'semantic-commit-body-gate': disposition('policy.git-delivery.v1', PLANNED, NILS, [NILS_POLICY]),
  'session-start-healthcheck': disposition('operations.health.v1', 'implemented', DSH, [
    testOwner(DSH, 'test/runtime-health.test.mjs', ACTIVE),
    testOwner(DSH, 'test/runtime-health-provider.test.mjs', ACTIVE),
  ]),
  'skill-usage-reminder': disposition('context.skill-routing.v1', PLANNED, DSH, [
    testOwner(DSH, 'test/skill-routing.test.mjs', PLANNED),
  ]),
  'stop-finish-line-gate': disposition('finish-line.enforcement.v1', PLANNED, `${DSH} + ${NILS}`, [
    testOwner(DSH, 'test/finish-line.test.mjs', PLANNED),
    testOwner(NILS, 'crates/agent-hook/tests/finish_line.rs', PLANNED),
  ]),
  'stop-pre-pr-reminder': disposition('delivery.pre-pr.v1', PLANNED, `${DSH} + ${NILS}`, [
    testOwner(DSH, 'test/delivery.test.mjs', PLANNED),
    NILS_POLICY,
  ]),
  'user-prompt-agent-docs': disposition('context.selective.v1', PLANNED, `${DSH} + ${NILS}`, [
    testOwner(DSH, 'test/context.test.mjs', PLANNED),
    testOwner(NILS, 'crates/agent-docs/tests/integration/dsh_context.rs', PLANNED),
  ]),
  'user-prompt-agent-memory': disposition('context.private-profile.v1', PLANNED, DSH, [
    testOwner(DSH, 'test/private-context.test.mjs', PLANNED),
  ]),
}))

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function ruleIdDigest(rules) {
  return digest(`${rules.map(rule => rule.id).sort().join('\n')}\n`)
}

function canonicalSourceBytes(sourceBytes) {
  assert.ok(
    sourceBytes.length < 3
      || sourceBytes[0] !== 0xef
      || sourceBytes[1] !== 0xbb
      || sourceBytes[2] !== 0xbf,
    'legacy source contains an unsupported UTF-8 BOM',
  )
  const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
  const canonical = sourceText.replaceAll('\r\n', '\n')
  assert.ok(!canonical.includes('\r'), 'legacy source contains an unsupported lone CR')
  return Buffer.from(canonical, 'utf8')
}

export function verifyParityInventory(inventory) {
  assert.equal(inventory.schema_version, 'dsh-runtime-kit.rule-parity.v1')
  assert.ok(Array.isArray(inventory.capabilities))
  assert.ok(Array.isArray(inventory.rules))
  assert.deepEqual(inventory.source, EXPECTED_SOURCE, 'frozen source boundary drift')
  assert.deepEqual(
    inventory.test_owner_repositories,
    EXPECTED_OWNER_REPOSITORIES,
    'test owner repository boundary drift',
  )
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
  assert.equal(
    ruleIdDigest(inventory.rules),
    EXPECTED_SOURCE.normalized_rule_id_digest,
    'inventory rule ID boundary drift',
  )

  const capabilities = new Map(
    inventory.capabilities.map(capability => [capability.source_capability, capability]),
  )
  assert.equal(capabilities.size, EXPECTED_DISPOSITIONS.size)
  for (const [sourceCapability, expected] of EXPECTED_DISPOSITIONS) {
    const capability = capabilities.get(sourceCapability)
    assert.ok(capability, `missing capability disposition: ${sourceCapability}`)
    assert.deepEqual(
      capability,
      { source_capability: sourceCapability, ...expected },
      `capability disposition drift: ${sourceCapability}`,
    )
    const expectedOwnerState = capability.status === PLANNED ? PLANNED : ACTIVE
    assert.ok(capability.test_owners.length > 0, `missing test owner: ${sourceCapability}`)
    assert.ok(
      capability.test_owners.every(owner => owner.state === expectedOwnerState),
      `test owner state does not match capability status: ${sourceCapability}`,
    )
    assert.deepEqual(
      [...new Set(capability.test_owners.map(owner => owner.repository))].sort(),
      capability.owner.split(' + ').sort(),
      `test owner repository coverage drift: ${sourceCapability}`,
    )
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

/** @param {string} remote */
function normalizedRepositoryIdentity(remote) {
  const trimmed = remote.trim()
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed)
  if (scp !== null) return `${scp[1]}/${scp[2].replace(/\.git$/, '')}`
  try {
    const url = new URL(trimmed.replace(/^git\+/, ''))
    return `${url.hostname}/${url.pathname.replace(/^\//, '').replace(/\.git$/, '')}`
  } catch {
    return undefined
  }
}

/**
 * @param {string} root
 * @param {string[]} arguments_
 * @param {string} repository
 */
function gitOutput(root, arguments_, repository) {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  }
  for (const variable of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ]) delete environment[variable]
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', ['--no-replace-objects', '-C', root, ...arguments_], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new Error(`repository identity invalid: ${repository}`))
        return
      }
      resolvePromise(stdout.trim())
    })
  })
}

export async function verifyParityTestOwners(inventory, repositoryRoots) {
  const verified = verifyParityInventory(inventory)
  const roots = repositoryRoots instanceof Map
    ? repositoryRoots
    : new Map(Object.entries(repositoryRoots ?? {}))
  const activeOwners = new Map()
  for (const capability of verified.capabilities) {
    for (const owner of capability.test_owners) {
      if (owner.state === ACTIVE) {
        activeOwners.set(`${owner.repository}\0${owner.path}`, owner)
      }
    }
  }

  const activeRepositories = [...new Set(
    [...activeOwners.values()].map(owner => owner.repository),
  )].sort()
  const verifiedRoots = new Map()
  for (const repository of activeRepositories) {
    const configuredRoot = roots.get(repository)
    assert.equal(typeof configuredRoot, 'string', `missing repository root: ${repository}`)
    const root = await realpath(resolve(configuredRoot))
    const boundary = EXPECTED_OWNER_REPOSITORIES[repository]
    assert.ok(boundary !== undefined, `unknown owner repository: ${repository}`)
    const topLevel = await gitOutput(root, ['rev-parse', '--show-toplevel'], repository)
    assert.equal(await realpath(topLevel), root, `repository identity invalid: ${repository}`)
    const remote = await gitOutput(root, ['remote', 'get-url', 'origin'], repository)
    assert.equal(
      normalizedRepositoryIdentity(remote),
      boundary.identity,
      `repository identity invalid: ${repository}`,
    )
    const squash = TRUSTED_SQUASH_INTEGRATIONS[repository]
    if (squash?.evidence_commit === boundary.evidence_commit) {
      await gitOutput(root, ['cat-file', '-e', `${squash.merge_commit}^{commit}`], repository)
      await gitOutput(root, ['merge-base', '--is-ancestor', squash.merge_commit, 'HEAD'], repository)
    } else {
      await gitOutput(
        root,
        ['merge-base', '--is-ancestor', boundary.evidence_commit, 'HEAD'],
        repository,
      )
    }
    assert.equal(
      await gitOutput(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'], repository),
      '',
      `repository replacement objects are forbidden: ${repository}`,
    )
    verifiedRoots.set(repository, { root, boundary, squash })
  }

  const repositories = new Set()
  for (const owner of [...activeOwners.values()].sort((left, right) => (
    `${left.repository}/${left.path}`.localeCompare(`${right.repository}/${right.path}`)
  ))) {
    const verifiedRoot = verifiedRoots.get(owner.repository)
    assert.ok(verifiedRoot !== undefined, `missing repository root: ${owner.repository}`)
    const { root, boundary, squash } = verifiedRoot
    const candidate = resolve(root, owner.path)
    assert.ok(candidate.startsWith(`${root}${sep}`), `test owner escapes repository: ${owner.path}`)
    const metadata = await lstat(candidate)
    assert.ok(!metadata.isSymbolicLink(), `test owner must not be a symlink: ${owner.path}`)
    assert.ok(metadata.isFile(), `test owner must be a regular file: ${owner.path}`)
    const resolved = await realpath(candidate)
    assert.ok(resolved.startsWith(`${root}${sep}`), `test owner escapes repository: ${owner.path}`)
    assert.equal(
      await gitOutput(root, ['ls-files', '-v', '--', owner.path], owner.repository),
      `H ${owner.path}`,
      `test owner index flags are unsafe: ${owner.repository}/${owner.path}`,
    )
    const evidenceSubject = squash?.merge_commit ?? boundary.evidence_commit
    const [evidenceBlob, headBlob, workingBlob] = await Promise.all([
      gitOutput(
        root,
        ['rev-parse', `${evidenceSubject}:${owner.path}`],
        owner.repository,
      ),
      gitOutput(root, ['rev-parse', `HEAD:${owner.path}`], owner.repository),
      gitOutput(root, ['hash-object', '--no-filters', '--', owner.path], owner.repository),
    ])
    assert.equal(evidenceBlob, headBlob, `test owner evidence drift: ${owner.repository}/${owner.path}`)
    assert.equal(workingBlob, headBlob, `test owner working blob drift: ${owner.repository}/${owner.path}`)
    await gitOutput(root, ['diff', '--quiet', '--', owner.path], owner.repository)
    await gitOutput(root, ['diff', '--cached', '--quiet', '--', owner.path], owner.repository)
    repositories.add(owner.repository)
  }
  return {
    active_test_owner_count: activeOwners.size,
    repositories: [...repositories].sort(),
  }
}

export function verifyParitySource(sourceBytes, inventoryBytes) {
  const canonicalBytes = canonicalSourceBytes(sourceBytes)
  const source = parse(canonicalBytes.toString('utf8'))
  const inventory = verifyParityInventory(parse(inventoryBytes.toString('utf8')))
  assert.equal(source.schema_version, 'agent-runtime-kit.hook-rules.v1')
  assert.equal(digest(canonicalBytes), inventory.source.file_digest)
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
  stream.write('dsh-runtime-kit-check-parity <legacy-hook-rules.yaml> --owner-root <repository=path>...\n')
  stream.write('Verify the frozen dsh-runtime-kit parity inventory against its retained source.\n')
}

function parseArguments(arguments_) {
  if (arguments_.length === 1 && ['--help', '-h'].includes(arguments_[0])) {
    return { help: true, sourcePath: undefined, repositoryRoots: new Map() }
  }
  const sourcePath = arguments_[0]
  const repositoryRoots = new Map()
  for (let index = 1; index < arguments_.length; index += 1) {
    assert.equal(arguments_[index], '--owner-root', `unknown argument: ${arguments_[index]}`)
    const assignment = arguments_[index + 1]
    assert.ok(assignment !== undefined, '--owner-root requires repository=path')
    const separator = assignment.indexOf('=')
    assert.ok(separator > 0 && separator < assignment.length - 1, 'invalid --owner-root value')
    const repository = assignment.slice(0, separator)
    const path = assignment.slice(separator + 1)
    assert.ok(!repositoryRoots.has(repository), `duplicate repository root: ${repository}`)
    repositoryRoots.set(repository, path)
    index += 1
  }
  return { help: false, sourcePath, repositoryRoots }
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : await realpath(resolve(process.argv[1])).catch(() => undefined)
if (invokedPath === fileURLToPath(import.meta.url)) {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    usage(process.stdout)
  } else if (arguments_.sourcePath === undefined) {
    usage(process.stderr)
    process.exitCode = 64
  } else {
    const sourcePath = arguments_.sourcePath
    const inventoryPath = new URL('../policy/rule-parity.yaml', import.meta.url)
    const [sourceBytes, inventoryBytes] = await Promise.all([
      readFile(resolve(sourcePath)),
      readFile(inventoryPath),
    ])
    const result = verifyParitySource(sourceBytes, inventoryBytes)
    const owners = await verifyParityTestOwners(
      parse(inventoryBytes.toString('utf8')),
      arguments_.repositoryRoots,
    )
    process.stdout.write(`${JSON.stringify({
      ...result,
      active_test_owner_count: owners.active_test_owner_count,
      test_owner_repositories: owners.repositories,
      source: resolve(sourcePath),
    })}\n`)
  }
}
