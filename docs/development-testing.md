# Layered runtime-kit development and testing

This is the mandatory validation policy for material changes to
`dsh-runtime-kit`. Use the repository-local `project-runtime-development`
skill to apply it.

The layers prove different boundaries. A repository test cannot prove an
installed package tree; a packed smoke cannot prove an operations-engine
install; model output cannot prove observable state; and local acceptance does
not replace independently controlled hosted promotion. Start at the earliest
layer that can prove the observable delta and advance only after its receipt is
current.

## Validation map

Before implementation, record:

- the observable contract delta and retained invariants;
- the earliest proving layer and its canonical owner;
- the focused command or bounded manual step;
- the expected secret-safe stage/code receipt and permitted side effects;
- exact source, tree, package, catalog, DSH, patch, companion, provider, model,
  effort, harness, and hosted-control identities that matter at later layers;
- which later receipts the change invalidates and which layers the observable
  delta or owning issue actually requires.

Capture a meaningful failing owner test at the earliest testable layer. If a
failure cannot be captured safely or practically, name the substitute
validation before implementation. Each layer emits its own bounded,
secret-safe stage/code receipt; an outer layer must not infer an inner result from a
generic success, model statement, marker, or exit status alone.

Run focused validation while editing. Freeze the candidate before the routine
gate or an external matrix, then run each declared full validation once.
Do not run duplicate full suites concurrently: one process owns one final
receipt, while other work waits or uses a focused target.

## The validation ladder

### 1. Contract and owner tests

Prove schemas, parsers, policy projections, state transitions, error classes,
receipts, negative paths, and documentation wiring with deterministic tests.
Every materially different failure stage needs a stable code and a remediation
that points at its owner. Tests should be portable and must not depend on an
undeclared host binary, credential, provider, DSH checkout, or machine path.

Use the smallest owner suite during iteration, for example one test file or a
test-name pattern. A broad suite is not a substitute for a missing assertion.
The receipt records the command, target, exit status, and the specific contract
proved.

### 2. Adapter and authenticated-boundary tests

Exercise one integration boundary with synthetic envelopes, isolated fixtures,
or an authenticated local seam. Prove request projection, response parsing,
permission modes, cancellation, denial, cleanup, and typed failures without a
real provider where possible.

The authenticated tool identity is part of the contract. A successful call to
an ordinary `subagent` does not prove the restricted `review_specialists`
surface, even if both can produce similar prose. Test the exact caller-facing
tool, role, authority, and permission mode. Fixture permissions must match the
real harness: a read-only or reviewer principal cannot be simulated by merely
asking a write-capable principal not to edit.

Expected induction is evidence only when the fixture returns its registered
typed induction record and leaves the asserted observable state unchanged. It
must not be represented as a failing registered validation; otherwise a finish
line may legitimately repair the fixture and conceal what the scenario meant
to prove. Recovery is a separate phase with its own marker and attestation.

### 3. Build, package, and installed-identity tests

Build the exact candidate and inspect what is shipped. `npm pack` does not build
this package, and the operations engine rejects lifecycle hooks that could build
during installation. Any packaging or installation flow must run the declared
TypeScript build first.

For changes under `src/**`, `bin/**`, or `scripts/**`, regenerate and commit
build provenance. Validate emitted names, the closed package inventory,
dependency pins, executable roles for every `package.json#bin`, and a
reproducible package SHA-256. Do not treat source presence as emitted-runtime
proof.

Also exercise installed-tree identity. The operations engine compares the
declared `installed_sha256` with the extracted artifact tree using
`packageTreeDigest`, which binds relative path, entry kind, executable role,
size, and content while excluding the defined shallow `node_modules` boundary.
A repository check or ordinary packed smoke cannot expose defects that arise
only after extraction or installation. If local tooling cannot reproduce this
boundary, the receipt must explicitly defer it to hosted acceptance.

### 4. Runtime and versioned DSH smoke

With the layer-3 artifact, use a pristine supported DSH checkout and the exact
version-scoped, hash-authenticated patch. Build both typed and bundled host
output after patch apply or reverse; source status alone does not prove which
runtime is executing.

Exercise setup, `doctor`, `--dump-config`, operations installation, rollback
coupling, and the relevant smoke commands. Companion binaries and Node must be
staged from admitted owner-only paths, not mutable convenience paths rejected
by the operations engine. The selected DSH/Cordis row, patch digest, companion
versions, artifact digest, installed digest, and smoke results belong in the
receipt.

When a clean profile needs multiple bundles before its first launch, install
them in one profile transaction unless an intermediate installed state is the
contract under test. Read and assert the declared bundle tuple immediately
after that transaction, before an installed-package repair or configuration
dump can turn a missing reconciliation into a generic downstream failure.

Run only the smoke legs owned by the change while iterating. The complete local
acceptance command may compose those legs after each has an independently
diagnosable result; it must not become the first diagnostic surface.

### 5. Single-scenario real-provider acceptance

Before a full matrix, install the frozen artifact into a clean profile and give
one real task to an external Codex or Claude harness through DSH. Bind the exact
provider surface, subscription identity class, model, effort, DSH revision,
runtime package SHA-256, scenario catalog SHA-256, and harness instructions.
For the current subscription acceptance path, use the reviewed
`gpt-5.6-luna` binding; do not silently replace it with a DeepSeek API or
another billed provider.

Run the scenario's success, deliberate-failure, and recovery phases where the
catalog declares them. The harness receives no human diagnosis hints about why
a phase should fail. It must diagnose from DSH and runtime-kit output alone.
An independent attestation then checks the actual filesystem, Git, provider,
or other observable state. Model output and terminal markers are supporting
evidence, never the sole proof.

A typed provider receipt such as `usage_limit_reached` stops the run. Preserve
the candidate and wait for the declared entitlement reset or obtain separately
authorized credentials; the failure must not switch either provider or model.

### 6. Full external-harness matrix

Run the complete registered catalog only after every changed scenario family
has a current layer-5 receipt at the exact frozen identities. The driver emits
one typed JSONL result per scenario plus a summary, and an independent harness
emits matching attestations for observable state. The matrix proves
composition, ordering, isolation, diagnostic coverage, and recovery; it must
not contain the only assertion for an individual contract.

Do not mutate the candidate after the matrix starts. A source, build,
provenance, packaged-file, executable-role, or catalog change creates a new
identity and invalidates affected outer receipts. A same-digest retry may
preserve an already passed prefix only when package SHA-256, catalog SHA-256,
DSH revision and patch, provider/model/effort, harness contract, and projected
scenario inputs are identical. Retain the old run reference and independently
attested prefix; replace only the failed or incomplete rows under a new run
identifier. If any identity or projection differs, restart the affected
matrix.

### 7. Hosted promotion

Hosted acceptance is the promotion boundary, not another local retry. Start
from the accepted main commit, create the governed signed anchor, reproduce the
package digest twice with the pinned builder, and repin the independent
acceptance control to exact head/tree, delivery head/tree, reviewed anchor,
package digest, pinned file hashes, and PR identity. Run the hosted workflow
against the installed artifact and require all declared jobs.

This layer owns defects visible only after operations installation and guards
the merge race created when individually green PRs land sequentially on an
unprotected main branch. Recheck the actual post-merge main validation and
mergeable state; two pre-merge green receipts do not prove their combined
main. A pure trust-root repin does not require reinstalling the hosted runner;
runner installation is required only when its owning runner script changes.

## Identity and invalidation

Use these minimum rules when deciding whether evidence remains current.
Invalidated and required are different: invalidation forbids reusing a stale
receipt, but it does not make an otherwise out-of-scope outer layer mandatory.
The observable delta and owning issue select required layers; record every
omitted invalidated layer and why it is not required.

| Change | Invalidated evidence |
| --- | --- |
| Contract, parser, adapter, or fixture semantics | Its owner tests and every outer layer that consumes the changed projection. |
| TypeScript source, scripts, bins, dependencies, provenance, executable role, or any packaged file | Build/package identity and layers 3–7. |
| Scenario catalog or harness contract | Affected layer-5/6 rows and hosted controls that pin that file; package layers too when the changed file ships in the tarball. |
| DSH revision, patch, companion, permission mode, provider, model, or effort | The runtime or real-provider layer where it enters and every outer layer. |
| Transient provider availability with all bound identities unchanged | Only the incomplete row; a same-digest retry may reuse an independently attested prefix. |
| Hosted control repin with no runner-script change | Hosted control validation and workflow; no runner reinstall. |

For example, editing this shipped development document changes package bytes,
so an old package digest cannot be reused. A documentation-only delivery still
stops after deterministic owner checks, whitespace/link validation, package
inventory inspection, and the routine gate unless package admission, runtime
behavior, real-provider acceptance, or promotion is explicitly in scope.

`rollback_baseline` is not an independent pin. A control manifest's rollback
digest must equal the candidate's own
`compatibility/nils-cli.json#rollback_validation.runtime_package_sha256`.

## Failure and replan rule

One failure is evidence, not permission for blind repetition. Read the typed
stage/code receipt and observable-state attestation. If they identify a layer,
repair that owner and rerun its focused regression. Stop and replan before
another broad run when:

- a generic failure cannot distinguish materially different stages;
- the same layer fails again without producing new evidence;
- a higher layer is being changed to compensate for an unproved lower layer;
- exact identities, target, authority, or cleanup state are unknown;
- progress depends on sleeps, blind retries, human diagnosis hints, or a
  write-capable fixture standing in for a restricted principal;
- another full suite or matrix already owns the same mutable resources;
- the missing primitive belongs to another repository.

An acceptance owner is not ready for unattended use when it emits only one
generic failure for multiple stages. Add a bounded, secret-safe stage/code
receipt and a focused owner regression before restoring the outer matrix.

## Owner routing

| Observed gap | Canonical owner | Required response |
| --- | --- | --- |
| Test-first evidence, agent-docs, worktrees, semantic commit, forge delivery, or reusable deterministic CLI policy | `sympoies/nils-cli` | Repair or release the shared CLI contract; do not add a JavaScript policy clone here. |
| Runtime composition, admission, operations, installed identity, receipts, scenario driver, fixtures, or this package's docs | `sympoies/dsh-runtime-kit` | Add the focused regression and repair this repository. |
| Public application/profile semantics or reusable application acceptance | `sympoies/dsh-applications` | Repair and release the public owner, then repin the consumer. |
| Independently released DSH plugin behavior | `sympoies/dsh-plugins` | Repair and release the plugin owner, then update compatibility evidence. |
| Agent loop, session, native tool dispatch, permission enforcement, provider bridge, subagent behavior, approval, or cancellation | DSH | Track or repair the exact supported runtime boundary; do not build a second loop here. |
| Hosted trust root, builder, runner, installer, control manifest, credential delivery, or promotion workflow | `serenvia/sympoies-infra` | Repair the private owner and prove it with its own validation before repinning. |
| External subscription entitlement or provider outage | Provider/account owner | Retain the typed receipt and exact candidate; wait or obtain separately authorized access without changing acceptance identity. |

Before proposing an external-repository change, follow
[`docs/policies/upstream-contribution.md`](policies/upstream-contribution.md).
An upstream issue is not a substitute when the active task already authorizes
a local owner fix, and this policy does not grant issue-write or provider-write
authority.

## Receipt requirements

Each layer records only what reviewers need:

- layer, owner, focused assertion, command or bounded step;
- exact relevant source, artifact, catalog, runtime, patch, provider/model, and
  hosted-control identities;
- pass/fail with stable stage and code;
- side effects attempted or observed, cleanup, and residual gap;
- which evidence was invalidated and the next permitted layer or owner repair.

Do not retain prompts, raw model responses, credentials, auth state, session
tokens, private identifiers, machine-local paths, or private topology in the
repository, issues, commits, or public logs.

## Self-improvement loop

Treat recurring development friction as product evidence:

1. Preserve the first bounded failure and independent observable-state result.
2. Identify the earliest layer that should have caught it and the canonical
   owner of the missing assertion, diagnostic, fixture, or primitive.
3. Add a focused failing regression or record why a safe failure is not
   practical.
4. Repair the owner within the active authority; otherwise prepare the minimal
   handoff and stop at the boundary requiring new authority.
5. Rerun only the focused layer until it passes, then resume at the first
   invalidated outer layer.
6. Update this policy or the project skill only when the lesson generalizes to
   future runtime-kit work. Keep incident-specific identities and chronology
   in the owning issue and public-safe devlog.
7. Record the new diagnostic or validation decision in the final evidence so a
   future agent starts with the strengthened layer instead of rediscovering it.

The loop improves tests and diagnostics, not authority. It never authorizes an
automatic issue, deployment, provider mutation, credential change, model
substitution, or cross-repository write.

## Repository finish line

During implementation, run focused commands from the validation map. Once the
candidate is stable, run the declared routine gate once:

```sh
npm test
npm run typecheck
npm run benchmark:policy
```

Add build, package, smoke, real-provider, matrix, or hosted layers only when
the change invalidates them or the owning issue explicitly requires them.
State every intentionally omitted layer and why its existing receipt remains
current. Never present local source rehearsal as installed-artifact promotion.
