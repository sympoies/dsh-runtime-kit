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
| Worker-side bootstrap/checkpoint               | the worker runs `main-agent bootstrap` / `main-agent checkpoint` |
| Lane interrupt/close                           | this bundle's tools; CLI stop verbs refuse dsh lanes |

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

## Known limitations (v1)

- A harness restart ends every lane runtime with it. The sidecar's pinned
  process identity proves the stop, `worker diagnose` classifies it, and the
  run continues through `worker reconcile-stopped` plus reassignment; live
  lane re-adoption after restart is future work.
- Coordination is not an OS security boundary: lane isolation is worktree
  scoping plus in-process tool authority, matching the caveat the managed-CLI
  design carries.
- Turn evidence folds from subagent run boundaries defensively; absent or
  unrecognized payload shapes degrade to no turn evidence, which the CLI
  treats conservatively.
