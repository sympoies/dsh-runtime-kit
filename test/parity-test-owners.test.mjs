// @ts-check

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { parse } from 'yaml'

import { verifyParityTestOwners } from '../scripts/check-rule-parity-source.mjs'

const ROOT = dirname(dirname(new URL(import.meta.url).pathname))
const INVENTORY_URL = new URL('../policy/rule-parity.yaml', import.meta.url)
const NILS_TESTS = [
  'crates/agent-hook/tests/read_only_capability.rs',
  'crates/agent-hook/tests/dsh_ingress.rs',
]

async function writeNilsEvidence(root) {
  for (const relative of NILS_TESTS) {
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, '// ownership fixture\n')
  }
}

test('synthetic directories cannot impersonate an active owner repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-owners-'))
  try {
    await writeNilsEvidence(temporary)
    const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))
    await assert.rejects(
      verifyParityTestOwners(inventory, {
        'dsh-runtime-kit': ROOT,
        'nils-cli': temporary,
      }),
      /repository identity invalid: nils-cli/,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('active cross-repository owners cannot be silently skipped', async () => {
  const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))
  await assert.rejects(
    verifyParityTestOwners(inventory, { 'dsh-runtime-kit': ROOT }),
    /missing repository root: nils-cli/,
  )
})
