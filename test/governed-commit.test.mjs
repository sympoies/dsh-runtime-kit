import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGovernedCommitTool } from '../src/governed-commit/index.js'
import { isolatedNilsEnvironment } from '../src/nils/session-environment.js'

const expectedHead = 'a'.repeat(40)

function execution(overrides = {}) {
  const signal = new AbortController().signal
  const session = {
    id: 'session-current',
    header: { id: 'session-current', cwd: '/managed/worktrees/task' },
    events: [],
  }
  return {
    token: Symbol('governed-commit-call'),
    callId: 'governed-commit-call',
    rootCallId: 'governed-commit-call',
    name: 'runtime_kit_governed_commit',
    arguments: {},
    signal,
    agent: { id: 'session-current', session },
    deferContext() {},
    concludeTurn() {},
    ...overrides,
  }
}

function semanticReceipt() {
  return {
    schema_version: 'cli.semantic-commit.commit.v1',
    ok: true,
    operation: 'commit',
    validate_only: false,
    dry_run: false,
    commit: {
      sha: 'b'.repeat(40),
      subject: 'feat(runtime): add native governed commit',
    },
    target: null,
    staged: {
      file_count: 1,
      files: [{ status: 'M', path: 'src/runtime.js', old_path: null }],
    },
  }
}

function harness({
  receipt = semanticReceipt(),
  outcome = { exitCode: 0, signal: null },
  pending = false,
  lossy = false,
  quiescent = true,
  waitPending = false,
  waitError,
  resolveError,
  resolvePending = false,
  spawnError,
} = {}) {
  const spawns = []
  const resolutions = []
  let settle
  let settleResolve
  let settleWait
  let terminateCount = 0
  let disposer
  const ctx = {
    effect(register) { disposer = register() },
    subprocess: {
      async resolveExecutable(command, env, signal) {
        resolutions.push({ command, env, signal })
        if (resolveError !== undefined) throw resolveError
        if (resolvePending) {
          return new Promise(resolve => { settleResolve = resolve })
        }
        return `/resolved/${command}`
      },
      spawn(spec) {
        if (spawnError !== undefined) throw spawnError
        spawns.push(spec)
        const done = pending
          ? new Promise(resolve => { settle = resolve })
          : Promise.resolve(outcome)
        return {
          done,
          terminate() {
            terminateCount += 1
            settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
          collected: {
            stdout: {
              readFrom: () => ({ text: JSON.stringify(receipt), lossy }),
            },
          },
          waitForExit() {
            if (waitError !== undefined) throw waitError
            return waitPending
              ? new Promise(resolve => { settleWait = resolve })
              : Promise.resolve(quiescent)
          },
        }
      },
    },
  }
  return {
    ctx,
    spawns,
    resolutions,
    get terminateCount() { return terminateCount },
    settleResolve(value = '/resolved/semantic-commit') { settleResolve?.(value) },
    settle(value = outcome) { settle?.(value) },
    settleWait(value = quiescent) { settleWait?.(value) },
    dispose() { return disposer?.() },
  }
}

function validArgs() {
  return {
    type: 'feat',
    scope: 'runtime',
    subject: 'add native governed commit',
    body_bullets: ['Bind delivery to the session-owned managed worktree.'],
    expected_head: expectedHead,
  }
}

test('governed commit binds a literal semantic-commit argv to the authenticated session worktree', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
  })
  const args = validArgs()

  const result = await tool.execute(args, execution({ arguments: args }))

  assert.equal(tool.name, 'runtime_kit_governed_commit')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(subject.resolutions.map(value => value.command), ['semantic-commit'])
  assert.equal(subject.spawns.length, 1)
  assert.deepEqual(subject.spawns[0].argv, [
    '/resolved/semantic-commit',
    'commit',
    '--automation',
    '--json',
    '--summary', 'none',
    '--expect-head', expectedHead,
    '--type', 'feat',
    '--scope', 'runtime',
    '--subject', 'add native governed commit',
    '--body-bullet', 'Bind delivery to the session-owned managed worktree.',
  ])
  assert.equal(subject.spawns[0].cwd, '/managed/worktrees/task')
  assert.deepEqual(subject.spawns[0].env, isolatedNilsEnvironment(undefined))
  assert.equal(subject.spawns[0].argv.includes('--repo'), false)
  assert.equal(subject.spawns[0].argv.includes('--message-file'), false)
  assert.deepEqual(result, {
    schema_version: 'dsh-runtime-kit.governed-commit.result.v1',
    status: 'committed',
    commit: {
      sha: 'b'.repeat(40),
      subject: 'feat(runtime): add native governed commit',
    },
    staged: {
      file_count: 1,
      files: [{ status: 'M', path: 'src/runtime.js', old_path: null }],
    },
  })
})

test('governed commit rejects model-authored repository routing before spawning', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
  })
  const valid = {
    type: 'fix',
    subject: 'preserve the authenticated target',
    body_bullets: ['Do not accept a repository or workdir argument.'],
    expected_head: expectedHead,
  }

  await assert.rejects(
    tool.execute({ ...valid, repo: '/foreign/repository' }, execution()),
    /expects exactly the governed message and expected-head fields/,
  )
  await assert.rejects(
    tool.execute({ ...valid, expected_head: 'HEAD' }, execution()),
    /expected_head must be a full object id/,
  )
  assert.equal(subject.spawns.length, 0)
})

test('governed commit preserves stable rejection and receipt failure codes without child output', async () => {
  const rejected = harness({ outcome: { exitCode: 65, signal: null } })
  const rejectedTool = createGovernedCommitTool(rejected.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
  })
  await assert.rejects(
    rejectedTool.execute(validArgs(), execution()),
    error => error.code === 'GOVERNED_COMMIT_REJECTED'
      && !error.message.includes('private child detail'),
  )

  const malformed = harness({ receipt: { schema_version: 'substituted' } })
  const malformedTool = createGovernedCommitTool(malformed.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
  })
  await assert.rejects(
    malformedTool.execute(validArgs(), execution()),
    error => error.code === 'GOVERNED_COMMIT_RECEIPT_INVALID',
  )
})

test('governed commit cancellation terminates and joins the subprocess before returning', async () => {
  const subject = harness({ pending: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
    TOOL_ABORTED: 'TOOL_ABORTED',
  })
  const controller = new AbortController()
  const running = tool.execute(validArgs(), execution({ signal: controller.signal }))
  while (subject.spawns.length === 0) await new Promise(resolve => setImmediate(resolve))

  controller.abort(new Error('caller cancelled'))

  await assert.rejects(running, error => error.code === 'TOOL_ABORTED')
  assert.equal(subject.terminateCount, 1)
})

test('governed commit disposal terminates and joins every active subprocess before settling', async () => {
  const subject = harness({ pending: true, waitPending: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
  })
  const running = tool.execute(validArgs(), execution())
  while (subject.spawns.length === 0) await new Promise(resolve => setImmediate(resolve))

  let disposed = false
  const disposing = Promise.resolve(subject.dispose()).then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(subject.terminateCount, 1)
  assert.equal(disposed, false)
  subject.settleWait(true)
  await assert.rejects(running, error => error.code === 'GOVERNED_COMMIT_DISPOSED')
  await disposing
  assert.equal(disposed, true)
})

test('governed commit sanitizes worktree, resolution, spawn, and quiescence failures', async () => {
  const privateDetail = 'private /machine/worktree detail'
  const worktree = harness()
  const worktreeTool = createGovernedCommitTool(worktree.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: () => { throw new Error(privateDetail) },
  })
  await assert.rejects(
    worktreeTool.execute(validArgs(), execution()),
    error => error.code === 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE'
      && !error.message.includes(privateDetail),
  )

  for (const [subject, expectedCode, semanticCommit] of [
    [harness({ resolveError: new Error(privateDetail) }), 'GOVERNED_COMMIT_UNAVAILABLE', 'semantic-commit'],
    [harness({ spawnError: new Error(privateDetail) }), 'GOVERNED_COMMIT_UNAVAILABLE', '/tools/semantic-commit'],
    [harness({ waitError: new Error(privateDetail) }), 'GOVERNED_COMMIT_UNAVAILABLE', '/tools/semantic-commit'],
  ]) {
    const tool = createGovernedCommitTool(subject.ctx, {
      semanticCommit,
      canonicalPath: value => value,
    })
    await assert.rejects(
      tool.execute(validArgs(), execution()),
      error => error.code === expectedCode && !error.message.includes(privateDetail),
    )
  }
})

test('governed commit refuses a primary-relative or missing authenticated cwd before resolution', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
  })
  await assert.rejects(
    tool.execute(validArgs(), execution({
      agent: { id: 'session-current', session: { header: { cwd: 'relative/repository' } } },
    })),
    error => error.code === 'GOVERNED_COMMIT_WORKTREE_UNAVAILABLE',
  )
  assert.equal(subject.resolutions.length, 0)
  assert.equal(subject.spawns.length, 0)
})

test('governed commit timeout covers executable resolution and prevents a late spawn', async () => {
  const subject = harness({ resolvePending: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    governedCommitTimeoutMs: 5,
  })
  const running = tool.execute(validArgs(), execution())
  const observed = running.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', code: error.code }),
  )
  while (subject.resolutions.length === 0) await new Promise(resolve => setImmediate(resolve))

  const beforeLateResolution = await Promise.race([
    observed,
    new Promise(resolve => setTimeout(() => resolve({ status: 'deadline-missed' }), 50)),
  ])
  subject.settleResolve()
  await observed

  assert.deepEqual(beforeLateResolution, {
    status: 'rejected',
    code: 'GOVERNED_COMMIT_TIMEOUT',
  })
  assert.equal(subject.spawns.length, 0)
})

test('governed commit disposal settles pending executable resolution without a late spawn', async () => {
  const subject = harness({ resolvePending: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
  })
  const running = tool.execute(validArgs(), execution())
  while (subject.resolutions.length === 0) await new Promise(resolve => setImmediate(resolve))

  const disposing = Promise.resolve(subject.dispose()).then(() => ({ status: 'disposed' }))
  const beforeLateResolution = await Promise.race([
    disposing,
    new Promise(resolve => setTimeout(() => resolve({ status: 'disposal-stalled' }), 50)),
  ])
  subject.settleResolve()
  await assert.rejects(running, error => error.code === 'GOVERNED_COMMIT_DISPOSED')
  await disposing

  assert.deepEqual(beforeLateResolution, { status: 'disposed' })
  assert.equal(subject.spawns.length, 0)
})
