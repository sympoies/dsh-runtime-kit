# Repository policy

This repository owns the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness (DSH).

## Invariants

- Do not fork or vendor DeepSeek Harness. Integrate through public Cordis and
  DSH bundle, plugin, tool, event, and service interfaces.
- Keep DSH compatibility code isolated when version-specific adapters become
  necessary. Pin every tested DSH release candidate in compatibility evidence.
- Keep private skill contents, credentials, machine paths, and personal policy
  out of this repository. Public code may discover and load explicitly
  configured private skill directories.
- Do not duplicate a policy engine in JavaScript when the rule belongs in the
  shared `nils-cli` policy boundary.

## Validation

Run the keyless end-to-end smoke test against a prepared DSH source checkout:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
npm run test:smoke
```

The test must install this package into a clean temporary DSH profile, verify
the composed bundle layer, and execute `runtime_kit_plus_one` through DSH's real
tools pipeline.

## Development log

- `docs/devlog/` is the append-only narrative for notable work: what changed,
  why, the evidence, and links worth keeping. It complements commit messages
  and the normative docs; it does not replace keeping those docs current.
- After non-trivial development work with future debugging or decision value,
  append an entry through the `project-devlog` skill before declaring the task
  complete. Skip transient or same-turn fixes with no durable outcome.
- Keep entries English, newest-first by month, and safe for a public repo. Do
  not record credentials, private skill contents, personal identifiers,
  internal hostnames, private topology, or machine-local paths.

## Project skills

- Project-local skills live under `.agents/skills/<name>/`; the canonical
  source for this workflow is `project-devlog`.
- Search existing entries with
  `scripts/devlog-search.sh <term> [YYYY-MM]` before adding a new one.
