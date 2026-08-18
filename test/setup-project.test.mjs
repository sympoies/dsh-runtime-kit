import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function applySetup(repo, replace = false) {
  return spawnSync('bash', [
    script,
    '--repo', repo,
    '--apply',
    '--pre-pr-command', 'printf safe',
    ...(replace ? ['--replace-existing'] : []),
  ], { encoding: 'utf8' })
}

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
