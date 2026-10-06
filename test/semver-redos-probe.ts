import { parseSemver } from '../dist/src/composition/index.js'

const value = `0.0.0-0.${'--.'.repeat(80)}!`

try {
  parseSemver(value)
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'version-invalid') {
    process.exit(0)
  }
  throw error
}

process.exitCode = 1
