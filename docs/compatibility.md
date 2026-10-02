# Compatibility

The supported runtime is deliberately exact:

| Surface | Supported version |
| --- | --- |
| DeepSeek Harness (generic/headless) | `0.1.7-rc.1` or `0.2.0-rc.2` |
| Cordis | `4.0.4` with both DSH releases |
| Node.js | `24` or newer |
| nils-cli | `1.29.0` minimum; exactly validated through `1.31.13` |

The validated companion release is nils-cli 1.31.13. Its exact Linux x64 and
macOS arm64 archives and consumed binary digests are recorded in
`compatibility/nils-cli.json`; the minimum remains 1.29.0. This adoption retains
the managed-session mailbox reminder and guard contracts admitted in 1.31.8.
The generic Main Agent controller fixtures use an inert explicit Codex stub;
DSH workers still use the external-runtime contract. The live-scope conflict
scenario now verifies refusal before a worker session is created.

## Agent runtime source alignment

The frozen source inventory under `policy/rule-parity.yaml` and
`policy/runtime-rule-parity.yaml` names `sympoies/agent-runtime-kit`
`1809e49ea7f14759afde7e154c065cf38e80ee57`. Since the previous
`6bf6aaefeeca59ba2b83c5bc79920b8798bf49c1` boundary, the only hook-manifest
change is agent-runtime-kit #179, which retired four handlers: 92 rules and 58
legacy registrations remain. The four capability groups stay in the runtime
parity inventory with `source_removed`: `block-claude-coauthor-trailer` was
already retired in DSH, and the three reminders that DSH still selects
(`memory-write-principle-reminder`, `skill-usage-reminder`,
`stop-pre-pr-reminder`) retire under #313.

`compatibility/agent-runtime-alignment.json` pins the same commit and gives
every agent-runtime-kit skill, home policy, `AGENT_HOME.md`, the hook
manifest, and the hook implementations one disposition: `synced`,
`dsh-native`, `retired`, `not-applicable`, or `open-issue` with its issue.
The read-only guard fixes from agent-runtime-kit #180, #184, and #185 reach
DSH through nils-cli 1.31.8 (sympoies/nils-cli#2001, #2010, #2016, and #2020),
so the hook implementations are `synced`. DSH's Bash tool admits quoted command
substitutions, backticks, `[`/`test` and `[[ ... ]]` tests, `if`/`while`/`for`
blocks, here-document bodies, installed `git-<name>` extensions such as
`git lfs`, and non-committing `semantic-commit --help`,
`semantic-commit commit --help`, `--dry-run`, and `--validate-only` forms. A
direct `git commit`, the same hidden in a substitution, after a precommand
modifier assignment, or in a here-document, a `semantic-commit` flag swallowed
into an option value by a redirection, and an unsafe default-branch push still
block. DSH stays stricter than the source where nils-cli refuses an
unclassifiable form: `case` blocks, subshells, `$((...))`, process
substitution, `git mergetool`, and `PATH=` prefixes on Git builtins. Work modes
and session coordination are synced as packaged DSH documents.
`npm run check:agent-runtime-drift` and the weekly `agent-runtime-kit drift`
workflow report every watched change after the pin; see the
[development reference](development-reference.md#agent-runtime-kit-alignment).

The source changes were checked against DSH by behavior and owner:

| Source change | DSH route |
| --- | --- |
| Trusted pre-edit intent recovery | `runtime_context` prepares `project-dev` for an explicit absolute `project_path`, regardless of the session's starting cwd or the target's dirty state. Bash `workdir` and native file edits use the checkout lease's authenticated target. A pre-edit denial names the target-context route. |
| Default-branch and persistent-integration delivery hook | DSH uses the released nils-cli `block-unsafe-default-delivery` group and governed `git-cli`/`semantic-commit` routes. The Codex/Claude Python parser is not loaded by DSH. The DSH-native default-branch proof is a separate nils-cli contract. |
| Dirty checkout recovery hook | DSH uses its native checkout lease and `workspace_recovery`/`workspace_recovery_handoff` for inspecting the session's repository. The v2 lease permits an explicitly resolved dirty target to pass to another session after release and terminal operations. With nils-cli v1.28.46, an idle live foreign owner may transfer an exact-target lease after one approval; active operations and stale conflicts stay fenced. A session started outside Git uses `runtime_context` with the target path directly. |
| Artifact routing and portable path hook | DSH provides session-owned `artifact_*` tools. The released nils-cli v1.28.43 native `portable-paths-scan` group also rejects hand-built `agent-out` directories and repo-local `.cache` scratch for DSH; the rule is not reimplemented in JavaScript. |
| Coordination, health, skills, docs prompt, and finish-line hooks | DSH uses native coordination and runtime-health surfaces, selective `runtime_context`, and its nils/runtime-kit finish-line coordinator. macOS Bash and symlink fixes apply to the host-hook launchers, not to DSH's subprocess adapter. |
| Devlog, upstream, Git delivery, review, browser, evidence, memory, and work-mode documents | DSH sessions in any repository receive DSH-native adaptations from the packaged `agent-docs/` catalog through `runtime_context`; see the home-policy dispositions below. A repository's own catalog adds project documents only for the products it names. Codex/Claude-only invocation text is not copied. |

### Home-policy dispositions

Each agent-runtime-kit home policy reaches DSH sessions as a packaged
adaptation, through a DSH-native replacement, or not at all. Packaged
documents live in `agent-docs/` and resolve through `runtime_context`; every
intent and phase stays within 18 KiB of packaged documents so a call fits the
default 20 KiB context budget.

| agent-runtime-kit policy | DSH disposition |
| --- | --- |
| `work-modes.md` | Adapted: `WORK_MODES.md`, `project-dev` phase `delivery`. |
| `git-delivery.md` | Adapted: `GIT_DELIVERY.md`, `project-dev` phase `delivery`. Codex/Claude hook mechanics and the inline waiver are omitted; DSH's guards are the nils-cli `dsh_policy` groups. |
| `review-thread-convergence.md` | Adapted: `REVIEW_CONVERGENCE.md`, `project-dev` phase `review`. |
| `evidence-control-plane.md` | Adapted: `EVIDENCE.md`, `project-dev` phase `review`, with session `artifact_*` storage. |
| `devlog-capability.md` | Adapted: `DEVLOG.md`, intent `devlog`. It is not part of `delivery` because work modes and Git delivery already fill that phase's budget. |
| `external-facts.md` and `cli-tools.md` | Adapted together: `EXTERNAL_FACTS.md`, intent `external-facts`, with the command-line defaults a DSH session can use. The Homebrew catalog, browser CLI wrappers, and Codex/Claude tool rows are not applicable. |
| `browser-test-routing.md` | Adapted: `BROWSER_TESTING.md`, intent `web-testing`. DSH has no built-in browser; the document routes to a mounted browser-use provider, the project's own harness, or a stated blocker. |
| `memory.md` | Adapted: `MEMORY.md`, intent `memory`. DSH has no built-in memory store; the content boundary applies to a connected memory MCP server. The `agent-memory` candidate lifecycle is not applicable. |
| `upstream-contribution.md` | Adapted: `UPSTREAM_CONTRIBUTION.md`, intent `upstream-contribution`, generalized from this repository's own policy. |
| `files-hooks-validation.md` | DSH-native replacement: the nils-cli `dsh_policy` groups, the finish-line coordinator, and `PROJECT_DEV_EDIT.md`. |
| `session-coordination.md` | Adapted: `PEER_COORDINATION.md`, intent `peer-coordination`: the read-only board check, mailbox checkpoints at least every five minutes, and disposition replies with the session's own `agent-session` identity. No mailbox reminder reaches DSH sessions yet (sympoies/nils-cli#2011), so DSH relies on these checkpoints. Claim enforcement and recovery internals are not applicable. |
| `code-review-delegation-codex.md` | Not applicable: Codex-only. DSH routes review through the native `review_specialists` tool. |
| `intent-cards.md` | DSH-native replacement: the `runtime_context` intent and phase routing in the packaged home instructions. |
| `forge-label-taxonomy.md` | Not packaged: the `workflow::tracking` and `workflow::follow-up` labels are named inline in `WORK_MODES.md` and the `issue-follow-up` skill; repositories own their label catalogs. |
| `execution-capsules.md` | Not packaged: the bundled `execution-capsule` skill carries the procedure. |

The nils-cli v1.28.25 to v1.28.40 source comparison found no repair for the
wrong-intent incident. DSH PR #263 repaired intent recovery in runtime-kit;
nils-cli PR #1784 added the missing native portable-path rule for DSH and was
released as v1.28.42. PR #1786 fixed the Agent Console DSH initial-prompt
handoff and was released as v1.28.43. PR #1788 added the released-dirty-worktree
successor lease contract in v1.28.44. PR #1792 added the opt-in
exact-target live-owner takeover contract in v1.28.46.

The package retains exactly the latest two reviewed DSH releases. A promotion
must add the newest release and remove the oldest release, its patch artifact,
and its CI row in the same change; the validation count therefore remains
bounded while DSH is immature. When deployed operations receipts still name
the evicted release, retain its exact version, tag, revision, and Cordis
identity under `retired_operations_toolchains` until those profiles have
converged. That historical row authenticates completed receipts only and does
not keep the release in the runtime support window. Runtime startup requires
one homogeneous `0.1.7-rc.1` or `0.2.0-rc.2` public peer set and validates
the consumed public exports and service methods before registering a listener,
tool, service, or skill. The
reviewed compositions are exact: both DSH releases require Cordis 4.0.4.
The retired `0.1.6-alpha.2` row keeps its Cordis 4.0.2 identity only for
completed operations receipts. Mixed,
cross-composed, or unknown peer versions
fail closed. Incompatibility returns a typed
`DshCompatibilityError` with code
`DSH_RUNTIME_KIT_INCOMPATIBLE_DSH`; plugin activation also requires the native
`tools.bindPrerequisite` and `llm.guard` methods supplied by the authenticated
patch and never partially activates without them.

## Machine-readable contract

[`compatibility/dsh.json`](../compatibility/dsh.json) is authoritative for the
pinned DSH tag, reviewed `upstream-next` revision, exact `0.1.7-rc.1`
and `0.2.0-rc.2` release identities, the enforced two-release support policy, public package/export
surface, complete pinned workspace closure, artifact bounds, and runtime
performance budgets. Each `validated_releases` row also declares its exact
Cordis composition so the public contract and runtime admission stay aligned.

[`compatibility/dsh-patches.json`](../compatibility/dsh-patches.json) is
authoritative for the only logical downstream DSH patch: each reviewed
release's artifact digest, its exact target before/after hashes, and the two
reviewed release revisions. The
package does not fork, vendor, or propose this integration upstream, which the
entry records as an explicit `upstream_reference` state of `not-reported`
rather than leaving to prose. The patch
manager accepts only a pristine or exactly patched checkout and emits a typed
receipt for check, apply, or reverse.

The current `native-execution-boundaries-v5` patch supplies the monotonic
pre-body guard and prerequisite seams retained from earlier revisions, adds a
single terminal policy provider after ordinary persistence and result
materialization, preserves model-order persistence projection, and adds the
dynamic protected-root sandbox contract. It also adds DSH-owned restricted
one-shot roles: immutable host registration, caller-minimal starts, exact-live
classification and receipts, atomic unpublished-child authority mounting,
bounded global/per-role admission, and quiescent teardown. The authenticated
continuation setup seam passes the exact unpublished child `Agent` alongside
its context. Runtime-kit therefore never tries to rediscover that identity
through a module-private DSH scope tag, which is not portable across separate
host and installed-package module instances. Runtime-kit selects the candidate
data-policy command only through the exact reviewed-source selector; released
and selectorless operation never invokes it. Its release-specific
target hashes bind those seams independently for 0.1.7-rc.1 and
0.2.0-rc.2; an
unknown or locally drifted checkout remains ineligible.

Both artifacts also dispatch profile reload notifications from the private
bootstrap Include's current active context. Settings mutation, package reload,
and HMR retain their root-owned reconciliation while the installed TUI keeps
denying plugin access to composition-root event capabilities. The notification
does not grant a root capability to the caller; an unavailable Include owner
rejects the reload. Native owner tests and installed Workbench acceptance cover
the welcome acknowledgement that exposed this integration boundary.

Both retained releases expose the source-bearing `agent/created` event.
The version adapter under `src/compat/` preserves repeated starts such as
clear or compact. Patch target hashes remain release-specific wherever
upstream source moved or changed.

DSH 0.1.7 and 0.2.0 write native session format v4 and rejects the retired
`source.kind = plugin` wrapper for new messages. Runtime-kit emits
`source.kind = dsh-runtime-kit` for its own context, steering, and queued
prompts on both retained releases; diagnostics still recognize the earlier
wrapper in historical session records.

Two authentication rules follow the newer release rather than the patch.
Checkout authentication lists the complete index and HEAD tree, so its output
bound scales with DSH's tracked file count. Both retained releases declare
`*.cmd text eol=crlf`, the one
sanctioned smudge boundary between an authenticated blob and its working-tree
form, so byte-level attestation accepts a working tree that is the exact
canonical CRLF form of the authenticated LF bytes and still refuses every other
difference.

A downstream patch's upstream issue or pull request belongs in its
`upstream_reference` field as the patch's removal signal;
`docs/policies/upstream-contribution.md` owns the states and their rules.

[`compatibility/nils-cli.json`](../compatibility/nils-cli.json) is authoritative
for the minimum and validated nils-cli release, consumed commands and protocols,
official release source, the primary Linux archive and seven acceptance binary
hashes, plus the macOS ARM64 archive and runtime-health companion hashes. The
validated `review-specialists` requires every delivery finding to
declare `actionable: true` or `actionable: false`; packed review acceptance
proves the former becomes one native line or file thread while the latter stays
in the summary only. The same release preserves `not-in-repository` as an exact
public policy code for existing non-symlink directories with no Git ancestor;
since #199 that answer means the session cwd carries no finish-line obligation
for any principal, while repository access, scope coverage, malformed output,
and enforcement failures remain authoritative. The v1.29.0 floor is required
because every finish-line open now sends the actual DSH process as `owner_pid`.
Earlier strict request schemas reject that field even when opening a fresh
session. The consumer never omits the owner binding to admit an older companion.
The released owner performs old-process death proof, authoritative cleanup and
quiescence, incarnation and capability rotation, and prior acceptance-evidence
invalidation before crash takeover. A live or unverifiable owner remains refused;
ordinary command termination is not cleanup proof. Existing unbound sessions
cannot gain takeover authority retroactively.

The same floor retains the tiered policy contract, non-repository governed-commit
admission, non-repository finish-line answer for any command, and the other native
contracts required by the convergence children:
the atomic `agent-session work-context set --if-absent` contract, the durable
finish-line acceptance provider, the bounded `agent-hook workspace-recovery`
inspection and handoff contracts, the restricted-role review companions, the
session-owned artifact contracts, and the profile-lifecycle health probes. An
earlier release is therefore not runtime-compatible and fails typed before
activation. The retired surfaces that this floor allowed the package to drop
are recorded in
[`compatibility/retired-surfaces.json`](../compatibility/retired-surfaces.json);
see [Retired surfaces](#retired-surfaces). A
platform may activate native health only when its exact archive, `agent-hook`,
and `agent-docs` digests are recorded. A local nils checkout or ambient
prototype binary is not release compatibility evidence.

The same manifest may carry a separate exact-head candidate validation record.
That record does not change `status`, `validated_release`, release archive
identity, or operator compatibility. It exists only to bind pre-merge
cross-repository integration to one reviewed nils source tree; promotion still
requires merge, release, artifact authentication, and a new released row. The
candidate selector is explicit and scoped to source rehearsal, so normal
runtime and smoke paths continue to authenticate only the released artifacts.
Promotion removes the completed source-candidate record.

Runtime-kit does not own a TUI composition. Agent Console DSH sessions use the
separately released DSH Workbench, which pins exact DSH, dsh-TUI, and
runtime-kit revisions in one reviewed contract and owns their acceptance and
rollback. This repository's compatibility window applies to the runtime-kit
bundle only.

Controller and lane tools are separate surfaces: the controller must not expose
`main_agent_checkpoint`, while a managed lane owns that checkpoint tool and is
forbidden from the controller's lane-management tools.

## Promotion checks

The authenticated installation closure contains every production patch package
owner as well as the public peer roots and their dependencies. Its 84 artifacts
include five unmodified native-system registry archives at version 0.1.2.
The peer packer requires `--registry-artifact-root` with those exact archives;
it verifies their pinned SHA-512 integrity and canonical package digests without
rebuilding native binaries. The independent stager authenticates all 84 archives,
then materializes the entry package and the matching native platform package.
On Linux x64, `packages` lists 81 materialized packages, `verified_packages`
lists all 84, and `skipped_optional_packages` lists the three incompatible
optional native platform packages. The pack receipt retains the full closure
in its existing `packages` field. These installation roots do not expand the
runtime-kit's public peer API.

The compatibility gate reads a clean, already-built upstream checkout. It
verifies exact Git identity, package versions, public entrypoint digests, export
kinds, and the complete selected workspace dependency closure without executing
checkout bytes.

CI keeps separate blocking `pinned` and `upstream-next` matrix rows for the
candidate headless lane. Each row
authenticates and packs the pristine upstream artifact closure, applies the
reviewed patch, rebuilds DSH, runs DSH's complete tool, LLM, and
descriptor-subprocess runtime tests and the packed runtime smoke, reverses the
patch, and proves the checkout pristine.
It then rebuilds the pristine host, starts the unpatched DSH CLI as a process,
and authenticates the unpatched build closure. The patched runtime smoke keeps
an independently installed profile package and therefore proves the
process-wide scheduler identity across package instances. CI authenticates the unpatched tools
closure by sorted path, mode, length, and bytes, so source reversal cannot leave
patched declarations, maps, extra files, or other ignored `lib/` output.
The retained non-pinned release is independently pinned and receives the same local
patch apply/reverse and packed-smoke acceptance before their peer range is
advertised. Advancing any selection therefore requires new patch hashes and
evidence; it cannot silently broaden the supported range.

Every Linux channel row authenticates the selected checkout before patching,
then rebuilds and compares its complete host closure after reversal. The
0.2.0 candidate rows also stage retained 0.1.7, apply its authenticated patch,
and run the executable tools canary without runtime-kit. Pristine 0.1.7 is
valid source-reversal evidence, but it lacks the awaited tools-finish boundary
needed by the canary.

A separate blocking macOS ARM64 lane authenticates the released nils-cli
archive, exercises the declared Darwin `verified-transient` health provider,
proves that an inherited executable file descriptor supplies the verified bytes
for a private mode-`0500` per-spawn materialization, checks post-spawn
self-resolution through descendant exit, root/current-UID temp-parent ownership
and writable-mode validation, immediate
pre-spawn identity validation, process-tree-bound identity cleanup, and
preserved cleanup failures, the 256 MiB executable
ceiling, and stable source/target identity, runs the
native tools/LLM boundary tests and a packed runtime-health smoke, then
reverses the patch and authenticates the pristine candidate checkout. The
executable rollback canary then switches to retained `0.1.7-rc.1`, applies
its authenticated patch, and runs its real tools pipeline. That
platform-scoped smoke uses DSH's real tools pipeline to prove unauthenticated
companion denial, project-health denial before model or adapter work,
same-session recovery, `runtime_kit_plus_one(41) = 42`, and absence of health
or audit state from model context. It deliberately does not claim
authoritative finish-line acceptance: nils-cli's current finish-line contract
requires Linux systemd/cgroup containment, so the complete packed smoke remains
a blocking Linux gate. Direct fdesc execution, dyld-as-executable bridging,
and directory traversal through
`/dev/fd/<directory-fd>` are deliberately not part of the contract. The lane
also preserves the nonexistent-`argv[0]` regression so an ordinary runtime
snapshot pathname fallback cannot pass unnoticed.

When nils rejects `finish-line open` with an exact, bounded exit-69 host
diagnostic, the DSH Bash denial retains its provider code and message. A
malformed envelope remains `finish-line-unavailable`; neither outcome permits
ordinary Bash to bypass the finish-line contract. macOS authoritative execution
is tracked in [nils-cli #1800](https://github.com/sympoies/nils-cli/issues/1800).

Contributor commands and staging examples are in
[`DEVELOPMENT.md`](../DEVELOPMENT.md#compatibility-validation). The architecture
guide explains the artifact, extraction, runtime boot, and benchmark trust
boundaries in more detail.

## Policy enforcement tiers

Every `dsh.policy.v1` rule in
[`policy/dsh-runtime-kit-v1.toml`](../policy/dsh-runtime-kit-v1.toml) belongs
to one of three tiers. nils-cli (from 1.28.1) owns the table in
`DshCapabilityGroup::tier()`, enforces it when the policy loads, and reports
it per rule through `agent-hook inventory` as `tier`, `override_class`
and `effective_modes.dsh`, which `doctor` reads; runtime-kit only declares the matching
`override_class` and annotates each rule with a `# tier:` line that
`test/policy-parity.test.ts` checks against the table below and, when a
companion is available, against the inventory.

| Tier | Rules | Default | Downgrade |
| --- | --- | --- | --- |
| `integrity` (A) | `dsh.owner-unclaimed`, `dsh.semantic-conflict`, `dsh.operation-lifecycle-tool`, `dsh.operation-lifecycle-stop`, `dsh.agent-scope-lock-guard`, `dsh.checkout-lease-guard`, `dsh.mcp-secret-scan` | block | none; `locked`, and nils rejects any other declaration (`tier-a-rule-not-locked`) |
| `governed-seam` (B) | `dsh.block-direct-git-commit`, `dsh.block-direct-git-worktree`, `dsh.block-direct-pr-create`, `dsh.block-unsafe-default-delivery`, `dsh.semantic-commit-body-gate`, `dsh.block-project-memory-write`, `dsh.portable-paths-scan`, `dsh.pre-edit-intent-gate` | block, naming the governed replacement | per rule to `advise` through `--policy-overrides` (see [operations](operations.md#debug-time-policy-downgrades)); `downgrade-only` |
| `reminder` (C) | `dsh.block-direct-python`, `dsh.forge-label-reminder`, `dsh.memory-write-principle-reminder`, `dsh.skill-usage-reminder`, `dsh.stop-pre-pr-reminder`, `dsh.user-prompt-agent-memory`, `dsh.agent-activity` | context, once per session | n/a; `locked`, and a reminder never blocks |

Two nils behaviours that this table changed are recorded as reduced surfaces:
an unclassifiable Bash command (nested or dynamic execution, a shell-state
preamble, an unreadable command field) now blocks only Tier A groups and the
Tier B groups whose subject the command names (`git`, `gh`/`glab`,
`semantic-commit`, an agent-memory path, a machine-local path), explaining
the gap as context for every other group; and `block-direct-python` is a
reminder that names the detected manager instead of a denial.

## Retired surfaces

[`compatibility/retired-surfaces.json`](../compatibility/retired-surfaces.json)
(`dsh-runtime-kit.retired-surfaces.v1`) is the machine-readable closeout of the
native convergence program. It records the minimum supported runtime-kit
commit, nils-cli release, and DSH releases that carry every native contract,
and one entry per surface the program touched: its category, whether it was
`removed`, `reduced`, or deliberately `retained`, the paths and identifiers
involved, the owner and contract that replace it (`dsh`, `nils-cli`, or a
retained runtime-kit workflow), the first supported versions, the
compatibility window, the rollback path, and, for retained surfaces, the
rationale. `test/retired-surfaces.test.ts` validates the schema, requires the
recorded minimums to equal the compatibility manifests, scans every file
`package.json#files` ships (the development log and plans are history) and
every normative document for each removed identifier and deleted file, and
refuses retired DSH release names in normative documentation, so a retired
behaviour cannot return as a hidden fallback without failing the suite.

## Performance budgets

The deterministic policy benchmark runs 250 warmups and two 1,000-check
measured batches. Promotion blocks when adapter p95 exceeds 5 ms, retained heap
for a batch exceeds 8 MiB, retained growth exceeds 2 MiB, or policy operations
or provider handles remain active at teardown.

The packed released-`agent-hook` benchmark performs five warmups and 25 real
sequential subprocess dispatches. Its p95 budget is 250 ms, and teardown must
leave both transport admission and live-child counts at zero.

The selected reviewed-source candidate benchmark performs three warmups and
20 full tool lifecycles. Each lifecycle contains exactly five sequential policy
subprocesses; its end-to-end p95 budget is 1,000 ms, and teardown has the same
zero-admission/zero-live-child requirement.
