import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeSandboxEscalationRequest } from '../src/policy/index.js'

test('the effective sandbox mode echoed without justification is not an escalation', () => {
  let validations = 0
  const request = normalizeSandboxEscalationRequest({
    permissions: 'danger-full-access',
    justification: undefined,
    effectiveMode: 'danger-full-access',
    validate() { validations += 1 },
  })

  assert.equal(request, undefined)
  assert.equal(validations, 0)
})

test('a different sandbox mode still requires the native escalation pair', () => {
  assert.throws(
    () => normalizeSandboxEscalationRequest({
      permissions: 'danger-full-access',
      justification: undefined,
      effectiveMode: 'workspace-write',
      validate(permissions, justification) {
        if (permissions !== undefined && justification === undefined) {
          throw new Error('invalid escalation: sandbox_permissions requires a justification')
        }
      },
    }),
    /sandbox_permissions requires a justification/,
  )
})
