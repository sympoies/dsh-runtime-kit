import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedSessionBridge } from '../dist/src/nils/session-bridge.js'

test('session bindings are private, cannot be overwritten, and old disposers cannot erase a replacement', async () => {
  const bridge = createManagedSessionBridge()
  const principal = Object.freeze({ sessionId: 'first' })
  const release = bridge.bind('dsh-session', principal)
  assert.equal(bridge.resolve('other-session'), undefined)
  assert.equal(await bridge.authenticate('dsh-session', {}), principal)
  assert.throws(() => bridge.bind('dsh-session', { sessionId: 'second' }), /already bound/)
  release()
  const replacement = Object.freeze({ sessionId: 'replacement' })
  const releaseReplacement = bridge.bind('dsh-session', replacement)
  release()
  assert.equal(bridge.resolve('dsh-session'), replacement)
  releaseReplacement()
  assert.equal(bridge.resolve('dsh-session'), undefined)
})

test('startup authentication and resolver registrations retain independent disposal fences', async () => {
  const bridge = createManagedSessionBridge()
  const principal = { sessionId: 'authenticated' }
  let calls = 0
  const releaseAuthenticator = bridge.registerAuthenticator(async (id, execution) => {
    calls += 1
    assert.equal(execution, 'execution')
    return id === 'session' ? principal : undefined
  })
  assert.throws(() => bridge.registerAuthenticator(async () => principal), /already registered/)
  assert.equal(await bridge.authenticate('session', 'execution'), principal)
  assert.equal(bridge.resolve('session'), undefined)
  const releaseResolver = bridge.register(id => id === 'session' ? principal : undefined)
  assert.equal(await bridge.authenticate('session', 'execution'), principal)
  assert.equal(calls, 1)
  releaseResolver()
  releaseAuthenticator()
  assert.equal(await bridge.authenticate('session', 'execution'), undefined)
})
