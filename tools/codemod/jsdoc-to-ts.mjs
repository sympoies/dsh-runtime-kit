// Driver: apply the JSDoc -> TypeScript conversion to one file.
//
// Type information moves into syntax; the JSDoc block keeps its prose with the
// `{T}` expression removed, which is the idiomatic TypeScript-with-JSDoc form
// and a far smaller edit than deleting and reflowing whole tags. A @typedef
// becomes an exported type alias emitted just above its original block.

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

import { convert } from './jsdoc-to-ts-convert.mjs'

const [, , target, mode] = process.argv
if (target === undefined) {
  console.error('usage: jsdoc-to-ts.mjs <file.js> [--write] | --all')
  process.exit(64)
}

if (target === '--all') {
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  /** @param {string} dir */
  const walk = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  const files = ['index.js', 'policy.js', ...walk('bin'), ...walk('src')]
    .filter(path => path.endsWith('.js'))
  let converted = 0
  for (const file of files) {
    const result = spawnSync(process.execPath, [process.argv[1], file, "--write"], { stdio: "inherit" }).status ?? 70
    if (result !== 0) {
      console.error(`FAILED ${file}`)
      process.exit(70)
    }
    converted += 1
  }
  console.log(`converted ${converted} files`)
  process.exit(0)
}


const original = readFileSync(target, 'utf8')
const { edits, consumed } = convert(original, target)

/** @type {{start: number, end: number, text: string}[]} */
const textEdits = edits.filter(edit => edit.kind === 'text')

/** Flatten a JSDoc comment field, which is a string or a node array. */
function proseOf(node) {
  if (node === undefined) return ''
  if (typeof node.comment === 'string') return node.comment.trim()
  return (node.comment ?? []).map(part => part.text ?? '').join('').trim()
}

/**
 * Rebuild a JSDoc block rather than deleting inside it.
 *
 * Surgical line deletion is where this transform kept going wrong: a tag's
 * reported range can extend past the closing terminator, adjacent edits
 * overlap, and a mistake silently swallows the declaration below. Regenerating
 * the whole comment is one edit with no positional arithmetic, and a block that
 * has nothing left to say disappears entirely.
 */
const aliasByDoc = new Map()
for (const edit of edits) {
  if (edit.kind !== 'typedef') continue
  if (!aliasByDoc.has(edit.doc)) aliasByDoc.set(edit.doc, [])
  aliasByDoc.get(edit.doc).push(edit.text)
}

const docsToRewrite = new Set([...consumed.keys(), ...aliasByDoc.keys()])
for (const doc of docsToRewrite) {
  const taken = consumed.get(doc) ?? new Set()
  const description = proseOf(doc)
  /** @type {string[]} */
  const lines = []
  for (const tag of doc.tags ?? []) {
    const name = tag.tagName?.escapedText ?? ''
    if (taken.has(tag)) {
      // The type moved into syntax. Keep the tag only if it still carries prose.
      const prose = proseOf(tag)
      if (prose === '') continue
      if (tag.kind === ts.SyntaxKind.JSDocParameterTag) {
        lines.push(`@param ${tag.name?.getText?.() ?? ''} ${prose}`.trimEnd())
      } else {
        lines.push(`@${name} ${prose}`.trimEnd())
      }
      continue
    }
    // Untouched tag: preserve its original text verbatim.
    lines.push(original.slice(tag.pos, tag.end).replace(/\n\s*\*\s?/gu, '\n').trim())
  }

  const body = [description, ...lines].filter(part => part !== '').join('\n\n')
  const indentMatch = /(^|\n)([ \t]*)$/u.exec(original.slice(0, doc.pos + 1))
  const indent = indentMatch === null ? '' : indentMatch[2]
  const aliases = (aliasByDoc.get(doc) ?? []).join('')

  let replacement = aliases
  if (body !== '') {
    const rendered = body.includes('\n')
      ? `/**\n${body.split('\n').map(line => `${indent} *${line === '' ? '' : ` ${line}`}`).join('\n')}\n${indent} */`
      : `/** ${body} */`
    replacement += `${aliases === '' ? '' : indent}${rendered}\n${indent}`
  }

  // Replace the comment itself, from its `/**` through its `*/`.
  let start = doc.pos
  while (start < original.length && /\s/u.test(original[start])) start += 1
  let end = doc.end
  if (body === '') {
    // Absorb the trailing newline and indentation so no blank line is left.
    while (end < original.length && original[end] !== '\n') end += 1
    if (end < original.length) end += 1
    replacement = aliases
    start = original.lastIndexOf('\n', doc.pos + 1) + 1
  }
  textEdits.push({ start, end, text: replacement })
}

textEdits.sort((a, b) => b.start - a.start || b.end - a.end)
let output = original
let previousStart = Infinity
for (const edit of textEdits) {
  if (edit.end > previousStart) continue // overlapping edit; keep the later one
  output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  previousStart = edit.start
}

// Tidy: a JSDoc block reduced to `/** */` or `/**\n */` carries nothing.
output = output.replace(/^[ \t]*\/\*\*[\s*]*\*\/\n/gmu, '')
// `// @ts-check` is the JavaScript opt-in; a `.ts` file is checked by default.
output = output.replace(/^\/\/ @ts-check\n\n?/u, '')
// Collapse the blank runs a removed tag or typedef can leave behind.
output = output.replace(/\n{3,}/gu, '\n\n')

if (mode === '--write') {
  writeFileSync(target, output)
  console.log(`converted ${target}: ${textEdits.length} edits`)
} else {
  process.stdout.write(output)
}
