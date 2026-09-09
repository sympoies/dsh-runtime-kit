# Execution State: Make real-provider acceptance fixtures executable

## Execution State

- Source document: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-plan.md`
- Plan: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/218>
- Profile: tracking
- Plan branch: `fix/issue-218-executable-fixtures`
- Current sprint: Sprint 2
- Status: validating
- Current task: Task 2.3
- Next task: deliver and review the PR, then run hosted acceptance before closing #218
- Blockers: none for the #218 executable-fixture delivery; the 28 non-pass baseline rows remain owned by #217 and block #D promotion
- Last updated: 2026-09-09
- Branch/commit/PR: `fix/issue-218-executable-fixtures`; PR pending

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Freeze the fixture manifest contract | done | RED: missing manifest; GREEN: focused manifest/provider suite passes | Strict v1 coverage binds all 12 families and 33 rows |
| 1.2 | Implement the packaged provider transitions | done | all twelve induction/inverse integration cases pass | #220 phase tasks are digest-bound; workspace lease uses the v2 protocol and other families switch only their typed phase input |
| 1.3 | Integrate discovery and harness guidance | done | packaged-provider discovery, task-digest summary binding, and explicit override tests pass | Attestation-owned fixture inputs are retained after driver cleanup |
| 2.1 | Validate package, smoke, and scripted accounting | done | focused final suite passes 70/70; full test passes 927/928 with one intentional skip, typecheck and policy benchmark pass, and all three smoke legs pass; packaged v50 scripted proof reports 66/66 results and 66/66 attestations | `typecheck:test` has the same broad pre-existing failures on accepted main and is waived as baseline noise |
| 2.2 | Run the complete real-provider matrix | done | `gpt-5.6-luna` baseline records all 66 unique cases: 38 pass, 25 fail, 3 precondition-unmet; every pass has an external attestation | #217 retains the closed-set non-pass matrix and blocks #D promotion without expanding #218 |
| 2.3 | Review, merge, and close the tracker | in-progress | final package, local gates, and real-provider baseline are complete | Deliver the PR, run the full pre-merge review, hosted acceptance, and strict tracker closeout |

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
- 2026-09-09: Managed-subagent fixtures now validate the child before submission, close the lane before the controller's read-only verification, and require the external harness to rerun child validation after DSH exits. This keeps the child activity-ledger generation current across lane release. Exact primary, child, and controller-review bytes are independently attested; retry workspaces are selected through their own authenticated environment pair.
- 2026-09-09: Final specialist re-review closed the executable ancestry, task/argv binding, folder-kind binding, and managed-child Git-topology findings. The focused acceptance suite passes 70/70 and security, testing, and maintainability re-reviews report no remaining findings.
- 2026-09-09: Packaged candidate v50 passed the complete scripted accounting gate: 66/66 driver results and 66/66 independent attestations with no missing, duplicate, invalid-pair, or profile-isolation rows. After the final source fixes, the full repository suite passed 927/928 with one intentional skip and all three required local DSH smoke legs passed again; typecheck and the policy benchmark also pass.
- 2026-09-09: Fresh v56 real-provider profiles and workdirs were initialized successfully, including operations-engine installation, healthy doctor output, and composed headless configuration. The real harness authenticated owner-only copies of the v50 driver, fixture provider, and DSH launcher. Two independent attempts of `workspace-identity.non-git.success` both reached DSH and stopped before model execution with typed `provider-failure / QUOTA`; both stderr artifacts have SHA-256 `b9655c8665f8f7871c7981988af7316896b45f10383b18171f2b524f2b6ed0fa`. The strict 66/66 merge gate remains unmet and no PR may merge until provider availability is restored.
- 2026-09-09: The existing ChatGPT-subscription-backed DSH relay replaced the unavailable provider without changing the candidate. A clean v59 matrix pinned `codex-proxy` to `gpt-5.6-luna` and recorded all 66 unique catalog cases: 38 pass, 25 fail, and 3 precondition-unmet. All 38 passing rows have independent attestations; there are no missing, unexpected, duplicate, quota, credential, authentication, or provider-availability rows. The final JSONL SHA-256 is `48bcc9d84cc622d9dc35a40b2e3128a2a4986aa4f444f3b1a856c84196ba7dd8`. #217 retains the 28 non-pass rows for later repair, so #218 can deliver the executable evidence boundary without falsely promoting #D.
- 2026-09-09: PR #225 pre-merge security review rejected the runbook's uncontained `danger-full-access` instruction for linked-worktree Git writes. A focused RED proved the missing boundary; the repaired runbook permits that inner mode only under an outer `bwrap` sandbox with the host read-only, one owner-only family root writable, an explicit environment, and a fail-closed `precondition-unmet` result when equivalent containment is unavailable. The full `acceptance-drive` test file passes 33/33 after the repair.

## Handoff

- Deliver the unchanged executable-fixture candidate, run the full pre-merge review and hosted Gate 4, then close #218. Keep #217 open until its retained real-provider matrix reaches 66 pass and 66 independent attestations, at which point #D may be promoted in #197.
