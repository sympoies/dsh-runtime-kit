import assert from 'node:assert/strict'
import test from 'node:test'

import { probeNativeSubagentWorkspace } from './fixtures/native-subagent-workspace.mjs'

function host({ cwd = '/child', leaseState = 'owned', earlyPrompt = false, sharedRef = false, idle } = {}) {
  const parent = { id: 'parent', session: { header: { cwd: '/parent' } } }
  const child = {
    id: 'child',
    session: { header: { cwd, parentSession: parent.id } },
    whenIdle: () => idle ?? Promise.resolve(),
  }
  const parentRef = {}
  const childRef = {}
  const disposals = []
  let observe
  let provider
  const ctx = {
    on(_event, listener) {
      observe = listener
      return () => { disposals.push('observer') }
    },
    workspaceLease: {
      async ref(agent) { return agent === parent || sharedRef ? parentRef : childRef },
      async state() { return leaseState },
    },
    subagents: {
      registerContinuableWorkspaceProvider(selected) {
        provider = selected
        return () => { disposals.push('provider') }
      },
      async startContinuable(spec) {
        assert.equal(spec.provider, 'in-process')
        provider.validate(spec.workspace.ref, spec.request.parent)
        const prepared = await provider.prepare({
          sessionId: child.id, parent, ref: spec.workspace.ref,
          descriptor: { provider: provider.name, version: provider.version },
        })
        assert.equal(prepared.cwd, '/child')
        if (earlyPrompt) observe({ agent: child }, () => {})
        await provider.activate({ agent: child })
        observe({ agent: child }, () => {})
        return { childId: child.id }
      },
      async closeContinuable(caller, childId, signal) {
        assert.equal(caller, parent)
        assert.equal(childId, child.id)
        assert.equal(signal.aborted, false)
        disposals.push('child')
      },
    },
  }
  return { ctx, parent, disposals }
}

test('native workspace probe proves distinct host selection and pre-prompt lease before closing child', async () => {
  const fixture = host()
  const receipt = await probeNativeSubagentWorkspace(fixture.ctx, {
    parent: fixture.parent, workspace: '/child', signal: AbortSignal.timeout(1_000),
  })
  assert.equal(receipt.distinct_workspace, true)
  assert.equal(receipt.lease_ready_before_first_prompt, true)
  assert.deepEqual(receipt.order, ['workspace-issued', 'lease-ready', 'first-prompt', 'child-idle', 'child-closed'])
  assert.deepEqual(fixture.disposals, ['child', 'provider', 'observer'])
})

test('native workspace probe rejects workspace reuse, shared authority and unowned child lease', async () => {
  const reused = host()
  await assert.rejects(probeNativeSubagentWorkspace(reused.ctx, {
    parent: reused.parent, workspace: '/parent', signal: AbortSignal.timeout(1_000),
  }), /distinct workspace/)
  for (const options of [{ cwd: '/parent' }, { sharedRef: true }, { leaseState: 'foreign-active' }]) {
    const fixture = host(options)
    await assert.rejects(probeNativeSubagentWorkspace(fixture.ctx, {
      parent: fixture.parent, workspace: '/child', signal: AbortSignal.timeout(1_000),
    }), { code: 'ERR_ASSERTION' })
    assert.deepEqual(fixture.disposals, ['provider', 'observer'])
  }
})

test('native workspace probe rejects prompt before host activation and drops its registrations', async () => {
  const fixture = host({ earlyPrompt: true })
  await assert.rejects(probeNativeSubagentWorkspace(fixture.ctx, {
    parent: fixture.parent, workspace: '/child', signal: AbortSignal.timeout(1_000),
  }), /activated child/)
  assert.deepEqual(fixture.disposals, ['provider', 'observer'])
})

test('native workspace probe bounds an idle child wait and closes its admitted continuation', async () => {
  const fixture = host({ idle: new Promise(() => {}) })
  const controller = new AbortController()
  const pending = probeNativeSubagentWorkspace(fixture.ctx, {
    parent: fixture.parent, workspace: '/child', signal: controller.signal,
  })
  const timeout = setTimeout(() => controller.abort(new Error('fixture deadline')), 20)
  try {
    await assert.rejects(pending, /fixture deadline/)
    assert.deepEqual(fixture.disposals, ['child', 'provider', 'observer'])
  } finally {
    clearTimeout(timeout)
  }
})
