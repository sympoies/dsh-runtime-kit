import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('released nils-cli compatibility is pinned to the exact authenticated artifacts', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.29.0')
  assert.equal(manifest.validated_release, '1.29.2')
  assert.deepEqual(manifest.release, {
    "source_revision": "v1.29.2",
    "source_commit": "eb686ad8d601b6b2fd91788b633a2621288647d8",
    "platform": "x86_64-unknown-linux-gnu",
    "archive": {
      "name": "nils-cli-v1.29.2-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "59063edf406ac84565f42f7d9d167a9b13a747950a57825501ee68482a043d1d"
    },
    "artifacts": {
      "agent-hook": {
        "sha256": "cf6186142e741d226eac5323fa64b016a664c6d0354c450a568406525de602b9"
      },
      "agent-docs": {
        "sha256": "d916b8dc95d58fe7920b9960f5cc2a960b43a7eab67af6f5251e75b9ff685baf"
      },
      "agent-session": {
        "sha256": "ee2138e18b57a38897a1fba3f78c268bd63d154e9972b095e2df53b88cbc7b75"
      },
      "forge-cli": {
        "sha256": "0c83c7865190ddb1db00fdf67cce4efafe4624b87544cf06f5f02c03e94073e9"
      },
      "git-cli": {
        "sha256": "3d9731c80069790f88f12f4521074fbd421e690ae229f0e4402a262a633e8a7b"
      },
      "review-specialists": {
        "sha256": "001c3c931c1440f6693962527b79a99c7429b9a4e9300b208a0aa7945ec49b7a"
      },
      "semantic-commit": {
        "sha256": "e17720bc2155e45fa6e26c9d4d9ce195a46cf00f92e3ebd415197e1f7c40831b"
      }
    },
    "platforms": {
      "aarch64-apple-darwin": {
        "archive": {
          "name": "nils-cli-v1.29.2-aarch64-apple-darwin.tar.gz",
          "sha256": "7a02025c4b3e449b9e3a169635851b5fa5edb533fc810af139778dc16f7f596f"
        },
        "artifacts": {
          "agent-hook": {
            "sha256": "f5572164949f552639b171a2db9d2333e2b8601dbbeca06f15b0404f69606200"
          },
          "agent-docs": {
            "sha256": "b9bfaaa60f7e20c7eaeb5856addb70fb0ff3ed9d2d412e140355be4fe255d9f5"
          },
          "agent-session": {
            "sha256": "f33cf3bbbeba3e5d6eafc27cab17760cda3d68f8241fe401b0778816c56c924f"
          }
        }
      }
    }
  })

  assert.ok(manifest.commands.every(command => command.status === 'released'))
  assert.ok(manifest.commands.some(command => command.id === 'agent-hook.workspace-recovery.dsh'))
  assert.ok(
    manifest.commands
      .find(command => command.id === 'agent-hook.dispatch.dsh')
      ?.source_tasks.includes('sympoies/nils-cli#1541'),
  )
  assert.ok(
    manifest.commands
      .find(command => command.id === 'agent-session.work-context-set-if-absent')
      ?.source_tasks.includes('sympoies/nils-cli#1591'),
  )
  assert.equal(manifest.candidate_validation?.feature, 'typed-data-policy-protected-roots')
  assert.equal(manifest.candidate_validation?.status, 'reviewed-source-candidate')
  assert.equal(manifest.candidate_validation?.validation, 'exact-reviewed-source')
  assert.equal(
    manifest.candidate_validation?.source_commit,
    '81be602378e3790e042aae5000befd78c1d584bc',
  )
  // #255 and Gate 0 select the serial predecessor. PR #254 acceptance admits
  // the pinned 1.28.25 host, so it is the executable rollback baseline. The
  // package identity is the compiled hosted acceptance artifact (a full build,
  // then npm 11.19.0 production pack under Node 24.16.0, recompressed by the
  // authenticated zlib-ng helper), not raw `npm pack` output. This assertion
  // freezes that reviewed selection for #255; it does not discover a future
  // child baseline.
  assert.deepEqual(manifest.rollback_validation, {
    runtime_package_sha256: '237abe93c57d77fe00cc4b104ea7994644b65dd43061ac2ff71e7a623802177b',
    version: '1.28.25',
    source_revision: 'v1.28.25',
    source_commit: '6657af3a12a61e3cbda349c5e93279db690ca268',
    platform: 'x86_64-unknown-linux-gnu',
    archive: {
      name: 'nils-cli-v1.28.25-x86_64-unknown-linux-gnu.tar.gz',
      sha256: '92f996f9bec38d8c5edfd52cc0966ae6cfb24fef193dbc6c5a6c26a5d22e69e8',
    },
    artifacts: {
      'agent-hook': { sha256: 'fadde034b1d9d7efd3ec296f2858cdfa4dec437408de83d0d94c1d2165d56bc3' },
      'agent-docs': { sha256: '2a736ae29db016c4fdedf2585b556983152a8bf012d01a96c3071539679a5a0d' },
      'agent-session': { sha256: '752c87c5980ac40710dde8043c30d66d4edb71f5e6c86cfa4022b6d0e17ba264' },
      'forge-cli': { sha256: 'ad6e887cc5f691cdfb36baeadde468bdca3d912a17bd6ff726e3286bdfb8659a' },
      'git-cli': { sha256: '904a2912b1bdbe13e2b1c66353b2aa6cc7a8db1bde0cc45827de18708367ea28' },
      'review-specialists': { sha256: 'a0110af730b1e00307aca1c3ba49a98ec77daf1c9ddfc59684f8fdf8fd477a8a' },
      'semantic-commit': { sha256: 'dd7a4dfe2e5df88e38e8e5d8af681fd86455cc9013fd03b07f409a7d1f66631f' },
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
      source_tasks: [
        'serenvia/sympoies-infra#213',
        'sympoies/nils-cli#1591',
      ],
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
