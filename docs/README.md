# Documentation

This directory holds durable documentation for `dsh-runtime-kit`. The root
`README.md` is the product entrypoint for DSH users; `DEVELOPMENT.md` is the
routine contributor entrypoint.

## Use and operate

- [Operations](operations.md) — activate, inspect, update, roll back, repair,
  and remove an isolated DSH installation.
- [Private and project skills](private-skills.md) — skill roots, precedence,
  validation, limits, and restart behavior.
- [Main Agent Mode](main-agent-mode.md) — controller/worker ownership, tools,
  runtime shape, and current limitations.
- [Compatibility](compatibility.md) — exact DSH, Cordis, Node.js, and nils-cli
  support plus promotion checks.
- [Native runtime health](runtime-health.md) — model-hidden capability probes,
  admission states, cleanup, and operator recovery.
- [Composition contracts](composition-contracts.md) — strict public plugin and
  bot schemas, canonical resolution, lock receipts, and trust boundaries.

## Understand the runtime

- [Architecture](architecture.md) — composition, lifecycle, policy, reviewer,
  finish-line, activation, compatibility, and trust boundaries.
- [Workspace identity and leases](workspace-leases.md) — the runtime-owned
  Cordis contract, nils-cli provider boundary, and fail-closed lifecycle.
- [Authoritative completion acceptance](authoritative-acceptance.md) — exact
  mutation generations, validator observations, stop and GoalService gates,
  and rollback behavior.
- [Acceptance boundary](acceptance.md) — what local rehearsal proves and what
  independent promotion must add.
- [Historical migration snapshot](migration.md) — the pre-closeout source
  rehearsal state retained for context; use the devlog for current status.

## Develop and investigate

- [Contributor setup and validation](../DEVELOPMENT.md) — prerequisites,
  source-of-truth files, routine gates, smoke tests, and delivery constraints.
- [Test-first evidence](test-first-evidence.md) — retained implementation and
  validation evidence for the migration work.
- [Development log](devlog/README.md) — curated, newest-first project history.
- [Retained plans](plans/) — detailed implementation plans and execution state.

Normative guidance belongs in the current product, development, operations,
acceptance, or architecture owner. Evidence and logs should link to those
documents instead of repeating or overriding the current contract.
