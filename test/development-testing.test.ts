import assert from 'node:assert/strict'
import { access, constants, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

function documentBlock(catalog: string, path: string): string | undefined {
  return catalog
    .split(/(?=\[\[document\]\])/u)
    .find((block) => block.includes(`path = "${path}"`))
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  assert.notEqual(start, -1, `missing section: ${heading}`)
  const level = heading.match(/^#+/u)?.[0].length ?? 0
  const remainder = markdown.slice(start + heading.length)
  const nextHeading = new RegExp(`^#{1,${level}}\\s`, 'mu').exec(remainder)
  return remainder.slice(0, nextHeading?.index ?? remainder.length)
}

function assertOrdered(text: string, clauses: string[]): void {
  let cursor = -1
  for (const clause of clauses) {
    const index = text.indexOf(clause)
    assert.ok(index > cursor, `missing or out-of-order clause: ${clause}`)
    cursor = index
  }
}

function normalizedSection(markdown: string, heading: string): string {
  return markdownSection(markdown, heading).replace(/\s+/gu, ' ')
}

test('layered development policy is mandatory and routed through the project skill', async () => {
  const [agents, catalog, development] = await Promise.all([
    readFile(new URL('AGENTS.md', root), 'utf8'),
    readFile(new URL('AGENT_DOCS.toml', root), 'utf8'),
    readFile(new URL('DEVELOPMENT.md', root), 'utf8'),
  ])

  assert.match(agents, /project-runtime-development/u)
  assert.match(agents, /docs\/development-testing\.md/u)
  assert.match(agents, /stop and replan/iu)
  assert.match(development, /Layered development and testing/u)

  const block = documentBlock(catalog, 'docs/development-testing.md')
  assert.ok(block, 'AGENT_DOCS.toml must declare the layered development policy')
  assert.match(block, /context = "project-dev"/u)
  assert.match(block, /product = \["codex", "claude", "hermes"\]/u)
  assert.match(block, /phase = \["edit", "delivery"\]/u)
  assert.match(block, /required = true/u)
  assert.match(catalog, /production = \[[^\n]*"\.agents\/\*\*"/u)
})

test('project runtime development skill applies one canonical policy and closes its improvement loop', async () => {
  const skillPath = new URL('.agents/skills/project-runtime-development/SKILL.md', root)
  await access(skillPath, constants.R_OK)

  const skill = await readFile(skillPath, 'utf8')
  assert.match(skill, /^name: project-runtime-development$/mu)
  assert.match(skill, /docs\/development-testing\.md/u)
  const workflow = normalizedSection(skill, '## Workflow')
  assert.match(workflow, /declared required layers/iu)
  assert.match(workflow, /Invalidation prevents reuse.*does not by\s+itself require/isu)
  assert.match(workflow, /authenticated tool identity.*permission mode.*expected induction.*installed-tree identity.*attestation/isu)
  assert.match(workflow, /usage_limit_reached.*keep the candidate frozen.*do not switch provider or model/isu)
  assert.match(workflow, /same-digest rule.*prior run.*independent attestations/isu)
  assert.match(workflow, /generic failure.*same layer fails again.*stop and replan/isu)
  assert.match(skill, /## Self-improvement loop/u)
  assert.match(skill, /does not grant/iu)
  for (const owner of ['nils-cli', 'dsh-runtime-kit', 'dsh-applications', 'sympoies-infra']) {
    assert.match(skill, new RegExp(owner, 'u'))
  }
})

test('canonical policy orders independently diagnosable runtime-kit validation layers', async () => {
  const policy = await readFile(new URL('docs/development-testing.md', root), 'utf8')
  const orderedLayers = [
    'Contract and owner tests',
    'Adapter and authenticated-boundary tests',
    'Build, package, and installed-identity tests',
    'Runtime and versioned DSH smoke',
    'Single-scenario real-provider acceptance',
    'Full external-harness matrix',
    'Hosted promotion',
  ]
  let cursor = -1
  for (const layer of orderedLayers) {
    const index = policy.indexOf(layer)
    assert.ok(index > cursor, `missing or out-of-order layer: ${layer}`)
    cursor = index
  }

  const validationMap = normalizedSection(policy, '## Validation map')
  assert.match(validationMap, /Each layer emits its own bounded.*stage\/code receipt/isu)
  assert.match(validationMap, /Do not run duplicate full suites concurrently/iu)

  const adapters = normalizedSection(policy, '### 2. Adapter and authenticated-boundary tests')
  assert.match(adapters, /ordinary `subagent` does not prove.*`review_specialists`/isu)
  assert.match(adapters, /exact caller-facing.*tool.*role.*authority.*permission mode/isu)
  assert.match(adapters, /Expected induction.*registered typed induction record.*observable state unchanged/isu)
  assert.match(adapters, /must not be represented as a failing registered validation.*finish line.*conceal/isu)
  assert.match(adapters, /Recovery is a separate phase.*marker.*attestation/isu)

  const packaging = normalizedSection(policy, '### 3. Build, package, and installed-identity tests')
  assert.match(packaging, /`npm pack` does not build.*rejects lifecycle hooks/isu)
  assert.match(packaging, /build provenance.*executable roles.*package\.json#bin/isu)
  assert.match(packaging, /packageTreeDigest.*path.*entry kind.*executable role.*size.*content/isu)
  assert.match(packaging, /defects that arise only after extraction or installation/iu)

  const provider = normalizedSection(policy, '### 5. Single-scenario real-provider acceptance')
  assert.match(provider, /gpt-5\.6-luna.*do not silently replace.*DeepSeek API/isu)
  assert.match(provider, /no human diagnosis hints.*independent attestation.*observable state/isu)
  assert.match(provider, /usage_limit_reached.*stops the run.*Preserve the candidate.*must not switch either provider or model/isu)

  const matrix = normalizedSection(policy, '### 6. Full external-harness matrix')
  assert.match(matrix, /same-digest retry.*package SHA-256.*catalog SHA-256.*DSH revision and patch.*provider\/model\/effort.*harness contract.*projected scenario inputs/isu)
  assert.match(matrix, /Retain the old run reference.*independently attested prefix.*replace only the failed or incomplete rows/isu)

  const hosted = normalizedSection(policy, '### 7. Hosted promotion')
  assert.match(hosted, /defects visible only after operations installation/iu)
  assert.match(hosted, /merge race.*unprotected main branch/isu)
  assert.match(hosted, /pure trust-root repin does not require reinstalling.*runner script changes/isu)

  const invalidation = normalizedSection(policy, '## Identity and invalidation')
  assert.match(invalidation, /Invalidated and required are different/iu)
  assert.match(invalidation, /documentation-only delivery still stops after.*package inventory.*routine gate/isu)
  assert.match(invalidation, /`rollback_baseline` is not an independent pin/iu)

  const failure = normalizedSection(policy, '## Failure and replan rule')
  assert.match(failure, /generic failure.*same layer fails again/isu)
  assert.match(failure, /stage\/code receipt.*focused owner regression/isu)

  const improvement = normalizedSection(policy, '## Self-improvement loop')
  assertOrdered(improvement, [
    'Preserve the first bounded failure',
    'Identify the earliest layer',
    'Add a focused failing regression',
    'Repair the owner',
    'Rerun only the focused layer',
    'Update this policy or the project skill only when the lesson generalizes',
    'Record the new diagnostic or validation decision',
  ])
  assert.match(improvement, /never authorizes an automatic issue.*deployment.*provider mutation.*model substitution.*cross-repository write/isu)
})
