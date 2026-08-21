---
name: project-devlog
description: >
  Append a development-log entry to docs/devlog/<YYYY-MM>.md after a session
  produces a durable outcome for dsh-runtime-kit. Skip trivial or transient
  work.
argument-hint: "[entry title]"
allowed-tools: Bash, Read, Edit, Write
---

# Project Devlog

Append one entry to the monthly development log when the current session
produces an outcome worth looking up later. The log is signal, not a changelog:
use it for shipped runtime changes, validated milestones, compatibility or
security decisions, and external references that will help future debugging.
This skill enforces `docs/devlog/README.md`.

## Contract

Prereqs:

- Run inside the `dsh-runtime-kit` git worktree with `docs/devlog/` present.
- A durable outcome exists. If the work is trivial, transient, or a same-turn
  cleanup with no future debugging or decision value, do not write an entry.

Inputs:

- Optional:
  - `[entry title]` - concise title; otherwise derive one from the outcome.

Outputs:

- A new `## YYYY-MM-DD - <title>` entry at the top of
  `docs/devlog/<YYYY-MM>.md`, creating and indexing the month when needed.
- When the user requests committed delivery, a standalone semantic commit for
  the devlog files: `docs(devlog): <YYYY-MM> - <subject>`.

Exit codes:

- `0`: an entry was written.
- `1`: a prerequisite is missing or the write failed.
- `2`: no durable outcome exists; intentional no-op.

Failure modes:

- The outcome has no durable lookup value; skip with a one-line reason.
- The entry only repeats a commit or normative document without adding context,
  evidence, or useful links.
- Current contract or operating guidance is stale; update its canonical owner
  before recording history.
- The draft includes secrets, private skill contents, personal identifiers,
  internal hostnames, private topology, or machine-local paths.

## Scripts

- Find earlier entries with `scripts/devlog-search.sh <term> [YYYY-MM]`.

## Workflow

1. Decide whether the outcome is worth future lookup. Default to writing for
   non-trivial development work unless it has no durable value.
2. Keep normative docs current first. The devlog records the narrative and
   does not own the current runtime contract, architecture, or runbook.
3. Resolve `docs/devlog/$(date +%Y-%m).md`. When creating a month, add a
   `# Development log - YYYY-MM` header and add it to the month index in
   `docs/devlog/README.md`.
4. Use the repository template: **Result**, **Why / context**, **Evidence**,
   **Links**, and optional **Follow-ups**. Ground evidence in commands or
   concrete observations that actually ran.
5. Insert the entry immediately below the month header so entries remain
   newest-first. Do not rewrite older entries except to correct a factual error
   in the same change.
6. Keep the entry in English, explain why rather than restating the diff, and
   scan it for public-repository privacy violations.
7. If committing, commit only the devlog file or new-month index alongside it,
   using the semantic-commit workflow.

## Boundary

This skill only appends under `docs/devlog/` and updates the month index when a
new month is created. It must not edit code, normative docs, runtime-kit
manifests, generated output, global runtime homes, credentials, sessions, or
cache state.
