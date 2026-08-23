# Main Agent Mode Protocol

This reference defines the DSH-native controller/worker handoff. The selected
skill remains authoritative when it is stricter.

## Durable state ownership

The nils-cli `main-agent` store owns runs, assignments, revision-fenced
checkpoints, idempotency receipts, and acceptance state. The bundle's lane
runtime owns only transport: spawning the lane worker in its worktree,
running the lane's coordination heartbeat, publishing the liveness sidecar the
CLI reads for runtime evidence, and carrying each fenced decision between the
store and the right lane. Neither side substitutes for the other: a lane
without a checkpoint has made no progress, and a checkpoint without a live lane
still holds its durable state.

Every mutation the lane runtime performs is a store call first and a transport
action second. A recorded decision the lane never received is a delivery gap to
retry; it is never re-recorded, because the fence already moved.

The controller initializes through `main_agent_run_initialize`, which owns the
fixed DSH capability and authenticated self-readiness checks before the store
init call. Before it succeeds, ordinary DSH shell calls intentionally do not
inherit a controller capability and are not an initialization fallback. After
success, the exact top-level DSH controller id is bound in memory to the
readiness-authenticated session principal so its later policy, context, shell,
and finish-line subprocesses restore only the session-owned identity fields.

## Controller packet

Each worker receives one private `main-agent.assignment-input.v1` packet
(absolute path, owner-only file mode, stored outside every repository
checkout) carrying:

- objective and explicit non-goals;
- repository, base ref, and owned files or responsibility as a
  non-overlapping path scope;
- `launch.agent` set to `dsh`, the lane's isolated worktree as `launch.cwd`,
  and coordination mode `enforce`;
- relevant requirements and constraints;
- expected output and validation commands;
- instruction to preserve unrelated changes and integrate with concurrent work;
- prohibition on commits, provider mutations, or delivery unless separately
  authorized;
- optional `depends_on` lanes: only an accepted or released dependency
  satisfies an edge, and an unsatisfied dependency refuses the launch with a
  typed result instead of creating anything.

## Worker completion packet

Return:

- outcome: complete or genuinely blocked;
- changed files and observable behavior;
- validation commands with exit results;
- assumptions, residual risks, and any unverified boundary;
- no claim that integration or user acceptance is complete.

## Controller acceptance

The controller inspects every returned diff, resolves overlap, runs final
validation on the integrated tree, performs risk-based review, and checks that
all child sessions have settled. Only the controller reports user-facing
completion.

Acceptance is serialized on the controller: read-only gathering (diffs,
validation suites, review passes) may run across lanes in parallel, but only
the controller decides `request-changes`, `accept`, or `cancel`, and each
decision is revision-fenced against the lane's current state.

The review *decision* is the controller's; the lane runtime owns only its
delivery. `main_agent_worker_request_changes` records the fenced decision and
then places it in the lane's inbox, so a worker never needs raw terminal input
and never learns of a revision request the store did not accept.

## Stop and recovery

Branch on typed store evidence, never on runtime impressions:

- Lane `working` with a live harness: leave it alone; an idle lane resumes on
  its next message.
- Lane `submitted`: run the review loop; findings return to the same lane via
  `request-changes` plus a message, never via a new lane.
- Runtime proven stopped (terminated sidecar, or the harness process
  identity no longer matches): `worker reconcile-stopped` moves a working
  lane to cancelled while preserving its worktree; reassign afterward.
- Ambiguous or missing evidence: `worker diagnose` classifies conservatively;
  never launch a second writer on the same owned files until the first lane
  is known quiescent. Recover useful uncommitted work from the worktree
  rather than discarding it.
- Harness restart: every lane runtime ends with the process, the sidecar's
  pinned process identity proves it, and the durable store carries the run
  forward through reconcile and reassignment.
