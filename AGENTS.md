# Repository policy

This repository owns the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness (DSH).

## Invariants

- Do not fork or vendor DeepSeek Harness. Use public Cordis and DSH interfaces
  by default. A missing execution boundary may use only the version-scoped,
  hash-authenticated downstream patch declared in
  `compatibility/dsh-patches.json`; patch apply and reverse must fail closed on
  unknown revisions, content drift, or unrelated checkout changes.
- Keep DSH compatibility code isolated when version-specific adapters become
  necessary. Pin every tested DSH release candidate in compatibility evidence.
- Keep private skill contents, credentials, machine paths, and personal policy
  out of this repository. Public code may discover and load explicitly
  configured private skill directories.
- Do not duplicate a policy engine in JavaScript when the rule belongs in the
  shared `nils-cli` policy boundary.

## Delivery discipline

- Inspect affected targets, callers, tests, and rules; distinguish facts,
  assumptions, and inference. Deliver the smallest correct solution for the
  accepted observable outcome.
- Exclude hypothetical hardening, unsupported edge cases, architecture
  preference, and future flexibility from the current task.
  Possible improvement is not incompleteness.

## Validation

Apply the reviewed patch to a pristine selected checkout, rebuild DSH, and run
the keyless end-to-end smoke test:

```sh
node scripts/manage-dsh-patch.mjs --action apply \
  --source-root /path/to/deepseek-harness
pnpm --dir /path/to/deepseek-harness run build:lib:host
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/target/debug/agent-docs \
npm run test:smoke
node scripts/manage-dsh-patch.mjs --action reverse \
  --source-root /path/to/deepseek-harness
pnpm --dir /path/to/deepseek-harness run build:lib:host
```

The reverse receipt authenticates source state only (`runtime_rebuilt: false`).
Rollback is incomplete until the pristine host libraries have been rebuilt and
the unpatched DSH process has been smoke-tested.

The smoke also resolves `review-specialists` as a sibling of `AGENT_HOOK_BIN`,
so build all three from the same nils-cli checkout
(`cargo build --bin agent-hook --bin agent-docs --bin review-specialists`).
Binaries older than the contracts under test fail as typed bridge errors
(`policy-output-invalid`, `finish-line response invalid`), not as version
warnings.

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
