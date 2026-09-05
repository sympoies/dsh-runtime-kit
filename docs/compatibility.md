# Compatibility

The supported runtime is deliberately exact:

| Surface | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.2`, `0.1.2-alpha.4`, or `0.1.2-rc.1` |
| Agent Console TUI | `@deepseek-harness-tui/dsh-tui@0.10.0-beta.4` |
| Cordis | `4.0.1` or `4.0.2` |
| Node.js | `24` or newer |
| nils-cli | `1.27.37` minimum; exactly validated through `1.27.37` |

The package retains exactly the latest three reviewed DSH releases. A promotion
must add the newest release and remove the oldest release, its patch artifact,
and its CI row in the same change; the validation count therefore remains
bounded while DSH is immature. Runtime startup requires one homogeneous
`0.1.1-rc.2`, `0.1.2-alpha.4`, or `0.1.2-rc.1` public peer set and validates the consumed public exports and
service methods before registering a listener, tool, service, or skill. The
reviewed compositions are exact: rc.2 requires Cordis 4.0.1, while alpha.4
and rc.1 require Cordis 4.0.2. Mixed, cross-composed, or unknown peer versions
fail closed. Incompatibility returns a typed
`DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; plugin activation also requires the native
`tools.bindPrerequisite` and `llm.guard` methods supplied by the authenticated
patch and never partially activates without them.

## Machine-readable contract

[`compatibility/dsh.json`](../compatibility/dsh.json) is authoritative for the
pinned DSH tag, reviewed `upstream-next` revision, exact `0.1.1-rc.2`,
`0.1.2-alpha.4`, and `0.1.2-rc.1` release identities, the enforced three-release support policy, public package/export
surface, complete pinned workspace closure, artifact bounds, and runtime
performance budgets. Each `validated_releases` row also declares its exact
Cordis composition so the public contract and runtime admission stay aligned.

[`compatibility/dsh-patches.json`](../compatibility/dsh-patches.json) is
authoritative for the only logical downstream DSH patch: each reviewed
release's artifact digest, its exact target before/after hashes, and the three
reviewed release revisions. The
package does not fork, vendor, or propose this integration upstream, which the
entry records as an explicit `upstream_reference` state of `not-reported`
rather than leaving to prose. The patch
manager accepts only a pristine or exactly patched checkout and emits a typed
receipt for check, apply, or reverse.

The current `native-execution-boundaries-v5` patch supplies the monotonic
pre-body guard and prerequisite seams retained from earlier revisions, adds a
single terminal policy provider after ordinary persistence and result
materialization, preserves model-order persistence projection, and adds the
dynamic protected-root sandbox contract. It also adds DSH-owned restricted
one-shot roles: immutable host registration, caller-minimal starts, exact-live
classification and receipts, atomic unpublished-child authority mounting,
bounded global/per-role admission, and quiescent teardown. Runtime-kit selects the candidate
data-policy command only through the exact reviewed-source selector; released
and selectorless operation never invokes it. Its release-specific
target hashes bind those seams independently for rc.2, alpha.4, and rc.1; an
unknown or locally drifted checkout remains ineligible.

[`compatibility/dsh-tui-patches.json`](../compatibility/dsh-tui-patches.json)
owns the narrowed installed-package repair for the exact 0.10.0-beta.4 TUI
artifact.
It binds the package manifest bytes, patch digest, and target before/after
hashes. The manager accepts only pristine or exactly patched bytes and emits a
typed check/apply/reverse receipt. The
[upstream history repair](https://github.com/ccch1mneyyy/dsh-TUI/pull/593) is
included in beta.4 and is no longer part of the downstream diff. The remaining
authenticated target only migrates owner-owned legacy history paths to private
modes before reading them; it is separate from #593's async lock repair and has
no upstream counterpart, so the entry's `upstream_reference` state is
`not-reported`. Once a downstream patch does have an upstream issue or pull
request, that link belongs in the same field as the patch's removal signal;
`docs/policies/upstream-contribution.md` owns the states and their rules.

[`compatibility/nils-cli.json`](../compatibility/nils-cli.json) is authoritative
for the minimum and validated nils-cli release, consumed commands and protocols,
official release source, the primary Linux archive and seven acceptance binary
hashes, plus the macOS ARM64 archive and runtime-health companion hashes. The
validated v1.27.37 `review-specialists` requires every delivery finding to
declare `actionable: true` or `actionable: false`; packed review acceptance
proves the former becomes one native line or file thread while the latter stays
in the summary only. The same release preserves `not-in-repository` as an exact
public policy code for existing non-symlink directories with no Git ancestor.
Managed advisory and off-mode finish-line fallback may delegate only that code;
repository access, scope coverage, malformed output, and enforcement failures
remain authoritative. The v1.27.37 floor is intentional: it is the release that
contains every native contract the accepted convergence children require —
the atomic `agent-session work-context set --if-absent` contract, the durable
finish-line acceptance provider, the bounded `agent-hook workspace-recovery`
inspection and handoff contracts, the restricted-role review companions, the
session-owned artifact contracts, and the profile-lifecycle health probes. An
earlier release is therefore not runtime-compatible and fails typed before
activation. The retired surfaces that this floor allowed the package to drop
are recorded in
[`compatibility/retired-surfaces.json`](../compatibility/retired-surfaces.json);
see [Retired surfaces](#retired-surfaces). A
platform may activate native health only when its exact archive, `agent-hook`,
and `agent-docs` digests are recorded. A local nils checkout or ambient
prototype binary is not release compatibility evidence.

The same manifest may carry a separate exact-head candidate validation record.
That record does not change `status`, `validated_release`, release archive
identity, or operator compatibility. It exists only to bind pre-merge
cross-repository integration to one reviewed nils source tree; promotion still
requires merge, release, artifact authentication, and a new released row. The
candidate selector is explicit and scoped to source rehearsal, so normal
runtime and smoke paths continue to authenticate only the released artifacts.
Promotion removes the completed source-candidate record.

[`compatibility/agent-console.json`](../compatibility/agent-console.json) owns
the exact non-headless Agent Console profile: ordered bundles, interaction/TUI
and runtime-kit surfaces, default Sol route, and the sandbox/approval/credential
authority facts a sanitized live observation must prove. It does not broaden
the generic DSH version range or authorize another custom profile.
The TUI pin includes the exact package specifier, source tag and tag-ref type,
source revision, npm tarball URL, SRI, and shasum. The beta.4 release uses a
lightweight tag whose ref points directly at the recorded commit, rather than
the annotated tag object used by the prior 0.9.3 boundary. The prerelease adds
the 0.10 interaction and plugin surfaces, repairs beta.1's startup failure,
and includes #593's asynchronous history persistence; these remain upstream
TUI behaviors rather than runtime-kit patches. The narrowed package repair
recorded in `compatibility/dsh-tui-patches.json` migrates retained, owner-owned
history data to private modes before reading it, refuses unexpected or
symlinked paths, and maps beta.4's legacy read-only session-event view to DSH
alpha.4's public cached snapshot interface. DSH alpha.4 natively provides the
package-inventory plugin, so the former rc.2-only TUI configuration removal is
no longer applied.
Controller and lane tools are separate surfaces: the controller must not expose
`main_agent_checkpoint`, while a managed lane owns that checkpoint tool and is
forbidden from the controller's lane-management tools.

## Promotion checks

The compatibility gate reads a clean, already-built upstream checkout. It
verifies exact Git identity, package versions, public entrypoint digests, export
kinds, and the complete selected workspace dependency closure without executing
checkout bytes.

CI keeps separate blocking `pinned` and `upstream-next` matrix rows. Each row
authenticates and packs the pristine upstream artifact closure, applies the
reviewed patch, rebuilds DSH, runs DSH's complete tool, LLM, and
descriptor-subprocess runtime tests and the packed runtime smoke, reverses the
patch, and proves the checkout pristine.
It then rebuilds the pristine host, starts the unpatched DSH CLI as a process,
and authenticates the unpatched tools
closure by sorted path, mode, length, and bytes, so source reversal cannot leave
patched declarations, maps, extra files, or other ignored `lib/` output.
The retained alpha.4 and rc.2 releases are independently pinned and receive the same local
patch apply/reverse and packed-smoke acceptance before their peer range is
advertised. Advancing any selection therefore requires new patch hashes and
evidence; it cannot silently broaden the supported range.

A separate blocking macOS ARM64 lane authenticates the released nils-cli
archive, exercises the declared Darwin `verified-transient` health provider,
proves that an inherited executable file descriptor supplies the verified bytes
for a private mode-`0500` per-spawn materialization, checks post-spawn
self-resolution through descendant exit, root/current-UID temp-parent ownership
and writable-mode validation, immediate
pre-spawn identity validation, process-tree-bound identity cleanup, and
preserved cleanup failures, the 256 MiB executable
ceiling, and stable source/target identity, runs the
native tools/LLM boundary tests and a packed runtime-health smoke, then
reverses the patch and authenticates the pristine DSH checkout. That
platform-scoped smoke uses DSH's real tools pipeline to prove unauthenticated
companion denial, project-health denial before model or adapter work,
same-session recovery, `runtime_kit_plus_one(41) = 42`, and absence of health
or audit state from model context. It deliberately does not claim
authoritative finish-line acceptance: nils-cli's current finish-line contract
requires Linux systemd/cgroup containment, so the complete packed smoke remains
a blocking Linux gate. Direct fdesc execution,
dyld-as-executable bridging, and directory traversal through
`/dev/fd/<directory-fd>` are deliberately not part of the contract. The lane
also preserves the nonexistent-`argv[0]` regression so an ordinary runtime
snapshot pathname fallback cannot pass unnoticed.

Contributor commands and staging examples are in
[`DEVELOPMENT.md`](../DEVELOPMENT.md#compatibility-validation). The architecture
guide explains the artifact, extraction, runtime boot, and benchmark trust
boundaries in more detail.

## Retired surfaces

[`compatibility/retired-surfaces.json`](../compatibility/retired-surfaces.json)
(`dsh-runtime-kit.retired-surfaces.v1`) is the machine-readable closeout of the
native convergence program. It records the minimum supported runtime-kit
commit, nils-cli release, and DSH releases that carry every native contract,
and one entry per surface the program touched: its category, whether it was
`removed`, `reduced`, or deliberately `retained`, the paths and identifiers
involved, the owner and contract that replace it (`dsh`, `nils-cli`, or a
retained runtime-kit workflow), the first supported versions, the
compatibility window, the rollback path, and, for retained surfaces, the
rationale. `test/retired-surfaces.test.mjs` validates the schema, requires the
recorded minimums to equal the compatibility manifests, scans every shipped
file and normative document for each removed identifier and deleted file, and
refuses retired DSH release names in normative documentation, so a retired
behaviour cannot return as a hidden fallback without failing the suite.

## Performance budgets

The deterministic policy benchmark runs 250 warmups and two 1,000-check
measured batches. Promotion blocks when adapter p95 exceeds 5 ms, retained heap
for a batch exceeds 8 MiB, retained growth exceeds 2 MiB, or policy operations
or provider handles remain active at teardown.

The packed released-`agent-hook` benchmark performs five warmups and 25 real
sequential subprocess dispatches. Its p95 budget is 250 ms, and teardown must
leave both transport admission and live-child counts at zero.

The selected reviewed-source candidate benchmark performs three warmups and
20 full tool lifecycles. Each lifecycle contains exactly five sequential policy
subprocesses; its end-to-end p95 budget is 1,000 ms, and teardown has the same
zero-admission/zero-live-child requirement.
