# Execution State: Make real-provider acceptance fixtures executable

## Execution State

- Source document: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-plan.md`
- Plan: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/218>
- Profile: tracking
- Plan branch: `fix/issue-218-executable-fixtures`
- Current sprint: Sprint 2
- Status: in-progress
- Current task: Task 2.1
- Next task: run the final packaged candidate through scripted accounting, smoke, and the complete real-provider matrix
- Blockers: none; #221 is an in-scope reporting repair exposed by the real runtime-health run
- Last updated: 2026-09-08
- Branch/commit/PR: `fix/issue-218-executable-fixtures`; PR pending

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Freeze the fixture manifest contract | done | RED: missing manifest; GREEN: focused manifest/provider suite passes | Strict v1 coverage binds all 12 families and 33 rows |
| 1.2 | Implement the packaged provider transitions | done | all twelve induction/inverse integration cases pass | #220 phase tasks are digest-bound; workspace lease uses the v2 protocol and other families switch only their typed phase input |
| 1.3 | Integrate discovery and harness guidance | done | packaged-provider discovery, task-digest summary binding, and explicit override tests pass | Attestation-owned fixture inputs are retained after driver cleanup |
| 2.1 | Validate package, smoke, and scripted accounting | in-progress | focused driver/provider suite passes 57/57; earlier full test and three smoke legs passed before the latest safety edits | Final full gates follow the real-provider matrix |
| 2.2 | Run the complete real-provider matrix | pending | 4/66 exploratory rows passed across two non-Git pairs; the final matrix restarts from fresh workdirs | Git rows use distinct success, induced-failure, and clean-retry checkouts |
| 2.3 | Review, merge, and close the tracker | pending | pending | Depends on Task 2.2 |

## Validation Log

- 2026-09-08: #218 read back as an open follow-up with no lifecycle comments.
- 2026-09-08: accepted main synchronized to merge `2195722e05f0d3e4d5e8fef84ff402c02cfce63a`; its six-job compatibility run passed.
- 2026-09-08: project-dev and acceptance-harness edit intents passed strict preflight.
- 2026-09-08: Gate 0 RED captured at baseline `0ce52ff9b46b37edf1ad25ca929ff4b7274eb18d`; the new package-ownership test fails because `compatibility/acceptance-fixtures.json` is absent. Contract delta, affected target, manual real-provider scope, and retained invariants are recorded in test-first evidence.
- 2026-09-08: Real Codex-driven DSH runs completed and independently attested both phases of `automatic-prerequisite.non-git` and `runtime-health.non-git` (4/66 rows). The runtime-health failure exposed diagnostic projection loss, recorded as #221.
- 2026-09-08: Nine nominal failure recipes were proven to write metadata without changing any runtime input. They now fail closed as `fixture-failure-kind-unimplemented`; #220 records the deeper fixed-task contract contradiction rather than permitting unrelated pre-model faults to manufacture green rows.
- 2026-09-08: Security and evidence-integrity remediation binds state to canonical roots, derives cleanup targets from the selected family, validates path components before creation, rechecks provider identity before every invocation, retains observation inputs for post-driver attestation, and normalizes transcript decision surfaces. The state-bound success-to-failure reset preserves the required paired lifecycle. Focused coverage passes 33/33; security and lifecycle re-reviews have no remaining findings.
- 2026-09-08: The maintainer approved #220's recommended contract: committed phase-specific catalog tasks, with byte identity preserved between each induced failure run and its clean retry. Task 1.2 resumed; generic or metadata-only faults remain forbidden.
- 2026-09-08: Scenario/catalog schemas advanced to v2 and bind both phase-task digests plus the canonical recovery marker. The driver and pack summary reject task/marker drift. All twelve provider induction/inverse recipes now execute in focused integration tests, and #221's pre-model runtime-health code is retained through an allowlisted `HealthProbeFailure` projection.
- 2026-09-08: A real nested invocation proved that an outer Codex lifecycle principal cannot be forwarded into an ordinary DSH subprocess: the task completed, but the outer provider rejected DSH activity as `session-activity-failed`. The harness contract now treats Codex or Claude as the external observer, strips its principal selectors before DSH starts, and requires three physical checkouts for each Git scenario so the one-shot workspace lease is neither bypassed nor reused. The driver authenticates the separate retry checkout, repeats the exact task bytes there, and records both checkout-specific fixture receipts.

## Handoff

- Package the principal-isolated candidate, prove one Git pair, then run repository/package/smoke gates, scripted 66/66 accounting, and the complete serial real-provider matrix before delivery.
