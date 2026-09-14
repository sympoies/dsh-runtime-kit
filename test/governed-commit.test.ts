import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGovernedCommitTool } from '../dist/src/governed-commit/index.js'

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
      files: [{ status: 'M', path: 'src/runtime.ts', old_path: null }],
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
  quiescentAfterTerminate = false,
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
              : Promise.resolve(quiescent || (quiescentAfterTerminate && terminateCount > 0))
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
    hasRepository: () => true,
    environment: { XDG_RUNTIME_DIR: '/run/user/1000' },
    runtime: { uid: 1000, platform: 'linux' },
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
  assert.deepEqual(subject.spawns[0].env, {
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  })
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
      files: [{ status: 'M', path: 'src/runtime.ts', old_path: null }],
    },
  })
})

test('governed commit forwards only the ambient signing bridge to semantic-commit', async () => {
  const subject = harness()
  const environment = {
    GNUPGHOME: '/home/fixture/.gnupg',
    GPG_TTY: '/dev/pts/7',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
    XDG_RUNTIME_DIR: '/run/user/1000',
    UNRELATED_SECRET: 'must-not-cross',
  }
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
    environment,
    runtime: { uid: 1000, platform: 'linux' },
  })

  await tool.execute(validArgs(), execution({ arguments: validArgs() }))

  assert.deepEqual(subject.spawns[0].env, {
    GNUPGHOME: '/home/fixture/.gnupg',
    GPG_TTY: '/dev/pts/7',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  })
})

test('governed commit restores the authenticated session principal for commit hooks', async () => {
  const subject = harness()
  const environment = {
    GNUPGHOME: '/home/fixture/.gnupg',
    XDG_RUNTIME_DIR: '/run/user/1000',
  }
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
    environment,
    runtime: { uid: 1000, platform: 'linux' },
    managedSessionBridge: {
      resolve(sessionId) {
        assert.equal(sessionId, 'session-current')
        return {
          sessionId,
          environment: {
            AGENT_SESSION_ID: sessionId,
            AGENT_SESSION_STATE_DIR: '/state/session-current',
          },
        }
      },
    },
  })

  await tool.execute(validArgs(), execution({ arguments: validArgs() }))

  assert.deepEqual(subject.spawns[0].env, {
    GNUPGHOME: '/home/fixture/.gnupg',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    AGENT_SESSION_ID: 'session-current',
    AGENT_SESSION_STATE_DIR: '/state/session-current',
  })
})

test('governed commit rejects model-authored repository routing before spawning', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
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
    hasRepository: () => true,
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
    hasRepository: () => true,
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
    hasRepository: () => true,
    TOOL_ABORTED: 'TOOL_ABORTED',
  })
  const controller = new AbortController()
  const running = tool.execute(validArgs(), execution({ signal: controller.signal }))
  while (subject.spawns.length === 0) await new Promise(resolve => setImmediate(resolve))

  controller.abort(new Error('caller cancelled'))

  await assert.rejects(running, error => error.code === 'TOOL_ABORTED')
  assert.equal(subject.terminateCount, 1)
})

test('governed commit reaps a lingering helper after a completed signed commit', async () => {
  const subject = harness({ quiescent: false, quiescentAfterTerminate: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
    governedCommitTeardownTimeoutMs: 5,
  })

  const result = await tool.execute(validArgs(), execution())

  assert.equal(result.status, 'committed')
  assert.equal(subject.terminateCount, 1)
})

test('governed commit disposal terminates and joins every active subprocess before settling', async () => {
  const subject = harness({ pending: true, waitPending: true })
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: '/tools/semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
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
      hasRepository: () => true,
    hasRepository: () => true,
    })
    await assert.rejects(
      tool.execute(validArgs(), execution()),
      error => error.code === expectedCode && !error.message.includes(privateDetail),
    )
  }
})

test('a non-repository session cwd returns a typed no-repository result instead of spawning semantic-commit', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => false,
  })
  const result = await tool.execute(validArgs(), execution({
    agent: { id: 'session-current', session: { header: { cwd: '/srv/notes' } } },
  }))
  assert.deepEqual(result, {
    schema_version: 'dsh-runtime-kit.governed-commit.result.v1',
    status: 'no-repository',
    cwd: '/srv/notes',
    guidance: 'The authenticated session cwd is not inside a Git repository, so there is nothing to commit. Start the session from a managed worktree (git-cli worktree add) or an existing repository to deliver a governed commit.',
  })
  assert.equal(subject.resolutions.length, 0)
  assert.equal(subject.spawns.length, 0)
  const rendered = tool.output.render(validArgs(), result)
  assert.match(rendered[0].text, /^No governed commit: .* not inside a Git repository/)
})

test('the output schema keeps the committed and no-repository variants apart', () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
  })
  const variants = tool.output.schema.oneOf
  assert.equal(variants.length, 2)
  const committed = variants.find(variant => variant.properties.status.const === 'committed')
  const noRepository = variants.find(variant => variant.properties.status.const === 'no-repository')
  assert.deepEqual(committed.required, ['schema_version', 'status', 'commit', 'staged'])
  assert.deepEqual(noRepository.required, ['schema_version', 'status', 'cwd', 'guidance'])
  assert.equal(committed.additionalProperties, false)
  assert.equal(noRepository.additionalProperties, false)
})

test('the default repository probe recognises a .git directory, a worktree .git file, and a plain directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-governed-commit-'))
  try {
    const plain = join(root, 'plain', 'nested')
    const repository = join(root, 'repository')
    const linked = join(root, 'linked')
    mkdirSync(plain, { recursive: true })
    mkdirSync(join(repository, '.git', 'refs'), { recursive: true })
    mkdirSync(join(repository, 'src'), { recursive: true })
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, '.git'), `gitdir: ${join(repository, '.git', 'worktrees', 'linked')}\n`)
    for (const [cwd, expectSpawn] of [[plain, false], [join(repository, 'src'), true], [linked, true]]) {
      const subject = harness()
      const tool = createGovernedCommitTool(subject.ctx, {
        semanticCommit: 'semantic-commit',
        canonicalPath: value => value,
      })
      const result = await tool.execute(validArgs(), execution({
        agent: { id: 'session-current', session: { header: { cwd } } },
      }))
      assert.equal(result.status, expectSpawn ? 'committed' : 'no-repository', cwd)
      assert.equal(subject.spawns.length, expectSpawn ? 1 : 0, cwd)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('governed commit refuses a primary-relative or missing authenticated cwd before resolution', async () => {
  const subject = harness()
  const tool = createGovernedCommitTool(subject.ctx, {
    semanticCommit: 'semantic-commit',
    canonicalPath: value => value,
    hasRepository: () => true,
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
    hasRepository: () => true,
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
    hasRepository: () => true,
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
