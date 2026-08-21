# Compatibility

The supported runtime is deliberately exact:

| Surface | Supported version |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.7` |
| Cordis | `4.0.1` |
| Node.js | `22.19` or `24` |
| nils-cli | `1.27.1` |

The package does not claim compatibility with later DSH release candidates or
the eventual `0.1.x` line. Runtime startup resolves every installed public peer
version and validates the consumed public exports and service methods before
registering a listener, tool, service, or skill. Incompatibility returns a typed
`DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; it never patches DSH sources or partially
activates the plugin.

## Machine-readable contract

[`compatibility/dsh.json`](../compatibility/dsh.json) is authoritative for the
pinned DSH tag, reviewed `upstream-next` revision, public package/export
surface, complete DSH workspace closure, artifact bounds, and runtime
performance budgets.

[`compatibility/nils-cli.json`](../compatibility/nils-cli.json) is authoritative
for the minimum and validated nils-cli release, consumed commands and protocols,
official release source, Linux archive, and the six acceptance binary hashes.
A local nils checkout or ambient prototype binary is not release compatibility
evidence.

## Promotion checks

The compatibility gate reads a clean, already-built upstream checkout. It
verifies exact Git identity, package versions, public entrypoint digests, export
kinds, and the complete selected workspace dependency closure without executing
checkout bytes.

CI keeps separate blocking `pinned` and `upstream-next` matrix rows even when
they currently select the same revision. Advancing `upstream-next` is therefore
a reviewed compatibility decision and does not silently broaden the released
peer range.

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
