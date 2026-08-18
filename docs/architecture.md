# Architecture

`dsh-runtime-kit` is an out-of-tree DSH bundle. It composes only through public
Cordis and DSH service APIs and never patches or vendors the harness.

Responsibilities are intentionally split:

- DSH owns the agent loop, sessions, tools, sandbox, approvals, skills
  registry, and subagents.
- This bundle owns composition, compact workflow skills, DSH-to-nils policy
  adaptation, reviewer personas, and compatibility diagnostics.
- nils-cli owns deterministic policy evaluation, repository lifecycle
  commands, and machine-readable contracts.

All imports of DSH packages stay at the bundle boundary. The runtime policy
protocol is versioned independently as `agent-hook.dsh-ingress.v1` and accepts
only DSH `tools/pre-execute` with native allow/block semantics today. The
waterfall listener performs asynchronous evaluation, while DSH's monotonic
tool guard requires and consumes an allow marker bound to the exact opaque
execution token. Missing, stale, aborted, or already-consumed markers deny.

Private skill source remains outside this public repository. At process start,
the loader validates the configured owner-controlled tree with bounded
asynchronous traversal and no-follow reads, copies it into a sealed temporary
snapshot, and registers definitions parsed from those retained bytes. Project
skills rank above the snapshot, which ranks above bundled public skills.

Upstream compatibility is executable: pack the bundle, install it into a clean
profile, dump the composed config, boot DSH, discover skills, and execute an
allow/block tool probe.
