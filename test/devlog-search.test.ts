import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = join(projectRoot, 'scripts', 'devlog-search.sh')

const search = (...args) => spawnSync(scriptPath, args, {
  cwd: projectRoot,
  encoding: 'utf8',
})

test('devlog search enforces its term and YYYY-MM argument contract', () => {
  const missingTerm = search()
  assert.equal(missingTerm.status, 2)
  assert.match(missingTerm.stderr, /usage:/)

  const validMonth = search('PROJECT DEVLOG WORKFLOW', '2026-08')
  assert.equal(validMonth.status, 0)
  assert.match(validMonth.stdout, /Project devlog workflow established/)

  const noMatch = search('definitely-not-a-devlog-entry', '2026-08')
  assert.equal(noMatch.status, 1)
  assert.match(noMatch.stderr, /no matches/)

  const missingMonth = search('anything', '2026-07')
  assert.equal(missingMonth.status, 1)
  assert.match(missingMonth.stderr, /no devlog month files/)

  for (const invalidMonth of ['../../README', '2026/08', '2026-8', '2026-13']) {
    const invalid = search('current implementation', invalidMonth)
    assert.equal(invalid.status, 2, invalidMonth)
    assert.match(invalid.stderr, /usage:/)
    assert.equal(invalid.stdout, '')
  }

  const extraArgument = search('workflow', '2026-08', 'unexpected')
  assert.equal(extraArgument.status, 2)
  assert.match(extraArgument.stderr, /usage:/)
})
