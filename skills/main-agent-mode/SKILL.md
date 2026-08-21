---
name: main-agent-mode
description: >
  Run an explicit opt-in DSH delivery workflow where one controller owns user
  acceptance while managed worker lanes implement isolated assignments through
  the nils-cli orchestration store and the bundle's lane runtime.
---

# Main Agent Mode

## Activation contract

- Activate only when the user explicitly requests Main Agent Mode for the
  current bounded workflow. Generic parallelism requests never activate it,
  and activation does not persist into later requests.
- The controller retains the user conversation, requirements, integration,
  validation, review synthesis, and final acceptance. Workers never create
  delivery authority.
- Deterministic run, assignment, checkpoint, and acceptance state lives in
  the nils-cli `main-agent` store; this runtime only executes lane transport.

## Readiness gates (fail closed)

Run all three before creating any durable state; stop and report the bounded
limitation when any gate fails:

1. `main-agent capabilities --provider dsh --format json` must return
   `main-agent.capabilities.v1` with `compatible:true` and
   `capabilities.external_runtime` exactly `main-agent.external-runtime.v1`.
2. The `main_agent_worker_launch`, `main_agent_worker_interrupt`, and
   `main_agent_lane_close` tools must be available in this session (they are
   registered only where the subagent runtime exists).
3. `main-agent self readiness --format json` must return `data.ready:true`.

## Workflow

1. Confirm scope, acceptance criteria, repository, base ref, and whether the
   work splits into non-overlapping lanes. Keep integration-sensitive work
   with the controller.
2. Create the durable run: write a private `main-agent.objective-packet.v1`
   JSON file (owner-only mode, outside every repository checkout) and run
   `main-agent init --packet-file <path> --if-absent --idempotency-key <key>
   --format json`.
3. Prepare one isolated worktree per mutating lane with `git-cli worktree
   add`, then write one private `main-agent.assignment-input.v1` packet per
   lane with `launch.agent` set to `dsh`, a non-overlapping path scope,
   validation duties, and the worktree as `launch.cwd`.
4. Launch each lane with the `main_agent_worker_launch` tool
   (`assignment_file`, `idempotency_key`). The tool performs the fenced
   `worker start` bookkeeping, spawns the lane worker in its own worktree,
   starts the lane's coordination heartbeat, and publishes its liveness
   sidecar. It is idempotent per assignment and key; a lane incarnation
   conflict is a typed error, never a second worker.
5. Supervise through the store, never through runtime impressions:
   `main-agent worker list|show|wait|diagnose|supervise --format json`.
   Branch only on typed `state`, `classification`, and `recovery_action`
   fields. An idle lane with a live harness is a running lane; cold resume is
   automatic when the lane receives its next message.
6. Review loop: a worker submits via a revision-fenced checkpoint with
   `state:"submitted"`. Independently extract the lane diff, verify scope and
   exclusions, rerun proportionate validation, and run the
   `code-review-specialists` outcome. Return findings to the same lane with
   `main-agent worker request-changes` plus `main-agent worker message
   --body-file`; only the acceptance decision is serialized on the
   controller.
7. Interrupt a lane only through `main_agent_worker_interrupt`; the CLI's
   runtime-stop verbs refuse dsh lanes by design. A lane whose runtime is
   proven stopped reconciles with `main-agent worker reconcile-stopped`.
8. Accept each lane (`main-agent worker accept`), then close its runtime with
   `main_agent_lane_close` (interrupts the child, stops the heartbeat, and
   marks the liveness sidecar terminated so store-side cleanup can proceed).
9. Close the run with `main-agent closeout --if-run-revision <n>
   --checkpoint-file <private-json> --idempotency-key <key> --format json`
   and report acceptance to the user with the declared validation evidence.

## Recovery and limitations

- Worker checkpoints are the only progress proof; heartbeats, diffs in the
  worktree, and runtime liveness never substitute for a typed checkpoint.
- If this harness process restarts, lane runtimes end with it: the liveness
  sidecar's pinned process identity proves the stop, `worker diagnose`
  classifies it, and the lane continues through `reconcile-stopped` plus a
  fresh assignment or reassignment. Durable run state is never lost.
- If native subagents or the orchestration tools are unavailable, keep the
  work with the controller and report that bounded limitation.

Detailed packet contents, ownership rules, dependency ordering, the
acceptance loop, and the stop-and-recovery matrix live in
`references/MAIN_AGENT_MODE_PROTOCOL.md`.
