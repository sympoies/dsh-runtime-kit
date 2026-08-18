// @ts-check

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { parse } from 'yaml'

const execute = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LEGACY_SOURCE = fileURLToPath(new URL('./fixtures/legacy-hook-rules.yaml', import.meta.url))

test('the packed package exposes the parity inventory and verifier entrypoints', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-parity-'))
  try {
    const packed = JSON.parse((await execute(
      'npm',
      ['pack', '--json', '--pack-destination', temporary],
      { cwd: ROOT },
    )).stdout)
    const tarball = join(temporary, packed[0].filename)
    await execute(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: temporary },
    )
    const requireFromInstall = createRequire(join(temporary, 'consumer.cjs'))
    const inventoryPath = requireFromInstall.resolve(
      '@sympoies/dsh-runtime-kit/policy/rule-parity.yaml',
    )
    const inventoryBytes = await readFile(inventoryPath)
    assert.match(inventoryBytes.toString('utf8'), /dsh-runtime-kit\.rule-parity\.v1/)

    const verifierPath = requireFromInstall.resolve(
      '@sympoies/dsh-runtime-kit/check-rule-parity-source',
    )
    const verifier = await import(pathToFileURL(verifierPath).href)
    assert.equal(typeof verifier.verifyParitySource, 'function')
    assert.equal(typeof verifier.verifyParityInventory, 'function')
    const sourceBytes = await readFile(LEGACY_SOURCE)
    assert.deepEqual(verifier.verifyParitySource(sourceBytes, inventoryBytes), {
      schema_version: 'dsh-runtime-kit.rule-parity-check.v1',
      ok: true,
      rule_count: 101,
      rule_id_digest: 'sha256:089d67c5b3dc4de422b3e89500b92fe5ee5db4b989a9d690edc6385d13f5a671',
      legacy_handler_count: 21,
      legacy_registration_count: 67,
      relocated_capability_count: 1,
      runtime_handler_or_relocated_count: 22,
    })

    const executable = join(temporary, 'node_modules', '.bin', 'dsh-runtime-kit-check-parity')
    const help = await execute(executable, ['--help'], { cwd: temporary })
    assert.match(help.stdout, /^dsh-runtime-kit-check-parity /)
    const nilsRoot = join(temporary, 'nils-cli')
    for (const relative of [
      'crates/agent-hook/tests/read_only_capability.rs',
      'crates/agent-hook/tests/dsh_ingress.rs',
    ]) {
      const target = join(nilsRoot, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, '// packed ownership fixture\n')
    }
    await assert.rejects(
      execute(executable, [
        LEGACY_SOURCE,
        '--owner-root',
        `dsh-runtime-kit=${ROOT}`,
        '--owner-root',
        `nils-cli=${nilsRoot}`,
      ], { cwd: temporary }),
      error => error.code !== 0,
    )

    const mutatedSource = join(temporary, 'mutated-hook-rules.yaml')
    await writeFile(mutatedSource, Buffer.concat([sourceBytes, Buffer.from('\n# mutation\n')]))
    await assert.rejects(
      execute(executable, [
        mutatedSource,
        '--owner-root',
        `dsh-runtime-kit=${ROOT}`,
        '--owner-root',
        `nils-cli=${nilsRoot}`,
      ], { cwd: temporary }),
      error => error.code !== 0,
    )

    const mutatedInventory = parse(inventoryBytes.toString('utf8'))
    mutatedInventory.source.commit = '0'.repeat(40)
    assert.throws(() => verifier.verifyParityInventory(mutatedInventory))

    const mutatedRuleIds = parse(inventoryBytes.toString('utf8'))
    mutatedRuleIds.rules[0].id = 'runtime.fabricated.registration'
    assert.throws(() => verifier.verifyParityInventory(mutatedRuleIds))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
