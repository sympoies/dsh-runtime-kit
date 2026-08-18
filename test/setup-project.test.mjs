import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const script = resolve(import.meta.dirname, '..', 'skills', 'setup-project', 'scripts', 'setup-project.sh')

function initializeRepo(root) {
  mkdirSync(root, { recursive: true })
  const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
}

function applySetup(repo, replace = false, command = 'printf safe') {
  return spawnSync('bash', [
    script,
    '--repo', repo,
    '--apply',
    '--pre-pr-command', command,
    ...(replace ? ['--replace-existing'] : []),
  ], { encoding: 'utf8' })
}

test('setup creates and replaces a working project dispatcher without disturbing unrelated content', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-setup-success-'))
  try {
    const repo = join(fixture, 'repo')
    initializeRepo(repo)
    mkdirSync(join(repo, '.agents'), { mode: 0o700 })
    writeFileSync(join(repo, '.agents', 'keep.txt'), 'preserve me', { mode: 0o600 })

    const initial = applySetup(repo, false, "printf 'first:%s'")
    assert.equal(initial.status, 0, initial.stderr)
    const dispatcher = join(repo, '.agents', 'scripts', 'pre-pr.sh')
    const initialMetadata = lstatSync(dispatcher)
    assert.equal(initialMetadata.isFile(), true)
    assert.equal(initialMetadata.isSymbolicLink(), false)
    assert.equal(statSync(dispatcher).mode & 0o777, 0o700)
    const initialRun = spawnSync(dispatcher, ['one', 'two'], { cwd: repo, encoding: 'utf8' })
    assert.equal(initialRun.status, 0, initialRun.stderr)
    assert.equal(initialRun.stdout, 'first:onefirst:two')

    const replaced = applySetup(repo, true, "printf 'second:%s'")
    assert.equal(replaced.status, 0, replaced.stderr)
    const replacementMetadata = lstatSync(dispatcher)
    assert.equal(replacementMetadata.isFile(), true)
    assert.equal(replacementMetadata.isSymbolicLink(), false)
    assert.equal(statSync(dispatcher).mode & 0o777, 0o700)
    const replacementRun = spawnSync(dispatcher, ['three'], { cwd: repo, encoding: 'utf8' })
    assert.equal(replacementRun.status, 0, replacementRun.stderr)
    assert.equal(replacementRun.stdout, 'second:three')
    assert.equal(readFileSync(join(repo, '.agents', 'keep.txt'), 'utf8'), 'preserve me')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('setup rejects symlinked .agents and child directories', () => {
  for (const target of ['.agents', '.agents/scripts', '.agents/skills']) {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-setup-link-'))
    try {
      const repo = join(fixture, 'repo')
      const external = join(fixture, 'external')
      initializeRepo(repo)
      mkdirSync(external)
      writeFileSync(join(external, 'sentinel'), 'unchanged')

      if (target === '.agents') {
        symlinkSync(external, join(repo, '.agents'))
      } else {
        mkdirSync(join(repo, '.agents'))
        symlinkSync(external, join(repo, ...target.split('/')))
      }

      for (const replace of [false, true]) {
        const result = applySetup(repo, replace)
        assert.notEqual(result.status, 0, `${target} replace=${replace}: ${result.stdout}\n${result.stderr}`)
        assert.match(result.stderr, /symbolic link/)
        assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'unchanged')
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }
})

test('setup never follows a destination symlink in normal or replace mode', () => {
  for (const replace of [false, true]) {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-setup-destination-'))
    try {
      const repo = join(fixture, 'repo')
      const external = join(fixture, 'external-dispatcher.sh')
      initializeRepo(repo)
      mkdirSync(join(repo, '.agents', 'scripts'), { recursive: true })
      mkdirSync(join(repo, '.agents', 'skills'))
      writeFileSync(external, 'external sentinel')
      symlinkSync(external, join(repo, '.agents', 'scripts', 'pre-pr.sh'))

      const result = applySetup(repo, replace)
      assert.notEqual(result.status, 0, `replace=${replace}: ${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, /symbolic link/)
      assert.equal(readFileSync(external, 'utf8'), 'external sentinel')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }
})
