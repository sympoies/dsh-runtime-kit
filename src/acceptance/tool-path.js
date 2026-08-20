import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** @param {string} value */
function shellLiteral(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Build a scenario PATH without relocating package-relative launchers.
 *
 * @param {string} root
 * @param {Record<string,{path:string}>} tools
 */
export async function createToolPath(root, tools) {
  const path = resolve(root, 'tool-path')
  await mkdir(path, { mode: 0o700 })
  const entries = {
    git: tools.git.path,
    npm: tools.npm.path,
    pnpm: tools.pnpm.path,
    tar: tools.tar.path,
    node: process.execPath,
  }
  for (const [name, target] of Object.entries(entries)) {
    const destination = resolve(path, name)
    await writeFile(
      destination,
      `#!/bin/sh\nexec ${shellLiteral(target)} "$@"\n`,
      { mode: 0o500, flag: 'wx' },
    )
    await chmod(destination, 0o500)
  }
  return path
}
