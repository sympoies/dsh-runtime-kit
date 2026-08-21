#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'

import { DshCompatibilityError, validateDshCompatibilityManifest } from '../src/compat/contract.js'
import { inspectSelectedDshCheckout } from '../src/compat/git-checkout.js'
import { inspectCanonicalPackageArtifact } from '../src/compat/package-artifact.js'

const run = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseCli() {
  let parsed
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        'source-root': { type: 'string' },
        'artifact-root': { type: 'string' },
        channel: { type: 'string' },
        'git-bin': { type: 'string', default: '/usr/bin/git' },
        'pnpm-bin': { type: 'string' },
        receipt: { type: 'string' },
      },
    })
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'peer-pack arguments are invalid',
    )
  }
  const sourceRoot = parsed.values['source-root']
  const artifactRoot = parsed.values['artifact-root']
  const channel = parsed.values.channel
  const gitBin = parsed.values['git-bin']
  const pnpmBin = parsed.values['pnpm-bin']
  const receipt = parsed.values.receipt
  if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)
    || typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)
    || !['pinned', 'upstream-next'].includes(channel ?? '')
    || typeof gitBin !== 'string' || !isAbsolute(gitBin)
    || typeof pnpmBin !== 'string' || !isAbsolute(pnpmBin)
    || typeof receipt !== 'string' || !isAbsolute(receipt)) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'source-root, artifact-root, git-bin, pnpm-bin, and receipt must be absolute paths with one selected channel',
    )
  }
  return {
    sourceRoot: resolve(sourceRoot),
    artifactRoot: resolve(artifactRoot),
    channel,
    gitBin,
    pnpmBin,
    receipt: resolve(receipt),
  }
}

async function trustedLauncher(path) {
  let canonical
  let metadata
  try {
    canonical = await realpath(path)
    metadata = await stat(canonical)
  } catch {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'pnpm-bin must resolve to a trusted executable file',
    )
  }
  const callerUid = process.getuid?.()
  const trustedOwner = metadata.uid === 0 || callerUid === undefined || metadata.uid === callerUid
  if (!metadata.isFile() || !trustedOwner || (metadata.mode & 0o022) !== 0
    || (metadata.mode & 0o111) === 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'pnpm-bin must resolve to a trusted executable file',
    )
  }
  return canonical
}

function contained(root, child) {
  const candidate = resolve(root, child)
  const rel = relative(root, candidate)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return candidate
  }
  throw new DshCompatibilityError(
    'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
    'A DSH peer package path escapes the selected checkout',
  )
}

async function main() {
  const input = parseCli()
  const manifest = validateDshCompatibilityManifest(JSON.parse(
    await readFile(resolve(projectRoot, 'compatibility', 'dsh.json'), 'utf8'),
  ))
  const pnpmBin = await trustedLauncher(input.pnpmBin)
  const sourceRoot = await realpath(input.sourceRoot)
  await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 })
  if ((await readdir(input.artifactRoot)).length !== 0) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_ARTIFACT_ROOT_NOT_EMPTY',
      'DSH peer artifact root must be empty',
    )
  }
  const receiptRel = relative(input.artifactRoot, input.receipt)
  if (receiptRel === '' || (!receiptRel.startsWith(`..${sep}`) && receiptRel !== '..')) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_ARGUMENT_INVALID',
      'DSH peer receipt must be outside the artifact root',
    )
  }
  const before = await inspectSelectedDshCheckout({
    sourceRoot,
    channel: input.channel,
    gitBin: input.gitBin,
    manifest,
  })
  const artifacts = new Map()
  for (const [name, contract] of Object.entries(manifest.workspace_artifacts)) {
    const packageRoot = await realpath(contained(sourceRoot, contract.path))
    const packageRel = relative(sourceRoot, packageRoot)
    if (packageRel === '..' || packageRel.startsWith(`..${sep}`) || isAbsolute(packageRel)) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_DSH_SOURCE_INVALID',
        `DSH workspace package ${name} resolves outside the checkout`,
      )
    }
    let packageManifest
    try {
      packageManifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
    } catch {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
        `Selected DSH workspace package ${name} has invalid metadata`,
      )
    }
    if (packageManifest.name !== name || packageManifest.version !== contract.version) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
        `Selected DSH workspace package ${name} has the wrong identity`,
      )
    }
    const dependencies = new Set()
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(packageManifest[field] ?? {})) {
        if (!dependency.startsWith('@deepseek-ai/')) continue
        if (manifest.workspace_artifacts[dependency] === undefined) {
          throw new DshCompatibilityError(
            'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
            `Selected DSH workspace dependency ${dependency} is outside the authenticated closure`,
          )
        }
        dependencies.add(dependency)
      }
    }
    artifacts.set(name, { contract, packageRoot, dependencies })
  }
  const reachable = new Set()
  const pending = Object.keys(manifest.public_packages)
  while (pending.length > 0) {
    const name = pending.shift()
    if (reachable.has(name)) continue
    reachable.add(name)
    for (const dependency of artifacts.get(name)?.dependencies ?? []) pending.push(dependency)
  }
  if (reachable.size !== artifacts.size
    || [...artifacts.keys()].some(name => !reachable.has(name))) {
    throw new DshCompatibilityError(
      'DSH_RUNTIME_KIT_COMPATIBILITY_MANIFEST_INVALID',
      'DSH workspace artifact closure contains unreachable or missing packages',
    )
  }

  const stagingRoot = await mkdtemp(resolve(input.artifactRoot, '.staging-'))
  /** @type {Array<{name: string, version: string, staged: string, tarballSha256: string, artifactSha256: string}>} */
  const packages = []
  /** @type {Array<{name: string, version: string, path: string, tarball_sha256: string, artifact_sha256: string}>} */
  const receiptPackages = []
  try {
    for (const [name, { contract, packageRoot }] of artifacts) {
      let packed
      try {
        const result = await run(pnpmBin, [
          'pack',
          '--json',
          '--pack-destination', stagingRoot,
        ], {
        cwd: packageRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          npm_config_ignore_scripts: 'true',
          npm_config_userconfig: '/dev/null',
          npm_config_update_notifier: 'false',
          LANG: 'C',
          LC_ALL: 'C',
        },
      })
        packed = JSON.parse(result.stdout)
      } catch {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
          `Could not pack selected DSH workspace package ${name}`,
        )
      }
      const tarball = typeof packed?.filename === 'string'
        ? await realpath(packed.filename)
        : ''
      const tarballRel = relative(stagingRoot, tarball)
      const metadata = tarball.length > 0 ? await stat(tarball) : undefined
      if (packed?.name !== name
        || packed?.version !== contract.version
        || tarballRel === '..'
        || tarballRel.startsWith(`..${sep}`)
        || isAbsolute(tarballRel)
        || !tarball.endsWith('.tgz')
        || !metadata?.isFile()
        || metadata.size <= 0) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
          `Selected DSH workspace package ${name} produced an invalid tarball`,
        )
      }
      const tarballBytes = await readFile(tarball)
      const tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex')
      const artifactReport = inspectCanonicalPackageArtifact(tarballBytes)
      if (artifactReport.name !== name
        || artifactReport.version !== contract.version
        || artifactReport.artifact_sha256 !== contract.artifact_sha256) {
        throw new DshCompatibilityError(
          'DSH_RUNTIME_KIT_INCOMPATIBLE_DSH',
          `Selected DSH workspace package ${name} did not match its reviewed artifact`,
          {
            artifact: name,
            expected_sha256: contract.artifact_sha256,
            actual_sha256: artifactReport.artifact_sha256,
          },
        )
      }
      packages.push({
        name,
        version: contract.version,
        staged: tarball,
        tarballSha256,
        artifactSha256: artifactReport.artifact_sha256,
      })
    }
    const after = await inspectSelectedDshCheckout({
      sourceRoot,
      channel: input.channel,
      gitBin: input.gitBin,
      manifest,
    })
    if (after.revision !== before.revision) {
      throw new DshCompatibilityError(
        'DSH_RUNTIME_KIT_UNSELECTED_DSH_REVISION',
        'DSH checkout identity changed during artifact packing',
      )
    }
    for (const artifact of packages) {
      const path = resolve(input.artifactRoot, artifact.staged.slice(stagingRoot.length + 1))
      await rename(artifact.staged, path)
      receiptPackages.push({
        name: artifact.name,
        version: artifact.version,
        path,
        tarball_sha256: artifact.tarballSha256,
        artifact_sha256: artifact.artifactSha256,
      })
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  const envelope = {
    schema_version: 'dsh-runtime-kit.dsh-peer-pack.v1',
    ok: true,
    data: {
      channel: input.channel,
      revision: before.revision,
      packages: receiptPackages,
      upstream_checkout_clean: true,
    },
  }
  const serialized = `${JSON.stringify(envelope)}\n`
  await writeFile(input.receipt, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  process.stdout.write(serialized)
}

try {
  await main()
} catch (error) {
  const failure = error instanceof DshCompatibilityError
    ? error
    : new DshCompatibilityError(
        'DSH_RUNTIME_KIT_DSH_PEER_PACK_FAILED',
        'Selected DSH peer packing failed',
      )
  process.stdout.write(`${JSON.stringify({
    schema_version: 'dsh-runtime-kit.dsh-peer-pack.v1',
    ok: false,
    error: failure.diagnostic,
  })}\n`)
  process.exitCode = 1
}
