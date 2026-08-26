import assert from 'node:assert/strict'
import { test } from 'node:test'

import { observableChildPid } from './fixtures/authoritative-acceptance-canary/observable-child-pid.js'

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
