# Tracker Row Grammar

Normative grammar for the phase table of a program tracker: how its rows are
read, how the dependency graph is derived from them, and which findings a
linter reports. Independent parsers implement this file, so it is exact.
`program-mode.md` holds the tracker template and a short guide to writing a
row.

The phase row is the authoritative declaration of a dependency. The
dependency graph is derived from the rows, and a child's `Depends on` line
repeats its row's `after` list for the reader.

## Lines And Sections

Read the body as lines: split on line feeds, then remove trailing spaces,
tabs, and carriage returns from each line. Everywhere else in this grammar,
"trim" means removing spaces and tabs from both ends of a text. No other
character is whitespace: a no-break space is ordinary text. No other Markdown
is interpreted, so a code fence does not hide a heading or a row.

- The phase table starts after the first line equal to `## Phase table`,
  compared without regard to ASCII case, and ends before the next line that
  starts with `## `. The `## Dependency graph` section is found the same way.
  A heading that only begins with those words, such as
  `## Phase table notes`, is another section. A body without a phase table
  has no rows.
- Inside the phase table, a line that starts with `### ` starts a phase. Its
  name is the rest of the line, trimmed. A phase only groups the rows below
  it, and rows above the first phase heading have no phase. A heading whose
  name is empty, such as a bare `###`, is not a phase heading and is ignored.
- A line that starts at column one with `- [ ]`, `- [x]`, or `- [X]` is a
  row. Every other line is ignored: prose, blank lines, other bullets, deeper
  headings, and anything indented. A row is one line; never wrap it.

## Row

```text
- [ ] **<id>** <title>: <ref> (<notes>) · after <id>, <id>
```

| Part | Rule |
| --- | --- |
| Checkbox | `[ ]` is open. `[x]` or `[X]` is done. |
| `<id>` | An upper-case ASCII letter followed by any number of ASCII letters or digits. Case-sensitive, and unique within the tracker. |
| `<title>` | Free text, kept as written. Never empty. |
| `<ref>` | `owner/repo#N`, or `#N` for the tracker's own repository. A row without a ref is a gate: a release, a deploy, or a decision. |
| `(<notes>)` | Optional free text, such as the delivering PR. |
| `· after` | Optional. The ids this row depends on. The mark is U+00B7 MIDDLE DOT. |

An id is written into the graph as a Mermaid node identifier, and Mermaid's
special words, such as `end`, all start with a lower-case letter; that is why
an id starts with an upper-case one. A row whose bold token is not an id,
such as `**end**` or `**a1**`, is malformed.

A row starts with `- [<state>] **<id>**`, with single spaces exactly as
shown, and the rest of the line starts with a space. Parse that rest from
right to left, so that a title may contain anything. After each step, trim
the remaining text:

1. **Dependencies.** Find the last ` · after` (space, middle dot, space,
   `after`) that is followed by a space or ends the line. The list is the
   text after it, trimmed. It must be one or more ids separated by commas,
   where a comma may have spaces and tabs around it, and no id may repeat;
   otherwise the row is malformed. Every entry must itself be an id, so
   ` · after a1` makes the row malformed; it is not an unknown dependency.
   Remove the clause.
2. **Notes.** If the remaining text ends with `)`, find the matching `(`,
   counting nested pairs. The group is the notes when that `(` exists, is
   not the first character of the remaining text, follows a space, and
   encloses text that is not empty once trimmed. The notes are that trimmed
   text; remove the group. Otherwise the row has no notes and the remaining
   text is unchanged, so a row whose rest is only `(draft)` has the title
   `(draft)`.
3. **Ref.** If the remaining text ends with `: <ref>` (colon, one space,
   ref), that is the ref and the text before the colon, trimmed, is the
   title. Otherwise the row is a gate and the remaining text is the title. A
   row with an empty title is malformed.

In a ref, `owner` and `repo` each use one or more ASCII letters, digits, `.`,
`_`, and `-`. `N` is one to fifteen decimal digits and does not start with
`0`; a longer number is not a ref. Two rows may name the same issue when it
is delivered in two steps; their ids stay distinct.

Three consequences to write rows by:

- A parenthesised group that ends the row, before any `· after` clause, is
  always the notes, on a gate too: `Release the CLI (v2)` has the title
  `Release the CLI`.
- A ref that is not written exactly, such as `:#12` or `: #12.`, stays in the
  title and turns the row into a gate. No finding reports it.
- A title that itself ends with ` · after <word>` is read as a dependency.

Example rows:

```markdown
- [ ] **B1** Board leads with trackers: #21
- [x] **S1** Row grammar: example/alpha#14 (PR example/alpha#16)
- [ ] **S2** `lint | graph | tick` commands: example/beta#7 · after S1
- [ ] **REL** Release containing S2 · after S2
```

## Derived Dependency Graph

The `## Dependency graph` section holds one fenced `mermaid` block. The block
is derived: its lines are exactly what the rules below generate from the
rows. Tracker tooling writes it when that tooling is available; otherwise
write those lines from the rows. Never change the graph independently of the
rows. Keep nothing else in the section.

The example rows above generate:

```text
graph LR
  B1
  S1
  S2
  REL{{REL}}
  S1 --> S2
  S2 --> REL
```

- The first line is `graph LR`. Every other line is indented by two spaces.
- Node lines come next, one per row in table order: `<id>`, or
  `<id>{{<id>}}` for a gate.
- Edge lines come last, one per dependency, as
  `<prerequisite> --> <dependent>`. Order them by the dependent's table
  order, then by the order of its `after` list.
- There is no styling, label, subgraph, comment, or blank line.
- A table with no rows, which includes a body with no phase table, generates
  the single line `graph LR`.

The block is the lines between the first line in the section equal to three
backticks followed by `mermaid` and the next line equal to three backticks.
Both fence lines match exactly: no indentation, no longer fence, no other
info string, and `mermaid` in lower case. The block is current when its
lines equal the generated lines, in the same order. Lines outside the block,
a later block included, are not compared. The block is missing when the body
has no `## Dependency graph` section, the section has no opening fence line,
or the block is never closed.

## Findings

Linters report a broken tracker with these codes:

| Code | Reported |
| --- | --- |
| `malformed-row` | Once per row line that does not match the grammar. Such a row contributes no id and no dependency, so an `after` that names the id it shows is an `unknown-dependency`. |
| `duplicate-id` | Once per row that reuses the id of an earlier row. The row still counts for the dependency findings: its `after` list is checked, and its dependencies attach to the shared id, so it can close a cycle. |
| `unknown-dependency` | Once per `after` id that is not the id of any row. |
| `self-dependency` | Once per row that lists its own id in `after`. |
| `cycle` | Once per largest set of two or more ids in which every id depends on every other, directly or through other rows. Unknown ids and self-dependencies do not form a cycle. |
| `stale-graph` | Once, when the `mermaid` block is missing or is not current. |

A table with any of the first five findings has no generated graph, so
`stale-graph` is reported only when no other finding is. A table with no rows
has a generated graph and is checked like any other: a placeholder tracker
without a `graph LR` block reports `stale-graph`.

## Fixtures

The grammar's upstream owner keeps a conformance corpus of valid tracker
bodies with their expected rows and graph, and invalid bodies with their
expected findings; `forge-cli issue tracker` is tested against it. This copy
follows that grammar and does not define a second parser or corpus. A change
to this grammar arrives through a validated `forge-cli` release.
