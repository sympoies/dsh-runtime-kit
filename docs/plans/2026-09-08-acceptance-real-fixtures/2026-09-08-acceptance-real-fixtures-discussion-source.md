# Executable real-provider acceptance fixtures handoff

## Status

- Date: 2026-09-08
- Source: issue #218 and the retained #217 real-provider baseline
- Status: ready for tracked implementation
- Intended next step: execute the linked L2 plan through real-provider acceptance, review, merge, and strict closeout

## Purpose

Make the public `#D` scenario pack sufficient for a fresh Codex or Claude Code
harness to construct every declared success precondition and reversible
deliberate-failure state. The package must own deterministic fixture recipes
and an authenticated executable provider instead of depending on unpublished
operator knowledge.

## Confirmed facts

- The packaged scenario pack accounts for all 33 `#D` catalog rows in twelve
  capability families.
- `acceptance-drive` already requires and authenticates a fixture executable
  for scenario-pack phases, invokes `prepare|induce|recover|cleanup`, and
  validates the complete receipt chain.
- The scripted provider proves the driver and accounting boundary at 66/66.
- The first complete real-provider success sweep reached 3/33. The other rows
  lacked deterministic family-specific workspace, acceptance, lifecycle,
  artifact, protected-root, dispatcher, or host-session state.
- The task bytes in `compatibility/acceptance-scenarios.json` are fixed inputs.
  Fixtures may prepare the named state but must not add diagnostic hints to the
  DSH prompt.

## Decisions

- Ship one machine-readable fixture manifest and one package executable that
  implements the existing provider protocol.
- Bind each invocation to the exact family, scenario, phase, stage, profile,
  workdir, and DSH home supplied by `acceptance-drive`.
- Restrict recipes to an explicit operation vocabulary with bounded paths,
  owned state, exact digests, reversible backups, and append-only receipts.
- Keep capability-family profiles isolated. A provider invocation may mutate
  only its scenario workdir, its family DSH home, and its private fixture-state
  directory.
- Treat preparation, induction, recovery, and cleanup as independently
  attestable transitions. Cleanup must be idempotent and must not erase result
  evidence.
- Keep runtime capability semantics unchanged. A correctly prepared fixture
  that exposes a runtime defect receives a separate owner and does not weaken
  the scenario gate.

## Scope

- Packaged `dsh-runtime-kit.acceptance-fixtures.v1` recipe contract covering
  all twelve capability families and all 33 scenario IDs.
- `dsh-runtime-kit-acceptance-fixture` executable implementing the existing
  fixture-provider request and result schemas.
- Driver/runbook integration so a fresh harness can discover and invoke the
  packaged provider without a machine-local script.
- Focused security, path-containment, rollback, receipt, and full-accounting
  tests.
- Scripted 66/66 proof, complete real-provider 33 + 33 proof, independent
  attestations, PR review, merge, issue closeout, and parent-ledger update.

## Non-scope

- Changing DSH, nils-cli policy, or any capability merely to manufacture a
  passing fixture.
- Relaxing result, diagnosis, recovery, isolation, transcript, executable
  identity, or independent-attestation gates.
- Rewriting catalog task text or treating fixture receipts as proof of the
  scenario's natural-language observable outcome.
- Installing or rebuilding the hosted acceptance runner for a pure trust-root
  repin.

## Requirements

1. The manifest accounts for every scenario exactly once and maps it to one
   family-owned recipe.
2. The provider rejects unknown schema versions, stages, families, scenarios,
   symlink escapes, unsafe ownership/modes, unexpected state, and stale
   recovery tokens before mutation.
3. Every successful transition emits at least one portable digest-bound
   evidence reference and leaves a private local receipt.
4. `induce` changes only the declared reversible fault; `recover` restores the
   exact prior state; `cleanup` is idempotent and removes only provider-owned
   fixture state.
5. Prepared Git repositories and managed worktrees preserve default-branch and
   primary-checkout isolation.
6. The package is built before packing and the committed build provenance
   remains current.
7. A fresh external harness can run the unchanged 33 success and 33
   deliberate-failure tasks through real DSH and reach 66/66 results plus
   independent attestations.

## Acceptance criteria

- A pre-change regression fails because no packaged fixture provider or
  complete fixture manifest exists.
- Manifest validation rejects incomplete coverage, family drift, unsafe
  operations, and non-reversible deliberate-failure recipes.
- Focused provider tests prove success, induction, recovery, cleanup,
  idempotence, path confinement, executable identity, and receipt integrity.
- `npm test`, `npm run typecheck`, `npm run benchmark:policy`, package
  inspection, and the three required local smoke commands pass.
- The real Codex/Claude -> DeepSeek -> DSH matrix reports 33/33 success and
  33/33 deliberate-failure/recovery passes with independent attestations.
- Independent testing, maintainability, and security review converge with no
  open finding before merge.

## Risks and guardrails

- Fixture preparation has a large mutation surface. Keep all writes beneath
  resolved owned roots and fail closed on links, ownership drift, or unknown
  existing bytes.
- Git and profile lifecycle state have separate owners. Use governed CLIs and
  existing runtime-kit operations rather than reproducing their policy.
- Provider tasks can be expensive and flaky. Run serially with unique run IDs,
  retain bounded artifacts, and distinguish provider failure from runtime or
  fixture failure.
- Build output is shipped. Rebuild and refresh provenance after every source,
  bin, or script change before packing.

## Execution

- Recommended plan: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-plan.md`
- Recommended execution state: `docs/plans/2026-09-08-acceptance-real-fixtures/2026-09-08-acceptance-real-fixtures-execution-state.md`
- Profile: tracking
- Plan branch: `fix/issue-218-executable-fixtures`

## Read first

- `AGENTS.md`
- `PROJECT_DEV_EDIT.md`
- `docs/acceptance-harness.md`
- `compatibility/acceptance-scenarios.json`
- `compatibility/acceptance-scenario-pack.json`
- `src/acceptance/drive.ts`
- `src/acceptance/scenario-pack.ts`
- `test/acceptance-drive.test.ts`
- `test/acceptance-scenario-pack.test.ts`
