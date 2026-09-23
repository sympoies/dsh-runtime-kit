import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, realpathSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

function ownedOrdinary(path: string, fd: number, type: 'directory' | 'file'): void {
  const opened = fstatSync(fd)
  const named = lstatSync(path)
  const ordinary = type === 'directory' ? opened.isDirectory() : opened.isFile()
  if (!ordinary || opened.uid !== process.getuid?.()
    || opened.dev !== named.dev || opened.ino !== named.ino
    || named.isSymbolicLink()) {
    throw new Error(`unsafe history ${type}: ${path}`)
  }
}

function restrict(path: string, type: 'directory' | 'file', mode: number): void {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW
      | (type === 'directory' ? constants.O_DIRECTORY : 0))
  } catch (error) {
    throw new Error(`unsafe history ${type}: ${path}`, { cause: error })
  }
  try {
    ownedOrdinary(path, fd, type)
    fchmodSync(fd, mode)
    ownedOrdinary(path, fd, type)
    if ((fstatSync(fd).mode & 0o777) !== mode) {
      throw new Error(`unsafe history ${type}: ${path}`)
    }
  } finally {
    closeSync(fd)
  }
}

/** Restrict consumer-owned history before pristine dsh-TUI first reads it. */
export function prepareDshTuiHistory(home: string): { directory_mode: number, file_mode: number | null } {
  if (!isAbsolute(home) || resolve(home) !== home || realpathSync(home) !== home) {
    throw new Error('unsafe history home: expected an absolute ordinary directory')
  }
  const homeStat = lstatSync(home)
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.()) {
    throw new Error('unsafe history home: expected an owned directory')
  }
  const directory = join(home, '.dsh-tui')
  const file = join(directory, 'history.jsonl')
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  restrict(directory, 'directory', 0o700)
  const fileStat = lstatSync(file, { throwIfNoEntry: false })
  if (fileStat === undefined) return { directory_mode: 0o700, file_mode: null }
  restrict(file, 'file', 0o600)
  return { directory_mode: 0o700, file_mode: 0o600 }
}
