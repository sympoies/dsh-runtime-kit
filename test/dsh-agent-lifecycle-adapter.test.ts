import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { onDshSessionStart } from '../dist/src/compat/dsh-agent-lifecycle.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function harness() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  return {
    ctx: {
      on(event: string, listener: (payload: unknown) => void) {
        const current = listeners.get(event) ?? []
        current.push(listener)
        listeners.set(event, current)
        return () => {}
      },
    },
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
}

test('the DSH lifecycle adapter maps alpha.5 session-start onto one callback', () => {
  const subject = harness()
  const agent = { id: 'alpha5' }
  const observed: unknown[] = []
  onDshSessionStart(subject.ctx, payload => observed.push(payload))

  subject.emit('agent/created', { agent })
  subject.emit('agent/session-start', { agent, source: 'resume' })

  assert.deepEqual(observed, [{ agent, source: 'resume' }])
})

test('the DSH lifecycle adapter maps alpha.6 agent/created onto one callback', () => {
  const subject = harness()
  const agent = { id: 'alpha6' }
  const observed: unknown[] = []
  onDshSessionStart(subject.ctx, payload => observed.push(payload))

  subject.emit('agent/created', { agent, source: 'startup' })

  assert.deepEqual(observed, [{ agent, source: 'startup' }])
})

test('the DSH lifecycle adapter preserves repeated alpha.5 lifecycle starts', () => {
  const subject = harness()
  const agent = { id: 'alpha5-rebound' }
  const observed: unknown[] = []
  onDshSessionStart(subject.ctx, payload => observed.push(payload))

  subject.emit('agent/created', { agent })
  subject.emit('agent/session-start', { agent, source: 'startup' })
  subject.emit('agent/session-start', { agent, source: 'compact' })

  assert.deepEqual(observed, [
    { agent, source: 'startup' },
    { agent, source: 'compact' },
  ])
})

test('shipped integration drivers consume the release-aware lifecycle adapter', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(
    manifest.exports['./dsh-agent-lifecycle'],
    './dist/src/compat/dsh-agent-lifecycle.js',
  )
  for (const relative of [
    'test/smoke.ts',
    'test/fixtures/authoritative-acceptance-canary/index.js',
  ]) {
    const source = readFileSync(join(projectRoot, relative), 'utf8')
    assert.match(source, /onDshSessionStart/u, relative)
    assert.doesNotMatch(source, /ctx\.on\('agent\/session-start'/u, relative)
  }
  const smokeSource = readFileSync(join(projectRoot, 'test/smoke.ts'), 'utf8')
  assert.match(
    smokeSource,
    /lifecycleModuleSpecifier = agentConsoleTuiPackage === undefined[\s\S]*pathToFileURL\(join\(projectRoot, 'dist', 'src', 'compat', 'dsh-agent-lifecycle\.js'\)\)/u,
    'the temporary headless driver must import the built adapter by file URL',
  )
  const acceptanceSource = readFileSync(
    join(projectRoot, 'test', 'authoritative-acceptance-smoke.ts'),
    'utf8',
  )
  assert.match(
    acceptanceSource,
    /DSH_RUNTIME_KIT_LIFECYCLE_ADAPTER_URL:\s*pathToFileURL\([\s\S]*dsh-agent-lifecycle\.js/u,
    'the unpatched acceptance profile must resolve the built adapter without installing runtime-kit',
  )
  const canarySource = readFileSync(
    join(projectRoot, 'test', 'fixtures', 'authoritative-acceptance-canary', 'index.js'),
    'utf8',
  )
  assert.match(
    canarySource,
    /process\.env\.DSH_RUNTIME_KIT_LIFECYCLE_ADAPTER_URL[\s\S]*Promise\.all\(\[[\s\S]*import\(lifecycleModuleSpecifier\)/u,
    'the acceptance canary must honor the runner-authenticated adapter URL',
  )
})
