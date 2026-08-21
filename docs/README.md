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

## Understand the runtime

- [Architecture](architecture.md) — composition, lifecycle, policy, reviewer,
  finish-line, activation, compatibility, and trust boundaries.
- [Acceptance boundary](acceptance.md) — what local rehearsal proves and what
  independent promotion must add.
- [Migration status](migration.md) — completed migration capabilities and the
  remaining promotion boundary.

## Develop and investigate

- [Contributor setup and validation](../DEVELOPMENT.md) — prerequisites,
  source-of-truth files, routine gates, smoke tests, and delivery constraints.
- [Test-first evidence](test-first-evidence.md) — retained implementation and
  validation evidence for the migration work.
- [Development log](devlog/README.md) — curated, newest-first project history.
- [Retained plans](plans/) — detailed implementation plans and execution state.

Normative guidance belongs in the current product, development, operations, or
architecture owner. Evidence and logs should link to those documents instead of
repeating or overriding the current contract.
