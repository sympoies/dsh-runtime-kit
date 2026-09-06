// @ts-check

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Build provenance for a package that ships compiled output.
 *
 * A package whose `exports` point at build output cannot prove freshness the
 * way a source-shipping package does: `npm pack --ignore-scripts` runs no
 * build, and every lifecycle hook that could run one is refused by the
 * operations engine, so nothing rebuilds automatically at pack time. A stale
 * output therefore packs, installs, and runs while the source tree, the
 * typecheck, the plan digest and the receipt all remain internally consistent.
 *
 * The build records the digest of the sources it consumed. The engine
 * recomputes that digest from the sources as packed and refuses a mismatch.
 * Freshness is content-derived, so a fresh checkout, a `git stash`, or a
 * touched mtime cannot forge it.
 */

export const BUILD_PROVENANCE_SCHEMA = 'dsh-runtime-kit.build-provenance.v1'

const MAX_SOURCE_ENTRIES = 20_000
const MAX_SOURCE_DEPTH = 64
const ROOT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** @param {string} root @param {string} candidate */
function within(root, candidate) {
  const fragment = relative(root, candidate)
  return fragment !== '' && fragment !== '..'
    && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment)
}

/**
 * Digest one source root deterministically: sorted names, entry kind, symlink
 * target, and file content. Metadata that a checkout does not preserve — mode
 * beyond the executable bit, mtime, inode — is deliberately excluded, so the
 * same content digests the same on any machine.
 *
 * @param {string} absolute
 * @param {string} logical
 * @param {import('node:crypto').Hash} hash
 * @param {{entries: number}} budget
 * @param {string} containment
 * @param {number} depth
 */
function digestEntry(absolute, logical, hash, budget, containment, depth) {
  if (depth > MAX_SOURCE_DEPTH) {
    throw new Error('build provenance source tree exceeds the depth limit')
  }
  budget.entries += 1
  if (budget.entries > MAX_SOURCE_ENTRIES) {
    throw new Error('build provenance source tree exceeds the entry limit')
  }
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute)
    if (isAbsolute(target) || !within(containment, resolve(absolute, '..', target))) {
      throw new Error('build provenance source tree contains an escaping symlink')
    }
    hash.update(`L\0${logical}\0${target}\0`)
    return
  }
  if (stat.isDirectory()) {
    hash.update(`D\0${logical}\0`)
    for (const name of readdirSync(absolute).sort()) {
      digestEntry(join(absolute, name), `${logical}/${name}`, hash, budget, containment, depth + 1)
    }
    return
  }
  if (!stat.isFile()) {
    throw new Error('build provenance source tree contains an unsupported entry')
  }
  const content = readFileSync(absolute)
  hash.update(`F\0${logical}\0${(stat.mode & 0o111) === 0 ? '0' : '1'}\0${content.byteLength}\0`)
  hash.update(content)
}

/**
 * Digest the declared source roots of a package tree. The build writes this
 * value into its provenance; the engine recomputes it from the packed sources.
 *
 * @param {string} packageRoot
 * @param {readonly string[]} sources
 * @returns {string}
 */
export function buildSourceDigest(packageRoot, sources) {
  const root = resolve(packageRoot)
  const hash = createHash('sha256')
  hash.update(`${BUILD_PROVENANCE_SCHEMA}\0`)
  const budget = { entries: 0 }
  for (const source of [...sources].sort()) {
    const absolute = resolve(root, source)
    if (!within(root, absolute)) {
      throw new Error('build provenance source root escapes the package')
    }
    hash.update(`R\0${source}\0`)
    digestEntry(absolute, source, hash, budget, root, 1)
  }
  return hash.digest('hex')
}

/**
 * Validate a provenance declaration's shape. Returns the frozen declaration;
 * throws with a plain message the caller maps to a typed operations error.
 *
 * @param {unknown} value
 */
export function validateBuildProvenance(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('build provenance must be an object')
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const known = new Set(['schema_version', 'sources', 'outputs', 'source_sha256'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`build provenance has an unknown key "${key}"`)
  }
  if (record.schema_version !== BUILD_PROVENANCE_SCHEMA) {
    throw new Error('build provenance schema_version is unsupported')
  }
  const roots = /** @param {unknown} raw @param {string} field @returns {string[]} */ (raw, field) => {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`build provenance ${field} must be a non-empty array`)
    }
    const seen = new Set()
    for (const entry of raw) {
      if (typeof entry !== 'string' || !ROOT_PATTERN.test(entry)) {
        throw new Error(`build provenance ${field} must hold package-relative paths`)
      }
      if (seen.has(entry)) throw new Error(`build provenance ${field} repeats "${entry}"`)
      seen.add(entry)
    }
    return [...raw]
  }
  const sources = roots(record.sources, 'sources')
  const outputs = roots(record.outputs, 'outputs')
  for (const source of sources) {
    for (const output of outputs) {
      if (source === output || source.startsWith(`${output}/`) || output.startsWith(`${source}/`)) {
        throw new Error('build provenance sources and outputs must not overlap')
      }
    }
  }
  if (typeof record.source_sha256 !== 'string' || !SHA256_PATTERN.test(record.source_sha256)) {
    throw new Error('build provenance source_sha256 must be a sha-256 hex digest')
  }
  return Object.freeze({
    schema_version: BUILD_PROVENANCE_SCHEMA,
    sources: Object.freeze(sources),
    outputs: Object.freeze(outputs),
    source_sha256: record.source_sha256,
  })
}
