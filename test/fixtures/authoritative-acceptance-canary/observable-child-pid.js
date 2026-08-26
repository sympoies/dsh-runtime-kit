import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function observableChildPid(namespacePid, pidPath, heartbeatPath, procRoot = '/proc') {
  const matches = []
  let entries
  try {
    entries = readdirSync(procRoot, { withFileTypes: true })
  } catch (cause) {
    throw new Error('host-visible cancellable child lookup unavailable', { cause })
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    try {
      const argv = readFileSync(join(procRoot, entry.name, 'cmdline'), 'utf8').split('\0')
      if (argv[1] === '-e'
        && argv[2]?.includes(pidPath)
        && argv[2]?.includes(heartbeatPath)) {
        matches.push(Number.parseInt(entry.name, 10))
      }
    } catch {}
  }
  if (matches.length !== 1) {
    throw new Error('expected one host-visible cancellable child, got '
      + JSON.stringify(matches) + ' (namespace pid ' + namespacePid + ')')
  }
  return matches[0]
}
