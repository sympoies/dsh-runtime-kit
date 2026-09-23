import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const SCHEMA = 'dsh-runtime-kit.dsh-tui-pristine.v2'
const INSPECTION_SCHEMA = 'dsh-runtime-kit.dsh-tui-pristine-inspection.v2'
const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const SHA256 = /^[0-9a-f]{64}$/u
// pnpm materializes transitive dependencies under this directory. The reviewed
// TUI tarball has no node_modules, so this install graph is outside its file
// inventory and is checked by the consumer's frozen dependency graph instead.
const INSTALLED_DEPENDENCY_ROOT = 'node_modules'

function manifestRecord(value: unknown): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DSH TUI pristine manifest must be an object')
  }
  return value as Record<string, any>
}

function validatedManifest(value: unknown) {
  const manifest = manifestRecord(value)
  const files = manifestRecord(manifest.files)
  if (manifest.schema_version !== SCHEMA
    || manifest.package_name !== PACKAGE_NAME
    || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    || !Number.isSafeInteger(manifest.file_count)
    || manifest.file_count < Object.keys(files).length
    || typeof manifest.tree_sha256 !== 'string'
    || !SHA256.test(manifest.tree_sha256)
    || !Number.isSafeInteger(manifest.installed_file_count)
    || manifest.installed_file_count < Object.keys(files).length
    || manifest.installed_file_count > manifest.file_count
    || typeof manifest.installed_tree_sha256 !== 'string'
    || !SHA256.test(manifest.installed_tree_sha256)
    || !Object.hasOwn(files, 'package.json')
    || Object.keys(files).length === 0) {
    throw new Error('DSH TUI pristine manifest identity is invalid')
  }
  for (const [path, hash] of Object.entries(files)) {
    if (!path || isAbsolute(path) || path.split(/[\\/]/u).includes('..')
      || typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new Error('DSH TUI pristine manifest file is invalid')
    }
  }
  return manifest as {
    package_name: string,
    version: string,
    file_count: number,
    tree_sha256: string,
    installed_file_count: number,
    installed_tree_sha256: string,
    files: Record<string, string>,
  }
}

function publishedTreeIdentity(root: string): { fileCount: number, sha256: string } {
  const files: string[] = []
  const walk = (directory: string, prefix = ''): void => {
    for (const name of readdirSync(directory)) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      const absolute = join(directory, name)
      const metadata = lstatSync(absolute)
      if (path === INSTALLED_DEPENDENCY_ROOT) {
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error('installed dependency root is unsafe')
        }
        continue
      }
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        walk(absolute, path)
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        files.push(path)
      } else {
        throw new Error('published package tree contains a non-file')
      }
    }
  }
  walk(root)
  files.sort()
  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(path)
    digest.update('\0')
    digest.update(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'))
    digest.update('\0')
  }
  return { fileCount: files.length, sha256: digest.digest('hex') }
}

/** Observe reviewed published bytes without repairing or rewriting the TUI. */
export function inspectDshTuiPristine(input: { packageRoot: string, manifest: unknown }) {
  const manifest = validatedManifest(input.manifest)
  const base = {
    schema_version: INSPECTION_SCHEMA,
    package_name: manifest.package_name,
    version: manifest.version,
  }
  const outcome = (status: string, extra: Record<string, unknown> = {}) => Object.freeze({
    ...base,
    ok: status === 'pristine',
    status,
    ...extra,
  })
  if (!isAbsolute(input.packageRoot)) return outcome('unsupported', { error: 'package root must be absolute' })
  try {
    if (realpathSync(input.packageRoot) !== input.packageRoot) {
      return outcome('unsupported', { error: 'package root must not traverse a symlink' })
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? outcome('absent', { error: 'the DSH TUI package is not installed' })
      : outcome('unsupported', { error: 'the DSH TUI package root is unreadable' })
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const candidate = resolve(input.packageRoot, path)
    const rel = relative(input.packageRoot, candidate)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return outcome('unsupported', { error: 'package file escapes its root', path })
    }
    try {
      const metadata = lstatSync(candidate)
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || realpathSync(dirname(candidate)) !== dirname(candidate)) {
        return outcome('unsupported', { error: 'package file is not ordinary', path })
      }
      const actual = createHash('sha256').update(readFileSync(candidate)).digest('hex')
      if (actual !== expected) return outcome('drift', { error: 'published package file changed', path })
    } catch {
      return outcome('unsupported', { error: 'package file is unreadable', path })
    }
  }
  let identity
  try {
    identity = JSON.parse(readFileSync(resolve(input.packageRoot, 'package.json'), 'utf8'))
  } catch {
    return outcome('unsupported', { error: 'package manifest is invalid' })
  }
  if (identity?.name !== manifest.package_name || identity?.version !== manifest.version) {
    return outcome('unsupported', { error: 'package identity changed' })
  }
  try {
    const tree = publishedTreeIdentity(input.packageRoot)
    if (tree.fileCount !== manifest.installed_file_count
      || tree.sha256 !== manifest.installed_tree_sha256) {
      return outcome('drift', { error: 'published package tree changed' })
    }
  } catch {
    return outcome('unsupported', { error: 'published package tree is unreadable or unsafe' })
  }
  return outcome('pristine')
}
