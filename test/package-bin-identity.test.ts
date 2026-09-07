import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'))

// npm and pnpm set the executable bit on every bin target while installing a
// package. The operations engine digests the executable role of each packed
// path, so a bin target that ships non-executable installs to an identity the
// plan never authenticated and the install is refused as
// `native-dsh-verification-failed`. `tsc` emits 0644, so the build has to set
// this; nothing else in the repository observes an installed tree.
test('every published bin target ships executable', () => {
  const targets = Object.entries(manifest.bin as Record<string, string>)
  assert.ok(targets.length > 0, 'package.json#bin names no target')
  for (const [name, target] of targets) {
    assert.ok(target.startsWith('./dist/'), `${name} is not build output: ${target}`)
    const mode = statSync(resolve(projectRoot, target)).mode
    assert.notEqual(mode & 0o111, 0, `${name} ships non-executable: ${target}`)
  }
})
