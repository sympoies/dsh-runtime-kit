// @ts-check

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const BUILD_ROOTS = Object.freeze(['apps', 'packages', 'vendor'])

export class DshBuildClosureError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'DshBuildClosureError'
    this.code = 'DSH_RUNTIME_KIT_DSH_BUILD_CLOSURE_INVALID'
  }
}

/** @param {string} root @param {string} child */
function relativeBuildPath(root, child) {
  const path = relative(root, child)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new DshBuildClosureError('DSH build path escaped its authenticated root')
  }
  return path.split(sep).join('/')
}

/**
 * Hash the complete generated host closure under every DSH lib directory.
 * Paths, lengths, and bytes are framed so additions, removals, renames, and
 * content changes all produce a different digest.
 * @param {string} sourceRoot
 */
export async function digestDshBuildClosure(sourceRoot) {
  if (!isAbsolute(sourceRoot)) {
    throw new DshBuildClosureError('DSH source root must be absolute')
  }
  const root = await realpath(sourceRoot)
  /** @type {{path:string,relative:string,size:number}[]} */
  const files = []

  /** @param {string} directory */
  async function collectLib(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new DshBuildClosureError('DSH build closure contains a non-regular entry')
      }
      if (entry.isDirectory()) {
        await collectLib(path)
        continue
      }
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new DshBuildClosureError('DSH build closure contains a non-regular entry')
      }
      files.push(Object.freeze({
        path,
        relative: relativeBuildPath(root, path),
        size: metadata.size,
      }))
    }
  }

  /** @param {string} directory */
  async function discoverLibs(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const path = resolve(directory, entry.name)
      if (entry.name === 'lib') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new DshBuildClosureError('DSH lib closure is not a regular directory')
        }
        await collectLib(path)
      } else if (entry.isDirectory()) {
        await discoverLibs(path)
      }
    }
  }

  for (const name of BUILD_ROOTS) await discoverLibs(resolve(root, name))
  files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'))
  if (files.length === 0) {
    throw new DshBuildClosureError('DSH build closure contains no generated files')
  }
  const hash = createHash('sha256')
  let byteCount = 0
  for (const file of files) {
    const bytes = await readFile(file.path)
    if (bytes.length !== file.size) {
      throw new DshBuildClosureError('DSH build closure changed while it was inspected')
    }
    byteCount += bytes.length
    hash.update(file.relative, 'utf8')
    hash.update('\0')
    hash.update(String(bytes.length), 'ascii')
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return Object.freeze({
    sha256: hash.digest('hex'),
    file_count: files.length,
    byte_count: byteCount,
  })
}
