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

All DSH rc.7 compatibility types and lifecycle names are isolated in
`src/compat/dsh-rc7.js`. It normalizes `agent/session-start`, `agent/pre-step`,
`tools/pre-execute`, `tools/post-execute`, `tools/result`, and
`agent/turn-stopping` into content-free session/cwd/turn/step/call correlation.
It never retains messages, arguments, candidate output, final result bodies, or
subprocess output.

Pre-step proposals are provisional. The adapter records turn/step only after
the downstream rc.7 decision is `enter` and its signal remains live. Tool
boundaries refresh the open position from the public Session events, so durable
`step/end` and `turn/end` override any cached proposal. Initial attachment
reverse-derives only through the recent matching lifecycle suffix. The adapter
then retains an event count and last-event identity: rc.7 immutable snapshots
preserve that anchor across append, allowing only the new suffix to be folded.
An unchanged content-heavy suffix is therefore constant work per boundary. A
missing anchor or shorter history violates the public append-only contract and
makes that attachment sticky-invalid until explicit session restart or a new
Session object reattaches it.

The runtime policy protocol is versioned independently as
`agent-hook.dsh-ingress.v1`. Only `tools/pre-execute` crosses that boundary;
session, turn, step, opaque token, and root-call facts remain process-local. The
policy waterfall records an allow or deny marker bound to the exact opaque
execution object, original opaque token, exact Agent and Session references, deep-frozen argument reference,
parent execution token, and cancellation signal. DSH's monotonic denial-only
guard also rederives the live session identity and
rechecks session/cwd/turn/step/call correlation before consuming that
authorization once: missing, stale, substituted, aborted, denied, or
already-consumed markers deny. Correlation survives guard consumption until
the authoritative frozen `tools/result` observer clears it. A
non-authoritative `tools/post-execute` candidate is never stored; identity
mismatch returns the public rc.7 block decision.

Both authorization and lifecycle correlation use the exact execution object as
their stable cleanup key. The original token has a separate owner index for
lookup and duplicate rejection. If a listener replaces the mutable token
property, the guard denies while `tools/result` still removes the original
marker, correlation, and token-owner entry; another execution object cannot
replay them.

`src/policy/nils-transport.js` owns one bounded operation per child process.
The first observed caller abort, deadline, or plugin disposal classifies the
failure. Admission closes before disposal cancellation. Child `done` is
observed with a rejection handler, while `waitForExit(signal)` and a consumer
race bound teardown even if a provider ignores the signal. Confirmed
quiescence releases capacity. Unknown quiescence permanently degrades admission
closed, cancels every sibling while preserving any earlier first cause, and
returns a bounded fail-closed result. Degradation advances a monotonic admission
epoch; the guard rejects an earlier allow marker even when it was already out
of the transport set and waiting for rc.7 approval. The subprocess receives a
fixed argv vector, explicit bounded stdio, an absolute session cwd, no shell,
no forwarded environment, and no spill or unbounded output path.

`src/context/nils-context.js` owns a separate bounded subprocess lifecycle for
`agent-docs session context`. A tool call derives the exact DSH Session id and
absolute cwd from the live Agent, mints a fresh request id, and asks nils to
resolve, budget-check, fingerprint, and persist one intent atomically. The
transport validates an exact `cli.agent-docs.session.context.v1` envelope and
`decision.context.v1` payload, including request, product, intent, optional
phase, document count, and UTF-8 byte count. It never trusts a previous tool
result as authorization. Nils remains the owner of session/project/product and
catalog-content replay binding; the plugin removes correlation and filesystem
metadata before DSH materializes the canonical tool result.

The tool result itself is the only model-facing context delivery path. Nothing
is attached to the system prompt or session-start event, and the plugin does
not duplicate the same document through `deferContext()`. The public tool
schema allows only `project-dev`, which deterministically selects phase `edit`;
the transport repeats the same allowlist check before spawning `agent-docs`.
Workflow code will prepare review and delivery phases at their own boundaries.
Context cancellation, timeout, and disposal join the complete child process
tree. Unknown quiescence permanently closes this context surface but does not
change the independent monotonic policy-transport state.

The security boundary ends at DSH's monotonic guard. Public `tools/execute`
wrappers run afterward with a `ToolDispatchExecution` whose contract makes only
`signal` mutable. Such in-process plugins are trusted computing base; deliberate
runtime violations of other readonly fields are not contained here. The bundle
therefore narrows its substitution guarantees to pre-execute listeners and
does not depend on brittle property descriptors or non-public APIs.

Private skill source remains outside this public repository. At process start,
the loader validates the configured owner-controlled tree with bounded
asynchronous traversal and no-follow reads, copies it into a sealed temporary
snapshot, and registers definitions parsed from those retained bytes. Project
skills rank above the snapshot, which ranks above bundled public skills.

Upstream compatibility is executable: pack the bundle, install it into a clean
profile, dump the composed config, boot DSH, discover skills, and drive a real
Agent/AgentLoop allow/block probe plus cancellation and plugin-disposal drains.
All `@deepseek-ai/dsh-*` peers used by this rc.7 adapter are pinned exactly to
`0.1.0-rc.7`.
