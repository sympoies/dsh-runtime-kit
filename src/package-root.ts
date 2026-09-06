import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The installed package root.
 *
 * Assets ship beside the package, not beside the module. Resolving one relative
 * to `import.meta.url` worked while the sources ran directly, but a build step
 * moves every module under `dist/` at a depth that differs per file, so those
 * relative paths would resolve inside the build output where no asset exists.
 * Walking up to the directory that owns `package.json` is correct from either
 * tree and at any nesting depth.
 */
function findPackageRoot(from: string): string {
  let directory = dirname(from)
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('dsh-runtime-kit: package root could not be resolved')
}

export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url))

/** Resolve a package-relative path against the installed package root. */
export function packageAsset(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments)
}
