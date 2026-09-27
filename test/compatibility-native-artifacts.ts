import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const receiptPath = process.argv[2]
const artifactRoot = process.argv[3]
assert.ok(receiptPath && artifactRoot, 'Provide an authenticated pack receipt and artifact root')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(projectRoot, 'compatibility/dsh.json'), 'utf8'))
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'dsh-native-artifact-contract-'))
const stage = (receiptFile: string, archives: string, consumer: string) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [
      join(projectRoot, 'dist/scripts/stage-dsh-compatibility-peers.js'),
      '--receipt', receiptFile, '--artifact-root', archives, '--consumer-root', consumer,
    ], { encoding: 'utf8' }))
  } catch (error) {
    return JSON.parse((error as { stdout: string }).stdout)
  }
}
const consumer = async (name: string) => {
  const path = join(root, name)
  await mkdir(path)
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: '@sympoies/dsh-runtime-kit' }))
  return path
}
try {
  const positive = stage(receiptPath, artifactRoot, await consumer('positive'))
  assert.equal(positive.ok, true)
  const skipped = Object.entries(manifest.registry_workspace_artifacts)
    .filter(([, value]) => (value as { platform?: string }).platform !== undefined
      && (value as { platform?: string }).platform !== `${process.platform}-${process.arch}`)
    .map(([name]) => name).sort()
  assert.deepEqual(positive.data.skipped_optional_packages.slice().sort(), skipped)
  assert.deepEqual(positive.data.verified_packages.slice().sort(), receipt.data.packages.map(item => item.name).sort())
  assert.deepEqual(positive.data.packages.slice().sort(), positive.data.verified_packages.filter(name => !skipped.includes(name)).sort())

  const archives = join(root, 'archives')
  await mkdir(archives)
  const changed = structuredClone(receipt)
  for (const item of changed.data.packages) {
    const destination = join(archives, `${item.name.slice(1).replace('/', '-')}.tgz`)
    await copyFile(item.path, destination)
    item.path = destination
    if (item.name === '@deepseek-ai/node-addon-system') {
      // Same canonical tar content, different compressed bytes: even a receipt
      // with an updated SHA-256 must not override the stock registry integrity.
      const bytes = gzipSync(gunzipSync(await readFile(destination)), { level: 0 })
      await writeFile(destination, bytes)
      item.tarball_sha256 = createHash('sha256').update(bytes).digest('hex')
    }
  }
  const changedReceipt = join(root, 'changed-receipt.json')
  await writeFile(changedReceipt, JSON.stringify(changed))
  const negativeConsumer = await consumer('negative')
  const negative = stage(changedReceipt, archives, negativeConsumer)
  assert.equal(negative.ok, false)
  assert.equal(negative.error.code, 'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH')
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(negativeConsumer), ['package.json'])
  console.log(JSON.stringify({ ok: true, verified: positive.data.verified_packages.length,
    materialized: positive.data.packages.length, skipped, alteredRegistryArchiveRejected: true }))
} finally {
  await rm(root, { recursive: true, force: true })
}
