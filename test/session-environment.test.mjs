import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isolatedNilsEnvironment } from '../src/nils/session-environment.js'

test('nils subprocess keeps only the trusted user-runtime route needed by finish-line', () => {
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
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
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
    { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  )
})
