import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const gitCli = resolve(process.env.GIT_CLI_BIN ?? '')
assert.notEqual(process.env.GIT_CLI_BIN, undefined, 'set GIT_CLI_BIN')
assert.equal(existsSync(gitCli), true, `git-cli not found: ${gitCli}`)
const releaseBin = dirname(gitCli)
const pathSeparator = process.platform === 'win32' ? ';' : ':'
assert.equal(
  existsSync(join(releaseBin, 'agent-session')),
  true,
  `agent-session companion not found beside git-cli: ${releaseBin}`,
)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'nils-cli-safe-worktree-'))
chmodSync(temporaryRoot, 0o700)
const agentHome = join(temporaryRoot, 'agent-home')
const stateHome = join(agentHome, 'state')
const sessionStateHome = join(stateHome, 'agent-session')
const checkoutLeaseStateHome = join(stateHome, 'checkout-leases')
const probeBin = join(temporaryRoot, 'probe-bin')
mkdirSync(agentHome, { mode: 0o700 })
mkdirSync(sessionStateHome, { recursive: true, mode: 0o700 })
mkdirSync(checkoutLeaseStateHome, { recursive: true, mode: 0o700 })
mkdirSync(probeBin, { mode: 0o700 })
// Give the released CLI a deterministic idle process inventory. The release's
// own tests cover incomplete and active process-probe refusal paths; this smoke
// focuses on successful removal and recoverable dirty-target preservation.
const lsofProbe = join(probeBin, 'lsof')
writeFileSync(lsofProbe, '#!/bin/sh\n[ "$1" = "-nP" ] || exit 2\nexit 1\n', { mode: 0o700 })
const environment = {
  ...process.env,
  AGENT_HOME: agentHome,
  AGENT_RUNTIME_CHECKOUT_LEASE_STATE_HOME: checkoutLeaseStateHome,
  AGENT_SESSION_STATE_DIR: sessionStateHome,
  PATH: [probeBin, releaseBin, process.env.PATH ?? ''].join(pathSeparator),
  XDG_STATE_HOME: stateHome,
}
const repository = join(temporaryRoot, 'repository')
const remote = join(temporaryRoot, 'origin.git')
let cleanWorktree: string | undefined
let dirtyWorktree: string | undefined

function run(command: string, args: string[], cwd: string, env = environment) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.error, undefined, `${command} ${args.join(' ')}: ${result.error ?? ''}`)
  return result
}

function git(args: string[], cwd = repository) {
  const result = run('/usr/bin/git', args, cwd)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout.trim()
}

function addWorktree(slug: string) {
  const result = run(gitCli, [
    'worktree', 'add', slug, '--from', 'main', '--kind', 'test', '--format', 'json',
  ], repository)
  assert.equal(result.status, 0, `git-cli worktree add failed:\n${result.stdout}\n${result.stderr}`)
  const receipt = JSON.parse(result.stdout)
  assert.equal(receipt.ok, true)
  const path = receipt.data.path as string
  assert.equal(path.startsWith(temporaryRoot), true, 'test worktree must stay inside its private root')
  return path
}

function removeWorktree(path: string) {
  const result = run(gitCli, [
    'worktree', 'remove', path, '--safe', '--format', 'json',
  ], repository)
  return { result, receipt: JSON.parse(result.stdout) }
}

try {
  mkdirSync(repository, { mode: 0o700 })
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'user.name', 'nils-cli compatibility smoke'])
  git(['config', 'user.email', 'compatibility-smoke@example.invalid'])
  writeFileSync(join(repository, 'tracked.txt'), 'baseline\n', { mode: 0o600 })
  git(['add', 'tracked.txt'])
  git(['commit', '--quiet', '-m', 'test: initialize safe worktree smoke'])
  git(['init', '--quiet', '--bare', remote], temporaryRoot)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  git(['remote', 'add', 'origin', remote])
  git(['push', '--quiet', '--set-upstream', 'origin', 'main'])

  cleanWorktree = addWorktree('safe-clean')
  const cleanRemoval = removeWorktree(cleanWorktree)
  assert.equal(cleanRemoval.result.status, 0, cleanRemoval.result.stderr)
  assert.equal(cleanRemoval.receipt.ok, true)
  assert.equal(existsSync(cleanWorktree), false, 'clean delivered worktree should be removed')

  dirtyWorktree = addWorktree('safe-dirty')
  const dirtyFile = join(dirtyWorktree, 'untracked.txt')
  writeFileSync(dirtyFile, 'must be preserved\n', { mode: 0o600 })
  const dirtyRemoval = removeWorktree(dirtyWorktree)
  assert.equal(dirtyRemoval.result.status, 0, dirtyRemoval.result.stderr)
  assert.equal(dirtyRemoval.receipt.ok, true)
  assert.equal(existsSync(dirtyWorktree), false, 'dirty target is removed after preservation')
  const backup = dirtyRemoval.receipt.data
  assert.match(backup.backup_ref, /^refs\/worktree-backup\//)
  assert.equal(backup.backup_reasons.includes('dirty-or-untracked'), true)
  assert.equal(backup.backup_bytes > 0, true)
  assert.equal(backup.backup_omitted_bytes, 0)
  assert.deepEqual(backup.backup_omissions, [])
  assert.equal(git(['show', `${backup.backup_ref}:untracked.txt`]), 'must be preserved')

  const restoration = run(gitCli, [
    'worktree', 'restore', backup.backup_ref, '--path', dirtyWorktree, '--format', 'json',
  ], repository)
  assert.equal(restoration.status, 0, restoration.stderr)
  assert.equal(JSON.parse(restoration.stdout).ok, true)
  assert.equal(readFileSync(dirtyFile, 'utf8'), 'must be preserved\n')
  assert.equal(readFileSync(join(dirtyWorktree, 'tracked.txt'), 'utf8'), 'baseline\n')

  unlinkSync(dirtyFile)
  const finalRemoval = removeWorktree(dirtyWorktree)
  assert.equal(finalRemoval.result.status, 0, finalRemoval.result.stderr)
  assert.equal(finalRemoval.receipt.ok, true)
  assert.equal(existsSync(dirtyWorktree), false, 'restored fixture is safely removed')
  dirtyWorktree = undefined
  cleanWorktree = undefined
  process.stdout.write('released git-cli safe worktree removal contract passed\n')
} finally {
  for (const path of [cleanWorktree, dirtyWorktree]) {
    if (path === undefined || !existsSync(path)) continue
    const dirtyFile = join(path, 'untracked.txt')
    if (existsSync(dirtyFile)) unlinkSync(dirtyFile)
    const removal = removeWorktree(path)
    assert.equal(removal.result.status, 0, `safe cleanup failed:\n${removal.result.stdout}\n${removal.result.stderr}`)
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
}
