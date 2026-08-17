# DSH Runtime Kit Migration Implementation Handoff

## Document control

- Status: approved and implementation-ready
- Date: 2026-08-18
- Source: maintainer requirements, local source inspection, and an executed
  DeepSeek Harness acceptance probe
- Target repositories: `sympoies/dsh-runtime-kit` and `sympoies/nils-cli`
- Intended next step: execute the linked L3 dispatch plan through phased PRs
- Open architecture questions: none

## Purpose

Replace every active `agent-runtime-kit` responsibility with an out-of-tree,
public DeepSeek Harness bundle plus deterministic nils-cli capabilities. The
finished system must run without Codex or Claude Code, must not fork DeepSeek
Harness, and must leave the old runtime repository with no active installation,
configuration, policy, skill, reviewer, or workflow responsibility.

## Confirmed facts

- DeepSeek Harness `0.1.0-rc.7` supports out-of-tree bundles through
  `package.json` bundle metadata and a Cordis patch.
- Its public lifecycle includes `agent/session-start`, `agent/pre-step`,
  `tools/pre-execute`, `tools/post-execute`, `tools/result`, and
  `agent/turn-stopping`.
- Its public skill filesystem provider discovers project roots at
  `<git-root>/.dsh/skills` and `<git-root>/.agents/skills` and accepts isolated
  custom and bundled roots.
- A packaged `@sympoies/dsh-runtime-kit` prototype has been installed into a
  clean DSH profile and booted without modifying the upstream checkout.
- The probe executed a DSH-native `runtime_kit_plus_one` tool (`41 -> 42`),
  proved a nils-cli policy block ran before the tool body, and proved project,
  private, and bundled skill precedence through DSH's standard filesystem
  provider.
- The legacy runtime exposes 29 public skills, eight reviewer personas, 101
  Codex/Claude policy registrations, and 22 allowlisted file-handler IDs. Some
  registrations are provider duplicates or provider-specific compatibility;
  final parity is behavior- and invariant-based, not a requirement to retain
  obsolete provider names or Python processes.
- nils-cli already owns the deterministic `agent-hook` policy engine and the
  workflow/domain CLIs used by the skills. The prototype adds a strict DSH
  ingress and native allow/block response seam, but that change is not yet
  delivered.
- The public package must contain no private skill name, body, personal topic
  profile, absolute private path, or private telemetry. Private support is a
  runtime loader only.

## Decisions

1. `dsh-runtime-kit` is a public package and DSH bundle in the `sympoies`
   organization. It is not a DeepSeek Harness fork.
2. Upstream DSH source and installed packages are never patched in place.
   Compatibility code is isolated behind a narrow adapter and tested against
   supported upstream versions.
3. DeepSeek Harness owns the agent loop, tool pipeline, sessions, approvals,
   sandbox, skill registry, and subagent runtime.
4. `dsh-runtime-kit` owns bundle composition, lifecycle wiring, public/private
   skill providers, compact runtime context, reviewer selection, diagnostics,
   and DSH-to-nils transport.
5. nils-cli owns deterministic policy, state machines, command classification,
   finish-line accounting, coordination, setup diagnostics, and durable
   workflow primitives.
6. Final production policy must not call the legacy Python handlers. Each
   active behavior is implemented as a typed nils-cli capability or a DSH
   lifecycle adapter over that capability. The old handlers may be used only
   as bounded parity fixtures during migration.
7. Project skills use DSH's native provider. An optional private root is
   loaded at runtime after ownership, mode, ancestor, containment, and symlink
   checks. Project wins over private; private wins over bundled public.
8. Reviewers are exposed as one `review_specialists` tool selecting one of
   eight server-side personas. Reviewer mutation denial is enforced by policy,
   not prompt text or tool filtering alone.
9. Large delivery is one shared dispatch outcome with independently reviewed
   PR lanes. DSH repository lanes target the plan branch; the nils-cli lane is
   a linked cross-repository dependency PR targeting nils-cli `main`.
10. `agent-runtime-kit` remains untouched and active until the replacement
    acceptance matrix is complete. Cutover first removes active references;
    archival/read-only treatment happens last.

## Scope

- Public DSH bundle, package, lifecycle plugins, policy adapter, diagnostics,
  compatibility boundary, and release assets.
- All 29 public skills and their resource closure.
- Project and private skill discovery with explicit precedence and trust.
- Strict DSH ingress and response contracts in nils-cli.
- Session start, pre-step, pre-tool, post-tool, result, and turn-stop behavior.
- Runtime context preparation and selective agent-docs disclosure.
- Behavior parity for all active legacy guards, reminders, coordination,
  validation, finish-line, secret, memory, Git, delivery, and scope policies.
- One reviewer tool, eight personas, parallel reviewer execution, red-team
  routing, and read-only authority.
- Setup, doctor, update, rollback, compatibility testing, and local cutover.
- Final active-reference audit and retirement of old runtime usage.

## Non-scope

- Forking DeepSeek Harness or copying its standard preset.
- Retaining Codex, Claude Code, or Hermes as supported runtime targets.
- Publishing private skills or personal profiles.
- Reimplementing nils-cli workflow commands in TypeScript.
- Preserving provider-specific duplicate registration counts when one typed DSH
  event implements the same invariant.
- Deleting historical issues, plans, commits, or audit evidence from the old
  repository.

## Implementation boundaries

```text
DSH typed lifecycle event
  -> dsh-runtime-kit bounded adapter
  -> nils-cli agent-hook typed request
  -> deterministic capability/state evaluation
  -> typed DSH allow/deny/context/continuation decision
```

- No shell interpolation is used to start nils-cli.
- Requests, responses, stderr, time, child count, and retained output are
  bounded. Caller cancellation terminates owned child work.
- Missing binary, timeout, malformed response, request replay, policy drift,
  target spoofing, or effect ambiguity fails closed whenever mutation is
  possible.
- DSH's `ToolExecution.token` and monotonic guard are used so a later plugin
  cannot reverse an authoritative denial.
- Authoritative post-tool results replace the legacy shell `EXIT` trap for
  validation accounting.
- Session state and finish-line records use opaque session identities and do
  not retain prompts, raw tool output, or credentials.

## Requirements

- Install, boot, update, remove, and rollback without editing the DSH checkout.
- Load exactly the expected 29 bundled skills and every declared resource.
- Support absent and present private roots, malformed entries, collisions,
  project overrides, and restart/revalidation behavior.
- Cover every legacy handler and rule with a parity row that is implemented,
  replaced by stronger DSH-native behavior, or explicitly retired as
  provider-obsolete with evidence.
- Enforce edit intent, checkout ownership, semantic conflict, owner liveness,
  direct Git/PR/worktree restrictions, semantic commit requirements, secret
  scans, portable paths, memory boundaries, agent scope, operation lifecycle,
  validation recording, and finish-line stopping.
- Prepare only requested agent-docs intents and return bounded required context.
- Select and execute all eight reviewer personas while denying reviewer
  mutation independently of model compliance.
- Keep deterministic workflow commands in nils-cli and expose them through
  skills rather than copying their mechanics into the harness.
- Prove supported DSH versions in CI and surface a typed incompatibility when a
  breaking upstream change is detected.
- Remove every active old-runtime environment variable, runtime-home link,
  sync/install call, CI dependency, and configuration reference before
  retirement.

## Acceptance criteria

- A clean machine/profile can install the public package and complete real DSH
  sessions for bootstrap, inspect, edit, validation, review, private/project
  skill use, semantic commit, and PR delivery.
- The policy parity matrix has no `pending` active behavior.
- Finish-line E2E proves edit -> dirty -> failed validation -> blocked stop ->
  successful validation -> allowed stop.
- Eight of eight reviewer personas are selectable; attempted reviewer mutation
  is blocked before the tool body.
- The upstream DSH checkout remains clean in every compatibility run.
- Security, API-contract, testing, maintainability, performance, and red-team
  review gates have no unresolved blocking finding.
- An active-reference audit returns zero runtime dependency on
  `agent-runtime-kit`; the old repository is then archived/read-only.

## Validation plan

- Unit and contract tests for every adapter, capability, trust boundary, and
  response branch.
- Real packed-bundle DSH smoke on the pinned release and an upstream
  compatibility lane.
- nils-cli focused tests, formatting, clippy, docs, and local-fast gate.
- Full skill catalog/resource/precedence/private-content package audit.
- Legacy parity fixtures plus DSH-native lifecycle integration tests.
- Performance measurement for pre-tool policy p95 and repeated-call process,
  parse, and binary-resolution cost.
- Managed reviewer and finish-line E2E sessions.
- Install/update/remove/rollback and final cutover/reference audits.

## Risks and guardrails

- DSH is pre-1.0 and can break public APIs. Keep imports in one compatibility
  layer, pin a tested range, and fail with a typed diagnostic outside it.
- Per-tool subprocess startup can become a hot-path cost. Measure it before
  cutover and move to a bounded persistent sidecar only if the agreed p95
  budget cannot be met safely.
- Cross-repository changes can drift. The nils-cli PR lands and releases before
  DSH policy code raises its minimum compatible version.
- Private skills are executable instruction authority. Reject unsafe roots and
  never watch a trusted root without equivalent revalidation.
- A compatibility migration must not weaken policy. Unknown parity remains a
  blocker, not an implicit allow.

## Read first

- `README.md`
- `docs/architecture.md`
- `docs/private-skills.md`
- nils-cli `crates/agent-hook/docs/specs/agent-hook-v1.md`
- DeepSeek Harness `packages/core/tools/README.md`
- DeepSeek Harness `packages/core/agent/README.md`
- DeepSeek Harness `packages/skill/skill-filesystem/README.md`

## Execution

Recommended plan: docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-plan.md

Recommended execution state: docs/plans/2026-08-18-dsh-runtime-kit-migration/dsh-runtime-kit-migration-execution-state.md

Retention intent: keep this source and the final plan as historical migration
evidence after closeout; promote only stable operational contracts into normal
repository documentation.

