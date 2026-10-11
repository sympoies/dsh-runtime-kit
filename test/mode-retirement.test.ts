import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import * as kit from '../dist/index.js'

test('default runtime composition and staged companions omit retired mode surfaces', () => {
  assert.equal('applyMainAgentMode' in kit, false)
  assert.equal('mainAgentMode' in kit, false)
  for (const file of ['index.ts', 'cordis.patch.yml', 'scripts/run-acceptance.ts']) {
    assert.doesNotMatch(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /mainAgent|main_agent|MAIN_AGENT|main-agent/)
  }
  assert.equal(existsSync(new URL('../skills/main-agent-mode', import.meta.url)), false)
  assert.equal(existsSync(new URL('../src/main-agent', import.meta.url)), false)
})
