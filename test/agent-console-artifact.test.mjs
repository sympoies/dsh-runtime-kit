import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  AgentConsoleArtifactError,
  fetchAuthenticatedAgentConsoleArtifact,
} from '../src/compat/agent-console-artifact.js'

const bytes = Buffer.from('authenticated Agent Console TUI archive')
const artifact = Object.freeze({
  tarball: 'https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-0.10.0-beta.4.tgz',
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  shasum: createHash('sha1').update(bytes).digest('hex'),
})

function response(body = bytes, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-length': String(body.byteLength),
      ...headers,
    },
  })
}

test('the Agent Console fetcher returns only bytes matching both declared digests', async () => {
  let requested
  const result = await fetchAuthenticatedAgentConsoleArtifact(artifact, {
    fetchImpl: async (url, options) => {
      requested = { url, options }
      return response()
    },
  })

  assert.equal(requested.url, artifact.tarball)
  assert.equal(requested.options.redirect, 'error')
  assert.deepEqual(result.bytes, bytes)
  assert.equal(result.integrity, artifact.integrity)
  assert.equal(result.shasum, artifact.shasum)
})

test('the Agent Console fetcher rejects a SHA-512 mismatch before returning bytes', async () => {
  await assert.rejects(
    fetchAuthenticatedAgentConsoleArtifact(
      { ...artifact, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
      { fetchImpl: async () => response() },
    ),
    error => error instanceof AgentConsoleArtifactError
      && error.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_INTEGRITY_MISMATCH',
  )
})

test('the Agent Console fetcher rejects a shasum mismatch before returning bytes', async () => {
  await assert.rejects(
    fetchAuthenticatedAgentConsoleArtifact(
      { ...artifact, shasum: '0'.repeat(40) },
      { fetchImpl: async () => response() },
    ),
    error => error instanceof AgentConsoleArtifactError
      && error.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_INTEGRITY_MISMATCH',
  )
})

test('the Agent Console fetcher rejects an oversized response before reading its body', async () => {
  let bodyRead = false
  const oversized = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(9 * 1024 * 1024) }),
    body: {
      async cancel() {},
      getReader() {
        bodyRead = true
        throw new Error('oversized body must not be read')
      },
    },
  }

  await assert.rejects(
    fetchAuthenticatedAgentConsoleArtifact(artifact, {
      fetchImpl: async () => oversized,
    }),
    error => error instanceof AgentConsoleArtifactError
      && error.code === 'DSH_RUNTIME_KIT_AGENT_CONSOLE_ARTIFACT_TOO_LARGE',
  )
  assert.equal(bodyRead, false)
})
