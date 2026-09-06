// Record the digest of the sources this build consumed.
//
// The operations engine recomputes this digest from the sources *as packed* and
// refuses a mismatch as `build-output-stale`, which is the only signal that
// catches a `dist/` built from different sources: `npm pack --ignore-scripts`
// runs no build, and every npm lifecycle hook that could run one is refused.
//
// The file list therefore has to be the list npm will actually pack, taken from
// `npm pack --dry-run --json`. A walk of the working tree does not match: npm
// drops the names it always ignores (`.gitignore`, `.npmignore`, `.npmrc`,
// `.DS_Store`, `.*.swp`, `*.orig`, `package-lock.json`) and a tarball carries no
// directory entries, so an empty directory does not survive a pack and extract.
// Digesting the working tree would disagree with the engine over entirely
// ordinary contents and fail every install as stale, with no rebuild able to fix
// it.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILD_PROVENANCE_SCHEMA, digestSourceFiles } from '../dist/src/operations/build-provenance.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'))
const declared = manifest.dsh?.build
if (typeof declared !== 'string') {
  console.error('package.json#dsh.build is not declared')
  process.exit(64)
}

const SOURCES = ['src', 'index.ts', 'policy.ts', 'bin']
const OUTPUTS = ['dist']

const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: projectRoot,
  encoding: 'utf8',
})
if (packed.status !== 0) {
  console.error(`npm pack --dry-run failed:\n${packed.stderr}`)
  process.exit(70)
}

/** Package-relative paths npm will place in the tarball. */
const packedPaths = JSON.parse(packed.stdout)[0].files.map(file => file.path)

// Only a root that survives packing may be declared: the engine walks these
// inside the extracted package and refuses a root that is not there.
const roots = SOURCES.filter(root => packedPaths.some(
  path => path === root || path.startsWith(`${root}/`),
))
if (roots.length === 0) {
  console.error('no declared source root survives npm pack; check package.json#files')
  process.exit(70)
}

const files = packedPaths.filter(path => roots.some(
  root => path === root || path.startsWith(`${root}/`),
))

writeFileSync(resolve(projectRoot, declared), `${JSON.stringify({
  schema_version: BUILD_PROVENANCE_SCHEMA,
  sources: roots,
  outputs: OUTPUTS,
  source_sha256: digestSourceFiles(projectRoot, files),
}, null, 2)}\n`)

console.log(`recorded provenance for ${files.length} source files under ${roots.join(', ')}`)
