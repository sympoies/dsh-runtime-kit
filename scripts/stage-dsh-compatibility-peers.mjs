#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DshCompatibilityError, validateDshCompatibilityManifest } from '../src/compat/contract.js'
import {
  extractPackageArtifact,
  inspectCanonicalPackageArtifact,
  prepareAuthenticatedPackageScope,
} from '../src/compat/package-artifact.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        receipt: { type: 'string' },
        'artifact-root': { type: 'string' },
        'consumer-root': { type: 'string' },
      },
    })
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'peer-stage arguments are invalid',
    )
  }
  const receipt = parsed.values.receipt
  const artifactRoot = parsed.values['artifact-root']
  const consumerRoot = parsed.values['consumer-root']
  if (typeof receipt !== 'string' || !isAbsolute(receipt)
    || typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)
    || typeof consumerRoot !== 'string' || !isAbsolute(consumerRoot)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'receipt, artifact-root, and consumer-root must be absolute paths',
    )
  }
  return { receipt: resolve(receipt), artifactRoot: resolve(artifactRoot), consumerRoot: resolve(consumerRoot) }
}

/** @param {string} root @param {string} candidate */
function contained(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function main() {
  const input = parseCli()
  const manifest = validateDshCompatibilityManifest(JSON.parse(
    await readFile(resolve(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
  ))
  const [artifactRoot, consumerRoot] = await Promise.all([
    realpath(input.artifactRoot),
    realpath(input.consumerRoot),
  ])
  const consumerManifest = JSON.parse(await readFile(resolve(consumerRoot, 'package.json'), 'utf8'))
  if (consumerManifest.name !== '@sympoies/dsh-runtime-kit') {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
      'DSH compatibility consumer root has the wrong identity',
    )
  }
  const receipt = JSON.parse(await readFile(input.receipt, 'utf8'))
  const channel = receipt.data?.channel
  if (receipt.schema_version !== 'dsh-runtime-kit.dsh-peer-pack.v1'
    || receipt.ok !== true
    || !['pinned', 'upstream-next'].includes(channel)
    || receipt.data?.revision !== manifest.channels[channel]?.revision
    || receipt.data?.upstream_checkout_clean !== true
    || !Array.isArray(receipt.data?.packages)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'DSH peer receipt identity is invalid',
    )
  }
  const expectedNames = Object.keys(manifest.workspace_artifacts).sort()
  const actualNames = receipt.data.packages.map(item => item?.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
      'DSH peer receipt does not contain the exact authenticated closure',
    )
  }
  const staged = []
  let installScope
  try {
    for (const item of receipt.data.packages) {
      const contract = manifest.workspace_artifacts[item.name]
      let tarball
      try {
        tarball = await realpath(item.path)
      } catch {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
          `DSH peer artifact ${item.name} is unavailable`,
        )
      }
      if (!contract
        || item.version !== contract.version
        || !contained(artifactRoot, tarball)) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
          `DSH peer artifact ${item.name} is outside its authenticated receipt`,
        )
      }
      const bytes = await readFile(tarball)
      const tarballSha256 = createHash('sha256').update(bytes).digest('hex')
      const artifact = inspectCanonicalPackageArtifact(bytes)
      if (tarballSha256 !== item.tarball_sha256
        || artifact.artifact_sha256 !== item.artifact_sha256
        || artifact.artifact_sha256 !== contract.artifact_sha256
        || artifact.name !== item.name
        || artifact.version !== item.version) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
          `DSH peer artifact ${item.name} failed staging authentication`,
        )
      }
      const base = item.name.slice('@deepseek-ai/'.length)
      staged.push({
        name: item.name,
        base,
        tarball,
        tarballSha256: item.tarball_sha256,
      })
    }
    installScope = await prepareAuthenticatedPackageScope(consumerRoot, '@deepseek-ai')
    for (const item of staged) {
      await installScope.assertStable()
      const target = installScope.resolveTarget(item.base)
      try {
        await lstat(target)
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
          `DSH peer install target ${item.name} must be absent`,
        )
      } catch (error) {
        if (error instanceof DshCompatibilityError) throw error
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
          throw new DshCompatibilityError(
            'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
            `DSH peer install target ${item.name} cannot be inspected`,
          )
        }
      }
      await installScope.assertStable()
      const bytes = await readFile(item.tarball)
      if (createHash('sha256').update(bytes).digest('hex') !== item.tarballSha256) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
          `DSH peer artifact ${item.name} changed before extraction`,
        )
      }
      await extractPackageArtifact(bytes, target)
      await installScope.assertStable()
    }
  } finally {
    await installScope?.close().catch(() => {})
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.dsh-peer-stage.v1',
    ok: true,
    data: {
      channel,
      revision: receipt.data.revision,
      packages: staged.map(item => item.name),
      network_resolution: false,
    },
  })}\n`)
}

try {
  await main()
} catch (error) {
  const failure = error instanceof DshCompatibilityError
    ? error
    : new DshCompatibilityError(
        'DSH_RUNTIME_KIT_DSH_PEER_STAGE_FAILED',
        'Selected DSH peer staging failed',
      )
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.dsh-peer-stage.v1',
    ok: false,
    error: failure.diagnostic,
  })}\n`)
  process.exitCode = 1
}
