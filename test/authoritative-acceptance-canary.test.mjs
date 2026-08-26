import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { observableChildPid } from './fixtures/authoritative-acceptance-canary/observable-child-pid.js'

const fixtureManifest = new URL('./fixtures/authoritative-acceptance-canary/package.json', import.meta.url)

test('the packed canary includes its host-visible child lookup helper', () => {
  const manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8'))
  assert.equal(manifest.files.includes('observable-child-pid.js'), true)
})

test('cancellable child lookup fails closed when host process enumeration is unavailable', () => {
  assert.throws(
    () => observableChildPid(
      42,
      '/isolated/cancellable.pid',
      '/isolated/cancellable.heartbeat',
      '/definitely-not-a-proc-root',
    ),
    /host-visible cancellable child lookup unavailable/u,
  )
})
