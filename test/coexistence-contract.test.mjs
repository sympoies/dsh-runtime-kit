import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('the published nils release is pinned by exact source, archive, and binary evidence', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.17')
  assert.equal(manifest.validated_release, '1.27.22')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.22',
    source_commit: '5ffcf3c01226fc2d1e513984210976bf00d2df08',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.22-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '06378bd4f9bcfa0041077489d9e1d95bc7bd49d22e0fd52eb62c4f76fcb91706',
    },
    artifacts: {
      'agent-hook': { sha256: '14b145c9b8ce4c93dab8d29e66e3e7bd6777d37db7a0e3995c6e737028f4e571' },
      'agent-docs': { sha256: '78b6aa3c3e6670f05c378ef939e7e4e48efa8d03f405363a60465cb5f1d89b6e' },
      'forge-cli': { sha256: '835ceca3246ccb3adc3cba318d55b4d3aa07662035b04c47f47414d819c204b1' },
      'git-cli': { sha256: '3b21055c54a0b13341f3fafd8f571292a66b3a4a11b57652b28bde06d0f53002' },
      'review-specialists': { sha256: 'e2ac00e4b16c5263fb774a152ecb787bf29c9241280daba0f8bfd0eda45eeb9f' },
      'semantic-commit': { sha256: '844d44d5d81cab8bc793e23ea790a77d73ec57e52f4928a17b5fa47fef7bc2b4' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.22-aarch64-apple-darwin.tar.gz',
          sha256: '852714ad3725cd9ec97aee29bb7e70703cf764d466a1b1ae75e3f73a26e460c6',
        },
        artifacts: {
          'agent-hook': { sha256: '44ee173f3876cfc31c64af96af2e934492a7d22be15c5b729a36e7daf5eb8ef3' },
          'agent-docs': { sha256: '15ac5afaed879e072cbb6b6e077e60c48336d9c005f883863b342fdb5f1dc057' },
        },
      },
    },
  })
  assert.ok(manifest.commands.every(command => command.status === 'released'))
  assert.ok(manifest.commands.some(command => command.id === 'agent-hook.workspace-recovery.dsh'))
  assert.ok(
    manifest.commands
      .find(command => command.id === 'agent-hook.dispatch.dsh')
      ?.source_tasks.includes('sympoies/nils-cli#1541'),
  )
  assert.equal(manifest.candidate_validation, undefined)
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '1cdb239378d5113bcf0634392d63bcefd4bb11be33bb04bd30049b299f858f7a',
    version: '1.27.9',
    source_revision: 'v1.27.9',
    source_commit: '9458a5e274e4a683eac4d285135061c2fc35aeae',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.9-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '1fb0a8acfe5c6a1d2239d3428c6cd356b25e60e7ec737c2faaa6d14779b1824b',
    },
    artifacts: {
      'agent-hook': { sha256: '1eaee0c0d6dd55822f20cfc6314afa866d8381b17c16711e55fa1052222c80f0' },
      'agent-docs': { sha256: 'b30cbdd920c2c8e564ea25ad46a755d5545adb1d604c8e9df011604c97c74288' },
      'forge-cli': { sha256: 'cf1505392fe68939e0d7944163e99fbaa64ebf0970a8d4885224697517b2eebb' },
      'git-cli': { sha256: '7b161e9ee388578e33ef9c62279ac4e0d7190f32301dd89b8d59f70ba779175e' },
      'review-specialists': { sha256: '8a664f167ec8ab01496d6c7b782618c6ec6ff95c4de4286896b35e4232122edb' },
      'semantic-commit': { sha256: 'f1f9ad4ad3d3e4b040e8250291d7052791b0d81dae058f4b3e1fb3cffaf9f7b8' },
    },
  })
  assert.equal(
    manifest.commands.find(command => command.id === 'main-agent.lane-orchestration')?.validation,
    'release-bundle-validated',
  )
  assert.deepEqual(
    manifest.commands.find(command => command.id === 'agent-session.work-context-set-if-absent'),
    {
      id: 'agent-session.work-context-set-if-absent',
      binary: 'agent-session',
      status: 'released',
      validation: 'release-bundle-validated',
      contracts: [
        'agent-session work-context set --if-absent',
        'cli.agent-session.work-context-set.v1',
        'agent-session.work-context-set-result.v1',
      ],
      source_task: 'serenvia/sympoies-infra#213',
    },
  )
})

test('retained migration docs define isolated coexistence instead of repository retirement', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const source = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-discussion-source.md')
  const plan = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md')
  const state = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-execution-state.md')
  const readme = read('README.md')

  for (const document of [source, plan, state, readme]) {
    assert.match(document, /Codex[\s\S]{0,120}Claude Code[\s\S]{0,180}agent-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /DSH[\s\S]{0,180}dsh-runtime-kit[\s\S]{0,80}nils-cli/i)
  }
  assert.match(plan, /Task 6\.2: Activate the local DSH profile reversibly/)
  assert.match(plan, /Task 6\.3: Prove coexistence isolation and close dispatch/)
  assert.match(state, /agent-runtime-kit remains active for Codex and Claude\s+Code/i)
  assert.doesNotMatch(source, /old repository is then archived\/read-only/i)
  assert.doesNotMatch(plan, /Retire active agent-runtime-kit usage/i)
  assert.doesNotMatch(state, /Retire active old runtime/i)
  assert.doesNotMatch(readme, /will replace `agent-runtime-kit`/i)
})

test('the package owns a DSH-only docs catalog and explicit isolated activation contract', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const manifest = JSON.parse(read('package.json'))
  const catalog = read('agent-docs/AGENT_DOCS.toml')
  const context = read('agent-docs/PROJECT_DEV_EDIT.md')
  const patch = read('cordis.patch.yml')
  const operations = read('docs/operations.md')
  const plan = read('docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md')

  assert.ok(manifest.files.includes('agent-docs'))
  assert.match(catalog, /context = "project-dev"/)
  assert.match(catalog, /product = "dsh"/)
  assert.match(catalog, /phase = "edit"/)
  assert.doesNotMatch(`${catalog}\n${context}`, /agent-runtime-kit/u)
  for (const variable of [
    'DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG',
    'DSH_RUNTIME_KIT_AGENT_HOOK_POLICY',
    'DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR',
    'DSH_RUNTIME_KIT_AGENT_DOCS_HOME',
    'DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME',
  ]) {
    assert.match(patch, new RegExp(variable))
    assert.match(operations, new RegExp(variable))
  }
  assert.match(
    patch,
    /mainAgentCli: !!js process\.env\.DSH_RUNTIME_KIT_MAIN_AGENT_BIN \?\? 'main-agent'/,
  )
  assert.match(
    patch,
    /agentSessionCli: !!js process\.env\.DSH_RUNTIME_KIT_AGENT_SESSION_BIN \?\? 'agent-session'/,
  )
  assert.match(operations, /native `headless` profile/i)
  assert.match(operations, /link count[\s\S]{0,120}one/i)
  assert.match(operations, /Codex[\s\S]{0,120}Claude[\s\S]{0,180}(?:unchanged|untouched)/i)
  assert.match(plan, /native `headless` profile/i)
})
