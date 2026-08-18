import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const skillsRoot = join(projectRoot, 'skills')
const expectedSkills = [
  'bootstrap',
  'code-review-specialists',
  'create-project-skill',
  'create-skill',
  'daily-brief',
  'deliver-dispatch-plan',
  'deliver-plan-tracking-issue',
  'deliver-pr',
  'deploy',
  'discussion-to-implementation-doc',
  'execution-capsule',
  'guided-feature-build',
  'handoff-session-prompt',
  'image-processing',
  'issue-follow-up',
  'issue-triage',
  'macos-desktop',
  'main-agent-mode',
  'nils-cli-bump',
  'project-retro',
  'release',
  'remove-project-skill',
  'remove-skill',
  'repo-docs-boundary',
  'screen-record',
  'setup-project',
  'sync-runtime-surfaces',
  'topic-radar',
  'worktree-triage',
]

const expectedResources = [
  'code-review-specialists/references/DELIVERY_REVIEW_OUTCOME_COMMENT.md',
  'code-review-specialists/references/DELIVERY_REVIEW_OUTCOME_SCHEMA.md',
  'code-review-specialists/references/DELIVERY_SPECIALIST_REVIEW_GATE.md',
  'code-review-specialists/references/REVIEW_OUTCOME_POSTING_CONTRACT.md',
  'code-review-specialists/references/SPECIALIST_REVIEW_COMMENT.md',
  'code-review-specialists/references/SPECIALIST_REVIEW_CONTRACT.md',
  'code-review-specialists/references/SPECIALIST_REVIEW_REPORT_TEMPLATE.md',
  'code-review-specialists/references/specialists/api-contract.md',
  'code-review-specialists/references/specialists/data-migration.md',
  'code-review-specialists/references/specialists/maintainability.md',
  'code-review-specialists/references/specialists/performance.md',
  'code-review-specialists/references/specialists/red-team.md',
  'code-review-specialists/references/specialists/security.md',
  'code-review-specialists/references/specialists/testing.md',
  'deliver-dispatch-plan/references/DISPATCH_ISSUE_RECORD_CONTRACT.md',
  'deliver-dispatch-plan/references/LOCAL_REHEARSAL.md',
  'deliver-dispatch-plan/references/MAIN_AGENT_REVIEW_RUBRIC.md',
  'deliver-dispatch-plan/references/POST_REVIEW_OUTCOMES.md',
  'deliver-dispatch-plan/references/TASK_LANE_CONTINUITY.md',
  'deliver-dispatch-plan/references/outcome-routing.md',
  'deliver-dispatch-plan/references/skill-family.md',
  'deliver-plan-tracking-issue/references/outcome-routing.md',
  'deliver-pr/references/pr-lifecycle.md',
  'guided-feature-build/references/DELEGATION_PROTOCOL.md',
  'guided-feature-build/references/prompts/architect.md',
  'guided-feature-build/references/prompts/explorer.md',
  'issue-follow-up/references/issue-lifecycle.md',
  'macos-desktop/references/setup.md',
  'main-agent-mode/references/MAIN_AGENT_MODE_PROTOCOL.md',
  'setup-project/scripts/setup-project.sh',
  'topic-radar/bin/topic_radar.py',
  'topic-radar/references/source-strategy.md',
  'topic-radar/scripts/topic-radar.sh',
  'worktree-triage/bin/worktree_triage.py',
  'worktree-triage/scripts/worktree-triage.sh',
]

function collectFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory()
      ? collectFiles(join(directory, entry.name), relative)
      : [relative]
  })
}

test('the public DSH bundle owns the complete 29-skill catalog', () => {
  const actual = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  assert.deepEqual(actual, expectedSkills)
  const expectedFiles = [
    ...expectedSkills.map(name => `${name}/SKILL.md`),
    ...expectedResources,
  ].sort()
  assert.deepEqual(collectFiles(skillsRoot).sort(), expectedFiles)

  for (const name of actual) {
    const content = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8')
    assert.match(content, /^---\n/)
    assert.match(content, new RegExp(`\\nname: ${name}\\n`))
    assert.match(content, /\ndescription: [>|]/)
  }
})

test('public skill instructions do not route through retired agent runtimes', () => {
  const forbidden = [
    /\$CODEX_HOME/,
    /\.codex\//,
    /\.claude\//,
    /\bcodex\b/i,
    /\bclaude\b/i,
    /\bhermes\b/i,
    /agent-runtime-kit/i,
    /agent-runtime render/,
  ]
  const violations = []
  for (const name of expectedSkills) {
    const content = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8')
    for (const pattern of forbidden) {
      if (pattern.test(content)) violations.push(`${name}: ${pattern}`)
    }
  }
  assert.deepEqual(violations, [])
})

test('the public skill artifact contains no named private profile', () => {
  const violations = []
  for (const relative of collectFiles(skillsRoot)) {
    const content = readFileSync(join(skillsRoot, relative), 'utf8')
    if (/\bterry\b|terry-ai-tech/i.test(content)) violations.push(relative)
  }
  assert.deepEqual(violations, [])
})

test('relative Markdown resource links stay inside the complete package', () => {
  const missing = []
  for (const relative of collectFiles(skillsRoot).filter(path => path.endsWith('.md'))) {
    const content = readFileSync(join(skillsRoot, relative), 'utf8')
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#', 1)[0]
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const resolved = resolve(skillsRoot, dirname(relative), target)
      if (!resolved.startsWith(`${projectRoot}/`) || !existsSync(resolved)) {
        missing.push(`${relative} -> ${match[1]}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('mandatory workflow policy references resolve to DSH-owned public resources', () => {
  const expectedPolicies = [
    'external-facts.md',
    'git-delivery.md',
    'heuristic-error-inbox.md',
    'review-thread-convergence.md',
  ]
  const policyRoot = join(projectRoot, 'docs', 'policies')
  assert.deepEqual(
    readdirSync(policyRoot, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort(),
    expectedPolicies,
  )

  const unresolvedLegacyReferences = []
  for (const relative of collectFiles(skillsRoot).filter(path => path.endsWith('.md'))) {
    const content = readFileSync(join(skillsRoot, relative), 'utf8')
    for (const match of content.matchAll(/core\/policies\/[a-z0-9_./-]+/gi)) {
      unresolvedLegacyReferences.push(`${relative} -> ${match[0]}`)
    }
  }
  assert.deepEqual(unresolvedLegacyReferences, [])

  for (const policy of expectedPolicies) {
    const content = readFileSync(join(policyRoot, policy), 'utf8')
    assert.match(content, /^# /)
    assert.doesNotMatch(content, /\bCodex\b|\.codex\//i)
  }
})

test('nils-cli compatibility is machine-readable and honest about pending DSH ingress release', () => {
  const path = join(projectRoot, 'compatibility', 'nils-cli.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.schema_version, 'dsh-runtime-kit.nils-compatibility.v1')
  assert.equal(manifest.status, 'pending-release')
  assert.equal(manifest.minimum_supported_release, null)
  assert.equal(manifest.validated_release, null)
  assert.ok(Array.isArray(manifest.commands))
  assert.ok(manifest.commands.length > 1)
  assert.equal(new Set(manifest.commands.map(command => command.id)).size, manifest.commands.length)

  for (const command of manifest.commands) {
    assert.match(command.id, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
    assert.match(command.binary, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(['released', 'pending-release'].includes(command.status))
    assert.ok(Array.isArray(command.contracts) && command.contracts.length > 0)
  }

  const ingress = manifest.commands.find(command => command.id === 'agent-hook.dispatch.dsh')
  assert.deepEqual(ingress, {
    id: 'agent-hook.dispatch.dsh',
    binary: 'agent-hook',
    status: 'pending-release',
    validation: 'source-validated',
    contracts: [
      'agent-hook.dsh-ingress.v1',
      'cli.agent-hook.dispatch.v1',
      'agent-hook.normalized-decision.v1',
    ],
    source_task: 'sympoies/nils-cli task 1.3',
  })
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-docs.session.context.dsh'),
    {
      id: 'agent-docs.session.context.dsh',
      binary: 'agent-docs',
      status: 'pending-release',
      validation: 'source-validated',
      contracts: [
        'cli.agent-docs.session.context.v1',
        'decision.context.v1',
        'agent-docs.session.v2',
      ],
      source_task: 'sympoies/nils-cli task 2.2',
    },
  )
})

test('greenfield evidence labels the initial module-absence run as setup failure', () => {
  const evidence = readFileSync(join(projectRoot, 'docs', 'test-first-evidence.md'), 'utf8')
  assert.match(evidence, /module-absence setup failure/i)
  assert.match(evidence, /not a meaningful behavioral red/i)
  assert.match(evidence, /packed DSH smoke/i)
  assert.match(evidence, /final contract suite/i)
})
