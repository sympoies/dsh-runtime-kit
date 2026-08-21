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
2. The controller lane tools must be available in this session (they are
   registered only where the subagent runtime exists):
   `main_agent_worker_launch`, `main_agent_worker_interrupt`,
   `main_agent_lane_close`, `main_agent_worker_supervise`,
   `main_agent_worker_request_changes`, `main_agent_worker_accept`, and
   `main_agent_run_closeout`.
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
5. Supervise with `main_agent_worker_supervise` (`assignment_id`). It returns
   the store's own bounded supervision result under `store` — branch only on
   its typed `classification`, `state`, and `recovery_action` — plus a `lane`
   object carrying this runtime's transport facts. Never treat a lane fact as
   store truth: `child_activity` is a session-store snapshot, not a durable
   outcome, and `unknown` means unproven. `main-agent worker
   list|show|wait|diagnose --format json` remain available for the store half
   alone. An idle lane with a live harness is a running lane; cold resume is
   automatic when the lane receives its next message.
6. Review loop: a worker submits via a revision-fenced checkpoint with
   `state:"submitted"`. Independently extract the lane diff, verify scope and
   exclusions, rerun proportionate validation, and run the
   `code-review-specialists` outcome — those decisions stay with this
   controller. Return the outcome with `main_agent_worker_request_changes`
   (`assignment_id`, `if_revision`, `reason`, `idempotency_key`), which records
   the fenced store decision and then delivers it into that lane's inbox. Treat
   `delivered:false` as a delivery gap to retry or report, never as a reason to
   re-record the decision.
7. Interrupt a lane only through `main_agent_worker_interrupt`; the CLI's
   runtime-stop verbs refuse dsh lanes by design. A lane whose runtime is
   proven stopped reconciles with `main-agent worker reconcile-stopped`.
8. Accept each lane with `main_agent_worker_accept` (`assignment_id`,
   `if_revision`, `idempotency_key`), then close its runtime with
   `main_agent_lane_close` (interrupts the child, stops the heartbeat, and
   marks the liveness sidecar terminated so store-side cleanup can proceed).
   The stop becomes provable once that released heartbeat lapses, not the
   instant close returns: a `reconcile-stopped` or record deletion attempted
   inside that window refuses with a coordination-unverified code. Retry after
   the lapse instead of treating the refusal as terminal.
9. Close the run with `main_agent_run_closeout` (`summary`, `next_action`,
   optional `result_summary`, `if_run_revision`, `idempotency_key`): it
   terminates any remaining lane, records the fenced final checkpoint through
   the store closeout macro, and drains this runtime's lane descendants. Then
   report acceptance to the user with the declared validation evidence.

Lane workers record their own progress with the `main_agent_checkpoint` tool,
which exists only inside a lane child's context. Do not instruct a worker to
write the checkpoint file itself; the tool owns that write and the fenced CLI
call.

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
