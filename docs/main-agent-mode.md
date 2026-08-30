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
| Worker-side bootstrap                          | this bundle's per-lane `main_agent_bootstrap` tool runs the authenticated CLI |
| Worker-side checkpoint                         | this bundle's per-lane `main_agent_checkpoint` tool, which writes the private input and runs the fenced CLI |
| Review decision (what to change, what to accept) | the controller agent and its review skills |
| Review-loop transport (record the decision, deliver it into the lane) | this bundle's tools |
| Child session, workspace composition, resume, interrupt, and descendant drain | DSH's continuable-subagent runtime |
| Workspace mutation lease and managed worker identity | nils-cli `WorkspaceLease` and `main-agent` external launch |
| Lane close and run closeout ordering | this bundle's tools; CLI stop verbs refuse dsh lanes |

## Runtime shape

The module mounts as a child plugin fiber gated on `agents`, `subagents`,
`subprocess`, and `tools`; where the subagent runtime is absent, Main Agent
Mode simply never activates and the rest of the bundle is unaffected.

- **Lane child**: an in-process continuable child on the configured subagent
  provider (default `spawn`), parented directly to the controller. Before DSH
  creates the Agent, this bundle's trusted workspace provider resolves a
  process-private opaque reference to the exact nils-issued worktree. DSH uses
  that result for the child session `cwd`; the existing filesystem and sandbox
  composition then derive their roots from the same session header. No parked
  Agent, model-visible cwd argument, or serializable bearer reference exists.
- **Route inheritance**: absent an explicit reviewed `workerProvider` or
  `workerModel`, the child copies the live controller's provider and model.
  The supported Agent Console composition verifies
  `codex-proxy/gpt-5.6-sol` on both controller and worker; the TUI provider
  picker does not weaken this binding.
- **Authority**: each lane child gets a monotonic deny-only tool guard for
  delegation and lane-management tools (visibility filtering alone is not
  authority), installed through `registerContinuableSetup` for the exact
  host-bound root id and its descendants only. The rc.7 visibility filter separately hides
  only bundle-owned global controller tools because rc.7 rejects unknown names;
  legacy, cross-product, and configured names remain in the monotonic execution
  guard, so a later registration cannot grant them. The bundle's process-wide
  nils policy lane applies on top.
- **Workspace lifecycle**: the workspace provider validates the exact opaque
  object and controller identity synchronously, binds the DSH-reserved child id
  to the lane during prepare, and activates nils `WorkspaceLease` before the
  first prompt is admitted. DSH persists only the provider name and version in
  its descriptor. A cold resume must resolve that descriptor, reproduce the
  exact persisted `cwd`, and acquire a fresh lease reference; unavailable,
  forged, copied, or mismatched bindings fail closed. Ordinary subagents omit
  the host workspace selection and keep their existing parent-cwd inheritance.
- **Worker identity bridge**: the exact `AGENT_SESSION_*` environment from the
  CLI's `main-agent.external-launch.v1` payload is bound in memory to that
  lane's DSH child and descendants. Policy, selective context, and finish-line
  nils subprocesses receive the authenticated worker session id and environment;
  unmanaged DSH sessions retain the scrubbed, ownerless boundary. Policy keeps
  the owner id in its ingress subject and transports the original DSH session
  separately on the private agent-hook subprocess edge, so provider activity
  correlation cannot be replaced by the coordination owner. The public ingress
  schema is unchanged. The bridge is private to this bundle and disappears
  when the lane or plugin closes.
- **Controller identity bridge**: when Agent Console supplies a managed-session
  candidate, the first top-level DSH pre-step authenticates it through the
  producer-owned self-readiness command before policy runs. This gives an
  ordinary single-agent session shell, selective-context, and finish-line
  authority without initializing a Main Agent run. The bridge restores only
  the six session-owned identity, state, capability, checkpoint, and pinned
  activity-helper fields; readiness must match the session id, incarnation,
  and checkpoint, and the helper must resolve to the trusted companion of the
  configured Main Agent CLI. Native run initialization rechecks and reuses the
  same principal before `init`. Portable CLI names are first resolved through
  DSH's host executable seam; the resulting real filesystem identity must
  still match. Unmanaged sessions, foreign subagents, and failed authentication
  attempts create no binding, and plugin teardown removes it.
- **Worker shell guidance**: the lane system prompt still renders the exact
  environment for worker-owned CLI commands not represented by a native tool.
  Because DSH shell calls are separate processes, assignments must prefix the
  same command; a standalone `export` call is explicitly non-persistent.
- **Liveness sidecar**: written atomically on lane transitions with the
  harness process identity (pid plus Linux starttime pin), the lane state,
  and optional turn evidence folded from `subagent/start` / `subagent/end`.
  The nils CLI reads it for `session_status`, durable runtime evidence, and
  diagnose classification.

## Controller tools

- `main_agent_run_initialize({objective_file, idempotency_key})` — runs the
  fixed DSH compatibility and authenticated controller-readiness gates, then
  initializes the durable run from the private objective packet. A failed gate
  creates no run or new identity binding. The exact top-level DSH controller
  principal must match the readiness-authenticated binding already established
  for single-agent policy, so initialization cannot replace it or route
  capability material through tool arguments.
- `main_agent_worker_launch({assignment_file, idempotency_key})` — runs the
  fenced `main-agent worker start --await-ready 0`, validates the
  external-launch payload, starts the broker heartbeat, then asks DSH to create
  the direct child with the private host workspace selection. Workspace prepare
  and lease activation complete before the bootstrap prompt is accepted.
  Idempotent per assignment and key;
  a different launch incarnation for a registered lane is a typed conflict.
- `main_agent_worker_interrupt({assignment_id})` — stops the lane's current
  turn (`keepInbox` semantics); the lane resumes on its next message.
- `main_agent_lane_close({assignment_id})` — terminal lane cleanup after the
  assignment reached a terminal store state: DSH terminally closes the exact
  child and drains its descendants first, then heartbeat stop, best-effort
  broker stop, and sidecar `terminated` publication release the remaining
  transport evidence.
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
  including each lane's child-first DSH close, before it writes the private
  final checkpoint and runs the store `closeout` macro. The controller session
  survives to deliver the final answer.

## Lane tools

- `main_agent_bootstrap({idempotency_key})` — registered only inside a live
  lane child and its descendants. It runs the exact trusted `main-agent
  bootstrap` argv with the lane's authenticated environment and worktree, so
  the first claim acquisition cannot be blocked by an ownerless DSH shell
  process. The initial prompt carries the runtime-issued key and directs the
  worker to this native tool rather than to Bash.

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

## Acceptance evidence

`npm run test:main-agent-e2e` (with `NILS_BIN_DIR` pointing at a nils-cli build)
runs three scenarios against a real store, real worker sessions, real
coordination brokers, real worktrees, and real CLI calls — asserting every
transition from the store rather than from this runtime's return values:

- **two-lane lifecycle** — launch two lanes, bootstrap both, submit lane one
  through its own checkpoint tool, supervise, request changes, resubmit, accept,
  and close the run out.
- **overlapping scope refused** — a third lane declaring a path another lane
  already claims is refused when it tries to acquire that claim at bootstrap.
- **closed lane proven by its released heartbeat** — a plugin-closed lane still
  reads `unknown` while its last beat is fresh, with `reconcile-stopped` refused;
  once that beat lapses it reads `stopped` and reconciles, all under a live
  harness.

The subagent seam is the one substituted part: the host workspace provider and
lane child lifecycle are simulated there, while the packed real-DSH acceptance
covers workspace activation, tool surface, and the provided service. The
promotion gate additionally runs a model-driven lane through bootstrap, edit,
validation, checkpoint, review change, acceptance, and closeout.

The direct-child response contract uses `dsh-runtime-kit.main-agent-lane.v2`;
supervision, review, and closeout use their corresponding v2 schemas. The v2
migration removes `anchor_session_id` because no parked anchor Agent exists.
Consumers that accepted v1 must select by `schema_version` and read the direct
`child_session_id` instead of treating a controller or child as an anchor.

`dsh-runtime-kit.main-agent-lane.v2` uses `disposition` only for launch results:
`launched` means this call created the in-process lane, while `reattached` means
an idempotent launch found the exact existing incarnation. Interrupt and close
results instead carry the neutral `operation` value `interrupt` or `close`, and
read-only service projections carry neither field.

## Known limitations (v1)

- A harness restart ends every resident Agent and lease reference with it.
  Persisted DSH continuation metadata can cold-resume only when the exact
  workspace provider is available, the recorded cwd matches, and lease
  activation succeeds. Otherwise nils classifies the expired external runtime
  deterministically as stopped or blocked and requires the existing reconcile
  path. The sidecar is corroborating transport evidence, never workspace
  identity or resume authority; live lane re-adoption after restart remains
  outside this contract.
- Broker heartbeat death is detected CLI-side, not by this module: a stale
  capability file makes the worker's next authenticated CLI call fail typed,
  and `worker diagnose` classifies the stale broker. The module only owns
  starting the heartbeat with the lane and terminating it at lane close.
- Concurrent lanes are bounded by the `maxLanes` config (default 8, hard cap
  64); a launch beyond capacity refuses with `main-agent-lane-capacity`.
- A lane can authenticate only once its coordination broker is ready. Its own
  heartbeat establishes readiness on the first beat, and the launch tool now
  performs a bounded authenticated status wait before it starts the child or
  reports success. A broker that never becomes usable is rolled back with
  `main-agent-broker-readiness-timeout`.
- Closing a lane is provable while this harness keeps serving its other lanes,
  but not instantly. `main_agent_lane_close` releases the lane's broker
  heartbeat, and the CLI accepts that release as corroboration for the
  `terminated` sidecar — so until the last beat it wrote goes stale, the lane
  still holds coordination authority and reads `unknown`, with
  `worker reconcile-stopped` and record deletion refused. Once the beat lapses
  the lane reads `stopped` and both paths open. The residual is a same-uid one:
  a hostile lane could write `terminated` and kill its own heartbeat to make its
  record deletable while still computing — what it gives up in exchange is every
  authenticated call it could still make.
- Coordination is not an OS security boundary: lane isolation is worktree
  scoping plus in-process tool authority, matching the caveat the managed-CLI
  design carries.
- Turn evidence folds from subagent run boundaries defensively; absent or
  unrecognized payload shapes degrade to no turn evidence, which the CLI
  treats conservatively.
