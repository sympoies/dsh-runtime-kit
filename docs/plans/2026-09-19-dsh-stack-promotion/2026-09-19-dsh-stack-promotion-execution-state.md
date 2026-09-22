# Execution State: Promote DSH 0.1.6-alpha.2 in the headless deployment lane

## Execution State

- Source document: `docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-plan.md`
- Plan: `docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-plan.md`
- Tracking issue: <https://github.com/sympoies/dsh-runtime-kit/issues/252>
- Profile: tracking
- Plan branch: `feat/support-dsh-0-1-6-alpha-2`
- Current sprint: Sprint 2
- Status: complete
- Current task: complete
- Next task: none
- Blockers: none
- Last updated: 2026-09-22
- Branch/commit/PR: sympoies/dsh-runtime-kit#259 merged (<https://github.com/sympoies/dsh-runtime-kit/pull/259>)

## Task Ledger

| ID | Title | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Enforce lane-scoped promotion before profile mutation | done | operations RED/green proves typed refusal before profile, receipt, or activation mutation; compatibility regression proves the candidate excludes the frozen workbench generation | Headless alpha.5 admission remains green; remove stays available for cleanup |
| 1.2 | Complete DSH 0.1.6-alpha.2 authenticated compatibility | done | exact patch-manager apply/reverse on alpha.5 and alpha.6, pristine/patched alpha.6 host builds, authenticated 54-package peer staging, alpha.6 production typecheck, affected upstream tests, lifecycle adapter regressions, and runtime-kit focused suites pass locally | Generic/headless candidate is ready |
| 1.3 | Record the deferred dsh-TUI alpha.2 handoff | done | public clean-profile reproduction and human-submission draft in `dsh-tui-0-1-6-alpha-2-handoff-draft.md` | Deferred workbench input; not a headless dependency |
| 2.1 | Freeze the excluded workbench lane | done | candidate peers exclude rc.1, CI omits TUI mutation smoke, and operations rejects mismatched `dsh-tui` mutation | Existing workbench generation remains untouched |
| 2.2 | Freeze and prove one immutable runtime-kit artifact | done | routine gate passed; build provenance is current; packed candidate SHA-256 `4ceced4c2318229823010bc20de3a2568a04f7b1d949832b594716c7e1240eae` with 1,292 entries; routine gate, build provenance, and candidate package SHA-256 passed | Headless only |
| 2.3 | Deliver, deploy the new generation, and close strictly | done | runtime-kit PR 259; infra PR serenvia/sympoies-infra#812; hosted acceptance run 35782696987 passed; host CLI and sympoies-bot live on DSH 0.1.6-alpha.2 | Host CLI and sympoies-bot deployed; dsh-notify and reviewer follow up in serenvia/sympoies-infra#815 |

## Validation Log

- 2026-09-19: DSH `dsh-v0.1.6-alpha.2` and `master` resolve to revision `ddefc45fbc7f8e46dd73185e68295696d1297887`.
- 2026-09-19: The existing alpha.5 downstream patch did not apply cleanly; it was ported to alpha.2 with release-specific target hashes. The alpha.2 typed/bundled host build and affected DSH tests passed on the ported tree.
- 2026-09-19: The pristine alpha.2 public entrypoint/type digests and 54-package transitive workspace artifact closure were recomputed from built and packed upstream artifacts.
- 2026-09-19: Registry inspection confirmed dsh-tui `0.10.1` and `0.10.2` do not admit DSH `0.1.6-alpha.2`; no peer override was attempted.
- 2026-09-19: The maintainer initially accepted all-or-nothing stack promotion, isolated canary, immutable artifact reuse, generation deployment, and whole-generation rollback. Permanent old-DSH exceptions were rejected.
- 2026-09-19: `dsh-tui` setup and repair now return `agent-console-dsh-mismatch` before profile, receipt, or activation mutation when the reviewed DSH identity differs from `compatibility/agent-console.json`; the focused operations regression passes and the equivalent headless alpha.5 regression remains green.
- 2026-09-20: The maintainer refined promotion atomicity to independently rollbackable deployment lanes. Headless may advance while the complete workbench generation remains unchanged; shared mutable DSH/profile/runtime/activation state would invalidate that boundary.
- 2026-09-20: The repository-level regression now proves the headless candidate excludes the frozen Agent Console DSH identity and that candidate CI contains no TUI mutation smoke.
- 2026-09-20: Authenticated alpha.2 workspace peers staged successfully after reproducing CI's `npm ci --omit=peer` consumer setup. Runtime-kit typecheck exposed the upstream lifecycle rename from `agent/session-start` to the source-bearing serial `agent/created`; one version-scoped adapter now preserves alpha.5 repeated starts and consumes the alpha.2 event.
- 2026-09-20: dsh-TUI `0.10.2` installed into an isolated alpha.2 profile with peer warnings, but clean composition reported missing patch target `workflow-worker-thread`. Default branch `a97f7bd` still carries that override and excludes alpha.2 peers; closed PR #906 independently documents the later missing code-runtime package. The public handoff is drafted for human submission under the upstream Discussions-first and contributor-allowlist rules.
- 2026-09-20: Runtime-kit focused lifecycle, acceptance, artifact, plugin, finish-line, and workspace-lease regressions passed 214/214; the complete operations suite passed 109/109, including restricted-PATH repair and pre-mutation Agent Console refusal.
- 2026-09-20: Before the lane decision, production typecheck and the policy benchmark passed (2,000 samples, p95 0.50 ms, zero active/live-handle leakage). The compatibility and complete routine suites had one intentional global-promotion failure; that obsolete global gate is now replaced by a lane-exclusion contract and must be rerun.
- 2026-09-20: Canonical compatibility and operations documentation now separates the generic/headless alpha.5/alpha.6 candidate from the frozen rc.1/TUI 0.10.1 workbench generation and records per-lane atomic promotion and rollback.
- 2026-09-20: Revised focused compatibility, Agent Console boundary, and operations tests passed 140/140. The routine gate passed 1,012/1,013 with one conditional skip, production typecheck passed, and the 2,000-sample policy benchmark passed at p95 0.392341 ms with no active or live-handle leakage.
- 2026-09-20: The final local candidate package contains 1,292 entries and is bound by SHA-256 `4ceced4c2318229823010bc20de3a2568a04f7b1d949832b594716c7e1240eae`; hosted application remains gated on lane-isolation read-back.

## Handoff

- Tracking issue <https://github.com/sympoies/dsh-runtime-kit/issues/252> is closed; terminal execution state is synchronized. No closeout or merge action remains.
