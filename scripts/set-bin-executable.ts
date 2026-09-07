// Make the published bin entries executable in the build output.
//
// The bin entries are build output now, and `tsc` emits 0644. npm and pnpm mark
// a bin target executable while installing it, and the operations engine binds
// the executable role of every packed path into the package identity. An
// artifact whose bin entries are not already executable therefore installs to a
// different identity than the one the plan authenticated, and the install is
// refused as `native-dsh-verification-failed` — with nothing in the repository
// able to observe it, because the mismatch only exists after an install.
//
// Emitting what the installer will produce is the fix: the extracted artifact
// and the installed tree then digest identically.

import { chmodSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { PACKAGE_ROOT } from '../src/package-root.js'

const manifest = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'))
const bin: unknown = manifest.bin
if (bin === null || typeof bin !== 'object' || Array.isArray(bin)) {
  console.error('package.json#bin is not an object')
  process.exit(64)
}

const targets = Object.values(bin as Record<string, unknown>)
if (targets.length === 0 || targets.some(target => typeof target !== 'string')) {
  console.error('package.json#bin must name at least one string target')
  process.exit(64)
}

for (const target of targets as string[]) {
  const absolute = resolve(PACKAGE_ROOT, target)
  const fragment = relative(PACKAGE_ROOT, absolute)
  // A bin target is build output. Refuse anything that escapes the package or
  // names a source file, so this never widens beyond what `tsc` just emitted.
  if (isAbsolute(fragment) || !fragment.startsWith(`dist${sep}`)) {
    console.error(`bin target is not build output: ${target}`)
    process.exit(65)
  }
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile()) {
    console.error(`bin target is missing from the build output: ${target}`)
    process.exit(65)
  }
  chmodSync(absolute, 0o755)
}

console.log(`marked ${targets.length} bin target(s) executable`)
