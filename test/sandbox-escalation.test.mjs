import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeSandboxEscalationRequest } from '../src/policy/index.js'

const isNonWideningEcho = (permissions, effectiveMode) => permissions === effectiveMode
  || (permissions === 'workspace-write' && effectiveMode === 'danger-full-access')

test('the effective sandbox mode echoed without justification is not an escalation', () => {
  let validations = 0
  const request = normalizeSandboxEscalationRequest({
    permissions: 'danger-full-access',
    justification: undefined,
    effectiveMode: 'danger-full-access',
    isNonWideningEcho,
    validate() { validations += 1 },
  })

  assert.equal(request, undefined)
  assert.equal(validations, 0)
})

test('a blank lower sandbox mode emitted under danger-full-access is not an escalation', () => {
  let validations = 0
  const request = normalizeSandboxEscalationRequest({
    permissions: 'workspace-write',
    justification: '',
    effectiveMode: 'danger-full-access',
    isNonWideningEcho,
    validate() { validations += 1 },
  })

  assert.equal(request, undefined)
  assert.equal(validations, 0)
})

test('a blank wider sandbox mode remains an invalid escalation', () => {
  assert.throws(
    () => normalizeSandboxEscalationRequest({
      permissions: 'danger-full-access',
      justification: '',
      effectiveMode: 'workspace-write',
      isNonWideningEcho,
      validate(_permissions, justification) {
        if (justification?.trim().length === 0) {
          throw new Error('invalid justification: expected a non-empty sentence')
        }
      },
    }),
    /expected a non-empty sentence/,
  )
})

test('an unobserved blank lower sandbox mode remains under native validation', () => {
  assert.throws(
    () => normalizeSandboxEscalationRequest({
      permissions: 'read-only',
      justification: '',
      effectiveMode: 'danger-full-access',
      isNonWideningEcho,
      validate() {
        throw new Error('native validation retained')
      },
    }),
    /native validation retained/,
  )
})

test('a different sandbox mode still requires the native escalation pair', () => {
  assert.throws(
    () => normalizeSandboxEscalationRequest({
      permissions: 'danger-full-access',
      justification: undefined,
      effectiveMode: 'workspace-write',
      isNonWideningEcho,
      validate(permissions, justification) {
        if (permissions !== undefined && justification === undefined) {
          throw new Error('invalid escalation: sandbox_permissions requires a justification')
        }
      },
    }),
    /sandbox_permissions requires a justification/,
  )
})

test('the authenticated DSH sandbox contract owns echo classification', () => {
  let observed
  assert.throws(
    () => normalizeSandboxEscalationRequest({
      permissions: 'workspace-write',
      justification: '',
      effectiveMode: 'danger-full-access',
      isNonWideningEcho(permissions, effectiveMode) {
        observed = { permissions, effectiveMode }
        return false
      },
      validate() {
        throw new Error('DSH classifier retained native validation')
      },
    }),
    /DSH classifier retained native validation/,
  )
  assert.deepEqual(observed, {
    permissions: 'workspace-write',
    effectiveMode: 'danger-full-access',
  })
})
