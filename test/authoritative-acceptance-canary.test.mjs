import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createBodyExecutionCounter,
  validationBodyExecutions,
} from './fixtures/authoritative-acceptance-canary/body-execution-counter.js'
import { observableChildPid } from './fixtures/authoritative-acceptance-canary/observable-child-pid.js'
import { writeScenarioCanaryReceipt } from './fixtures/authoritative-acceptance-canary/receipt-output.js'

const fixtureManifest = new URL('./fixtures/authoritative-acceptance-canary/package.json', import.meta.url)

test('the packed canary includes its host-visible child lookup helper', () => {
  const manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8'))
  assert.equal(manifest.files.includes('observable-child-pid.js'), true)
  assert.equal(manifest.files.includes('body-execution-counter.js'), true)
  assert.equal(manifest.files.includes('receipt-output.js'), true)
})

test('the canary waits for its receipt line to flush before allowing host exit', async () => {
  const receipt = {
    schema_version: 'dsh-runtime-kit.authoritative-acceptance-canary.v1',
    phase: 'positive',
    process_instance_sha256: 'sha256:' + 'a'.repeat(64),
  }
  const writes = []
  let flushed
  const stream = {
    write(chunk, callback) {
      writes.push(chunk)
      flushed = callback
      return false
    },
  }
  let settled = false
  const pending = writeScenarioCanaryReceipt(stream, receipt)
    .then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(writes, [
    'DSH_AUTHORITATIVE_ACCEPTANCE_CANARY=' + JSON.stringify(receipt) + '\n',
  ])
  flushed()
  await pending
  assert.equal(settled, true)
})

test('the canary rejects a receipt write that fails before host exit', async () => {
  const failure = new Error('closed output')
  await assert.rejects(
    writeScenarioCanaryReceipt({
      write(_chunk, callback) {
        callback(failure)
        return false
      },
    }, { phase: 'positive' }),
    failure,
  )
})

test('body evidence freezes body-side observations at the first stopping turn', () => {
  const happy = createBodyExecutionCounter()
  happy.bodyExecuted()
  happy.turnStopping(1)
  happy.bodyExecuted()
  assert.equal(happy.receipt(), 2)

  const denied = createBodyExecutionCounter()
  denied.turnStopping()
  denied.bodyExecuted()
  denied.bodyExecuted()
  assert.equal(denied.receipt(), 0)
})

test('a successful result without body-side marker evidence cannot advance the count', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-body-evidence-'))
  try {
    const marker = join(root, 'validation')
    const token = 'exact-validation-token'
    const resultReportedSuccess = true
    assert.equal(resultReportedSuccess, true)

    const missing = createBodyExecutionCounter()
    missing.bodyExecuted()
    missing.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(missing.receipt(), 1)

    writeFileSync(marker, token + '\n', { mode: 0o600 })
    const observed = createBodyExecutionCounter()
    observed.bodyExecuted()
    observed.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(observed.receipt(), 2)

    writeFileSync(marker, token + '\n' + token + '\n', { mode: 0o600 })
    const duplicated = createBodyExecutionCounter()
    duplicated.bodyExecuted()
    duplicated.turnStopping(validationBodyExecutions(marker, token))
    assert.equal(duplicated.receipt(), 3)

    writeFileSync(marker, 'forged\n', { mode: 0o600 })
    assert.throws(
      () => validationBodyExecutions(marker, token),
      /validation body evidence is invalid/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancellable child lookup fails closed when host process enumeration is unavailable', () => {
  assert.throws(
    () => observableChildPid(
      42,
      '/isolated/cancellable.pid',
      '/isolated/cancellable.heartbeat',
      '/definitely-not-a-proc-root',
    ),
    /host-visible cancellable child lookup unavailable/u,
  )
})
