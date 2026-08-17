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
only DSH `tools/pre-execute` with native allow/block semantics today.

Upstream compatibility is executable: pack the bundle, install it into a clean
profile, dump the composed config, boot DSH, discover skills, and execute an
allow/block tool probe.
