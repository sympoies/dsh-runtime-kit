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
  assert.equal(manifest.validated_release, '1.36.2')
  assert.deepEqual(manifest.release, {
    "source_revision": "v1.36.2",
    "source_commit": "f1bc09a40d7448b07c64552a5cc377cb007ebf8f",
    "platform": "x86_64-unknown-linux-gnu",
    "archive": {
      "name": "nils-cli-v1.36.2-x86_64-unknown-linux-gnu.tar.gz",
      "sha256": "b4a63ec6c8deb80fe6e1fcc8ca88579066b78bcd1397ec27469183775accbf85"
    },
    "artifacts": {
      "agent-hook": {
        "sha256": "b7c61bd7619db35aeb0550673b0e62691c021159ddb4ce082d288feff0754091"
      },
      "agent-session": {
        "sha256": "580a8869f660a72bf6f0651ae22cc004dfb475949d33d52cdc237e072092ec21"
      },
      "forge-cli": {
        "sha256": "e8a46901e49f3ca25fe5b3ff76258e8663ac43edbc2135f2e2176ad5b8b2fa6a"
      },
      "git-cli": {
        "sha256": "67f018c95ed031e0a9df714724133a2462335c369111fe470579ec760c834c05"
      },
      "review-specialists": {
        "sha256": "6227cada28636375d27c839ff7ccb514b1b29f2dbbf3234cffc27fd6daa9c91e"
      },
      "semantic-commit": {
        "sha256": "3d6923cc84702104304b228d44920182b9085cbabc506e2a6023a2c55d424def"
      }
    },
    "platforms": {
      "aarch64-apple-darwin": {
        "archive": {
          "name": "nils-cli-v1.36.2-aarch64-apple-darwin.tar.gz",
          "sha256": "f195015b95ace989ea5cabcddd7ffaf2a03936b9a35f3cae58b54da84d72b397"
        },
        "artifacts": {
          "agent-hook": {
            "sha256": "191c64b4a95bf70e561a36ce106f330f249b1b1b264ffc24e4ff713b614340e3"
          },
          "agent-session": {
            "sha256": "3d6534c7c78d7346cfdb24ff03060758ab09f57c107582631acf347e5254f5c7"
          }
        }
      }
    }
  })

  assert.ok(manifest.commands.every(command => command.status === 'released'))
  // agent-docs is retired: no release artifact or command contract pins it.
  // The frozen rollback tuple below keeps its historical companion digests.
  assert.ok(manifest.commands.every(command => command.binary !== 'agent-docs'))
  assert.equal(manifest.candidate_validation?.artifacts?.['agent-docs'], undefined)
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
    'DSH_RUNTIME_KIT_CONTEXT_HOME',
    'DSH_RUNTIME_KIT_SESSION_STATE_HOME',
  ]) {
    assert.match(patch, new RegExp(variable))
    assert.match(operations, new RegExp(variable))
  }
  // The retired agent-docs environment is neither read nor documented as live.
  assert.doesNotMatch(patch, /DSH_RUNTIME_KIT_AGENT_DOCS_/u)
  assert.match(
    patch,
    /agentSessionCli: !!js process\.env\.DSH_RUNTIME_KIT_AGENT_SESSION_BIN \?\? 'agent-session'/,
  )
  assert.match(operations, /native `headless` profile/i)
  assert.match(operations, /link count[\s\S]{0,120}one/i)
  assert.match(operations, /Codex[\s\S]{0,120}Claude[\s\S]{0,180}(?:unchanged|untouched)/i)
})
