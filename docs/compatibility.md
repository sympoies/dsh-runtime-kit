# Compatibility

The supported runtime is deliberately exact:

| Surface | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7`, `0.1.0-rc.8`, or `0.1.1-rc.2` |
| Agent Console TUI | `@deepseek-harness-tui/dsh-tui@0.9.0` |
| Cordis | `4.0.1` |
| Node.js | `22.19` or `24` |
| nils-cli | exactly validated `1.27.8` or a later explicitly validated release |

The package does not claim compatibility with DSH release candidates after the
exact promoted `0.1.1-rc.2` release or the eventual stable `0.1.x` line.
Runtime startup requires one homogeneous `0.1.0-rc.7`, `0.1.0-rc.8`, or
`0.1.1-rc.2` public peer set and validates the consumed public exports and
service methods before registering a listener, tool, service, or skill. Mixed
or unknown peer versions fail closed. Incompatibility returns a typed
`DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; plugin activation also requires the native
`tools.bindPrerequisite` method supplied by the authenticated patch and never
partially activates without it.

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
official release source, Linux archive, and the six acceptance binary hashes.
A local nils checkout or ambient prototype binary is not release compatibility
evidence.

[`compatibility/agent-console.json`](../compatibility/agent-console.json) owns
the exact non-headless Agent Console profile: ordered bundles, interaction/TUI
and runtime-kit surfaces, default Sol route, and the sandbox/approval/credential
authority facts a sanitized live observation must prove. It does not broaden
the generic DSH version range or authorize another custom profile.
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
reviewed patch, rebuilds DSH, runs DSH's complete tool-runtime tests and the
packed runtime smoke, reverses the patch, and proves the checkout pristine.
It then rebuilds the pristine host and authenticates the unpatched tools
entrypoint, so source reversal cannot leave a patched ignored `lib/` runtime.
The rc.7 and rc.8 releases are independently pinned and receive the same local
patch apply/reverse and packed-smoke acceptance before their peer range is
advertised. Advancing any selection therefore requires new patch hashes and
evidence; it cannot silently broaden the supported range.

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
