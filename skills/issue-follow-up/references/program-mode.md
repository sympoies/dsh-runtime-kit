# Program Mode Reference

Templates and operating rules for `issue-follow-up` program mode. The mode
selection itself (when work is a `program`, its closeout, and its
specializations) belongs to the work-modes policy that `runtime_context`
returns for intent `project-dev`, phase `delivery`.

## Creation Order

1. Pick a stable program key, for example `<topic>-<YYYY-MM>`.
2. Deduplicate: search open issues in every target repository for the same
   outcome. Link a clear existing match as a related or prerequisite child
   instead of opening a duplicate, and post one comment on it that names the
   program.
3. Open the tracker first with a short placeholder body so children can link
   to its number. Label it `workflow::tracking`.
4. Open each child with the child template. Label children
   `workflow::follow-up` plus the usual `type::`, `area::`, `state::`,
   `priority::`, and `size::` labels. Use `state::blocked` for a child whose
   dependencies are open.
5. Write the full tracker template to a body file, now listing the real child
   numbers, and fill its graph with
   `forge-cli issue tracker graph --body-file <file> --write`. Replace the
   placeholder with it through `forge-cli issue edit`, run
   `forge-cli issue tracker lint <tracker>` and fix every finding, then post
   the first checkpoint on the tracker. Without `issue tracker`, use the manual
   equivalents in [Tracker Commands](#tracker-commands).

When `forge-cli` runs outside a checkout of the target repository (for example
from a scratch directory), pass `--provider github --repo owner/name`
explicitly; remote detection otherwise fails and nothing is created. Confirm
every create returned a URL before continuing, and list open issues before
retrying a failed create so a retry cannot duplicate one.

## Public Repositories

A child in a public repository must not contain hostnames, network or tailnet
details, personal names, private repository names, or links to private
issues. Refer to the program by its key and item id instead. A private tracker
may link public children freely.

## Tracker Template

```markdown
## Purpose

Program key **`<key>`**. <What outcome the program delivers and why.>

## How to resume (read this first)

1. Read this body, then the latest checkpoint comment on this issue.
2. Pick the first unchecked item whose dependencies are all checked; items in
   one phase may run in parallel.
3. Read that child issue and its latest checkpoint; each child is
   self-contained.
4. Deliver through the owning repository's normal workflow.
5. Checkpoint the child at each boundary; when it closes, tick it here with
   `forge-cli issue tracker tick`, recording its PR and a one-line checkpoint
   with release or deploy evidence.
6. <Live changes and authority that planning does not grant.>

## Decisions (settled YYYY-MM-DD)

- <Decision, stated so a child can be checked against it.>

## Phase table

### Phase 1: <name>

- [ ] **<id>** <title>: <owner/repo#number>
- [ ] **<id>** <title>: <owner/repo#number> · after <id>

### Phase 2: <name>

- [ ] **<id>** <gate: a release, deploy, or decision> · after <id>, <id>

## Dependency graph

<The `mermaid` block that `forge-cli issue tracker graph --write` derives from
the phase table rows. Never change it independently of the rows.>

## Open decisions

- <Decision still needed, and which item it blocks.>

## Checkpoint log

Progress is recorded as comments on this issue. Keep the phase table in sync
with closed children.
```

## Child Template

```markdown
## Program

Program key `<key>` (tracker: <link where allowed>), item **<id>**.
Depends on <ids>. <Parallelism note.>

## Goal

<One observable outcome.>

## Current facts

- <Verified fact with a repository-relative file reference.>

## Scope

- [ ] <Concrete, checkable step.>

## Out of scope

<What belongs to other items.>

## Acceptance

- <Test-first, validation, and live-evidence requirements.>

## Unblocks

<ids this item unblocks.>
```

## Writing Phase Rows

`tracker-row-grammar.md`, next to this file, is the normative grammar: how a
row is parsed, how the dependency graph is derived, and what a linter
reports. Load it before writing or checking the graph block, and whenever a
row is unusual. The short form:

```text
- [ ] **<id>** <title>: <ref> (<notes>) · after <id>, <id>
```

- One row per line, starting at column one and never wrapped.
- `<id>` is an upper-case letter followed by letters or digits, unique in the
  tracker. A lower-case first letter makes the row malformed.
- `<ref>` is `owner/repo#N`, or `#N` for the tracker's own repository. A row
  without a ref is a gate: a release, a deploy, or a decision.
- `(<notes>)` is optional, such as the delivering PR.
- ` · after <ids>` lists the ids the row depends on; the mark is U+00B7
  MIDDLE DOT. The phase row is the authoritative declaration of a
  dependency, and the child's `Depends on` line repeats it.

```markdown
- [x] **S1** Row grammar: example/alpha#14 (PR example/alpha#16)
- [ ] **REL** Release containing S1 · after S1
```

Three consequences to write rows by:

- A parenthesised group that ends the row, before any `· after` clause, is
  always the notes, on a gate too: `Release the CLI (v2)` has the title
  `Release the CLI`.
- A ref that is not written exactly, such as `:#12` or `: #12.`, stays in the
  title and turns the row into a gate. No finding reports it.
- A title that itself ends with ` · after <word>` is read as a dependency.

The dependency graph block is derived from the rows by the generation rules
in the grammar. Never change the graph independently of the rows.

## Tracker Commands

This section is the one source for how a tracker is linted, ticked, and given
its graph; other skills and policies point here. `forge-cli issue tracker`
(forge-cli 1.31.2 or later) reads and maintains the phase table by
`tracker-row-grammar.md`. Use it instead of editing a checkbox or the Mermaid
block by hand:

- `lint <tracker>` reports the grammar's findings plus a missing
  `workflow::tracking` label; `--check-state` also reports each row whose
  checkbox disagrees with its issue's state. Any finding exits 65 with
  `tracker_findings`. `--body-file <file>` lints a draft without a provider
  call.
- `graph <tracker> --write` regenerates the `## Dependency graph` block from
  the rows; without `--write` it only prints the block.
  `--body-file <file> --write` fills a draft instead. Run it after every
  change to the rows except a tick: writing the first full body, adding,
  removing, or re-identifying a row, turning a row into a gate or back, or
  changing an `after` list. Otherwise `lint` reports `stale-graph`.
- `tick <tracker> --item <id> [--pr <ref>] [--comment-file <file>]` ticks one
  row, records `PR <ref>` in its notes, and posts the file as one comment after
  the body write. On `tracker_comment_not_posted` the row is already ticked:
  post the file with `forge-cli issue comment`.

Where `forge-cli` lacks `issue tracker`, use the manual equivalents:

- Tick: change the row's `[ ]` to `[x]`, add `(PR <ref>)` as its notes when
  it has none, and write the reviewed body file with `forge-cli issue edit`.
- Checkpoint: post it with `forge-cli issue comment --body-file <file>`.
- Graph: write the block by the grammar's generation rules.
- Lint: check the rows against the grammar's findings. At closeout, view every
  issue the rows reference and confirm each row is ticked exactly when its
  issue is closed.

## Checkpoint Discipline

- Post the normal follow-up checkpoint (Checked / Result / Decision / Next) on
  a child at each boundary.
- When a child closes, tick its row with
  `forge-cli issue tracker tick <tracker> --item <id> --pr <ref> --comment-file <file>`,
  or its manual equivalent where `forge-cli` lacks `issue tracker`. The file
  holds the one-line checkpoint with the PR link and any release or deploy
  evidence. Do not rewrite the body to tick a row when `tick` is available.
- Record a settled decision in the tracker's Decisions section before a child
  depends on it; open decisions stay in Open decisions until decided.
- Tick a gate row the same way, without `--pr`, when its release, deploy, or
  decision has happened.
- After any other change to the rows, regenerate the graph as
  [Tracker Commands](#tracker-commands) says.

## Closeout

Close the tracker only after the work-modes program closeout holds: every
child is closed or explicitly moved, key decisions are canonised in repository
docs or the devlog, `forge-cli issue tracker lint <tracker> --check-state`
(or its manual equivalent where `forge-cli` lacks `issue tracker`) reports no
finding, and a final tracker checkpoint is posted.
