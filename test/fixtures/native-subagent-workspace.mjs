import assert from 'node:assert/strict'

// A host-only smoke fixture. The model cannot select a cwd or the opaque ref.
export async function probeNativeSubagentWorkspace(ctx, { parent, workspace, agentOptions, signal }) {
  signal.throwIfAborted()
  assert.notEqual(workspace, parent.session.header.cwd, 'child must use a distinct workspace')
  const subagents = ctx.subagents
  assert.equal(typeof subagents?.registerContinuableWorkspaceProvider, 'function')
  const nativeProvider = subagents.getProvider('spawn')
  assert.equal(typeof nativeProvider?.prepareContinuable, 'function',
    'native workspace smoke requires the registered spawn provider with continuable support')
  const ref = Object.freeze(Object.create(null))
  const order = []
  let childId
  let child
  let leaseReady = false
  let started
  let resolvePrompt
  let rejectPrompt
  const firstPrompt = new Promise((resolve, reject) => {
    resolvePrompt = resolve
    rejectPrompt = reject
  })
  // A failed start can reject the observation before the probe awaits it.
  void firstPrompt.catch(() => {})
  let rejectAborted
  const aborted = new Promise((_, reject) => { rejectAborted = reject })
  void aborted.catch(() => {})
  const onAbort = () => rejectAborted(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  const stopObserving = ctx.on('agent/pre-step', ({ agent }, next) => {
    if (String(agent.id) === String(childId)) {
      try {
        assert.equal(agent, child, 'prompt must belong to the activated child')
        assert.equal(leaseReady, true, 'child prompt preceded lease readiness')
        assert.equal(agent.session.header.cwd, workspace)
        if (!order.includes('first-prompt')) order.push('first-prompt')
        resolvePrompt()
      } catch (error) {
        rejectPrompt(error)
        throw error
      }
    }
    return next()
  })
  let unregister
  try {
    unregister = subagents.registerContinuableWorkspaceProvider({
      name: 'native-workspace-smoke',
      version: 1,
      validate(candidate, caller) {
        assert.equal(candidate, ref)
        assert.equal(caller, parent)
      },
      async prepare(request) {
        signal.throwIfAborted()
        assert.equal(request.parent, parent)
        assert.equal(request.ref, ref)
        assert.deepEqual(request.descriptor, { provider: 'native-workspace-smoke', version: 1 })
        childId = request.sessionId
        order.push('workspace-issued')
        return { cwd: workspace }
      },
      async activate({ agent }) {
        child = agent
        assert.equal(String(agent.id), String(childId))
        assert.equal(agent.session.header.cwd, workspace)
        assert.equal(String(agent.session.header.parentSession), String(parent.id))
        const childRef = await ctx.workspaceLease.ref(agent)
        assert.notEqual(childRef, await ctx.workspaceLease.ref(parent))
        assert.equal(await ctx.workspaceLease.state(agent, childRef), 'owned', 'child lease must be owned')
        signal.throwIfAborted()
        leaseReady = true
        order.push('lease-ready')
      },
    })
    started = await subagents.startContinuable({
      provider: nativeProvider.name,
      label: 'native-workspace-smoke',
      workspace: { provider: 'native-workspace-smoke', ref },
      request: {
        parent,
        prompt: [{ type: 'text', text: 'Complete the native workspace smoke.' }],
        agentOptions,
      },
      signal,
    })
    assert.equal(String(started.childId), String(childId))
    await Promise.race([firstPrompt, aborted])
    await Promise.race([child.whenIdle(), aborted])
    order.push('child-idle')
  } finally {
    try {
      if (started !== undefined) {
        await subagents.closeContinuable(parent, started.childId, AbortSignal.timeout(5_000))
        order.push('child-closed')
      }
    } finally {
      unregister?.()
      stopObserving()
      signal.removeEventListener('abort', onAbort)
    }
  }
  assert.deepEqual(order, ['workspace-issued', 'lease-ready', 'first-prompt', 'child-idle', 'child-closed'])
  return {
    schema_version: 'dsh-runtime-kit.native-subagent-workspace.v1',
    distinct_workspace: true,
    lease_ready_before_first_prompt: true,
    child_completed: true,
    child_closed: true,
    order,
  }
}
