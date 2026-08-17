import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

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
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
