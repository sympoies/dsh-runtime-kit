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

test('code review routes quick, focused, specialist, and red-team work through the native tool', () => {
  const content = readFileSync(join(skillsRoot, 'code-review-specialists', 'SKILL.md'), 'utf8')
  for (const marker of [
    '**Quick**',
    '**Focused**',
    '**Specialist**',
    '`reviewer-quick`',
    '`reviewer-testing`',
    '`reviewer-maintainability`',
    '`reviewer-red-team`',
    '`review_specialists`',
    '`task` and `roles`',
  ]) {
    assert.match(content, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(content, /include `reviewer-red-team` in the same call/i)
  assert.match(content, /runs it only after the first wave/i)
  assert.doesNotMatch(content, /Select one canonical role per call/)
  assert.doesNotMatch(content, /\b(?:quick|testing|security|red-team)\b[^\n]*role per call/i)
})

test('provider review publication uses one canonical App report and metadata-only provenance', () => {
  const posting = readFileSync(
    join(
      skillsRoot,
      'code-review-specialists',
      'references',
      'REVIEW_OUTCOME_POSTING_CONTRACT.md',
    ),
    'utf8',
  )
  const deliverPr = readFileSync(join(skillsRoot, 'deliver-pr', 'SKILL.md'), 'utf8')
  const dispatch = readFileSync(join(skillsRoot, 'deliver-dispatch-plan', 'SKILL.md'), 'utf8')
  const tracking = readFileSync(
    join(skillsRoot, 'deliver-plan-tracking-issue', 'SKILL.md'),
    'utf8',
  )
  const specialistContract = readFileSync(
    join(
      skillsRoot,
      'code-review-specialists',
      'references',
      'SPECIALIST_REVIEW_CONTRACT.md',
    ),
    'utf8',
  )
  for (const marker of [
    '--profile provider-review',
    '--specialist-report',
    '--metadata-only',
    '--native-review-url',
    '--native-review-author',
    'complete report body exactly once',
    'must not pass `--comment-file`',
  ]) {
    assert.match(posting, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(
    posting,
    /\| Finding \| Severity \| Confidence \| Evidence \| Recommendation \|/u,
  )
  assert.match(specialistContract, /"actionable": true/u)
  assert.match(specialistContract, /- `actionable`/u)
  const publisherSection = posting.slice(
    posting.indexOf("The governed publisher's semantic interface is:"),
    posting.indexOf('\n## Command\n'),
  )
  assert.match(publisherSection, /ISSUE_MIRROR_ARGS=\(\)/u)
  assert.match(publisherSection, /"\$\{ISSUE_MIRROR_ARGS\[@\]\}"/u)
  assert.doesNotMatch(
    publisherSection.slice(publisherSection.indexOf('forge-review-publish')),
    /--issue "\$ISSUE"/u,
  )

  for (const marker of [
    'review-specialists bundle',
    'REVIEW_COMMENT_FILE="$REVIEW_BUNDLE_DIR/provider-review.md"',
    'REVIEW_THREAD_FILE="$REVIEW_BUNDLE_DIR/review-threads.json"',
    '--specialist-report',
    '--check-diff',
    'command -v forge-review-publish',
    'forge-review-publish --provider github',
    'forge-cli --provider "$PROVIDER" pr review',
  ]) {
    assert.match(tracking, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(deliverPr, /governed-vs-portable publication branch/u)
  assert.match(deliverPr, /forge-cli >=1\.27\.27/u)
  assert.match(deliverPr, /review-specialists >=1\.27\.29/u)
  assert.match(dispatch, /forge-cli >=1\.27\.27/u)
  assert.match(dispatch, /review-specialists >=1\.27\.29/u)
  assert.match(tracking, /forge-cli >=1\.27\.27/u)
  assert.match(tracking, /review-specialists >=1\.27\.29/u)
})

test('review convergence bounds broad discovery and keeps repair review closed-set', () => {
  const agentPolicy = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
  const convergence = readFileSync(
    join(projectRoot, 'docs', 'policies', 'review-thread-convergence.md'),
    'utf8',
  )
  const reviewSkill = readFileSync(join(skillsRoot, 'code-review-specialists', 'SKILL.md'), 'utf8')
  const reviewGate = readFileSync(
    join(skillsRoot, 'code-review-specialists', 'references', 'DELIVERY_SPECIALIST_REVIEW_GATE.md'),
    'utf8',
  )
  const reviewContract = readFileSync(
    join(skillsRoot, 'code-review-specialists', 'references', 'SPECIALIST_REVIEW_CONTRACT.md'),
    'utf8',
  )
  const quickReviewer = readFileSync(join(projectRoot, 'agents', 'reviewers', 'reviewer-quick.md'), 'utf8')
  const deliveryOwners = [
    'deliver-pr',
    'deliver-plan-tracking-issue',
    'deliver-dispatch-plan',
  ].map(name => readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'))

  assert.match(agentPolicy, /possible improvement is not incompleteness/i)
  assert.match(convergence, /Each discovery generation has at most one broad review\./)
  assert.match(convergence, /closed-set closure review/i)
  assert.match(convergence, /any head change that materially changes/i)
  assert.match(reviewSkill, /Admit a new finding only when[^.]+repair introduced a material/i)
  assert.match(reviewSkill, /legacy size-only result to not selected/i)
  assert.match(reviewSkill, /completed `findings` verdict[\s\S]*?does\s+not itself make them blocking/i)
  assert.match(reviewSkill, /During closure, escalation permits at most the one named directly\s+relevant specialist/i)
  assert.match(reviewGate, /Evidence alone does not make a concern blocking\./)
  assert.match(reviewGate, /Low and informational observations never block delivery\./)
  assert.match(reviewGate, /finite set of unresolved admitted\s+findings/i)
  assert.match(reviewGate, /unresolved-state disqualifier applies only to initial\s+discovery/i)
  assert.match(reviewContract, /Raw diff size alone does not activate red-team\./)
  assert.match(reviewContract, /smallest sufficient local repair/i)
  assert.match(quickReviewer, /Do not list skipped areas for completeness\./)
  for (const owner of deliveryOwners) {
    assert.match(owner, /closed-set admission rule/i)
    assert.match(owner, /without extending the repair loop for a\s+non-admitted concern/i)
    assert.match(owner, /admitted\s+blocking findings only/i)
    assert.match(owner, /materially\s+changes the accepted design, public\s+contract, trust boundary, or\s+migration strategy/i)
  }

  assert.doesNotMatch(reviewGate, /Repeat review and repair until no concrete unresolved findings remain/i)
  assert.doesNotMatch(reviewContract, /Run `red-team`[^\n]+when either condition is true:[\s\S]*?- `diff_lines > 200`\n/i)
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
    'upstream-contribution.md',
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

  const agentPolicy = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8')
  const upstreamPolicy = readFileSync(
    join(policyRoot, 'upstream-contribution.md'),
    'utf8',
  )
  assert.match(agentPolicy, /docs\/policies\/upstream-contribution\.md/u)
  assert.match(agentPolicy, /exhaust its downstream-first\s+order/u)
  assert.match(agentPolicy, /Agents may only draft third-party issues or PRs/u)
  assert.match(agentPolicy, /a human submits them\s+and signs any DCO or CLA/u)
  assert.match(agentPolicy, /Never publish a security defect or internal data\./u)
  assert.match(upstreamPolicy, /If only this runtime kit needs the boundary,\s+it stays downstream\./u)
  assert.match(upstreamPolicy, /must not submit\s+the issue, open the PR, or sign a DCO or CLA/u)
  assert.match(upstreamPolicy, /security defect is never reported publicly/u)
  assert.match(upstreamPolicy, /Never publish credentials,\s+private content,\s+machine paths/u)
  assert.doesNotMatch(upstreamPolicy, /agent-runtime-kit|github\.com\/sympoies\/agent-runtime-kit/iu)
  assert.match(upstreamPolicy, /^## Authorization boundary$/mu)
  assert.match(upstreamPolicy, /^## Escalation order$/mu)
  assert.match(upstreamPolicy, /^## Issue or pull request$/mu)
  assert.match(upstreamPolicy, /^## Contribution rules are a blocking gate$/mu)
  assert.match(upstreamPolicy, /^## Public evidence and disclosure$/mu)
  assert.match(upstreamPolicy, /^## Identity, licensing, and attribution$/mu)
  assert.match(upstreamPolicy, /^## Aftercare$/mu)
  assert.doesNotMatch(
    upstreamPolicy,
    /Follow the full .*policy|canonical policy.*https?:\/\//iu,
  )

  const requiredUpstreamPolicyBoundaries = [
    /another repository owned by the same organization continues through\s+that repository's normal governed issue and delivery workflows when the user\s+has authorized it/u,
    /must not submit\s+the issue, open the PR, or sign a DCO or CLA/u,
    /human maintainer performs those publicly attributed or legally significant\s+actions and chooses the account and email/u,
    /Configuration or a supported extension point[\s\S]*A local adapter or wrapper[\s\S]*Pinning or moving the external project's version[\s\S]*version-scoped, hash-authenticated downstream patch[\s\S]*A contribution to the other repository/u,
    /Search existing issues, pull requests, and discussions before drafting[\s\S]*merged to the default branch but not yet released/u,
    /For a bug, an issue and pull request may be prepared together/u,
    /For anything that is not a bug, prepare an issue first[\s\S]*until a maintainer responds positively/u,
    /public API or\s+schema, adds a dependency, requires a migration, changes a documented\s+default, or requires new documentation/u,
    /verify and record the applicable\s+rules from the exact project and target branch/u,
    /CONTRIBUTING\.md.*CODE_OF_CONDUCT\.md.*SECURITY\.md[\s\S]*DCO or CLA requirements[\s\S]*issue and pull-request templates[\s\S]*title conventions[\s\S]*test and lint commands[\s\S]*target-branch rules[\s\S]*required submission language/u,
    /Unverified requirements are a blocker, not a reason to assume conventional\s+defaults/u,
    /security defect is never reported publicly[\s\S]*SECURITY\.md` private disclosure route[\s\S]*If no private route is published[\s\S]*make no public report/u,
    /minimal, de-identified reproduction[\s\S]*tests using that project's own framework and conventions[\s\S]*observed and expected behavior[\s\S]*exact external version or commit/u,
    /Internal validation, DSH smoke runs, patch apply or\s+reverse receipts, private logs, and local workflow evidence stay with this\s+repository/u,
    /Never publish credentials,\s+private content, machine paths, internal hosts, private topology, private skill\s+contents, employer or client names that are not already public, or internal\s+identifiers/u,
    /link to this repository's workaround is optional[\s\S]*target is public and contains no internal information[\s\S]*downstream expedient/u,
    /human chooses the account and email that determine personal or employer\s+attribution/u,
    /must not sign a DCO or CLA or accept another legal contribution\s+agreement/u,
    /Do not add a `Co-Authored-By: Claude` trailer/u,
    /Disclose AI assistance when the other project's rules require it/u,
    /accepted submission as an ongoing obligation[\s\S]*answer review[\s\S]*rebase when required[\s\S]*terminal outcome/u,
    /If it is rejected or becomes stale, retain the downstream workaround and\s+record the result with its owner/u,
    /record the public link beside that patch[\s\S]*once the fix is released and the supported\s+version has moved, remove the patch through its normal authenticated lifecycle/u,
  ]
  for (const boundary of requiredUpstreamPolicyBoundaries) {
    assert.match(upstreamPolicy, boundary)
  }
})

test('repository agent-docs semantic smoke is wired to the documented product entrypoints', () => {
  const development = readFileSync(join(projectRoot, 'DEVELOPMENT.md'), 'utf8')
  const packageManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  const compatibilityWorkflow = readFileSync(
    join(projectRoot, '.github', 'workflows', 'compatibility.yml'),
    'utf8',
  )
  const contributorEditContract = readFileSync(
    join(projectRoot, 'PROJECT_DEV_EDIT.md'),
    'utf8',
  )

  assert.equal(readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n')
  assert.doesNotMatch(contributorEditContract, /DeepSeek|\bDSH\b|DSH runtime/iu)
  assert.equal(
    packageManifest.scripts['test:agent-docs-catalog'],
    'node test/agent-docs-catalog-smoke.mjs',
  )
  assert.match(compatibilityWorkflow, /name: Validate repository agent-docs loading contract/u)
  assert.match(compatibilityWorkflow, /AGENT_DOCS_BIN:[^\n]*agent-docs/u)
  assert.match(compatibilityWorkflow, /AGENT_HOOK_BIN:[^\n]*agent-hook/u)
  assert.match(compatibilityWorkflow, /run: npm run test:agent-docs-catalog/u)

  assert.match(development, /--phase edit[\s\\]+\n\s+--strict --require-declared-intent/u)
  assert.match(development, /Two catalogs intentionally coexist\./u)
  assert.match(development, /\| Harness \| `AGENTS\.md` \| Codex, Hermes, DSH/u)
  assert.match(development, /\| Harness \| `CLAUDE\.md` → `@AGENTS\.md` \| Claude/u)
  assert.match(
    development,
    /\| Root catalog \| `PROJECT_DEV_EDIT\.md` \| Codex, Claude, Hermes \| `project-dev` \/ `edit` \| yes/u,
  )
  assert.match(
    development,
    /\| Root catalog \| `DEVELOPMENT\.md` \| Codex, Claude, Hermes \| `project-dev` \/ `edit`, `delivery` \| no/u,
  )
  assert.match(
    development,
    /\| Root catalog \| `docs\/policies\/upstream-contribution\.md` \| Codex, Claude, Hermes \| `project-dev` \/ `delivery` \| no in the catalog/u,
  )
  assert.match(
    development,
    /\| Packaged DSH catalog \| installed `PROJECT_DEV_EDIT\.md` \(source: `agent-docs\/PROJECT_DEV_EDIT\.md`\) \| DSH \| `project-dev` \/ `edit` \| yes/u,
  )
  assert.match(development, /after\s+the final mutation and before declaring the task complete/u)
  assert.match(development, /authoritative finish-line resolver/u)
  assert.match(development, /they are not automatic model context/u)
})

test('nils-cli compatibility is machine-readable and pinned to the current DSH-capable release', () => {
  const path = join(projectRoot, 'compatibility', 'nils-cli.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(manifest.schema_version, 'dsh-runtime-kit.nils-compatibility.v1')
  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.17')
  assert.equal(manifest.validated_release, '1.27.34')
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
    status: 'released',
    validation: 'release-artifact-validated',
    contracts: [
      'agent-hook.dsh-ingress.v1',
      'agent-hook.dsh-ingress.v2',
      'agent-hook.dsh-ingress.v3',
      'agent-hook.dsh-ingress.v4',
      'agent-hook.dsh-ingress.v5',
      'agent-hook.policy.v1',
      'dsh.policy.v1',
      'cli.agent-hook.dispatch.v1',
      'agent-hook.normalized-decision.v1',
    ],
    source_tasks: [
      'sympoies/nils-cli task 1.3',
      'sympoies/nils-cli task 3.2',
      'sympoies/nils-cli task 3.3',
      'sympoies/nils-cli task 3.4',
      'sympoies/nils-cli#1491',
      'sympoies/nils-cli#1497',
      'sympoies/nils-cli#1541',
    ],
  })
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-docs.session.context.dsh'),
    {
      id: 'agent-docs.session.context.dsh',
      binary: 'agent-docs',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'cli.agent-docs.session.context.v1',
        'decision.context.v1',
        'agent-docs.session.v2',
      ],
      source_task: 'sympoies/nils-cli task 2.2',
    },
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-docs.session.prerequisite.dsh'),
    {
      id: 'agent-docs.session.prerequisite.dsh',
      binary: 'agent-docs',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'cli.agent-docs.session.prerequisite.v1',
        'decision.prerequisite.v1',
        'agent-docs.session.v2',
      ],
      source_task: 'sympoies/nils-cli#1497',
    },
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-docs.session.commit-prerequisite.dsh'),
    {
      id: 'agent-docs.session.commit-prerequisite.dsh',
      binary: 'agent-docs',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'cli.agent-docs.session.commit-prerequisite.v1',
        'agent-docs.session.v2',
      ],
      source_task: 'sympoies/nils-cli#1497',
    },
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-hook.finish-line.dsh'),
    {
      id: 'agent-hook.finish-line.dsh',
      binary: 'agent-hook',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'agent-hook.finish-line.open.v1',
        'cli.agent-hook.finish-line-open.v1',
        'agent-hook.finish-line.open-result.v1',
        'agent-hook.finish-line.begin.v1',
        'cli.agent-hook.finish-line-begin.v1',
        'agent-hook.finish-line.begin-result.v1',
        'agent-hook.finish-line.run.v1',
        'cli.agent-hook.finish-line-run.v1',
        'agent-hook.finish-line.run-result.v1',
        'agent-hook.finish-line.stop.v1',
        'cli.agent-hook.finish-line-stop.v1',
        'agent-hook.finish-line.stop-result.v1',
        'agent-hook.finish-line.quiesce.v1',
        'cli.agent-hook.finish-line-quiesce.v1',
        'agent-hook.finish-line.quiesce-result.v1',
        'agent-hook.finish-line.release.v1',
        'cli.agent-hook.finish-line-release.v1',
        'agent-hook.finish-line.release-result.v1',
        'agent-hook.finish-line.register.v1',
        'cli.agent-hook.finish-line-register.v1',
        'agent-hook.finish-line.register-result.v1',
        'agent-hook.finish-line.admit.v1',
        'cli.agent-hook.finish-line-admit.v1',
        'agent-hook.finish-line.admit-result.v1',
        'agent-hook.finish-line.observe.v1',
        'cli.agent-hook.finish-line-observe.v1',
        'agent-hook.finish-line.observe-result.v1',
        'agent-hook.finish-line.verdict.v1',
        'cli.agent-hook.finish-line-verdict.v1',
        'agent-hook.finish-line.verdict-result.v1',
      ],
      source_tasks: [
        'sympoies/nils-cli task 2.3',
        'sympoies/nils-cli#1503',
        'sympoies/nils-cli#1568',
        'sympoies/nils-cli#1595',
      ],
    },
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-hook.workspace-recovery.dsh'),
    {
      id: 'agent-hook.workspace-recovery.dsh',
      binary: 'agent-hook',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'agent-hook.workspace-recovery.inspect.v1',
        'cli.agent-hook.workspace-recovery-inspect.v1',
        'agent-hook.workspace-recovery.verify-handoff.v1',
        'cli.agent-hook.workspace-recovery-verify-handoff.v1',
        'agent-hook.workspace-recovery.result.v1',
      ],
      source_task: 'sympoies/nils-cli#1535',
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

test('integration branch delivery surfaces declare protection and exact-base ownership', () => {
  const triage = readFileSync(join(skillsRoot, 'worktree-triage', 'SKILL.md'), 'utf8')
  const delivery = readFileSync(join(skillsRoot, 'deliver-pr', 'SKILL.md'), 'utf8')
  const dispatch = readFileSync(join(skillsRoot, 'deliver-dispatch-plan', 'SKILL.md'), 'utf8')
  const tracking = readFileSync(
    join(skillsRoot, 'deliver-plan-tracking-issue', 'SKILL.md'),
    'utf8',
  )
  const policy = readFileSync(join(projectRoot, 'docs', 'policies', 'git-delivery.md'), 'utf8')
  const manifest = JSON.parse(readFileSync(
    join(projectRoot, 'compatibility', 'nils-cli.json'),
    'utf8',
  ))

  assert.match(triage, /--protect-branch <branch>/)
  assert.match(triage, /git-cli sync-branch/)
  assert.match(delivery, /forge-cli >=1\.27\.27/)
  assert.match(delivery, /exact base instead of falling back to the provider default/)
  assert.match(dispatch, /forge-cli >=1\.27\.27/)
  assert.match(tracking, /forge-cli >=1\.27\.27/)
  assert.match(tracking, /--head "\$BRANCH" --base "\$BASE_REF"/)
  assert.doesNotMatch(tracking, /--head "\$BRANCH" --base main/)
  assert.match(policy, /same-head PR targeting another base\s+is not an adoptable substitute/)

  assert.deepEqual(
    manifest.commands.find(command => command.id === 'git-cli.sync-branch'),
    {
      id: 'git-cli.sync-branch',
      binary: 'git-cli',
      status: 'released',
      validation: 'release-artifact-validated',
      contracts: [
        'git-cli sync-branch',
        'same-name tracked non-default branch synchronization',
        'exact single-branch fetch followed by clean fast-forward-only merge',
      ],
      source_task: 'sympoies/nils-cli#1533',
    },
  )
  assert.ok(
    manifest.commands
      .find(command => command.id === 'forge-cli.pr-deliver')
      .contracts
      .includes('exact requested-base binding across lookup, adoption, create readback, readiness, and merge'),
  )
})
