# Main Agent Mode on DSH

Main Agent Mode is an explicit opt-in delivery workflow: one controller
session owns the user conversation and acceptance while managed worker lanes
implement isolated assignments. On DSH the durable orchestration state stays
in the nils-cli `main-agent` store, and this bundle owns only the lane
transport that the store cannot: spawning workers, delivering their bootstrap
prompt, running per-lane coordination heartbeats, and publishing runtime
liveness evidence.

Tracking: sympoies/dsh-runtime-kit#6. The nils-cli side of the contract is
`main-agent-dsh-external-runtime-v1.md` in the nils-cli `agent-session` crate
(sympoies/nils-cli#1467).

## Division of responsibility

| Concern                                        | Owner                                        |
| ---------------------------------------------- | -------------------------------------------- |
| Runs, assignments, fenced checkpoints, receipts | nils-cli `main-agent` store                  |
| Worker session records, capability/checkpoint files | `main-agent worker start` (dsh arm)      |
| Spawning the lane child, prompt delivery       | this bundle (`src/main-agent/`)              |
| Per-lane broker heartbeat process              | this bundle (spawns `agent-session broker heartbeat`) |
| Liveness/turn evidence sidecar                 | this bundle (schema `main-agent.dsh-runtime-liveness.v1`) |
| Worker-side bootstrap                          | the worker runs `main-agent bootstrap`       |
| Worker-side checkpoint                         | this bundle's per-lane `main_agent_checkpoint` tool, which writes the private input and runs the fenced CLI |
| Review decision (what to change, what to accept) | the controller agent and its review skills |
| Review-loop transport (record the decision, deliver it into the lane) | this bundle's tools |
| Lane interrupt/close, run closeout, descendant drain | this bundle's tools; CLI stop verbs refuse dsh lanes |

## Runtime shape

The module mounts as a child plugin fiber gated on `agents`, `subagents`,
`subprocess`, and `tools`; where the subagent runtime is absent, Main Agent
Mode simply never activates and the rest of the bundle is unaffected.

- **Lane child**: an in-process continuable child on the configured subagent
  provider (default `spawn`), parented to a per-lane anchor agent whose
  session header carries the lane worktree as `cwd`. The worker's shell
  workdir and sandbox root both derive from that header. Anchors never run
  model turns: an `agent/pre-step` listener parks them.
- **Authority**: each lane child gets a monotonic deny-only tool guard for
  delegation and lane-management tools (visibility filtering alone is not
  authority), installed through `registerContinuableSetup` for children of
  this registry's anchors only. The bundle's process-wide nils policy lane
  applies on top.
- **Worker environment**: the lane child receives a per-child system-prompt
  section naming the exact `AGENT_SESSION_*` environment for its `main-agent`
  and `agent-session` commands; the values come from the CLI's
  `main-agent.external-launch.v1` payload, never from guesswork.
- **Liveness sidecar**: written atomically on lane transitions with the
  harness process identity (pid plus Linux starttime pin), the lane state,
  and optional turn evidence folded from `subagent/start` / `subagent/end`.
  The nils CLI reads it for `session_status`, durable runtime evidence, and
  diagnose classification.

## Controller tools

- `main_agent_worker_launch({assignment_file, idempotency_key})` — runs the
  fenced `main-agent worker start --await-ready 0`, validates the
  external-launch payload, spawns the anchor and lane child, starts the
  broker heartbeat, publishes the sidecar. Idempotent per assignment and key;
  a different launch incarnation for a registered lane is a typed conflict.
- `main_agent_worker_interrupt({assignment_id})` — stops the lane's current
  turn (`keepInbox` semantics); the lane resumes on its next message.
- `main_agent_lane_close({assignment_id})` — terminal lane cleanup after the
  assignment reached a terminal store state: interrupt, heartbeat stop,
  best-effort broker stop, sidecar marked `terminated`.
- `main_agent_worker_supervise({assignment_id})` — runs the store-side
  `worker supervise` macro and folds this runtime's lane facts onto it. The
  store's classification and next action pass through untouched; lane facts
  (child activity from `listChildren`, turn phase, lane state) live in a
  separate `lane` object, so transport observation can never be mistaken for
  durable store truth. A listing failure degrades to `child_activity:
  "unknown"` rather than failing supervision.
- `main_agent_worker_request_changes({assignment_id, if_revision, reason,
  idempotency_key})` — records the fenced store decision **first**, then
  delivers it into that lane's inbox through `followup()`. A delivery failure
  is reported (`delivered: false` plus `delivery_error`) and never unwinds the
  durable decision; the worker can still read it through its own rehydrate
  path. No raw terminal input is involved.
- `main_agent_worker_accept({assignment_id, if_revision, idempotency_key})` —
  records the fenced acceptance. The lane stays live so its worktree and inbox
  remain inspectable; closing it is a separate explicit step.
- `main_agent_run_closeout({summary, next_action, result_summary?,
  if_run_revision, idempotency_key})` — terminates every remaining lane,
  writes the private final checkpoint, runs the store `closeout` macro, then
  `drainContinuableDescendants()` on the lane anchors and disposes them. The
  controller session survives to deliver the final answer.

## Lane tool

- `main_agent_checkpoint({summary, next_action, state?, result_summary?,
  blocker_summary?, if_revision, idempotency_key})` — registered **inside each
  lane child's own context**, never globally, so a lane can only ever
  checkpoint its own assignment: there is no argument through which it could
  name another. It writes the `main-agent.checkpoint-input.v1` document to the
  path the launch payload declared (owner-only, atomic rename, verified real
  directory) and runs the fenced `main-agent checkpoint` with the lane's own
  environment and worktree.

  This replaces the worker writing that file itself — a file tool in one
  composition, a shell `printf` in another — and with it the checkpoint-file
  admission hook that existed to keep those writes honest. A lane whose payload
  names no checkpoint path inside its own coordination directory gets no
  checkpoint tool at all rather than one pointed somewhere unproven.

## Service

`ctx.provide('mainAgentOrchestration', …)` exposes a versioned, **read-only**
view: `apiVersion`, `laneCount`, `maxLanes`, `cliDegraded`, `lanes()`,
`lane(assignmentId)`, and the tool names this runtime owns. Every mutation is a
tool, so each one carries a model-visible call, an argument record, and the
store's fenced receipt; a service method that mutated the run would be an
unlogged second write path onto the same durable state. The pre-service name
`dshRuntimeKitMainAgent` stays bound to the same object.

## Known limitations (v1)

- A harness restart ends every lane runtime with it. The sidecar's pinned
  process identity proves the stop, `worker diagnose` classifies it, and the
  run continues through `worker reconcile-stopped` plus reassignment; live
  lane re-adoption after restart is future work.
- Broker heartbeat death is detected CLI-side, not by this module: a stale
  capability file makes the worker's next authenticated CLI call fail typed,
  and `worker diagnose` classifies the stale broker. The module only owns
  starting the heartbeat with the lane and terminating it at lane close.
- Concurrent lanes are bounded by the `maxLanes` config (default 8, hard cap
  64); a launch beyond capacity refuses with `main-agent-lane-capacity`.
- Coordination is not an OS security boundary: lane isolation is worktree
  scoping plus in-process tool authority, matching the caveat the managed-CLI
  design carries.
- Turn evidence folds from subagent run boundaries defensively; absent or
  unrecognized payload shapes degrade to no turn evidence, which the CLI
  treats conservatively.
