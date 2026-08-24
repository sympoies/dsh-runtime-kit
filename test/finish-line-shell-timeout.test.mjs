import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveFinishLineShellTimeout } from '../src/finish-line/index.js'
import { resolveFinishLineShellSpec } from '../src/policy/index.js'

test('finish-line validations preserve the long-running default at the DSH shell boundary', () => {
  assert.equal(resolveFinishLineShellTimeout('validation', undefined), 30 * 60 * 1_000)
  assert.equal(resolveFinishLineShellTimeout('ordinary', undefined), undefined)
  assert.equal(resolveFinishLineShellTimeout('validation', 45_000), 45_000)
})

test('the policy sends timeout intent through the active DSH shell resolver', () => {
  const requests = []
  const shell = {
    resolve(request) {
      requests.push(request)
      return {
        ...request,
        timeoutMs: Math.min(request.timeoutMs ?? 120_000, 600_000),
      }
    },
  }
  const input = {
    workdir: '/workspace/project',
    signal: new AbortController().signal,
    dshEnv: {},
  }

  assert.equal(resolveFinishLineShellSpec(shell, {
    kind: 'validation',
    command: 'make validate',
    timeoutMs: undefined,
  }, input).timeoutMs, 600_000)
  assert.equal(requests[0].timeoutMs, 30 * 60 * 1_000)

  assert.equal(resolveFinishLineShellSpec(shell, {
    kind: 'ordinary',
    command: 'git status --short',
    timeoutMs: undefined,
  }, input).timeoutMs, 120_000)
  assert.equal('timeoutMs' in requests[1], false)

  assert.equal(resolveFinishLineShellSpec(shell, {
    kind: 'validation',
    command: 'npm test',
    timeoutMs: 45_000,
  }, input).timeoutMs, 45_000)
  assert.equal(requests[2].timeoutMs, 45_000)
})
