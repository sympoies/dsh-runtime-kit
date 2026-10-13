import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

test('released nils-cli compatibility is pinned to the exact authenticated artifacts', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'compatibility', 'nils-cli.json'), 'utf8'))

  assert.equal(manifest.status, 'released')
  assert.equal(manifest.minimum_supported_release, '1.33.0')
  assert.equal(manifest.validated_release, '1.33.9')
  assert.deepEqual(manifest.release, {
    "source_revision": "v1.33.9",
    "source_commit": "50cfff5fbe23ef2b77a1c8180db6d7e495a8000b",
    "platform": "x86_64-unknown-linux-gnu",
    "archive": {
      "name": "nils-cli-v1.33.9-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "6266e70501c71d44c80cd865fb9d438d5d769eea7f9d471ee320c35cd64fe2d6"
    },
    "artifacts": {
      "agent-hook": {
        "sha256": "805cea36a077d9624785a2bc38f9753528fa0de08753f808b0eb09878dbcbe9f"
      },
      "agent-docs": {
        "sha256": "fb41d030348cf1590e651ca5b2823bc38b0378c9cff2ffaddd313ce53a2919a1"
      },
      "agent-session": {
        "sha256": "ec9404f7ecb006cdb01ddde2bb0de2786e1b2bf1e9abe6d664e2766a552fa2e8"
      },
      "forge-cli": {
        "sha256": "433374fcdc8de83e73d8104a007cad0092cee18d7750e6e94315f19cee397412"
      },
      "git-cli": {
        "sha256": "24903b6a6f753a055f6cdd5390b187ad144410905a33cd44c3a31751bdd3219f"
      },
      "review-specialists": {
        "sha256": "9da401a2291e5c58a584dad1ca76449bae621b9efb8d367e53274995b2033f05"
      },
      "semantic-commit": {
        "sha256": "0b9c96f80bf1d89919509ca4787a44d7269912f48590e89eebcee6ba43681efa"
      }
    },
    "platforms": {
      "aarch64-apple-darwin": {
        "archive": {
          "name": "nils-cli-v1.33.9-aarch64-apple-darwin.tar.gz",
          "sha256": "065385500523e34e4911a6c149b0b09db713a16a7f890999024bf88b5d4f141f"
        },
        "artifacts": {
          "agent-hook": {
            "sha256": "01af1f4456809a64e3a0cc50b39b2c629f7f5e711da4f2698f1d19aef9945708"
          },
          "agent-docs": {
            "sha256": "5aaaa9ec379621fb796c2d179ea7a9c5065122f229e4bb5712c8fe579f07b55a"
          },
          "agent-session": {
            "sha256": "e2ca1b6525255855681fe143c4bcf2e55b086ab9d3ebdeecf1746bf6312c5405"
          }
        }
      }
    }
  })

  assert.ok(manifest.commands.every(command => command.status === 'released'))
  const gitCliWorktree = manifest.commands.find(command => command.id === 'git-cli.worktree')
  assert.equal(gitCliWorktree?.validation, 'release-artifact-validated')
  assert.ok(gitCliWorktree?.contracts.includes('git-cli worktree remove --safe'))
  assert.ok(manifest.commands.some(command => command.id === 'agent-hook.workspace-recovery.dsh'))
  // Managed-session authentication (and the 1.33.0 floor) depends on this readiness contract.
  const readiness = manifest.commands.find(command => command.id === 'agent-session.readiness')
  assert.equal(readiness?.binary, 'agent-session')
  assert.ok(readiness?.contracts.includes('agent-session.runtime-readiness.v1'))
  assert.ok(readiness?.contracts.includes('cli.agent-session.readiness.v1'))
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

test('maintained docs define isolated coexistence instead of repository retirement', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const readme = read('README.md')
  const migration = read('docs/migration.md')

  for (const document of [readme, migration]) {
    assert.match(document, /Codex[\s\S]{0,120}Claude Code[\s\S]{0,180}agent-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /DSH[\s\S]{0,180}dsh-runtime-kit[\s\S]{0,80}nils-cli/i)
    assert.match(document, /native `headless` profile/i)
    assert.doesNotMatch(document, /old repository is then archived\/read-only|Retire active agent-runtime-kit usage|will replace `agent-runtime-kit`/i)
  }
})

test('the package owns a DSH-only docs catalog and explicit isolated activation contract', () => {
  const read = relative => readFileSync(join(projectRoot, relative), 'utf8')
  const manifest = JSON.parse(read('package.json'))
  const catalog = read('agent-docs/AGENT_DOCS.toml')
  const context = read('agent-docs/PROJECT_DEV_EDIT.md')
  const patch = read('cordis.patch.yml')
  const operations = read('docs/operations.md')

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
    /agentSessionCli: !!js process\.env\.DSH_RUNTIME_KIT_AGENT_SESSION_BIN \?\? 'agent-session'/,
  )
  assert.match(operations, /native `headless` profile/i)
  assert.match(operations, /link count[\s\S]{0,120}one/i)
  assert.match(operations, /Codex[\s\S]{0,120}Claude[\s\S]{0,180}(?:unchanged|untouched)/i)
})
