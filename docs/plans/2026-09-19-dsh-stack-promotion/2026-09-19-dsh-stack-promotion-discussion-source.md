# DSH 0.1.6-alpha.2 Headless-Lane Promotion Implementation Handoff

- Status: accepted for tracked execution
- Date: 2026-09-19
- Source: maintainer discussion prompted by the DSH 0.1.6-alpha.2 release
- Intended next step: execute the sibling plan through one tracking issue

## Purpose

Promote a DSH release atomically within each independently rollbackable
deployment lane. This change advances the headless lane only; the complete
Agent Console/workbench generation remains unchanged until its own DSH, TUI,
runtime-kit, profile, configuration, canary, and rollback evidence can advance
together.

## Confirmed facts

- Runtime-kit retains exactly two reviewed generic DSH releases and fails
  closed on mixed or unknown peer sets.
- Operations checks the DSH release declared by the installed runtime-kit
  artifact before mutating a profile.
- The Agent Console contract currently binds DSH `0.1.2-rc.1` and
  `@deepseek-harness-tui/dsh-tui@0.10.1`.
- Published dsh-tui `0.10.1` and `0.10.2` peer ranges do not admit DSH
  `0.1.6-alpha.2`.
- The deploy dispatcher installs one immutable runtime-kit tarball by exact
  SHA-256, distinguishes canary from primary scope, and does not own DSH,
  dsh-tui, or service-generation activation.
- A runtime-kit candidate can be packed and exercised in canary before it is
  formally released. Production activation must consume the identical,
  governed artifact rather than a rebuild.

## Decisions

1. No permanent compatibility exception will retain an otherwise retired DSH
   release solely for Agent Console.
2. A lane promotion is an all-or-nothing stack tuple covering DSH revision,
   authenticated DSH patch, runtime-kit artifact, Cordis, nils-cli, Node,
   required profile/application packages, and deployment configuration.
3. The selected cohort for this promotion is the native headless profile. The
   Agent Console `dsh-tui` cohort is excluded and frozen on its existing
   complete generation.
4. Candidate validation uses an isolated profile/generation and the same
   immutable runtime-kit artifact intended for production.
5. Headless production activation switches to a newly prepared generation only after
   health, profile inspection, smoke, and rollback rehearsal pass. Failure
   leaves or restores the prior complete generation.
6. The latest-two support window describes reviewed generic runtime-kit
   compatibility. It does not replace the complete prior deployment generation
   as the rollback artifact.
7. Runtime-kit must fail early and explicitly when a `dsh-tui` profile's DSH
   identity differs from the exact Agent Console contract.
8. Third-party TUI work follows the upstream-contribution policy: investigate
   and prepare a de-identified draft locally, but a human submits any issue or
   pull request and signs any required DCO or CLA.
9. Multi-component generation orchestration belongs to the hosted
   infrastructure owner, not to the runtime-kit package dispatcher.
10. Lane independence requires disjoint mutable DSH installations, profile
    homes, runtime roots, and activation targets. If hosted read-back cannot
    prove that boundary, deployment is blocked even though repository delivery
    may finish.

## Scope

- Add DSH `0.1.6-alpha.2` as the newest reviewed runtime-kit candidate and
  retire the oldest generic release in the same final promotion.
- Port and authenticate the version-scoped downstream DSH patch.
- Recompute the selected DSH public export and complete workspace artifact
  closure.
- Add an owner-level regression and typed refusal for an Agent Console DSH
  mismatch before profile mutation.
- Align compatibility manifests, CI rows, package peers, operations fixtures,
  normative documentation, and acceptance guidance with stack promotion.
- Retain the dsh-tui compatibility investigation and third-party draft as
  deferred input for a future workbench promotion.
- Validate the complete headless tuple in an isolated canary using one
  immutable runtime-kit artifact.
- Hand the exact headless tuple and artifact digest to the hosted
  infrastructure owner for generation deployment and observable read-back.

## Non-scope

- Widening dsh-tui peer ranges locally or forcing an unsupported install.
- Changing or redeploying the existing Agent Console/workbench generation.
- Keeping a third generic DSH release as a compatibility bridge.
- Publishing third-party issues or pull requests from an agent identity.
- Implementing a general deployment policy engine in runtime-kit JavaScript.
- Treating local smoke as final hosted promotion.

## Implementation boundaries

- Runtime-kit owns compatibility admission, exact profile contracts, package
  identity, operations receipts, local canary setup, and its documentation.
- dsh-TUI owns public compatibility with DSH `0.1.6-alpha.2` and its released
  package peer metadata and runtime behavior.
- `serenvia/sympoies-infra` owns complete service generations, traffic/service
  switching, production health read-back, and whole-generation rollback.
- DeepSeek Harness owns native agent/session/tool behavior; the downstream
  patch remains version-scoped and hash-authenticated.

## Requirements

- Promotion must fail before mutation when the selected lane is not bound to
  the selected DSH revision, and an excluded lane must remain wholly unchanged.
- The compatibility workflow must keep independent retained, pinned, and
  upstream-next headless rows and omit Agent Console install/mutation smoke
  while that lane is excluded.
- Patch apply and reverse must authenticate pristine source, rebuild typed and
  bundled host output, and restore the exact pristine build closure.
- Candidate and deployment receipts must bind the runtime-kit archive SHA-256,
  extracted package tree digest, DSH revision, patch digest, TUI artifact, and
  companion identities.
- No headless support claim is complete until that profile passes installed
  `doctor`, composition inspection, direct boot/smoke, and rollback rehearsal.
- A failed canary or deployment must preserve the old generation and emit an
  owner-specific, secret-safe stage/code receipt.

## Acceptance criteria

- Deterministic owner tests reject a `dsh-tui` operation when the observed DSH
  identity differs from `compatibility/agent-console.json`, without changing
  the profile, lockfile, activation, or receipts.
- Runtime-kit focused compatibility and patch tests pass for exact DSH
  `0.1.5-alpha.2` and `0.1.6-alpha.2` identities.
- The candidate workflow and peer contract exclude the frozen Agent Console
  generation, while accidental `dsh-tui` mutation is refused before state changes.
- One frozen runtime-kit archive passes build/package identity checks and the
  headless canary path.
- Hosted deployment creates a new headless generation, reports healthy
  post-activation read-back, retains a tested headless rollback, and reads back
  the unchanged workbench identity.
- The repository routine gate and required versioned DSH smoke pass once on the
  frozen final candidate.

## Validation plan

1. Contract owner: focused compatibility, Agent Console, operations, and DSH
   patch tests, including the pre-mutation mismatch regression.
2. Authenticated boundary: apply/reverse the exact patch on pristine DSH
   `ddefc45fbc7f8e46dd73185e68295696d1297887`, rebuild, and run the affected
   DSH suites.
3. Build/package: regenerate provenance, inspect package inventory and bin
   roles, and bind archive plus extracted-tree digests.
4. Runtime: install the immutable artifact into a clean headless canary, then
   run setup, doctor, dump-config, direct smoke, update, and rollback.
5. Hosted promotion: prove lane isolation, consume the same artifact and tuple
   in a new headless generation, require independent health read-back and
   unchanged workbench identity, then switch or retain the old headless generation.

## Risks and guardrails

- dsh-tui may require source changes beyond peer metadata; test actual runtime
  behavior before proposing an upstream release.
- An in-place host upgrade cannot provide atomic rollback across DSH and its
  profiles. Do not compensate with a permanent runtime-kit compatibility
  exception; require generation deployment from the infrastructure owner.
- Any source, manifest, patch, packaged file, or deployment tuple change
  invalidates the affected artifact and outer receipts.
- Keep third-party drafts public-safe and free of local paths, private
  topology, credentials, and internal acceptance evidence.

## Read first

- `docs/development-testing.md`
- `docs/compatibility.md`
- `docs/operations.md`
- `docs/acceptance-harness.md`
- `docs/policies/upstream-contribution.md`
- `compatibility/dsh.json`
- `compatibility/dsh-patches.json`
- `compatibility/agent-console.json`

## Execution

- Recommended plan: docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-plan.md
- Recommended execution state: docs/plans/2026-09-19-dsh-stack-promotion/2026-09-19-dsh-stack-promotion-execution-state.md
- Retention intent: archive with the tracking issue after final deployment and
  closeout; promote the generalized stack-promotion rules into canonical
  compatibility and operations documentation.
