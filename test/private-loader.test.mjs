import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as runtimeKit from '../index.js'

const { apply } = runtimeKit

test('private skill roots fail closed before provider registration', async () => {
  await assert.rejects(
    apply({}, { privateSkillsDir: 'relative/private-skills' }),
    /must be an absolute path/,
  )

  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-private-root-'))
  try {
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'fixture')
    await assert.rejects(
      apply({}, { privateSkillsDir: file }),
      /must be a directory/,
    )

    const link = join(root, 'linked-root')
    symlinkSync(root, link)
    await assert.rejects(
      apply({}, { privateSkillsDir: link }),
      /must not be a symbolic link/,
    )

    const writableRoot = join(root, 'writable-root')
    mkdirSync(writableRoot)
    chmodSync(writableRoot, 0o777)
    await assert.rejects(
      apply({}, { privateSkillsDir: writableRoot }),
      /must not be group- or world-writable/,
    )

    const writableAncestor = join(root, 'writable-ancestor')
    const safeChild = join(writableAncestor, 'safe-child')
    mkdirSync(safeChild, { recursive: true, mode: 0o700 })
    chmodSync(writableAncestor, 0o777)
    await assert.rejects(
      apply({}, { privateSkillsDir: safeChild }),
      /unsafe writable ancestor/,
    )

    const containedRoot = join(root, 'contained-root')
    const skillDir = join(containedRoot, 'linked-skill')
    const externalRoot = join(root, 'external-root')
    mkdirSync(containedRoot, { mode: 0o700 })
    mkdirSync(externalRoot, { mode: 0o700 })
    symlinkSync(externalRoot, skillDir)
    await assert.rejects(
      apply({}, { privateSkillsDir: containedRoot }),
      /must not contain symbolic links/,
    )

    const nestedWritableRoot = join(root, 'nested-writable-root')
    const nestedWritableSkill = join(nestedWritableRoot, 'unsafe-skill')
    mkdirSync(nestedWritableSkill, { recursive: true, mode: 0o700 })
    const nestedWritableDefinition = join(nestedWritableSkill, 'SKILL.md')
    writeFileSync(nestedWritableDefinition, 'unsafe', { mode: 0o600 })
    chmodSync(nestedWritableDefinition, 0o666)
    await assert.rejects(
      apply({}, { privateSkillsDir: nestedWritableRoot }),
      /entries must not be group- or world-writable/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('private trust traversal enforces explicit depth and entry ceilings', async () => {
  assert.equal(typeof runtimeKit.snapshotPrivateSkills, 'function')
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-private-limits-'))
  try {
    let directory = root
    for (let depth = 0; depth < 6; depth += 1) {
      directory = join(directory, `depth-${depth}`)
      mkdirSync(directory, { mode: 0o700 })
    }
    await assert.rejects(
      runtimeKit.snapshotPrivateSkills(root, { maxDepth: 4, maxEntries: 100 }),
      /maximum traversal depth/,
    )

    const broad = join(root, 'broad')
    mkdirSync(broad, { mode: 0o700 })
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(broad, `resource-${index}.txt`), String(index), { mode: 0o600 })
    }
    await assert.rejects(
      runtimeKit.snapshotPrivateSkills(broad, { maxDepth: 4, maxEntries: 5 }),
      /maximum entry count/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('private trust traversal enforces byte ceilings and clamps configurable hard caps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-private-byte-limits-'))
  let snapshot
  try {
    const oversized = join(root, 'oversized.bin')
    writeFileSync(oversized, '', { mode: 0o600 })
    truncateSync(oversized, (4 * 1024 * 1024) + 1)
    await assert.rejects(
      runtimeKit.snapshotPrivateSkills(root),
      /file exceeds 4194304 bytes/,
    )
    rmSync(oversized)

    for (let index = 0; index < 9; index += 1) {
      const path = join(root, `aggregate-${index}.bin`)
      writeFileSync(path, '', { mode: 0o600 })
      truncateSync(path, 4 * 1024 * 1024)
    }
    await assert.rejects(
      runtimeKit.snapshotPrivateSkills(root),
      /exceeds 33554432 total file bytes/,
    )
    for (let index = 0; index < 9; index += 1) {
      rmSync(join(root, `aggregate-${index}.bin`))
    }

    snapshot = await runtimeKit.snapshotPrivateSkills(root, {
      maxDepth: Number.MAX_SAFE_INTEGER,
      maxEntries: Number.MAX_SAFE_INTEGER,
    })
    assert.deepEqual(snapshot.limits, { maxDepth: 64, maxEntries: 20_000 })
  } finally {
    await snapshot?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('private instruction and resources are detached from post-validation substitutions', async () => {
  assert.equal(typeof runtimeKit.snapshotPrivateSkills, 'function')
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-kit-private-snapshot-'))
  let snapshot
  try {
    const skillRoot = join(root, 'private-only')
    mkdirSync(skillRoot, { mode: 0o700 })
    const skillPath = join(skillRoot, 'SKILL.md')
    const resourcePath = join(skillRoot, 'reference.txt')
    writeFileSync(skillPath, `---
name: private-only
description: >
  Trusted private snapshot fixture.
---

original private instructions
`, { mode: 0o600 })
    writeFileSync(resourcePath, 'original resource', { mode: 0o600 })

    snapshot = await runtimeKit.snapshotPrivateSkills(root)
    assert.equal(snapshot.definitions.length, 1)
    writeFileSync(skillPath, 'substituted instructions', { mode: 0o600 })
    writeFileSync(resourcePath, 'substituted resource', { mode: 0o600 })

    const definition = snapshot.definitions[0]
    assert.match(definition.content, /original private instructions/)
    assert.doesNotMatch(definition.content, /substituted instructions/)
    assert.equal(definition.resourceBase.kind, 'directory')
    assert.equal(
      readFileSync(join(definition.resourceBase.path, 'reference.txt'), 'utf8'),
      'original resource',
    )
  } finally {
    await snapshot?.dispose()
    if (snapshot !== undefined) assert.equal(existsSync(snapshot.root), false)
    rmSync(root, { recursive: true, force: true })
  }
})
