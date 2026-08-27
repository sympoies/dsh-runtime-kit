import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const scanner = join(projectRoot, 'skills', 'worktree-triage', 'bin', 'worktree_triage.py')

async function git(cwd, ...args) {
  return run('git', args, { cwd, encoding: 'utf8' })
}

test('worktree triage retains explicitly protected integration branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-triage-'))
  const repo = join(root, 'repo')
  const integrationWorktree = join(root, 'mainline')
  const dirtyWorktree = join(root, 'dirtyline')
  const lockedWorktree = join(root, 'lockedline')
  try {
    await run('git', ['init', '--initial-branch=main', repo], { encoding: 'utf8' })
    await git(repo, 'config', 'user.name', 'DSH Test')
    await git(repo, 'config', 'user.email', 'dsh-test@example.invalid')
    await git(repo, 'commit', '--allow-empty', '-m', 'initial')
    await git(repo, 'branch', 'mainline')
    await git(repo, 'worktree', 'add', integrationWorktree, 'mainline')
    await git(repo, 'branch', 'dirtyline')
    await git(repo, 'worktree', 'add', dirtyWorktree, 'dirtyline')
    await writeFile(join(dirtyWorktree, 'uncommitted.txt'), 'dirty\n')
    await git(repo, 'branch', 'lockedline')
    await git(repo, 'worktree', 'add', lockedWorktree, 'lockedline')
    await git(repo, 'worktree', 'lock', '--reason', 'test', lockedWorktree)

    const result = await run('python3', [
      scanner,
      '--repo', repo,
      '--base', 'main',
      '--protect-branch', 'zeta',
      '--protect-branch', 'main',
      '--protect-branch', 'mainline',
      '--protect-branch', 'mainline',
      '--protect-branch', 'dirtyline',
      '--protect-branch', 'lockedline',
      '--format', 'json',
    ], { encoding: 'utf8' })
    const report = JSON.parse(result.stdout)
    const integration = report.worktrees.find(record => record.branch === 'mainline')
    const primary = report.worktrees.find(record => record.branch === 'main')
    const dirty = report.worktrees.find(record => record.branch === 'dirtyline')
    const locked = report.worktrees.find(record => record.branch === 'lockedline')

    assert.deepEqual(
      report.protected_branches,
      ['dirtyline', 'lockedline', 'main', 'mainline', 'zeta'],
    )
    assert.equal(report.summary.protected, 1)
    assert.equal(integration.protected, true)
    assert.equal(integration.disposition, 'protected')
    assert.match(integration.suggested_action, /git-cli sync-branch/)
    assert.equal(primary.protected, true)
    assert.equal(primary.disposition, 'primary')
    assert.equal(dirty.protected, true)
    assert.equal(dirty.disposition, 'dirty')
    assert.equal(locked.protected, true)
    assert.equal(locked.disposition, 'locked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
