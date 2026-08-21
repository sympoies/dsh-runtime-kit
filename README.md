# dsh-runtime-kit

`@sympoies/dsh-runtime-kit` is the public, out-of-tree DeepSeek Harness runtime
layer. DSH uses dsh-runtime-kit plus nils-cli; Codex and Claude Code continue to
use agent-runtime-kit plus nils-cli. It is a DSH bundle, not a fork and not a
copied preset.

Notable implementation milestones and their validation evidence are recorded
in the [development log](docs/devlog/README.md).

The current implementation contributes one Cordis plugin, the 29 public
workflow skills, optional private-skill loading, one selective
`runtime_context({ intent })` tool, and the native DSH probe tool
`runtime_kit_plus_one`. It also exposes one DSH-native
`review_specialists({ task, roles })` tool backed by eight fixed, server-owned
read-only reviewer personas. Its rc.7 adapter correlates the public session-start,
pre-step, pre-tool, post-tool, result, and turn-stop lifecycle boundaries while
forwarding pre-tool plus pre-step/turn-stop policy and the versioned finish-line
open, begin, run, and stop boundaries to `agent-hook`. Policy and durable validation state are
evaluated by the shared Rust engine rather than repeated in prompts or
reimplemented in JavaScript.

The parent bundle requires only the rc.7 services used by policy, skills,
context, finish-line, and operations. Main Agent Mode and specialist review are
separate child plugins: each activates only when the native `subagents` service
is present, and either child may remain pending without withholding the parent
policy or skill surface.

The completed migration projection is recorded in
`policy/runtime-rule-parity.yaml`. It maps 101 source rules, including 69
handler-capability registrations across 22 handler IDs, to implemented nils
capability groups, stronger DSH-native boundaries, or the single
provider-obsolete Claude coauthor rule. The narrower legacy provider subset is
67 registrations across 21 handlers because two SessionStart memory rows were
later typed additions.
`npm run verify:policy-source -- /path/to/agent-runtime-kit
/path/to/nils-cli` compares the checked-in digests, all row projections, the
legacy registration snapshot, and the 23 nils-owned capability group IDs.

The separately frozen public source inventory is `policy/rule-parity.yaml`. It binds the
101 source registration IDs, 21 legacy handlers, and one relocated memory
capability to their DSH/nils replacement or evidence-backed retirement. During
migration, verify it against the retained legacy source with:

```sh
node scripts/check-rule-parity-source.mjs \
  /path/to/agent-runtime-kit/manifests/hook-rules.yaml \
  --owner-root dsh-runtime-kit=. \
  --owner-root nils-cli=/path/to/nils-cli
```

The source digest is defined over UTF-8 with CRLF materialization normalized
to LF; lone carriage returns are rejected. Every test owner is an exact
repository-qualified record. Planned capabilities may name only `planned`
owners, while implemented, in-progress, and retired capabilities require
`active` owners. The command resolves every active owner as a regular file in
the explicitly supplied repository roots. Each root must be the exact Git
top-level with the frozen `origin` identity and evidence commit in its history;
the active path must be tracked, clean, and have the same blob at `HEAD` as at
that evidence commit. Replacement objects and `skip-worktree` or
`assume-unchanged` index flags are forbidden; the actual unfiltered working-file
blob must also equal the authenticated Git blob. A synthetic directory,
relabelled repository, or hidden working-file substitution therefore cannot
impersonate cross-repository test evidence.
For the one recorded PR #5 squash merge, the verifier preserves the frozen
pre-squash evidence commit and additionally requires the trusted merge commit
to be an ancestor; every active evidence, merge, `HEAD`, index, and working-tree
blob must still be identical.

## Current contract

- Installs with `dsh plugin --profile <name> add <package>`.
- Ships a `dsh-runtime-kit` operations CLI whose mutations are dry-run by
  default and delegate package changes to that native DSH command. Reviewed
  applies require the exact plan digest; update, rollback, interruption repair,
  and remove retain only runtime-kit-owned receipts under `DSH_HOME`.
- Contributes configuration through `cordis.patch.yml`.
- Registers tools through the host-provided DSH `tools` service.
- Registers the packaged `skills/` catalog through DSH's public filesystem
  skill-provider API.
- Loads an optional absolute, owner-controlled private skill directory from
  `DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR`; no private names or contents are
  packaged.
- Preserves DSH precedence: project skills override configured private skills,
  which override bundled public skills.
- Registers exactly eight reviewer roles behind one schema-stable
  `review_specialists` tool. The caller supplies only a bounded task and fixed
  role IDs; persona text, child creation, runtime-global concurrency, result
  ordering, cancellation, cleanup, structured output, and second-wave
  red-team context are runtime-owned. Results contain summaries plus one
  deterministic `findings_jsonl` artifact accepted by nils
  `review-specialists validate`; model-authored prose is never the finding
  contract.
- Creates every reviewer through rc.7's native in-process `spawn` provider in
  a fresh child context. Quick review runs alone; focused and specialist roles
  may run in parallel under one semaphore shared by every concurrent tool
  call. A preselected red-team must accompany a first wave; the runtime also
  adds it automatically for a structured critical finding, always after
  bounded first-wave evidence is collected.
- Authenticates reviewer authority by the exact live child `Agent` published
  synchronously during the trusted spawn call, not by a session event, role
  string, prompt, or caller claim. The child receives a final read-only sandbox
  override and an agent-scoped monotonic tool guard. Local inspection is limited
  to `read`, single-file `grep`, and `glob` under the canonical session
  workspace; symlink escapes and credential-bearing paths are denied, and image
  reads, runtime context, skills, Bash, filesystem mutation, code mode, nested
  calls, delegation, and unknown tools are denied before their body executes. Exact
  reviewers bypass ordinary edit/finish-line lifecycle evaluation only because
  that stricter guard owns their entire tool surface; ordinary and forged
  sessions continue through the full nils policy path.
- Publishes `dshRuntimeKit.childPluginStatus` as a read-only snapshot for the
  optional reviewer and Main Agent Mode children. Each entry is `pending`,
  `active`, or a bounded `failed` record; activation failures remain logged but
  are no longer indistinguishable from an intentionally pending child.
- Validates private skills as an owner-controlled POSIX tree, then detaches all
  instructions and resources into a sealed process-local snapshot before
  registration. Changes take effect on the next DSH process; there is no live
  watching or lazy reopening of the private source tree.
- Invokes `agent-hook` through the host-provided DSH `subprocess` service and
  fails closed on missing, malformed, truncated, signaled, or mismatched policy
  output.
- Loads no policy corpus at session start. The model explicitly calls
  `runtime_context({ intent })`; the plugin invokes one atomic
  `agent-docs session context` command and returns only the satisfied required
  documents for that DSH session, project, product, intent, and content
  fingerprint.
- Allows only `project-dev` on the model-facing tool and always maps it to the
  bounded `edit` phase. Unknown, review, and delivery intents are rejected
  before `agent-docs` starts. Review and delivery phases remain workflow-owned
  so the ordinary edit path cannot load the full legacy delivery corpus.
- Accepts at most 20 KiB of document content by default (64 KiB hard cap),
  validates the exact response and byte count, strips request/session/path
  metadata from the model-facing result, and rejects cross-request replay.
  Repeating the explicit tool call re-resolves current documents and returns
  `already-current`; this supports recovery after model-context compaction
  without weakening nils session verification.
- Retains only content-free session/cwd/turn/step/call correlation. Prompt
  messages, raw arguments, subprocess output, and tool result bodies are never
  stored in lifecycle state. The strict `agent-hook.dsh-ingress.v2` wire binds
  the exact session/turn/step plus configured absolute agent-docs roots to each
  pre-tool request. V4 binds the matching post-tool identity and projects only
  the canonical `is_error` fact; candidate values, content, and errors never
  cross the nils boundary. V3 binds downstream-accepted pre-step and turn-stop
  requests, carries at most 64 KiB of user-authored prompt text, and includes a known
  session-start source only on the first accepted pre-step. Its closed values
  are the rc.7 `startup`, `resume`, `clear`, and `compact` sources plus the
  adapter-derived `observed` value for late or hot-reloaded attachment. V1
  remains a nils compatibility input but is not emitted by this bundle.
- Loads the packaged `policy/dsh-runtime-kit-v1.toml` Task 3.2 through 3.4 rule set
  during acceptance. Its first eleven `dsh.policy.v1` capabilities implement ownership,
  semantic-conflict, scope-lock, checkout-lease, project-dev edit admission,
  Git/worktree/PR/default-delivery, direct-Python, and semantic-commit-body
  gates inside nils without executing retired Python handlers. Default-branch
  identity is pinned in private nils state before Bash or native mutation;
  metadata drift, ambiguous semantic options, state-changing shell sequences,
  non-literal push/fetch refspecs, and stdin-driven Git ref updates fail closed
  while exact recovery and governed nils delivery routes remain available.
  Nine Task 3.3 capabilities block unsafe MCP/project-memory/machine-path
  writes and emit bounded, generic label, memory-principle, session-health,
  skill, startup-memory, and pre-PR context without echoing secret-bearing
  inputs or bundling private memory. Nils resolves quote-concatenated and
  destination-directory shell targets, treats unknown writers on protected
  operands as indeterminate, scans MCP documents and edit fragments for
  structural credentials, and emits recalled memory only as one escaped JSON
  string. Task 3.4 emits metadata-only activity and maps native Bash/write/edit/
  `str_replace_editor` calls to one exact `agent-session` operation lease.
  Managed mutations admit before the tool, complete from the v4 terminal fact,
  reauthenticate idempotent terminal retries, and let Stop rely only on
  capability-authenticated broker counts; fully unmanaged sessions are
  explicitly no-op, while any partial selector set fails closed. Private retry
  state is content-free, mode-checked, capacity-bounded, and compacted by a
  durable monotonic terminal sequence.
  The 101-row runtime migration projection now has no planned active group:
  every row resolves to one of 25 implemented groups or the single
  provider-obsolete retirement. The frozen public source inventory remains a
  separate compatibility contract. The production policy and package tree
  contain no retired handler rule or executable.
- Binds both allow and deny policy evaluations to DSH's opaque execution token,
  exact Agent, Session, and deep-frozen argument object, and live lifecycle
  correlation. Parent execution token and cancellation signal references are
  bound too. Authorization and correlation are keyed by the exact execution
  object, while the original opaque token is checked independently, so token
  replacement cannot leak or replay a marker. The host's denial-only guard
  consumes the exact authorization once, so a prepended pre-execute listener
  cannot skip policy, a later pre-execute listener cannot substitute an
  unevaluated payload, and an outer pre-execute waterfall cannot reverse an
  authoritative nils denial.
- Treats `tools/post-execute` as the operation-completion boundary while
  `tools/result` remains the authoritative model-facing outcome. Before the
  downstream post waterfall, v4 sends nils only the correlated error bit. A
  stale, mismatched, or unreconciled identity blocks through the public rc.7
  `PostToolDecision` contract; no candidate body is forwarded.
  A nils tool reminder is attached exactly once through the accepted result's
  native `additionalContexts`; it never alters admission identity.
- Delivers session health, skill, and startup-memory context only after an
  accepted rc.7 `agent/pre-step`, with constant-space per-session deduplication.
  A downstream rejection does not transmit the proposal or prompt to nils.
  Concurrent proposals for the same position share one provisional decision;
  a contender retries evaluation if the owner does not enter, so no accepted
  step can bypass the lifecycle context through an in-flight marker.
  After finish-line allows a turn to stop, a pre-PR context decision uses
  `agent.steer()` once for that turn; finish-line denial always wins first.
- Awaits `agent-hook finish-line begin` before delegating a correlated edit.
  The edit body remains DSH-native, while nils durably advances the generation
  without receiving file payload, tool output, or a post-hoc outcome.
- Routes every foreground `bash` call through a nils-owned runner capability
  and a non-executing exact-command probe. Exact validation targets return
  `ready`; every ordinary foreground command returns `ordinary-ready`.
  `run_in_background` is unsupported and fails closed before execution, while
  legacy `not-applicable` responses also fail closed.
- After either ready status, persists the DSH session and prepares the bounded
  public DSH shell runtime: exact command and repository cwd, timeout and output
  limits, environment overrides, and the resolved sandbox runner. Any sandbox
  escalation remains DSH execution authorization. Nils is the only executor
  and returns the normalized foreground result; DSH neither delegates to the
  underlying Bash body nor reports an inferred outcome afterward.
- Accepts a nils-observed execution only when exactly one of `exitCode` and
  `signal` is non-null, any signal is a canonical `NodeJS.Signals` name from the
  client's closed runtime allowlist, and `timedOut` and `aborted` are not both
  true. An unknown signal or impossible outcome combination makes the
  execution-bearing response invalid, so the client performs authenticated
  private quiesce before returning the error.
- Reserves exact targets before execution and records only nils-observed
  validation evidence. For an ordinary command, nils first advances the shared
  repository generation, executes once, and returns `ordinary-applied` without
  creating validation evidence. The generation advance makes older validation
  evidence stale, so stop requires the exact validations to be rerun.
- Requires the authoritative execution boundary described by the
  [nils finish-line contract](https://github.com/sympoies/nils-cli/blob/main/crates/agent-hook/docs/specs/agent-hook-v1.md#native-dsh-finish-line):
  Linux execution uses a verified systemd transient user cgroup and fails
  closed when that boundary is unavailable or on non-Linux hosts. This is
  descendant-lifetime containment, not a claim of an arbitrary network or IPC
  sandbox.
- Supplies the contained runner through immutable identities rather than
  re-resolved paths. Nils seals the bounded runner config in a memfd; systemd
  `OpenFile` passes that config and the exact current runner inode as read-only
  descriptors. A verified root-owned dynamic ELF interpreter starts the
  descriptor-bound runner, which watches its nils supervisor through a pidfd
  and terminates the command if that supervisor disappears.
- Every failed execution-bearing run awaits the private nils quiescence
  boundary before returning its failure to the caller. This includes transport
  failure, an unexpected agent-hook exit or signal, invalid JSON, envelope,
  schema, or result fields, cancellation, deadline, and plugin disposal.
  Recovery completes only after nils proves the exact transient unit inactive
  with no populated cgroup;
  failure to obtain that proof permanently degrades the finish-line client
  closed. This recovery command is internal to the adapter and is not a
  model-facing lifecycle operation.
- Binds the first successful finish-line response to its bounded opaque
  repository/session correlation ID across open, begin, run, stop, and internal
  release. Missing
  or changed correlation fails closed. The response-only ID is never added to
  the strict nils request wire.
- Calls the typed nils stop boundary directly at awaited
  `agent/turn-stopping`. Blocks steer a bounded plugin-authored user message
  into the same turn; persistence, correlation, runner, and process-quiescence
  failures stay closed.
- Keeps a private caller-generated open attempt token for the session lifetime.
  An ambiguous open retries with the same token, recovers the same nils-derived
  capability, and renews its 24-hour lease; a different attempt cannot replace
  a live capability. Expired quiescent crash orphans may be conservatively
  reclaimed by nils. Lease expiry alone never removes pending state: a crash
  orphan is eligible only after its exact stored systemd units pass bounded,
  stable stop/status, job, and cgroup quiescence checks. Active, indeterminate,
  or unbound sessions remain protected.
- On fire-and-forget rc.7 `agent/disposed`, synchronously registers an
  authenticated internal release task. Coordinator disposal drains that task
  after closing normal admission and quiescing active nils runs, then releases
  every remaining quiescent ledger before closing the nils client.
  It removes a ledger only after nils durably retires the session. Definitively
  abandoned edit/open attempts drop their private retry tokens. Release
  ambiguity is idempotent; an unrecoverable release closes later admission.
  A release tombstone is scoped to that capability incarnation, so rc.7 may
  resume the same stable session ID with a fresh open token; retrying the old
  release remains duplicate and cannot delete the resumed incarnation. The
  private open token is idempotency material, not a bearer: even if reused
  after release, nils advances its persisted incarnation sequence and returns
  a byte-distinct capability, so the old bearer stays invalid after tombstone
  compaction. Release and resume are serialized by stable repository/session
  identity, so a replacement DSH Session cannot race the old release.
- Exposes role selection and bounded review output, but no model-facing
  reviewer authority, persona text, child identity, continuation handle, or
  manual evidence-mutation surface. Unknown response fields are not projected,
  so a capability-shaped field cannot escape through supported lifecycle
  results.
- Commits a proposed step only after the rc.7 pre-step waterfall returns
  `enter`, then derives the live open step from public durable events. Initial
  attachment reverse-scans only the recent lifecycle suffix; later boundaries
  incrementally fold events after a retained append-only anchor instead of
  rescanning content-heavy suffixes. Replacement or truncation makes that
  attachment sticky-invalid until session reattachment. Reject, throw, abort,
  `step/end`, and `turn/end` therefore fail closed without invoking nils.
- For the separate pre-tool policy transport, caller cancellation, deadline,
  or plugin disposal terminates the nils child and observes both direct-child
  settlement and whole-process-tree exit.
  If a provider cannot establish quiescence by the teardown deadline, the
  current call fails closed and policy admission permanently degrades closed
  for the process; every in-flight sibling is cancelled too. A monotonic
  admission epoch also revokes allow markers waiting at rc.7 approval.
- Does not modify or vendor DeepSeek Harness.
- Contains no private skills. Project discovery remains DSH-native through
  `.dsh/skills` and `.agents/skills`.

Private discovery defaults to at most 32 directory levels, 10,000 entries,
4 MiB per regular file, and 32 MiB total. `privateSkillMaxDepth` and
`privateSkillMaxEntries` may lower those limits; hard ceilings are 64 and
20,000. Symlinks, non-regular entries, foreign ownership, and group- or
world-writable tree entries fail startup closed. The private loader is disabled
on Windows until equivalent ACL trust checks exist.

Policy checks default to a 5-second decision deadline, a 2-second teardown
deadline, and four active subprocesses. `policyTimeoutMs` is capped at 30
seconds, `policyTeardownTimeoutMs` at 10 seconds, and
`maxActivePolicyChecks` at 16. There is deliberately no waiting queue: calls
beyond the active ceiling fail closed with `policy-overloaded`. Confirmed
quiescence releases capacity normally; unknown quiescence closes all admission
instead of silently reopening capacity.

Selective context uses a separate process owner with a 5-second deadline,
2-second teardown deadline, and two active requests. The configurable fields
are `contextMaxBytes`, `contextTimeoutMs`, `contextTeardownTimeoutMs`, and
`maxActiveContextRequests`; their hard ceilings are 64 KiB, 30 seconds,
10 seconds, and 16. Context-transport degradation closes only context loading
and never relaxes the independent pre-tool policy gate.

Finish-line control and probe requests default to a 5-second deadline;
execution-bearing runs use the resolved Bash timeout plus bounded settlement
and teardown grace. Teardown defaults to 2 seconds, with four active requests
and two same-turn steering attempts. Configure these bounds with
`finishLineTimeoutMs`, `finishLineTeardownTimeoutMs`,
`maxActiveFinishLineRequests`, and `maxSameTurnFinishLineSteers`. No production
path installs an `EXIT` trap or rewrites shell commands.

Reviewer execution defaults to four concurrent children, at most sixteen
queued reviewer acquisitions, a 32 KiB task, 64 KiB per result, 128 KiB of
first-wave context for red-team, a ten-minute tool deadline, and delegation
depth two. The corresponding configuration fields are
`maxActiveReviewers`, `maxQueuedReviewers`, `reviewerTaskMaxBytes`, `reviewerOutputMaxBytes`,
`reviewerRedTeamContextMaxBytes`, `reviewerTimeoutMs`, and
`reviewerMaxDepth`; hard caps keep every request and collected result bounded.
Task and result limits are UTF-8 byte limits enforced after DSH schema
validation; they are not JSON Schema character-count approximations.
Reviewer children have no outbound web tool: the allowlist is limited to local
workspace-contained inspection and structured completion.

The exact supported DSH peer line is `0.1.0-rc.7`; the compatibility adapter is
not declared compatible with later release candidates or `0.1.x` releases.
The mutation containment claims above apply to the public pre-execute policy
waterfall and monotonic guard. In-process plugins that register
`tools/execute` around-dispatch wrappers are trusted computing base: the rc.7
public contract permits those wrappers to replace only `signal`, but a plugin
that deliberately violates other readonly fields is already executing trusted
code after the guard. This bundle does not use property-descriptor hardening or
non-public Harness APIs to contain a hostile in-process wrapper.

## Isolated DSH activation contract

Production activation uses DSH's native `headless` profile. A new arbitrary
profile name is not equivalent: DSH initializes unknown names with only
`@deepseek-ai/dsh-base`, while `headless` composes both the base and headless
agent bundles. Save the complete pre-activation `headless` profile and
owner-only DSH runtime root as the rollback point before applying the reviewed
package.

The package ships a compact DSH-only `agent-docs/` catalog and the
`policy/dsh-runtime-kit-v1.toml` policy source. The operations owner copies
both into a content-addressed, immutable asset directory under an owner-only
DSH runtime root; that root must not overlap a Codex or Claude Code runtime
home. It creates a strict `agent-hook.config.v1` file that binds the copied
policy digest, separate mutable hook and agent-docs state directories, and an
owner-only `activation.json` provenance manifest. The copied files are regular
files with `nlink` equal to 1; neither hard links nor pnpm-store links are part
of the activation contract.

The first authenticated mutation binds that runtime root to one canonical
`DSH_HOME` in an owner-only record and serializes every activation mutation and
collection pass with a root-scoped kernel lock. Reusing the root from another
DSH home fails closed. A valid version 2 installation created before root
ownership existed can be adopted only through digest-reviewed `doctor
--repair`: the selected canonical root must match every current, rollback,
pending, and last-applied reference in that DSH home's authenticated state;
the installed and active targets must match its current-or-pending targets;
and every retained set must be present with no extra, staging, oversized, or
malformed entry. Every global current, previous, or pending reference must map
to one authenticated target whose policy, catalog, document, and root-specific
hook configuration match the retained set. That configuration is compared as
the exact canonical byte sequence emitted by the activation writer: comments,
alternate policy paths or digests, provider sections, and other overrides are
not accepted even when canonical-looking assignments also appear elsewhere in
the TOML. The receipt binds each set's byte
count and canonical tree digest; apply revalidates that evidence under the root
lock, writes only the atomic owner record, and leaves state, activation, and
assets unchanged.
The activation reader canonicalizes the selected runtime root, then rejects a
symlink or unsafe owner/mode at every component below it. The asset-set,
agent-hook, and agent-docs directories must be real, their leaves must remain
contained in that versioned set, and every asset surface is disjoint from both
mutable state roots. A requested absolute root below a symlinked parent remains
compatible only after canonicalization to the same owner-private real runtime
root; symlinks inside that root are never followed.
Ordinary setup/update/remove never adopt an ownerless tree.

Adoption binds one explicit actual/activation provenance pair to the pending
protocol phase. With no pending operation, both must match `current`; a
terminal removed root instead requires absent package and activation surfaces,
null current/previous/pending state, an authenticated last-applied remove for
the selected root, and zero asset-set references across every authenticated
profile receipt. It may retain up to 16 reviewed unreferenced digest
directories from the pre-ownership remove: every directory must satisfy the
same owner, mode, link, depth, count, and per-set byte limits as a live set,
and its digest, byte count, and canonical tree digest are bound into the
adoption receipt. Adoption
preserves those orphan bytes; the next authenticated setup or update collects
them through ordinary reconciliation. During an
update or rollback, `prepared` permits `current/current` or `pending/current`,
and `native-applied` permits `pending/current` or `pending/pending`. Setup is
adoptable only at `native-applied/pending/pending`. A pending remove retains
the authenticated current snapshot and exact asset set: `prepared` permits
`current/current` or `absent/current`, and `native-applied` permits
`absent/current` or `absent/absent`. Undefined phases, `current/absent` remove,
`current/pending`, or more than one matching pair are ambiguous and rejected.
The adoption receipt binds both selected sources plus the pending phase and
action. Any topology, provenance, activation, or retained-asset change after
preview becomes `plan-drift` before the owner record is written. This
normalization is limited to reviewed durable evidence: command supervision,
runtime isolation, and configuration failures retain their original typed
error, exit status, and details.

Activation storage retains only asset sets referenced by current, rollback,
pending, or active receipts, admits at most 16 live sets, and removes
unreferenced digest sets plus interrupted pre-receipt staging directories.
Each set is independently bounded to 4 MiB of package assets plus 64 KiB of
generated activation overhead, so the total storage ceiling is derived as the
live-set count multiplied by the per-set ceiling rather than a separate
unreachable aggregate branch. Remove collects all sets after the final receipt
no longer references them.

Every setup, doctor, and live DSH launch uses the packaged owner launcher with
one absolute owner-only runtime root:

```sh
install -d -m 0700 /absolute/dsh-runtime
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- <command> [args...]
```

The launcher verifies that the root is a real owner-only directory and exports
`DSH_RUNTIME_KIT_RUNTIME_ROOT`. Before the first setup it supplies only the
bounded bootstrap layout needed by the operations command. Once activated, it
authenticates `activation.json`, every member digest, realpath containment, and
asset/state disjointness before exporting the exact versioned hook and docs
paths. It overrides ambient values for those five paths, then replaces the
launcher process with the requested long-lived command on POSIX so no idle Node
parent remains for the DSH lifetime. DSH `0.1.0-rc.7`
intentionally rejects every `DSH_*` bootstrap variable found in a project or
Harness-home `.env`; do not store this activation contract in `$DSH_HOME/.env`.

The five manifest-derived values are
`DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG`, `DSH_RUNTIME_KIT_AGENT_HOOK_POLICY`,
`DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR`, `DSH_RUNTIME_KIT_AGENT_DOCS_HOME`, and
`DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME`. Operators do not populate them
individually; the launcher replaces ambient values with authenticated paths.

`DSH_RUNTIME_KIT_AGENT_HOOK_BIN` and `DSH_RUNTIME_KIT_AGENT_DOCS_BIN` may also
pin the released v1.27.0 executables. The runtime passes the config, policy, and
state paths literally on every dispatch, finish-line request, and doctor call;
missing or non-absolute isolation paths fail plugin activation. Ambient
`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `~/.codex/AGENTS.md`, and
`~/.claude/CLAUDE.md` are never fallback sources for DSH.

Initialize or update only the native profile with the ordinary digest-reviewed
operations flow, then inspect and boot that same profile:

```sh
# Preview and retain the returned plan_digest.
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@<approved-version> --format json

# Apply the unchanged reviewed plan.
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@<approved-version> \
  --apply --expected-plan-digest <digest> --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --format json
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh --profile headless --dump-config
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh --profile headless "run the requested task"
```

The optional private loader remains opt-in. No Codex or Claude Code private
bundle is auto-enrolled. Leave `DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR` unset, point
it at an empty owner-only DSH directory, or select an explicit DSH-only
projection that satisfies the loader's no-symlink and permission checks.
Rollback restores only the saved `headless` profile and DSH runtime
root; Codex and Claude Code configuration, hooks, skills, and sessions remain
unchanged throughout activation and rollback.

## Operations

The package executable owns planning and receipts; DSH continues to own the
profile manifest, dependency installation, lockfile, and bundle reconciliation.
Targets must be an exact registry version or a local directory whose manifest
is exactly `@sympoies/dsh-runtime-kit` with an exact version. Both target forms
are resolved through script-free `npm pack`; the reviewed plan binds the
resulting tarball and extracted-tree SHA-256 values, and apply installs the
matching private content-addressed artifact rather than a mutable source or a
second unbound registry resolution.

```sh
# Preview only; prints plan_digest.
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@1.0.0 --format json

# Apply the unchanged reviewed plan.
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit setup --profile headless \
  --package @sympoies/dsh-runtime-kit@1.0.0 \
  --apply --expected-plan-digest <digest> --format json

dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit update --profile headless \
  --package @sympoies/dsh-runtime-kit@1.1.0 --format json
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit rollback --profile headless --format json
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit remove --profile headless --format json
dsh-runtime-kit-launch --runtime-root /absolute/dsh-runtime -- \
  dsh-runtime-kit doctor --profile headless --format json
```

`setup`, `update`, `rollback`, and `remove` all use preview then digest-bound
apply. After a successful setup/update, a digest-only replay may omit
`--package`; if `--package` is supplied, it must still resolve to the exact
reviewed target. A global artifact transaction plus a per-profile SQLite
transaction supply kernel-owned process locks; process exit releases them
without stale-path reclamation. Replaying the same applied digest succeeds as
`duplicate` only after those locks are acquired and the installed terminal
state is revalidated. The receipt records the exact target, artifact digest,
requested/dependency specs, installed version, installed package-tree digest,
policy/catalog/document digests, DSH and pnpm executable identities, bounded
profile control files, and bundle index. Apply revalidates all of those inputs
before mutation and rejects collateral manifest or lockfile changes afterward.
When the selected profile has no manifest yet, the exact reviewed DSH binary
owns its newly created native profile scaffold; any control file that existed
before initialization remains part of the collateral comparison and is
restored exactly on rejection. Doctor and interrupted-operation recovery never
use that initialization allowance and require exact absent/present topology.
Version 2 operations receipts bind the canonical DSH runtime root. Update,
rollback, remove, and duplicate setup reject a different supplied root before
native DSH runs, so an old activation cannot be stranded while state moves to
a new tree. Exact terminal version 1 receipts remain readable only for an
explicit `doctor --repair` migration: migration authenticates every retained
package artifact, compares the current receipt to installed bytes, derives the
versioned policy/docs asset digests, stages the matching activation, and writes
the version 2 state last. A version 1 pending attempt lacks the profile snapshot
needed for safe recovery, so it remains byte-for-byte unchanged and fails
closed with instructions to use the exact base CLI or an authenticated backup.
Source-byte, installed-byte, activation-asset, toolchain, or unrelated-profile
drift invalidates the operation; rollback and interrupted-operation recovery
restore the recorded package, profile, and activation-asset set together.
An unmanaged existing installation is never adopted by version alone. The
only legacy version 2 adoption is the root-owner migration described above;
cross-home, unbound, drifted, foreign-owner, malformed-pending, or incomplete
asset candidates remain closed. A durably renamed pending receipt is written
before native mutation. After interruption, `doctor --repair` previews the
complete recovered receipt and may finalize or clear only an internally
consistent attempt; every third state fails closed.

Doctor validates both released nils boundaries. `agent-hook doctor --product
dsh` must report DSH dispatch support and registration ownership by
`dsh-runtime-kit`; `agent-docs --version` must be v1.27.0, and the DSH-only
catalog plus state roots must remain owner-only real paths. Remove first asks
native DSH to remove the package and bundle
row, then cleans only a fixed final package entry if pnpm retained it. The
profile, state, package-parent, and cleanup paths reject symlinks or unsafe
ownership before any recursive removal. Management subprocesses use resolved
executable identities, a minimal environment, bounded output, and digest-only
stderr diagnostics.
Profile user patches, other dependencies/bundles, and
`DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR` are never read, written, or removed by the
operations layer. The private artifact store retains only digests reachable
from current, previous, pending, or terminal receipts; exact orphan/temp files
are reclaimed under the global lock, with hard caps of 64 archives, 1 GiB
total, and 128 MiB per archive.
Before any operations archive reaches system `tar`, the same bounded parser
used by compatibility staging enforces the 256 MiB expanded, 16,384-entry, and
64 MiB per-entry limits plus regular-file-only package paths.
Every external health, package, and DSH mutation command has a hard deadline of
30 seconds, two minutes, and ten minutes respectively. The outer operations
owner starts a private supervisor as the leader of a dedicated POSIX process
group, kills any group that remains after timeout, supervisor loss, or direct
command return, and proves group quiescence before the kernel-owned operation
locks are released; an unproven settlement fails closed. An operator may
lower, but never raise, these bounds with
`DSH_RUNTIME_KIT_COMMAND_TIMEOUT_MS` (minimum 100 ms). Because registry and
local targets both carry a pre-mutation artifact/tree identity, doctor can
authenticate and finalize an exact installed terminal state even if the owner
stopped before persisting the advisory `native-applied` phase. A nonzero DSH
result that does not match that identity remains closed.

## Keyless smoke test

Prepare a DeepSeek Harness source checkout without running its repository hook
installer, then run:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/target/debug/agent-docs \
npm run test:smoke
```

The smoke installs the packed bundle into an unmodified DSH `0.1.0-rc.7`
checkout. Its primary leg creates a real nils-managed feature worktree, proves
a raw default-branch merge is denied, and runs the governed
`semantic-commit default-branch --dry-run` recovery path. It never contacts or
mutates an external provider.

The acceptance test packs the publishable tarball, installs it into a clean
temporary `DSH_HOME`, invokes the actual `dsh plugin` and `dsh --dump-config`
paths, and boots the real DSH composition. It proves the 29-skill catalog plus
project/private precedence, then drives a scripted public LLM adapter through a
real Agent result-driven tool loop. It proves the context marker is absent
from the initial request, calls `runtime_context({ intent: "project-dev" })`,
observes the bounded marker only after that result, commits a filesystem edit,
opens the nils runner, probes the exact declared validation command, prepares
the DSH shell runtime, and receives the nils-recorded failure. Stop blocks and
steers; the same command is then executed and recorded successfully before the
next stop allows. An ordinary foreground mutation then runs once under nils,
advances generation, and makes stop demand exact revalidation. After that
revalidation, the loop observes `runtime_kit_plus_one({ value: 41 })` return
`42`. It switches policy to prove pre-body denial and rejects replacement of
the authenticated finish-line correlation. Cancellation, failed-run cleanup,
and plugin-disposal quiescence remain covered by the package's focused
lifecycle suites; the independently pinned acceptance controller does not
import candidate modules to make those assertions.

A separate leg calls the packed `review_specialists` tool through rc.7's real
`spawn` provider. The scripted quick reviewer deliberately calls `write`;
the exact child-scoped guard rejects it before the body, the marker file is
absent, the reviewer completes after observing the denial, emits one non-empty
finding accepted by nils `review-specialists validate`, and its child is no
longer live when the parent receives the correlated result.

The independent operations smoke uses an isolated DSH home and the unmodified
rc.7 `dsh plugin` path for setup, update, exact rollback, and remove. It proves
two complete packed runtime-kit variants retain their CLI, policy, source, and
smoke surfaces through setup, update, and rollback. It also proves an unrelated
installed bundle, the user patch, and private-skill content remain unchanged
after remove and the upstream DSH checkout remains clean. The acceptance runner
stages those complete variants; the standalone command therefore requires their
paths in `DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V1` and
`DSH_RUNTIME_KIT_ACCEPTANCE_PACKAGE_V2`.

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
npm run test:operations-smoke
```

## Acceptance boundary

`npm run acceptance` produces `dsh-runtime-kit.acceptance-summary.v2`. A local
source rehearsal snapshots and hashes six nils executables (`agent-hook`,
`agent-docs`, `git-cli`, `review-specialists`, `semantic-commit`, and
`forge-cli`), clones the manifest-pinned DSH revision without hardlinks,
installs its frozen lockfile offline, rebuilds the host libraries, packs this
package, and runs the producer-owned operations and packed-runtime scenarios
under a disposable HOME/XDG tree and fixed PATH. It requires
`--acknowledge-trusted-code` because the candidate still has user-systemd and
network authority. Each scenario runs in its own transient user-systemd control
group with a hard runtime deadline; before and after each leg the runner
rechecks the current control program, the packed tarball, every executable, and
the selected DSH public closure. Operations and runtime each receive a fresh
extraction of that authenticated tarball, so the second leg never executes a
package tree that the first leg could mutate. Each scenario owns one stable ID
and non-empty evidence; failures produce a typed nonzero CLI result.
The hosted acquisition and source legs share one explicit pnpm store contract:
acquisition prepares `$HOME/.local/share/pnpm/store`, and source acceptance
invokes the authenticated pnpm launcher with that exact `--store-dir` plus the
matching `XDG_DATA_HOME` and `PNPM_HOME`. It does not ask a package-relative
GitHub Actions launcher to infer a different store after the credentialless
runtime changes HOME/XDG scope. Because the selected DSH commit and its
lockfile are authenticated before installation, the frozen offline install
also uses pnpm's `--trust-lockfile` mode; this prevents supply-chain policy
metadata checks from attempting registry access inside the network-denied
candidate without weakening the pinned source or content-addressed store
bindings. The runtime-kit tarball also bundles its exact production dependency
closure, so native DSH `add` can use pnpm's explicit `--offline` mode. The
reviewed artifact digest binds that complete closure; post-install identity
projects out only the package root's package-manager-owned top-level
`node_modules` materialization and continues to bind all plugin-owned paths.
Native `remove` retains the isolated offline environment but does not forward
pnpm's unsupported `remove --offline` option.

This local mode proves only the scoped `functional-session` path. Its honest
result remains `incomplete` until a disposable OS-isolated environment and an
explicitly authorized live semantic-commit plus no-merge PR delivery are
correlated to the same run and exact repository/head. It does not make a
host-wide process claim. Final `pass` requires all six hashes to match the
independently authenticated nils-cli v1.27.0 release, exact pinned DSH identity,
a clean head bound to the tested tarball digest, isolated execution, and direct
provider read-back for the correlated open PR. Its `inspect` and
`private-project-skill` evidence must also prove that the DSH profile has zero
`agent-runtime-kit` dependency, Codex/Claude wiring is untouched, and DSH did
not cross-load their hooks, skills, or session state. Caller-supplied legacy
receipt flags are rejected. The
public local runner intentionally has no final-pass mode until that external
trust root is selected. The selected trust root is the private
`serenvia/sympoies-infra` manual acceptance workflow. It acquires and verifies
the exact released nils artifacts without executing candidate code, then runs
this public runner with a caller-bound `--run-id`, `--package-tarball`, and
`--package-sha256` under a credentialless, network-denied disposable UID. It
stops that UID's user manager and proves no process remains before publishing
candidate evidence. A separate credentialed phase may run only with explicit
live-delivery authorization; it never executes candidate repository code and
stops after a correlated draft, no-merge PR plus direct provider read-back.
That trust root independently pins the eight candidate controller/scenario
files it permits. The trusted controller imports none of them: it reads them as
authenticated inputs and executes candidate behavior only in descendant DSH
processes. Final provider read-back must contain exact standalone
`Acceptance-Run`, `Acceptance-Trust-Root`, and `Acceptance-Package` markers.

## Compatibility

The supported compatibility target is DeepSeek Harness `0.1.0-rc.7` with
Cordis `4.0.1` on Node.js 22.19 or 24. The machine-readable
[DSH compatibility manifest](compatibility/dsh.json)
pins the release tag and one reviewed `upstream-next` revision. At the current
2026-08-19 selection, upstream `master` and the rc.7 tag resolve to the same
commit; they remain separate blocking CI matrix rows so a later reviewed
selection can advance without broadening the release peer range.

The compatibility gate reads only a clean, already-built upstream checkout. It
verifies the selected Git revision, root/package versions, public package
entrypoint digests, and the name/kind of every runtime export consumed by this
bundle. Source inspection hashes exact files and never executes checkout bytes.
The manifest also pins the complete 37-package DeepSeek workspace dependency
closure by canonical artifact digest. Packing rechecks the selected clean Git
identity before and after, verifies every package name/version and reachable
dependency, and emits a receipt containing both the canonical digest and this
tarball's byte SHA-256. CI stages only those authenticated regular files into
the consumer after `npm ci --ignore-scripts --omit=peer` installs the five
exact, lockfile-bound non-DSH runtime dependencies; no DSH package is resolved
from the registry and no package lifecycle script runs. The Linux stager
rejects symlinked install ancestors, requires every final package target to be
absent, and anchors direct extraction beneath retained `O_NOFOLLOW` directory
descriptors. It never renames or deletes a package pathname: concurrent swaps
fail closed without touching the replacement, and a failed disposable consumer
is rebuilt rather than cleaned in place. Plugin
apply then version-checks every installed public peer before importing any
runtime module and checks export kinds plus the required rc.7 Context/service
methods before registering a DSH listener, tool, service, or skill.
Incompatibility is returned as a typed `DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; no source patch, copied preset, or partial
plugin registration is used.

```sh
npm run --silent check:compatibility -- \
  --source-root /path/to/deepseek-harness \
  --channel pinned \
  --format json
npm run --silent pack:compatibility-peers -- \
  --source-root /path/to/deepseek-harness \
  --artifact-root /empty/private/directory \
  --channel pinned \
  --pnpm-bin /absolute/path/to/pnpm \
  --receipt /separate/private/receipt.json
npm run --silent stage:compatibility-peers -- \
  --receipt /separate/private/receipt.json \
  --artifact-root /empty/private/directory \
  --consumer-root /path/to/dsh-runtime-kit
npm run benchmark:policy
AGENT_HOOK_BIN=/absolute/path/to/released/agent-hook \
  npm run benchmark:policy:real
```

The promotion benchmark runs 250 warmups and two 1,000-check controlled batches.
Before disposal it blocks if adapter p95 exceeds 5 ms, a batch retains more
than 8 MiB, retained growth across batches exceeds 2 MiB, or any policy
operation/provider handle remains active. Disposal must then return all active
operations and provider handles to zero. A separate promotion benchmark packs
the exact candidate, authenticates the released nils-cli `1.27.0` `agent-hook`
binary, and measures 25 real sequential subprocess dispatches after five
warmups. Its p95 must remain at or below 250 ms and teardown must leave both
transport admission and live child counts at zero. The deterministic benchmark
isolates adapter retention; the packed subprocess benchmark includes provider
startup and host scheduling instead of relying on a fake handle.

The machine-readable [nils-cli compatibility manifest](compatibility/nils-cli.json)
is authoritative for consumed commands and protocols. The first supported and
currently validated DSH-capable release is nils-cli `1.27.0`. The manifest pins
the official `v1.27.0` source commit, Linux x86-64 release archive, and exact
hashes of all six acceptance binaries. A local checkout or ambient prototype
binary must not be treated as release compatibility.
