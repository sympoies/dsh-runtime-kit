// @ts-check

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { parse } from 'yaml'

import { verifyParityTestOwners } from '../scripts/check-rule-parity-source.mjs'

const ROOT = dirname(dirname(new URL(import.meta.url).pathname))
const INVENTORY_URL = new URL('../policy/rule-parity.yaml', import.meta.url)
const run = promisify(execFile)
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

async function portableDshCheckout(parent) {
  const bare = join(parent, 'source.git')
  const checkout = join(parent, 'checkout')
  await run('git', ['init', '--bare', bare])
  await run('git', [
    '--git-dir', bare,
    'fetch', '--no-tags', ROOT, 'HEAD:refs/heads/evidence',
  ])
  await run('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/evidence'])
  await run('git', ['clone', '--no-local', bare, checkout])
  await run('git', [
    '-C', checkout,
    'remote', 'set-url', 'origin', 'https://github.com/sympoies/dsh-runtime-kit',
  ])
  await assert.rejects(run('git', [
    '-C', checkout,
    'cat-file', '-e', '64bf4388771f3acd13735db0456ebd6ef23f13ab^{commit}',
  ]))
  return checkout
}

test('synthetic directories cannot impersonate an active owner repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-owners-'))
  try {
    const dshRoot = await portableDshCheckout(temporary)
    await writeNilsEvidence(temporary)
    const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))
    await assert.rejects(
      verifyParityTestOwners(inventory, {
        'dsh-runtime-kit': dshRoot,
        'nils-cli': temporary,
      }),
      /repository identity invalid: nils-cli/,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('active cross-repository owners cannot be silently skipped', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-kit-owners-'))
  try {
    const dshRoot = await portableDshCheckout(temporary)
    const inventory = parse(await readFile(INVENTORY_URL, 'utf8'))
    await assert.rejects(
      verifyParityTestOwners(inventory, { 'dsh-runtime-kit': dshRoot }),
      /missing repository root: nils-cli/,
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
