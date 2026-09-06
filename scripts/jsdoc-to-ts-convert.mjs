// JSDoc -> TypeScript codemod driven by the TypeScript parser.
//
// Regex cannot do this safely at 2000+ sites: JSDoc type expressions nest
// braces, and the annotation target is a syntax position, not a text offset.
// So parse with ts.createSourceFile, collect edits as (start, end, text) against
// the original text, and apply them back to front.
//
// Handled: @param, @returns, @type (both cast and declaration forms), @typedef
// (object-literal and @property forms), @template. Prose in a JSDoc block is
// preserved; only the consumed type tags are removed.

import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

/** Render a JSDoc type node back to TypeScript source. */
function renderType(node, text) {
  if (node === undefined) return undefined
  return jsdocTypeToTs(node, text)
}

function jsdocTypeToTs(node, text) {
  switch (node.kind) {
    case ts.SyntaxKind.JSDocAllType: return 'any'
    case ts.SyntaxKind.JSDocUnknownType: return 'unknown'
    case ts.SyntaxKind.JSDocNullableType:
      return `${jsdocTypeToTs(node.type, text)} | null`
    case ts.SyntaxKind.JSDocNonNullableType:
      return jsdocTypeToTs(node.type, text)
    case ts.SyntaxKind.JSDocOptionalType:
      return `${jsdocTypeToTs(node.type, text)} | undefined`
    case ts.SyntaxKind.JSDocVariadicType:
      return `${jsdocTypeToTs(node.type, text)}[]`
    case ts.SyntaxKind.JSDocTypeLiteral: {
      const members = (node.jsDocPropertyTags ?? []).map(tag => {
        const name = tag.name.getText ? tag.name.getText() : String(tag.name.escapedText)
        const optional = tag.isBracketed || tag.typeExpression?.type?.kind === ts.SyntaxKind.JSDocOptionalType
        const inner = tag.typeExpression?.type
        const rendered = inner === undefined ? 'unknown' : jsdocTypeToTs(
          inner.kind === ts.SyntaxKind.JSDocOptionalType ? inner.type : inner,
          text,
        )
        return `${name}${optional ? '?' : ''}: ${rendered}`
      })
      return `{ ${members.join(', ')} }`
    }
    case ts.SyntaxKind.JSDocTypeExpression:
      return jsdocTypeToTs(node.type, text)
    default:
      // Ordinary type nodes (TypeReference, UnionType, literal object types,
      // import() types, ...) already carry TypeScript syntax verbatim. A
      // multi-line type still sits inside a JSDoc block, so its continuation
      // lines carry the ` * ` prefix; strip that or the emitted type is not
      // parseable TypeScript.
      return stripCommentPrefix(text.slice(node.pos, node.end))
  }
}

/** Remove JSDoc continuation markers from a type sliced out of a comment. */
function stripCommentPrefix(raw) {
  return raw
    .split('\n')
    .map((line, index) => (index === 0 ? line : line.replace(/^\s*\*\s?/u, '  ')))
    .join('\n')
    .trim()
}

/**
 * Resolve the function a JSDoc block describes. The parser attaches a block to
 * the nearest declaration or statement, which for a function expression or an
 * arrow initializer is not the function itself.
 */
function functionTarget(node) {
  const isFn = candidate => candidate !== undefined && (ts.isFunctionDeclaration(candidate)
    || ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate)
    || ts.isMethodDeclaration(candidate) || ts.isConstructorDeclaration(candidate))
  if (isFn(node)) return node
  if (ts.isVariableStatement(node)) {
    const initializer = node.declarationList.declarations[0]?.initializer
    if (isFn(initializer)) return initializer
  }
  if (ts.isReturnStatement(node) && isFn(node.expression)) return node.expression
  if (ts.isExportAssignment(node) && isFn(node.expression)) return node.expression
  return undefined
}

function tagName(tag) {
  if (tag.name === undefined) return undefined
  if (typeof tag.name.escapedText === 'string') return tag.name.escapedText
  return tag.name.getText?.()
}

/** Collect the JSDoc blocks attached to a node. */
function jsDocOf(node) {
  return node.jsDoc ?? []
}

export function convert(sourceText, fileName) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  /** @type {{start: number, end: number, text: string}[]} */
  const edits = []
  /** Tag ranges consumed into syntax, to be stripped from their JSDoc block. */
  const consumed = new Map() // jsDoc node -> Set of tag nodes
  const annotated = new Set()
  const returned = new Set()
  const consume = (doc, tag) => {
    if (!consumed.has(doc)) consumed.set(doc, new Set())
    consumed.get(doc).add(tag)
  }

  const visit = node => {
    for (const doc of jsDocOf(node)) {
      const tags = doc.tags ?? []

      // --- @template on functions and classes
      const templates = tags.filter(t => t.kind === ts.SyntaxKind.JSDocTemplateTag)

      // --- @typedef -> type alias
      for (const tag of tags) {
        if (tag.kind !== ts.SyntaxKind.JSDocTypedefTag) continue
        const name = tagName(tag)
        if (name === undefined) continue
        const expr = tag.typeExpression
        let rendered
        if (expr === undefined) continue
        if (expr.kind === ts.SyntaxKind.JSDocTypeLiteral) {
          rendered = jsdocTypeToTs(expr, sourceText)
        } else {
          rendered = jsdocTypeToTs(expr.type ?? expr, sourceText)
        }
        const params = templates.length === 0
          ? ''
          : `<${templates.flatMap(t => t.typeParameters.map(p => p.getText())).join(', ')}>`
        edits.push({ kind: 'typedef', name, text: `export type ${name}${params} = ${rendered}\n`, doc })
        consume(doc, tag)
        for (const t of templates) consume(doc, t)
      }

      // --- @param / @returns on function-like declarations.
      //
      // A JSDoc block does not always attach to the function itself: for
      // `return function f(x) {}` or `const f = x => x` the parser hangs it on
      // the enclosing statement or declaration, so resolve through to the
      // function the tags actually describe.
      const target = functionTarget(node)
      if (target !== undefined) {
        for (const tag of tags) {
          if (tag.kind === ts.SyntaxKind.JSDocParameterTag) {
            const name = tagName(tag)
            const param = target.parameters.find(p => p.name.getText?.() === name)
            // A JSDoc block can be reachable from more than one node; annotating
            // the same parameter twice yields `x: T: T`.
            if (param === undefined || param.type !== undefined || annotated.has(param)) continue
            annotated.add(param)
            const inner = tag.typeExpression?.type
            if (inner === undefined) continue
            const optional = tag.isBracketed || inner.kind === ts.SyntaxKind.JSDocOptionalType
            const rendered = jsdocTypeToTs(
              inner.kind === ts.SyntaxKind.JSDocOptionalType ? inner.type : inner,
              sourceText,
            )
            // `@param {T} [name]` means the argument may be *omitted*, which is
            // `name?: T` and not `name: T | undefined`. The union alone keeps
            // the parameter required, so every existing caller that omits it
            // fails as "expected N arguments". A parameter with a default is
            // already optional, and a rest parameter cannot be marked.
            const hasDefault = param.initializer !== undefined
            const markOptional = optional && !hasDefault && !param.dotDotDotToken
              && param.questionToken === undefined
            const suffix = ''
            // `x => ...` cannot carry an annotation; a single unparenthesized
            // arrow parameter has to gain parentheses first. The closing paren
            // rides the annotation edit so the two cannot order wrongly at the
            // same offset.
            // `x => ...` needs parentheses before it can carry an annotation.
            // Position, not the preceding character, decides: an arrow whose
            // own start equals its parameter's start has no parentheses of its
            // own. Looking for a nearby `(` misreads `list.some(x => ...)`,
            // where the paren belongs to the enclosing call.
            let needsParens = false
            if (ts.isArrowFunction(target) && target.parameters.length === 1) {
              // The arrow is unparenthesized when nothing between its own start
              // and its parameter opens a paren. Position equality alone misses
              // `async value => ...`, where the arrow starts at `async`.
              const head = sourceText.slice(target.getStart(source), param.getStart(source))
              if (!head.includes('(')) {
                needsParens = true
                const open = param.getStart(source)
                edits.push({ kind: 'text', start: open, end: open, text: '(' })
              }
            }
            const at = param.name.end
            // A parameter with a default extends past its name, so the closing
            // paren belongs after the initializer, not after the annotation.
            const closeAt = param.end > at ? param.end : at
            if (needsParens && closeAt > at) {
              edits.push({ kind: 'text', start: closeAt, end: closeAt, text: ')' })
            }
            edits.push({
              kind: 'text',
              start: at,
              end: at,
              // The `?` rides this same edit: emitting it separately would put
              // two insertions at one offset, which orders as `T?` and drops
              // the optionality.
              text: `${markOptional ? '?' : ''}: ${rendered}${suffix}${needsParens && closeAt === at ? ')' : ''}`,
            })
            consume(doc, tag)
          }
          if (tag.kind === ts.SyntaxKind.JSDocReturnTag) {
            const inner = tag.typeExpression?.type
            // Same reachability hazard as parameters: one JSDoc block can be
            // visited through two nodes, which would annotate twice.
            if (inner === undefined || target.type !== undefined || returned.has(target)) continue
            returned.add(target)
            const rendered = jsdocTypeToTs(inner, sourceText)
            // Anchor differently per form. An arrow always has `=>`, and for a
            // single unparenthesized parameter there is no closing paren to
            // scan back to - doing so walks into the previous declaration and
            // annotates the wrong statement. A function declaration has no
            // `=>`, so anchor it on the parameter list instead.
            if (target.body === undefined) continue
            let anchor
            if (ts.isArrowFunction(target)) {
              anchor = sourceText.indexOf('=>', target.parameters.end)
              if (anchor < 0) continue
            } else {
              const close = sourceText.lastIndexOf(')', target.body.pos)
              if (close < 0) continue
              anchor = close + 1
            }
            edits.push({ kind: 'text', start: anchor, end: anchor, text: `: ${rendered} ` })
            consume(doc, tag)
          }
        }
        for (const tag of templates) {
          if (target.typeParameters !== undefined) continue
          const names = tag.typeParameters.map(p => p.getText()).join(', ')
          const open = sourceText.lastIndexOf("(", target.parameters.pos)
          if (open < 0) continue
          edits.push({ kind: 'text', start: open, end: open, text: `<${names}>` })
          consume(doc, tag)
        }
      }

      // --- `/** @type {T} */ (expr)` cast form.
      //
      // Handled through the parser rather than by matching braces and parens in
      // text: a cast expression can contain parentheses inside comments and
      // template literals, which no hand-rolled matcher gets right.
      if (ts.isParenthesizedExpression(node)) {
        const castType = ts.getJSDocType(node)
        if (castType !== undefined) {
          const rendered = jsdocTypeToTs(castType, sourceText)
          const inner = sourceText.slice(node.expression.getStart(source), node.expression.end)
          // A JSDoc consumed as a type assertion is not reported as a leading
          // comment range, so locate the block textually between the node's
          // full start and its first token.
          let start = node.getStart(source)
          const close = sourceText.lastIndexOf('*/', start)
          if (close > node.getFullStart()) {
            const open = sourceText.lastIndexOf('/**', close)
            if (open >= node.getFullStart()) start = open
          }
          // Parenthesize the inner expression: `x => { ... } as T` does not
          // parse, because `as` cannot follow an arrow whose body is a block.
          edits.push({ kind: 'text', start, end: node.end, text: `((${inner}) as ${rendered})` })
        }
      }

      // --- @type on a variable declaration
      const typeTag = tags.find(t => t.kind === ts.SyntaxKind.JSDocTypeTag)
      // A class field carries its `@type` on the property declaration, which is
      // not a variable statement; without this the field stays implicitly any.
      if (typeTag !== undefined && ts.isPropertyDeclaration(node) && node.type === undefined) {
        const inner = typeTag.typeExpression?.type
        if (inner !== undefined) {
          const at = node.name.end
          edits.push({ kind: "text", start: at, end: at, text: `: ${jsdocTypeToTs(inner, sourceText)}` })
          consume(doc, typeTag)
        }
      }
      if (typeTag !== undefined && ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0]
        const inner = typeTag.typeExpression?.type
        if (decl !== undefined && decl.type === undefined && inner !== undefined) {
          const rendered = jsdocTypeToTs(inner, sourceText)
          const at = decl.name.end
          edits.push({ kind: 'text', start: at, end: at, text: `: ${rendered}` })
          consume(doc, typeTag)
        }
      }
    }
    // --- Class fields.
    //
    // JavaScript declares a field by assigning `this.x` in the constructor;
    // TypeScript requires the declaration. Synthesize one per assigned field,
    // carrying the JSDoc type where the assignment had one and otherwise
    // leaving it for TypeScript to infer from the constructor.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const ctor = node.members.find(member => ts.isConstructorDeclaration(member))
      if (ctor !== undefined && ctor.body !== undefined) {
        const declared = new Set(
          // Any named member counts, not only a property: a constructor that
          // rebinds its own method (this.write = this.write.bind(this)) would
          // otherwise gain a field declaration duplicating that method.
          node.members.map(member => member.name?.getText?.())
            .filter(name => name !== undefined),
        )
        /** @type {Map<string, string | undefined>} */
        const fields = new Map()
        const scan = statement => {
          if (ts.isExpressionStatement(statement)
            && ts.isBinaryExpression(statement.expression)
            && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(statement.expression.left)
            && statement.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const field = statement.expression.left.name.getText()
            if (declared.has(field) || fields.has(field)) return
            const typeTag = ts.getJSDocType(statement)
            fields.set(field, typeTag === undefined ? undefined : jsdocTypeToTs(typeTag, sourceText))
          }
          ts.forEachChild(statement, scan)
        }
        for (const statement of ctor.body.statements) scan(statement)
        if (fields.size > 0) {
          const open = sourceText.indexOf("{", node.members.pos - 1) >= 0
            ? sourceText.lastIndexOf("{", node.members.pos)
            : -1
          if (open >= 0) {
            const lines = [...fields].map(([field, type]) =>
              `  ${field}${type === undefined ? "" : `: ${type}`}`).join("\n")
            edits.push({ kind: "text", start: open + 1, end: open + 1, text: `\n${lines}\n` })
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)

  // --- Inline parameter annotation: `(/** @type {T} */ name)`.
  //
  // The parser reports this as a plain parameter with a leading comment rather
  // than as a type assertion, so it needs its own pass. Casts are handled from
  // the syntax tree above; this form only ever annotates a binding.
  const inlinePattern = /\/\*\*\s*@type\s*\{/gu
  let inline
  while ((inline = inlinePattern.exec(sourceText)) !== null) {
    const commentStart = inline.index
    const braceStart = sourceText.indexOf("{", commentStart + 3)
    const typeEnd = matchBrace(sourceText, braceStart)
    if (typeEnd < 0) continue
    const closeComment = sourceText.indexOf("*/", typeEnd)
    if (closeComment < 0) continue
    let cursor = closeComment + 2
    while (cursor < sourceText.length && /\s/u.test(sourceText[cursor])) cursor += 1
    const identifier = /^[A-Za-z_$][\w$]*/u.exec(sourceText.slice(cursor))
    if (identifier === null) continue
    let before = commentStart - 1
    while (before >= 0 && /\s/u.test(sourceText[before])) before -= 1
    if (sourceText[before] !== "(" && sourceText[before] !== ",") continue
    edits.push({
      kind: "text",
      start: commentStart,
      end: cursor + identifier[0].length,
      text: `${identifier[0]}: ${sourceText.slice(braceStart + 1, typeEnd).trim()}`,
    })
  }

  return { edits, consumed, source }
}

function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function matchParen(text, open) {
  let depth = 0
  let inString = null
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (inString !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inString) inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

export { matchBrace, matchParen }
