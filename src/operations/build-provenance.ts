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
 *
 * Both sides digest an **explicit file list**, never a tree they walk
 * themselves, because the working tree and the packed tree are not the same
 * set. `npm pack` drops the names npm always ignores (`.gitignore`,
 * `.npmignore`, `.npmrc`, `.DS_Store`, `.*.swp`, `*.orig`, `package-lock.json`)
 * and carries no directory entries at all, so an empty directory does not
 * survive a pack and extract. A tree walk on each side would therefore disagree
 * over contents that are entirely ordinary, and every install would fail as
 * stale with no rebuild able to fix it. The engine's list comes from the
 * extracted package (`collectPackedSourceFiles`); the build's list must come
 * from `npm pack --dry-run --json`, whose `files[].path` is exactly what the
 * tarball will hold.
 */

export const BUILD_PROVENANCE_SCHEMA = 'dsh-runtime-kit.build-provenance.v1'

const MAX_SOURCE_ENTRIES = 20_000
const MAX_SOURCE_DEPTH = 64
const ROOT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** A source tree that exceeds a traversal budget, distinct from a bad declaration. */
export class BuildSourceLimitError extends Error {
  name

  constructor(message: string) {
    super(message)
    this.name = 'BuildSourceLimitError'
  }
}

/** A source tree that escapes the package or holds an entry we refuse to digest. */
export class BuildSourceContainmentError extends Error {
  name

  constructor(message: string) {
    super(message)
    this.name = 'BuildSourceContainmentError'
  }
}

function within(root: string, candidate: string) {
  const fragment = relative(root, candidate)
  return fragment !== '' && fragment !== '..'
    && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment)
}

/**
 * Normalize a declared root or a package-relative file path to `/` separators
 * with no leading or trailing slash, so a digest computed on one platform
 * matches one computed on another.
 */

function logicalPath(value: string) {
  return value.split(/[\\/]+/u).filter(segment => segment !== '').join('/')
}

function underRoot(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}/`)
}

/**
 * Collect the package-relative files under the declared source roots of an
 * extracted package tree. Directory entries are deliberately not collected:
 * a tarball has none, so including them would make the packed and unpacked
 * views disagree.
 */

export function collectPackedSourceFiles(packageRoot: string, sources: readonly string[]): string[]  {
  const root = resolve(packageRoot)
  const files: string[] = []
  let entries = 0
  const visit = (absolute: string, logical: string, depth: number) => {
    if (depth > MAX_SOURCE_DEPTH) {
      throw new BuildSourceLimitError('build provenance source tree exceeds the depth limit')
    }
    entries += 1
    if (entries > MAX_SOURCE_ENTRIES) {
      throw new BuildSourceLimitError('build provenance source tree exceeds the entry limit')
    }
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute)
      if (isAbsolute(target) || !within(root, resolve(absolute, '..', target))) {
        throw new BuildSourceContainmentError('build provenance source tree contains an escaping symlink')
      }
      files.push(logical)
      return
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        visit(join(absolute, name), `${logical}/${name}`, depth + 1)
      }
      return
    }
    if (!stat.isFile()) {
      throw new BuildSourceContainmentError('build provenance source tree contains an unsupported entry')
    }
    files.push(logical)
  }
  for (const source of [...sources].sort()) {
    const logical = logicalPath(source)
    const absolute = resolve(root, logical)
    if (!within(root, absolute)) {
      throw new BuildSourceContainmentError('build provenance source root escapes the package')
    }
    visit(absolute, logical, 1)
  }
  return files.sort()
}

/**
 * Digest an explicit list of package-relative files.
 *
 * Content is bound along with the path, the entry kind, and the executable bit.
 * Mode beyond that bit, mtime and inode are excluded because a checkout does
 * not preserve them, so the same content digests the same anywhere — and a
 * `touch` cannot forge freshness.
 *
 * @param files package-relative paths, in any order
 */

export function digestSourceFiles(packageRoot: string, files: readonly string[]): string  {
  const root = resolve(packageRoot)
  const hash = createHash('sha256')
  hash.update(`${BUILD_PROVENANCE_SCHEMA}\0`)
  const logical = [...new Set(files.map(logicalPath))].sort()
  if (logical.length > MAX_SOURCE_ENTRIES) {
    throw new BuildSourceLimitError('build provenance source list exceeds the entry limit')
  }
  for (const file of logical) {
    const absolute = resolve(root, file)
    if (!within(root, absolute)) {
      throw new BuildSourceContainmentError('build provenance source file escapes the package')
    }
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${file}\0${readlinkSync(absolute)}\0`)
      continue
    }
    if (!stat.isFile()) {
      throw new BuildSourceContainmentError('build provenance source list names a non-file entry')
    }
    const content = readFileSync(absolute)
    hash.update(`F\0${file}\0${(stat.mode & 0o111) === 0 ? '0' : '1'}\0${content.byteLength}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

/**
 * Digest the declared source roots of an **extracted package** tree. This is
 * the engine side. A build must not call this against its working tree: use
 * `digestSourceFiles` with the `npm pack --dry-run --json` file list instead,
 * or the two digests will disagree over npm-ignored names and empty
 * directories.
 */

export function packedSourceDigest(packageRoot: string, sources: readonly string[]): string  {
  return digestSourceFiles(packageRoot, collectPackedSourceFiles(packageRoot, sources))
}

/**
 * Validate a provenance declaration's shape. Returns the frozen declaration;
 * throws with a plain message the caller maps to a typed operations error.
 */

export function validateBuildProvenance(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('build provenance must be an object')
  }
  const record = ((value) as Record<string, unknown>)
  const known = new Set(['schema_version', 'sources', 'outputs', 'source_sha256'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`build provenance has an unknown key "${key}"`)
  }
  if (record.schema_version !== BUILD_PROVENANCE_SCHEMA) {
    throw new Error('build provenance schema_version is unsupported')
  }
  const roots = (raw: unknown, field: string) : string[] => {
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
      if (underRoot(source, output) || underRoot(output, source)) {
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

/**
 * Refuse a provenance declaration that records its own digest, which no value
 * can satisfy: the file would be an input to the digest it carries.
 *
 * @param declaredPath package-relative path of the provenance file
 */

export function assertProvenanceOutsideSources(declaredPath: string, sources: readonly string[]) {
  const file = logicalPath(declaredPath)
  for (const source of sources) {
    if (underRoot(file, logicalPath(source))) {
      throw new Error('build provenance must not live inside a declared source root')
    }
  }
}
