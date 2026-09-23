import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareDshTuiHistory } from '../dist/src/compat/dsh-tui-history.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('preflight restricts legacy TUI history before it is read and preserves content', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-'))
  try {
    const data = join(home, '.dsh-tui')
    const file = join(data, 'history.jsonl')
    mkdirSync(data, { mode: 0o755 })
    writeFileSync(file, '{"text":"legacy sentinel"}\n', { mode: 0o644 })
    chmodSync(data, 0o755)
    chmodSync(file, 0o644)
    assert.deepEqual(prepareDshTuiHistory(home), { directory_mode: 0o700, file_mode: 0o600 })
    assert.equal(lstatSync(data).mode & 0o777, 0o700)
    assert.equal(lstatSync(file).mode & 0o777, 0o600)
    assert.equal(readFileSync(file, 'utf8'), '{"text":"legacy sentinel"}\n')
    assert.deepEqual(prepareDshTuiHistory(home), { directory_mode: 0o700, file_mode: 0o600 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('preflight refuses a symlinked history file without changing its target', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-link-'))
  try {
    const data = join(home, '.dsh-tui')
    const target = join(home, 'outside.jsonl')
    mkdirSync(data, { mode: 0o700 })
    writeFileSync(target, 'outside sentinel', { mode: 0o644 })
    symlinkSync(target, join(data, 'history.jsonl'))
    assert.throws(() => prepareDshTuiHistory(home), /unsafe history file/u)
    assert.equal(readFileSync(target, 'utf8'), 'outside sentinel')
    assert.equal(lstatSync(target).mode & 0o777, 0o644)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('published launch preflight uses HOME and fails before a symlinked history read', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-history-cli-'))
  try {
    const directory = join(home, '.dsh-tui')
    mkdirSync(directory)
    const target = join(home, 'outside.jsonl')
    writeFileSync(target, 'outside sentinel')
    symlinkSync(target, join(directory, 'history.jsonl'))
    const result = spawnSync(process.execPath, [join(packageRoot, 'dist/bin/dsh-runtime-kit-tui-history.js')], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unsafe history file/u)
    assert.equal(readFileSync(target, 'utf8'), 'outside sentinel')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
