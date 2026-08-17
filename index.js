import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPolicy, plusOneTool } from './policy.js'

export { plusOneTool }

export const name = 'dsh-runtime-kit'
export const inject = ['skills', 'subprocess', 'tools']

const bundledSkillDir = fileURLToPath(new URL('./skills/', import.meta.url))

async function filesystemSkillsApply() {
  try {
    return (await import('@deepseek-ai/dsh-skill-filesystem')).apply
  } catch (error) {
    const sourceCheckoutWithoutBuild = error?.code === 'ERR_MODULE_NOT_FOUND'
      && String(error.message).includes('dsh-skill-filesystem/lib/index.js')
    if (!sourceCheckoutWithoutBuild) throw error
    return (await import('@deepseek-ai/dsh-skill-filesystem/src/index.ts')).apply
  }
}

function privateSkillsDir(config) {
  const configured = config.privateSkillsDir
    ?? process.env.DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR
  if (configured === undefined || configured === '') return undefined
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be an absolute path')
  }
  if (process.platform === 'win32') {
    throw new Error('dsh-runtime-kit: privateSkillsDir is disabled on Windows until ACL trust checks are available')
  }

  const requested = resolve(configured)
  const linkMetadata = lstatSync(requested)
  if (linkMetadata.isSymbolicLink()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must not be a symbolic link')
  }
  const canonical = realpathSync(requested)
  const metadata = statSync(canonical)
  if (!metadata.isDirectory()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be a directory')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must be owned by the current user')
  }
  assertTrustedPrivateTree(canonical)
  return canonical
}

function writableByGroupOrWorld(metadata) {
  return (metadata.mode & 0o022) !== 0
}

function assertTrustedAncestor(directory) {
  const metadata = statSync(directory)
  if (!metadata.isDirectory()) {
    throw new Error('dsh-runtime-kit: privateSkillsDir ancestors must be directories')
  }
  if (!writableByGroupOrWorld(metadata)) return
  const stickyOwner = (metadata.mode & 0o1000) !== 0
    && (metadata.uid === 0
      || (typeof process.getuid === 'function' && metadata.uid === process.getuid()))
  if (!stickyOwner) {
    throw new Error('dsh-runtime-kit: privateSkillsDir has an unsafe writable ancestor')
  }
}

function assertTrustedPrivateTree(root) {
  const rootMetadata = statSync(root)
  if (writableByGroupOrWorld(rootMetadata)) {
    throw new Error('dsh-runtime-kit: privateSkillsDir must not be group- or world-writable')
  }

  const filesystemRoot = parse(root).root
  for (let cursor = dirname(root);; cursor = dirname(cursor)) {
    assertTrustedAncestor(cursor)
    if (cursor === filesystemRoot) break
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name)
      const entryMetadata = lstatSync(entryPath)
      if (entryMetadata.isSymbolicLink()) {
        throw new Error('dsh-runtime-kit: privateSkillsDir must not contain symbolic links')
      }
      const canonicalEntry = realpathSync(entryPath)
      if (canonicalEntry !== root && !canonicalEntry.startsWith(`${root}${sep}`)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir entries must remain inside the configured root')
      }
      if (typeof process.getuid === 'function' && entryMetadata.uid !== process.getuid()) {
        throw new Error('dsh-runtime-kit: privateSkillsDir entries must be owned by the current user')
      }
      if (writableByGroupOrWorld(entryMetadata)) {
        throw new Error('dsh-runtime-kit: privateSkillsDir entries must not be group- or world-writable')
      }
      if (entryMetadata.isDirectory()) visit(entryPath)
    }
  }
  visit(root)
}

export async function apply(ctx, config = {}) {
  const privateRoot = privateSkillsDir(config)
  const applyFilesystemSkills = await filesystemSkillsApply()
  applyFilesystemSkills(ctx, {
    providerName: 'dsh-runtime-kit',
    includeDefaultRoots: false,
    customSkillDirs: privateRoot === undefined ? [] : [privateRoot],
    bundledSkillDir,
    watch: false,
    watchFollowSymlinks: false,
  })
  applyPolicy(ctx, config)
}
