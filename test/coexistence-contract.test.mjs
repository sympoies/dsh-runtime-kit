import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('the published nils release is pinned by exact source, archive, and binary evidence', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.27.8')
  assert.equal(manifest.validated_release, '1.27.13')
  assert.deepEqual(manifest.release, {
    source_revision: 'v1.27.13',
    source_commit: '3dee491576cbea2801dd066a911d76309d8836f2',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.27.13-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '617d452481d4c992c0228684331d275c647096de94be8197f24cd5bdd2b527f4',
    },
    artifacts: {
      'agent-hook': { sha256: 'bc145e4b82b89e6011a0babe92f3c6c034d7a040c9f2ad1e14d4098dd35c6530' },
      'agent-docs': { sha256: 'e7553e2a2e33a3415f7a3cb4126f86513fe5cdabc0703497557c56f95ec0d411' },
      'forge-cli': { sha256: '5c48609163bd1c5e2d2a5e1b94b6a396483a4262f0ec7f1a66f351d428f096e0' },
      'git-cli': { sha256: '92ca33a5aee56060f42c0de2ecdb1895e80313bf38ced109df0dd3bce6fc4e14' },
      'review-specialists': { sha256: 'ed7eea3fcf2dd5cb127f3a09ff9aa51f736cdc7a8c1e5c99fbc77feaf3913782' },
      'semantic-commit': { sha256: 'be802860ed28a0d72226d2e08419032891523ace490ea7e22e6e1d460f70d118' },
    },
    platforms: {
      'aarch64-apple-darwin': {
        archive: {
          name: 'nils-cli-v1.27.13-aarch64-apple-darwin.tar.gz',
          sha256: 'e8d447fe1e967ed8a2b7586c4a73ae7c4cfff7f7456cebde5fd66e6de7e3c2d6',
        },
        artifacts: {
          'agent-hook': { sha256: 'f11375b651dde5d6075dd8608e4dcd6db8706d4dad82682259feb04fd896624f' },
          'agent-docs': { sha256: '1b4aee16e8eacbed21b8a87e11ef473a524e56e9bc720f857877239de8c884fd' },
        },
      },
    },
  })
  assert.ok(manifest.commands.every(command => command.status === 'released'))
  assert.equal(
    manifest.commands.find(command => command.id === 'main-agent.lane-orchestration')?.validation,
    'release-bundle-validated',
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
