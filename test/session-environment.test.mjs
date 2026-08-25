import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  authenticatedNilsEnvironment,
  isolatedNilsEnvironment,
} from '../src/nils/session-environment.js'

test('nils subprocess leaves the normal host PATH to the upstream scrubbed environment', () => {
  assert.deepEqual(
    isolatedNilsEnvironment(
      {
        DSH_RUNTIME_KIT_TEST: 'enabled',
        HOME: '/explicit/attacker',
        PATH: '/explicit/attacker/bin',
        XDG_RUNTIME_DIR: '/explicit/attacker/runtime',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/explicit/attacker/socket',
        AGENT_SESSION_OTHER: 'must-not-cross',
      },
      {
        HOME: '/home/fixture',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/attacker/socket',
        PATH: '/attacker/bin',
        AGENT_SESSION_TOKEN: 'must-not-cross',
        UNRELATED_SECRET: 'must-not-cross',
      },
      { uid: 1000, platform: 'linux' },
    ),
    {
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      DSH_RUNTIME_KIT_TEST: 'enabled',
      AGENT_SESSION_TOKEN: undefined,
      AGENT_SESSION_OTHER: undefined,
    },
  )
})

test('nils subprocess does not project a noncanonical runtime directory or user bus', () => {
  assert.deepEqual(
    isolatedNilsEnvironment(
      undefined,
      {
        HOME: '/home/fixture',
        XDG_RUNTIME_DIR: '/tmp/runtime-1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/attacker/bus',
      },
      { uid: 1000, platform: 'linux' },
    ),
    {},
  )
})

test('an authenticated lane bridge restores explicit managed fields while ambient identity stays scrubbed', () => {
  assert.deepEqual(
    authenticatedNilsEnvironment(
      {
        AGENT_SESSION_ID: 'worker-one',
        AGENT_SESSION_CAPABILITY_FILE: '/private/capability',
        AGENT_SESSION_STATE_DIR: '/private/state',
        UNRELATED_SECRET: 'must-not-cross',
      },
      {
        AGENT_SESSION_ID: 'ambient-attacker',
        AGENT_SESSION_TOKEN: 'ambient-token',
        UNRELATED_SECRET: 'ambient-secret',
      },
      { uid: 1000, platform: 'linux' },
    ),
    {
      UNRELATED_SECRET: 'must-not-cross',
      AGENT_SESSION_ID: 'worker-one',
      AGENT_SESSION_CAPABILITY_FILE: '/private/capability',
      AGENT_SESSION_STATE_DIR: '/private/state',
      AGENT_SESSION_TOKEN: undefined,
    },
  )
})
