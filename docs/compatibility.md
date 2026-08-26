# Compatibility

The supported runtime is deliberately exact:

| Surface | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7`, `0.1.0-rc.8`, or `0.1.1-rc.2` |
| Agent Console TUI | `@deepseek-harness-tui/dsh-tui@0.9.3` |
| Cordis | `4.0.1` |
| Node.js | `22.19` or `24` |
| nils-cli | exactly `1.27.17` |

The package does not claim compatibility with DSH release candidates after the
exact promoted `0.1.1-rc.2` release or the eventual stable `0.1.x` line.
Runtime startup requires one homogeneous `0.1.0-rc.7`, `0.1.0-rc.8`, or
`0.1.1-rc.2` public peer set and validates the consumed public exports and
service methods before registering a listener, tool, service, or skill. Mixed
or unknown peer versions fail closed. Incompatibility returns a typed
`DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; plugin activation also requires the native
`tools.bindPrerequisite` and `llm.guard` methods supplied by the authenticated
patch and never partially activates without them.

## Machine-readable contract

[`compatibility/dsh.json`](../compatibility/dsh.json) is authoritative for the
pinned DSH tag, reviewed `upstream-next` revision, exact `0.1.0-rc.7`,
`0.1.0-rc.8`, and `0.1.1-rc.2` release identities, public package/export
surface, complete pinned workspace closure, artifact bounds, and runtime
performance budgets.

[`compatibility/dsh-patches.json`](../compatibility/dsh-patches.json) is
authoritative for the only downstream DSH patch: its artifact digest, exact
target before/after hashes, and the three reviewed release revisions. The
package does not fork, vendor, or propose this integration upstream. The patch
manager accepts only a pristine or exactly patched checkout and emits a typed
receipt for check, apply, or reverse.

[`compatibility/nils-cli.json`](../compatibility/nils-cli.json) is authoritative
for the minimum and validated nils-cli release, consumed commands and protocols,
official release source, the primary Linux archive and six acceptance binary
hashes, plus the macOS ARM64 archive and runtime-health companion hashes. The
v1.27.17 floor is intentional: managed DSH startup requires the atomic
`agent-session work-context set --if-absent` contract and the durable
finish-line acceptance provider, while dirty-workspace quarantine requires the
bounded `agent-hook workspace-recovery` inspection and handoff contracts. An
earlier release is therefore not runtime-compatible. A
platform may activate native health only when its exact archive, `agent-hook`,
and `agent-docs` digests are recorded. A local nils checkout or ambient
prototype binary is not release compatibility evidence.

The same manifest may carry a separate exact-head candidate validation record.
That record does not change `status`, `validated_release`, release archive
identity, or operator compatibility. It exists only to bind pre-merge
cross-repository integration to one reviewed nils source tree; promotion still
requires merge, release, artifact authentication, and a new released row. The
v1.27.15 promotion removes the completed source-candidate record so normal
runtime and smoke paths authenticate only the released artifacts.

[`compatibility/agent-console.json`](../compatibility/agent-console.json) owns
the exact non-headless Agent Console profile: ordered bundles, interaction/TUI
and runtime-kit surfaces, default Sol route, and the sandbox/approval/credential
authority facts a sanitized live observation must prove. It does not broaden
the generic DSH version range or authorize another custom profile.
The TUI pin includes the exact package specifier, annotated release-tag object,
source revision, npm tarball URL, SRI, and shasum. The promoted 0.9.3 artifact
contains the release's resume-argument forwarding, suggestion-viewport
re-anchoring, macOS Terminal input repair, settings auto-save, and manifest-read
version display; these remain upstream TUI behaviors rather than runtime-kit
patches.
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
The rc.7 and rc.8 releases are independently pinned and receive the same local
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

## Performance budgets

The deterministic policy benchmark runs 250 warmups and two 1,000-check
measured batches. Promotion blocks when adapter p95 exceeds 5 ms, retained heap
for a batch exceeds 8 MiB, retained growth exceeds 2 MiB, or policy operations
or provider handles remain active at teardown.

The packed released-`agent-hook` benchmark performs five warmups and 25 real
sequential subprocess dispatches. Its p95 budget is 250 ms, and teardown must
leave both transport admission and live-child counts at zero.
