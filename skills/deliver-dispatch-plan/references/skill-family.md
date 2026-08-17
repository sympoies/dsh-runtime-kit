# Plan Issue Outcome Family

The tracking and dispatch outcomes share these invariants:

- Use `plan-tooling` to validate the plan bundle and task ledger.
- Use `plan-issue record` and `plan-issue tracking` for lifecycle records,
  run-state reconciliation, checkpoints, and close-readiness.
- Use `forge-cli` for issue and PR/MR lifecycle operations outside plan records.
- Reconcile live provider evidence before mutation; local run state is not
  durable truth when the provider is newer.
- Do not hand-compose or raw-post lifecycle comments.
- Keep source, plan, state, session, validation, review, and closeout work
  within their declared single-writer phases.
- Rewrite useful local paths as `$HOME/...` and omit remote-useless artifacts
  from provider-visible payloads.
- Stop on stale state, privacy failures, unresolved review gates, unchecked
  task items, or any close-ready blocker.
- Preserve independent review: implementers do not approve or merge their own
  lane work.

`deliver-plan-tracking-issue` owns one lightweight issue-backed delivery.
`deliver-dispatch-plan` owns one shared multi-lane dispatch issue. Neither
outcome may silently switch to the other's lifecycle or closeout semantics.
