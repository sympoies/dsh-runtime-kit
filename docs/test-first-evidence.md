# Test-first evidence note

The initial retained run was a module-absence setup failure: the package modules
and directories did not yet exist, so the
runner could not execute the intended assertions. This was not a meaningful behavioral red.
It must not be represented as one.

For that baseline, substitute validation is the packed DSH smoke against the
real supported Harness composition plus the final contract suite. The repair
work following provider review has its own behavioral red evidence: loadable
tests reproduced the monotonic policy-gate, bounded-resource, private snapshot,
symlink containment, public resource closure, and compatibility-manifest
failures before the corresponding production changes.

## Task 2.1 lifecycle and transport

The lifecycle implementation began with loadable behavioral regressions, not a
module-absence failure. The focused command was:

```sh
node --test \
  --test-name-pattern='caller abort joins|policy disposal|rc.7 compatibility seam' \
  test/plugin-contract.test.mjs
```

It reported 0 passing and 3 failing tests against the previous production
implementation:

- caller abort returned while its policy child was still active;
- policy disposal did not terminate or await an active child;
- only `tools/pre-execute` and `tools/result` were registered, rather than the
  six required rc.7 lifecycle extension points.

A later review-driven regression independently failed because stale post-tool
identity delegated to the remainder of the waterfall. It was made green by a
public rc.7 `PostToolDecision` block, without treating candidate output as the
authoritative result.

Testing review also found that the subprocess double made direct-child
settlement and process-tree exit the same promise. After strengthening the
assertions but before separating those signals, this affected command reported
0 passing and 3 failing tests because timeout, caller abort, and disposal all
completed before tree exit:

```sh
node --test \
  --test-name-pattern='stalled policy subprocess|caller abort joins|policy disposal stops ingress' \
  test/plugin-contract.test.mjs
```

The corrected double now settles `done` and `waitForExit()` independently. The
real rc.7 composition smoke uses the same two-phase release and proves that
both cancellation and policy-fiber disposal remain pending with one active
policy check after direct-child settlement, then complete only after tree exit.
Review also added durable-history cases for a closed step, closed turn, open
step, and reopened step; only the open positions attach successfully.

The final adversarial review found that rc.7 keeps the execution object mutable
through the pre-execute waterfall: a later listener could replace the
deep-frozen `exec.arguments` object after nils approved the original. The
focused regression reproduced an `allow` for the substituted payload before
the guard bound authorization to the exact evaluated argument reference and
the complete lifecycle correlation. A companion red reproduced the same bypass
with a different attached Agent object sharing the same session and durable
position; authorization now also binds the exact Agent reference. A second
companion red replaced the Session property on the same Agent, so authorization
also binds the exact Session and the compatibility check rederives its live
id/cwd. Focused reds also confirmed mutable parent-token and cancellation-signal
properties required exact reference binding. The packed real-DSH smoke installs
both adversarial listener variants and proves neither substituted context
reaches the tool body.

A further adversarial follow-up replaced `exec.token`. The pre-fix regression
denied the current execution but left one authorization and one correlation
under the original token; a second same-step execution then copied every bound
identity reference and replayed the leaked allow without nils. Exact
execution-object keys plus an independently captured original token now make
cleanup stable under property mutation and make authorization non-transferable.
The real rc.7 smoke also replaces the token and verifies denial, zero tool-body
executions, and zero pending markers/correlations.

Final independent review added loadable reds for six remaining contracts:

- rejected, throwing, and aborted pre-step proposals stayed executable because
  the adapter cached the proposal before the downstream decision;
- cached correlation survived live `step/end` and `turn/end` events;
- HMR attachment replayed all 100,000 old events instead of the recent suffix;
- a distinctive downstream pre-execute exception was rewritten as
  `policy-unavailable`;
- timeout and disposal remained pending forever when provider `done` and
  `waitForExit()` never settled;
- the package admitted future DSH release candidates through peer ranges.

The first focused repair run passed all six behavioral groups. A follow-up red
then showed one unknown-quiescence operation could close new admission while an
already-active sibling still authorized. Degradation now cancels all siblings
monotonically, preserves an earlier caller/timeout/disposal cause, bounds late
provider rejection safely, and never reopens capacity. Real rc.7 composition
also drives reject, throw, abort, and already-closed-step attempts: every final
result fails at the public correlation boundary with zero nils spawns, zero
tool-body executions, and zero pending state.

The last affected-only performance review added 100,000 assistant chunks after
an open step and exercised begin, match, post, and result boundaries. Before the
cursor repair those four checks revisited 400,008 events. The adapter now folds
only events after a retained count/identity anchor; repeated checks revisit at
most the anchor. Separate replacement and truncation reds require a violated
append-only attachment to remain invalid until session reattachment.

The last security review reproduced an allow marker preserved by downstream
`ask`, followed by a different call whose unknown process-tree quiescence
globally degraded transport admission. Before repair, approving the first call
still passed the guard. A monotonic transport admission epoch now invalidates
that waiting marker: approval is denied as `policy-unavailable`, no tool body is
reached, and the marker is consumed.

No hostile `tools/execute` property-mutation defense was added. rc.7 around
wrappers run after the guard and publicly permit only signal replacement; all
in-process wrappers are trusted computing base. The tested substitution
guarantee is deliberately limited to the extensible pre-execute waterfall.

## Task 3.1 parity inventory

After dependency setup, the initial owner test failed with `ENOENT` because no
DSH-owned `policy/rule-parity.yaml` existed. The completed inventory binds the
clean legacy source file digest and all 101 unique registration IDs to 27
source capability identifiers and explicit DSH/nils owners.

API review then produced a three-part behavioral red: the packed artifacts had
no exported package entrypoint, handler and relocation counts were literals
rather than derived facts, and the sole provider retirement cited unchecked
prose. Packed-install resolution plus bin execution, counter/disposition
mutation tests, and a retirement-specific negative runtime scan now own those
contracts. The exact retained source verifier reports 21 legacy handlers, 67
legacy registrations, one relocated capability, and 22 combined runtime
handler identifiers. API follow-up returned `NO_FINDINGS`.

Testing review then found three additional false-green paths: the target
capability/status/owner rows could drift together, the installed verifier was
only asked for `--help`, and provider retirement was only a partial source
substring scan. The owner suite now freezes all 27 source dispositions, keeps
an exact clean legacy manifest fixture, imports the verifier through its packed
public subpath, runs the installed binary through the complete 101/21/67/1/22
contract, and requires a mutated source to fail. Retirement evidence now scans
every packed runtime/config artifact and loads the installed package; the real
unmodified rc.7 smoke additionally inspects the composed profile plus live LLM
provider and tool registries. The strengthened smoke first failed because its
test driver had not declared the `tools` service injection, then passed after
that public dependency was made explicit. Testing follow-up returned
`NO_FINDINGS`.

Maintainability review then demonstrated that the exported verifier could
return `ok: true` for a caller-supplied inventory with no schema or capability
dispositions, because those checks lived only in repository tests. The focused
regression passed the counter case but failed the new incomplete-inventory
case. The public verifier now owns the frozen 27-disposition table, requires
active test ownership, checks retirement evidence, and verifies every rule's
target against its capability before any success result is emitted.
The first full-suite run after that repair correctly exposed a test ownership
coupling: the retirement scan treated the standalone migration verifier as a
DSH runtime-loaded module and rejected its required frozen retirement metadata.
Runtime/config classification now excludes migration tooling while retaining a
synthetic runtime-surface negative assertion and the live rc.7 graph check.
The next public-boundary mutation showed duplicate inventory rows could be
collapsed by the verifier's ID map and still return success. Both an appended
exact duplicate and a prepended conflicting-but-valid disposition duplicate
now fail explicit declared-count and unique-ID checks. Maintainability
follow-up returned `NO_FINDINGS`.

The finish-line specialist pass then found four additional false-success
boundaries. Before repair, focused tests proved that the exported inventory
validator accepted changed source provenance, digests, and rule IDs; accepted
fabricated test-owner paths; emitted the wrong installed command name; and
rejected a byte-equivalent CRLF checkout. The focused run failed four of six
tests, and the new owner-resolution suite could not import its missing public
function. The repair freezes the complete source record and exact normalized
rule-ID digest, represents every test owner as an exact repository/path/state
triple, and resolves all active owners beneath caller-supplied repository
roots. Capabilities not present on this PR's integrated base remain `planned`
with explicitly planned evidence; draft lanes do not claim active ownership
before merge. The retained fixture and inventory are pinned to LF, while the
external legacy source is canonicalized from CRLF to LF and rejects lone
carriage returns. The packed CLI now advertises its installed name and requires
both DSH and nils repository roots for active cross-repository evidence. The
same focused set then passed all ten tests.

The first data-migration and red-team follow-up found two remaining
canonicalization and provenance bypasses before delivery. `TextDecoder` removed
a leading UTF-8 BOM even though only LF materialization was declared, and the
owner resolver accepted a synthetic directory whose empty files merely matched
the frozen relative paths. New regressions reproduced both false successes.
The source verifier now rejects BOM and lone carriage returns explicitly. Test
owner repository boundaries freeze the GitHub identity and evidence commit for
both repositories; verification requires the exact Git top-level and `origin`,
an evidence commit that is an ancestor of `HEAD`, a tracked regular non-symlink
path, a clean index/worktree, and an identical evidence/HEAD blob. The synthetic
packed consumer is rejected, while the real DSH and nils worktrees verify all
three active owners.

The final adversarial pass then exercised Git's evidence-hiding mechanisms.
Repository-local clones with the authentic commits and remotes were modified
behind both `skip-worktree` and `assume-unchanged`; each verifier run rejected
the non-normal index tag. A replacement ref for the frozen DSH evidence commit
was also rejected. Provenance commands now run with replacement processing
disabled and relevant ambient Git overrides removed, any replace ref is a hard
failure, and the actual no-filter working-file object ID must equal both the
HEAD and frozen evidence blobs.

The first integration run after PR #5 was squash-merged produced a meaningful
provenance red: the verifier still required its pre-squash review head to be an
ancestor of the retained plan branch, so both owner-boundary tests failed
before reaching their intended nils assertions. The active DSH owner blob is
identical in the review head and merge result. The frozen owner boundary now
retains its original `64bf4388771f3acd13735db0456ebd6ef23f13ab` evidence
commit. A closed one-entry squash bridge additionally requires merge commit
`bfab898fe553db4857bb3aa54c5db102866cf321` in history and proves the active
owner blob is identical at evidence, squash, `HEAD`, index, and working tree.

The first complete integration suite then retained the retirement scan but
failed its obsolete four-service injection snapshot. The Stage 1 parent adds
sessions, shell preparation, and environment services while continuing to
exclude `llm` and every Anthropic dependency or runtime surface. The regression
then caught an attempted top-level `subagents` requirement: Issue #6 makes Main
Agent Mode an optional child plugin. Specialist review now follows that same
boundary, and the packed parent injection snapshot proves both child plugins
may stay pending without withholding policy or skills.

## Task 2.2 selective context

The selective-context implementation was exercised against the real packed
DSH rc.7 composition. It proved that no policy corpus appeared at startup, one
explicit `runtime_context({ intent: "project-dev" })` call returned only the
bounded `edit` documents, and the independent probe tool returned 42 for 41.

A later security review found a confused-deputy path: syntactically valid
model-selected review, delivery, or future intents reached `agent-docs` without
an explicit phase. Before the production repair, the focused context test
reported five passing and one failing test because all three disallowed intents
called the client. A shared exact allowlist now admits only
`project-dev -> edit`; the model-facing schema and subprocess transport both
enforce it, and the negative regression proves zero process creation.

The converged gates are the focused lifecycle/policy suite, the complete Node
test suite, strict JSDoc type checking, package dry-run inspection, and the
packed real-DSH rc.7 smoke. The smoke uses a public scripted LLM adapter and a
real Agent/AgentLoop to prove session, step, tool, result, turn-stop,
cancellation, and plugin-disposal behavior without an API key.

## Task 2.3 result-driven finish line

The first focused run hit the same module-absence setup failure described at
the top of this note: `src/finish-line/index.js` and
`src/finish-line/nils-client.js` did not exist. It was not a meaningful
behavioral red. The final loadable contract suites instead provide the retained
evidence for the adapter and wire boundary.

A later loadable mutation supplied the meaningful behavioral red for the final
all-foreground contract. The coordinator was temporarily changed to return
`{kind: "delegate"}` after a legacy `not-applicable` probe. This focused command

```sh
node --test \
  --test-name-pattern='legacy nils not-applicable probes fail closed' \
  test/finish-line.test.mjs
```

reported 0 passing and 1 failing test with `Missing expected rejection` at
`test/finish-line.test.mjs:333`. Removing the mutation restored the same command
to 1 passing test, proving the adapter fails closed instead of bypassing nils
supervision.

The final lifecycle review produced two further meaningful reds. Before the
open request schema changed, the nils takeover regression returned exit 65 with
`finish-line-request-invalid` instead of opening, so the focused run reported 0
passing and 1 failing test. Before the DSH wire repair, its open-focused run
reported 0 passing and 2 failing tests because no private attempt token crossed
the wire and a committed ambiguous response could not be replayed. Before the
disposal repair, the coordinator-focused run likewise reported 0 passing and 2
failing tests: teardown returned while a fire-and-forget release was gated and
did not release a remaining quiescent ledger. The green regressions now require
create-only live capability binding, exact retry recovery, conservative lease
reclamation, and release-task draining before client disposal.

The final capacity/shutdown follow-up added three more meaningful reds. The
nils crash-orphan regression first filled all 64 live-session slots with
expired pending records and received `finish-line-state-limit` for the next
open. After open recovery was added, the strengthened regression still failed
when a new session's first operation was `begin edit`. The green shared
admission path now reclaims one exact unit-bound orphan only after trusted
stable systemd quiescence and an atomic state recheck, whether admission starts
with capability open or edit begin. The DSH coordinator regression
initially observed `release`, `client-dispose` instead of the required `drain`,
`quiesced`, `release`, `client-dispose` order. The green path closes ordinary
admission, drains active nils work and authenticated cleanup, then allows only
private release until final client disposal.

The resume follow-up supplied another meaningful nils red. After a successful
authenticated release, the same stable session ID performed a new edit and
then attempted open with fresh retry material; the old session-key tombstone
returned `finish-line-session-retired` (0 passing, 1 failing). Tombstones are
now keyed to capability incarnation. The strengthened green regression proves
the fresh capability differs, the old release remains duplicate, that retry
does not remove the new incarnation, and the new incarnation can release. A
security follow-up then replayed the original released open token and exposed a
second meaningful red: nils recreated the tombstoned bearer and its tombstone-
first release path left the live session behind (0 passing, 1 failing). The
intermediate green regression rejected that replay with
`finish-line-session-retired`, while
fresh-token resume and both old/new release retries retain their intended
semantics. That intermediate token-revocation design was then removed: a
probabilistic or unbounded historical attempt set would create a durable
availability hazard even though `open` is not the authorization boundary. A
churn follow-up evicted the bounded release tombstone and reproduced the old
bearer byte-for-byte before incarnation binding (0 passing, 1 failing). The
final green engine treats the attempt token only as live-open idempotency and
binds every new open to a durable monotonic incarnation, so even identical
caller material mints a byte-distinct replacement and the retired bearer
cannot release or run against it.
Finally, a blocked fire-and-forget release plus immediate same-ID resume showed
the replacement admission completing too early (0 passing, 1 failing). The
green coordinator uses a stable identity-keyed release barrier and admits the
resume only after release completion and open-token rotation.
The packed unmodified rc.7 smoke now also creates, disposes, resumes with
`source = "resume"`, edits, executes the full Bash/stop sequence, and disposes
the same stable session ID again.

The coordinator suite proves that edit generation advances durably before the
DSH mutator body while no file payload is retained. Every foreground Bash call
then follows the two-call run sequence: nils probes without runtime metadata,
DSH prepares the bounded public shell runtime after `ready` or
`ordinary-ready`, and nils executes once before the adapter materializes the
foreground value. Exact targets may create validation evidence. Ordinary calls
advance repository generation, return `ordinary-applied`, and create no target
evidence, so prior validation becomes stale. Background Bash is denied before
execution; workdir and escalation inputs remain nils-supervised, and a legacy
`not-applicable` probe fails closed. Separate cases cover one shared capability
open, confined provider argv, sandbox facts, substituted execution identity,
session correlation pinning, runner failure poisoning, bounded stop steering,
and disposal cleanup.

The wire-client suite proves that open keeps one private retry token across an
ambiguous committed response and recovers the same nils-derived capability,
begin independently keeps its private retry token, and run sends
neither a consumer outcome nor an execution environment during the probe. It
types both `ordinary-ready` and `ordinary-applied`; execution calls preserve
exact command bytes, accept only bounded observed execution and sandbox facts,
and use the resolved command deadline rather than the short probe deadline.
Legacy `not-applicable`, malformed or replayed responses, exit-status mismatch,
caller cancellation, and plugin disposal all have fail-closed cases. Once a run
carries execution metadata, transport failure, unexpected agent-hook exit or
signal, invalid JSON, envelope, schema, or result fields, cancellation,
deadline, and disposal all enter the same recovery path. The failed-run
regressions require the client to terminate its subprocess when necessary,
invoke private nils quiesce with the exact operation identity and runner
capability, await that result before returning the original failure, and end
with zero active requests. A failed quiescence proof degrades later finish-line
admission closed. The machine-readable compatibility manifest declares the
public open/begin/run/stop wire contracts and the private quiesce/release request,
CLI-envelope, and result schemas needed for version negotiation. Private
commands remain absent from public help and completion.

The malformed execution table now includes `SIGNAL_999`, simultaneous non-null
exit code and signal, both termination discriminators null, and simultaneous
`timed_out` and `aborted`. It proves the runtime accepts exactly one non-null
`exitCode`/`signal`, restricts signals to canonical `NodeJS.Signals` names, and
keeps timeout and abort mutually exclusive instead of casting an impossible
combination into the public execution result. Each is an execution-bearing
invalid response, so the shared failed-run path performs authenticated quiesce
before returning the validation error.

The disposal regression delays an authenticated failed-run quiesce after its
primary invoke has failed. It proves the cleanup promise remains part of the
client's active lifecycle: `active` stays at one and disposal remains pending
until the quiesce response settles, after which the original run failure and
disposal both settle with `active` at zero. Two fail-closed cases then return a
semantically invalid quiesce response or leave quiesce process-tree exit
unknown. Both permanently mark the client degraded, drain active work to zero,
and reject a later open instead of reopening admission. The focused command

```sh
node --test \
  test/skills.test.mjs \
  test/finish-line.test.mjs \
  test/finish-line-client.test.mjs
```

passes 45 tests, including these cleanup-lifecycle regressions.

Linux execution containment and non-Linux rejection are owned by the
[nils finish-line contract](https://github.com/sympoies/nils-cli/blob/main/crates/agent-hook/docs/specs/agent-hook-v1.md#native-dsh-finish-line).
The nils evidence covers transient systemd cgroup teardown and the tested
descendant paths; it deliberately does not claim a general network namespace
or protection against every possible network or IPC delegation route. Its
current focused command, `cargo test -p nils-agent-hook --test finish_line`,
passes 31 tests. Those tests exercise retry-safe create-only open, expired
quiescent reclamation, unit-proven crash-orphan recovery with active and
indeterminate pending-session protection, authenticated release, the
sealed-memfd configuration, and
systemd `OpenFile` runner/config descriptor path, verified ELF interpreter,
pidfd supervisor monitoring, and recovery after a killed supervisor. The
quiesce regression proves the exact transient unit becomes inactive and
unpopulated before success and prevents a delayed descendant mutation.

The final packed smoke uses unmodified DSH `0.1.0-rc.7` plus the source-built
nils Task 2.3 binary. A real `write` advances edit generation before its native
body. The exact declared foreground validation is probed, receives a prepared
DSH runtime, fails under nils execution, and makes turn stop steer. The same
command then succeeds under nils execution and stop is allowed. An ordinary
foreground mutation subsequently advances generation under nils, stop blocks
again, and one exact revalidation restores allow. The receipt requires zero
active finish-line requests or reservations and no degraded state. Source and
argv assertions prohibit an `EXIT` trap, a deferred result queue, underlying
Bash delegation, or command rewriting. A second lifecycle persists and
releases a stable session, then a fresh runtime resumes it, performs edit and
finish-line execution, observes `session-start:resume`, and releases the new
capability incarnation without interference from the old release tombstone.

The first real packed smoke reached DSH but denied the edit because its project
fixture had created only an empty `.git` directory. The latest nils engine
correctly requires a repository identity resolvable by Git. The fixture now
initializes a real temporary repository, and the final run passed against the
clean official DSH `0.1.0-rc.7` checkout with the latest source-built
`agent-hook` and `agent-docs` binaries.

## Task 3.2 typed policy evidence

The initial nils regression added strict ingress v2 plus four dispatch cases
before the typed capability existed; all four failed with data exit 65. The
green implementation accepts only the eleven Task 3.2 `dsh.policy.v1` group
IDs for DSH `PreToolUse`, binds native Bash/write/edit/str-replace targets, and
blocks direct or nested Git commit/worktree, PR creation, Python, and missing
semantic-commit body forms. Follow-up cases prove owned/read-only workflows
remain usable and checkout leases are stable for one DSH session but reject a
foreign session before expiry. The full `cargo test -p nils-agent-hook` suite
passes.

Adversarial follow-ups first reproduced, then closed, wrapper option-arity and
depth confusion, inline environment retargeting, command/process substitution,
general-purpose interpreters, mutable message files, duplicate semantic
message/repository options, sequential HEAD changes, non-literal push
and fetch refspecs, `fetch --update-head-ok`, stdin/server-driven ref updates,
and raw merge/pull/cherry-pick/rebase/revert/am/reset/update-ref paths. A second
red/green sequence covers exported-variable, command-cache, alias, `read`,
`getopts`, tracing-hook assignments, and cwd changes before a later command.
Quoted `rebase --exec`, submodule foreach, filter-branch, and runtime Git config
options are rejected as nested command consumers. Helper-selection options on
otherwise read-only or transport commands (`upload-pack`, `receive-pack`, and
archive exec) are rejected before the read-only fast path. Default identity now
requires a private pinned primary-branch projection plus matching cached remote
HEAD; Bash or native Git-metadata drift makes the classification fail closed.
The scope-lock companion regression proves a repository-configured fsmonitor
helper is neither executed nor given ambient credentials. The focused DSH
policy suite passes 24 cases, and the companion's 28 integration cases pass.

The DSH ingress regression failed first because the transport still emitted v1
without a subject. It now emits exact session/turn/step and configured absolute
agent-docs roots in v2. The packaged policy test freezes all eleven groups in
order and rejects any retired handler reference. The canonical parity verifier
still reproduces all 101 source rows and the ordered 23-group nils fixture.

The final packed smoke installs the publishable tarball into a clean profile on
unmodified DSH `0.1.0-rc.7`, composes the packaged Task 3.2 policy with its
plus-one fixture rules, and runs the full context/edit/finish-line/revalidation
loop. The primary leg also executes `git-cli worktree add` to create a real
managed feature worktree, observes the raw default-branch merge denial, stages
the temporary fixture, and completes
`semantic-commit default-branch --dry-run`; no external provider mutation is
attempted. Independent-session legs restore the temporary primary checkout and
lease fixture before changing identities; same-session resume retains the
lease. The receipt passes with no retired handler file execution, all policy
and finish-line counters drained, 31 visible skills, and project/private/
bundled precedence intact.

## Task 3.3 privacy and native context evidence

The first nils regression selected all nine Task 3.3 groups on their intended
DSH events before `dsh.policy.v1` admitted them. The representative
`mcp-secret-scan` case failed with data exit 65 and
`policy-capability-event-unsupported`. The green engine accepts the five tool
groups only on `PreToolUse`, the three prompt/session groups only on
`UserPromptSubmit`, and the pre-PR group only on `Stop`; future Task 3.4 groups
remain unavailable. The focused `dsh_policy` suite is 31/31, with privacy
corpora for structural and value-only MCP edits, malformed braced secret
references, common and generic credential labels, machine-local paths,
quote-aware and indeterminate shell writers, inline-environment non-authority,
same-release companion validation, startup-memory redaction/bounds and
delimiter escaping, malformed health output, and a real feature-branch pre-PR
projection. The shell corpus covers known destination forms and fails closed
for unresolved writers while retaining proven read-only commands.

The DSH regressions failed before production edits because the rc.7 adapter had
no lifecycle identity API, rejected normalized `context`, and never steered a
post-finish-line reminder. The green adapter emits tool ingress v2 and strict
lifecycle v3, projects only user-authored text to a 64 KiB UTF-8 boundary, and
validates a 16 KiB normalized context boundary. It appends pre-step context only
after `enter`, folds tool context once into the exact authorized post-tool
result, and evaluates/steers stop context only after authoritative finish-line
allow. Pre-step deduplication hashes only the bounded accepted downstream user
prompt: identical concurrent proposals share one evaluation, while rewritten,
removed, or changed prompts at the same position are evaluated independently.
No prompt content is retained. The complete package suite is 111/111 and
typecheck passes. The packed bundle then installs into an unmodified rc.7
checkout and proves the real first model request contains the nils-produced
skill reminder while the complete context/edit/finish-line/delivery loop stays
green. The canonical nils local-fast gate passes docs, third-party artifacts,
formatting, and workspace clippy; its workspace nextest leg reaches the known
host-only Bubblewrap loopback `RTM_NEWADDR` limitation in the same 12 unrelated
`agent_run_inspect` cases after 2,520 passes. The complete agent-hook crate and
all Task 3.3-focused suites pass independently.

## Task 3.4 activity and operation-lifecycle evidence

The first nils regression sent strict `agent-hook.dsh-ingress.v4` post-tool
input before the adapter accepted that schema and received
`dsh-ingress-invalid`. The first DSH regression then showed the post waterfall
still delegated without sending v4. Green v4 binds the exact v2 call identity
and carries only `result.is_error`; candidate values, content, errors, and tool
output never cross the subprocess boundary. A nils lifecycle denial returns the
public rc.7 post `block` decision before downstream executes.

The managed-operation integration admits one exact native write once across a
duplicate pre request, blocks Stop while the lease is active, reauthenticates
both original and duplicate pass posts through the same idempotent completion,
and allows Stop only after authenticated broker status reports zero active and
zero uncertain operations. A locally forged terminal cache cannot satisfy Stop.
Private state contains hashed session/call correlation, exact path targets,
claim/lease identity, and idempotency material, but neither the raw call ID nor
the write body. A post-only lookup initially created an empty private directory;
that meaningful regression failed before the read path became non-creating.
The green bridge removes the whole provisional directory after a certain
denial, serializes capacity changes with a private session lock, retains at
most 64 terminal retry records ordered by a durable monotonic sequence, and
checks an existing retry identity before reserving capacity. It refuses new
admissions at a hard 128-directory ceiling rather than evicting active,
uncertain, malformed, or locked state. Fully unmanaged identity remains an
explicit no-op and every partial managed selector set blocks.

Activity projects only provider/session/turn/runtime metadata to
`agent-session activity event`; a credential-shaped prompt regression proves
the prompt never reaches that helper. DSH explicitly restores only five trusted
managed-session path/identity variables after the host subprocess scrub and
never restores bearer, checkpoint, or unrelated secret values. The packed
smoke removes the invoking agent's ambient `AGENT_SESSION_*` variables because
it creates an independent DSH session and therefore exercises the declared
unmanaged path; the managed bridge is covered by the exact companion
integration above. The focused nils suites pass 37/37 policy, 8/8 ingress, and
3/3 parity tests. DSH passes 116/116 package tests plus typecheck, and the packed
bundle completes the full acceptance receipt on unmodified DSH `0.1.0-rc.7`.

## Task 3.5 legacy-handler removal evidence

Task 3.5 is a removal-proof boundary rather than another evaluator rewrite.
The prior tasks had already changed every active parity group to
`implemented`; this task tightens the verifier so `planned` is no longer an
accepted terminal status. All 101 authenticated source rows resolve exactly to
23 nils capability groups, two stronger DSH-native groups, or the one
evidence-backed Claude-only retirement. The packaged TOML still has no
`runtime-kit.handler.v1`, Python path, or `agent-runtime-kit` reference.

The package-tree regression derives all 22 historical handler IDs from the
frozen inventory and scans every declared npm package root for matching `.py`
or `.sh` executables; the result is empty. Nils separately rejects any
`runtime-kit.handler.v1` rule for product `dsh`, while retaining the closed
capability for supported Codex/Claude compatibility. The canonical source
verifier authenticates all 101 rows at commit
`79d6b93f9df812e9cfd151ee03fc3d0ce44a0081`, and the packed rc.7 smoke observes
no retired handler execution.

## Task 4 native reviewer evidence

The initial reviewer test file could not load because `src/review/index.js` did
not exist; this is recorded as greenfield setup evidence rather than a
behavioral regression. The first useful contract red came from the review
skill: it still described one short role per call and had no strict native
`{ task, roles }` routing, fixed full role IDs, one-call parallel selection, or
same-call red-team ordering. The green skill contract now freezes quick,
focused, specialist, and red-team routing through one runtime-owned tool.

Sixteen focused runtime tests freeze the complete behavior: the exact role set
and server-owned persona bytes; caller/persona separation; bounded parallelism
across simultaneous calls with input-order result correlation; abortable queued
admission and runtime-disposal drain; DSH structured-output capture;
deterministic nils JSONL; UTF-8 byte limits; automatic critical and preselected
second-wave red-team context; rejection before child creation for malformed
routes; exact-Agent scoped read-only sandbox and tool guard; and rejection of
ordinary or forged identity claims. Direct, nested, code-mode, and delegated
mutation names are denied by the same child-scoped guard while read, grep,
glob, and the run-scoped `structured_output` conclusion remain available.

The Task 4 API and maintainability review supplied four meaningful red tests.
The prior implementation accepted arbitrary assistant prose with no
`outputSchema`, exposed a character `maxLength` while enforcing bytes, required
the caller to predict a future critical finding when selecting red-team, and
limited concurrency per call rather than per runtime. The new tests observed
missing structured fields, four simultaneous starts under a configured limit
of two, and the mismatched schema before the runtime changes made them green.
Security follow-up then found that the active semaphore still had an unbounded
waiting array. Its regression held every permit, filled the configured
runtime-global queue, and observed the next call remain admitted. The bounded
queue now rejects that call with `reviewer-overloaded`; cancellation, release,
and shutdown all return active and queued counts to zero.

API follow-up found two disposition mismatches: the quick persona said `pass`
while the closed schema said `clean`, and empty findings alone could represent
either an incomplete or escalated review. The canonical verdict is now
`clean | findings | escalate`; an empty JSONL file is findings-only evidence,
and the skill requires top-level `completed` plus all-`clean` verdicts before
calling a review clean. Focused tests cover empty escalated and partial results.
The final API follow-up aligned DSH's permissive string type with nils' actual
trimmed-nonempty contract: whitespace-only required finding fields now fail
before JSONL emission, while whitespace-only optional fields are omitted just
as the validator normalizes them.

The first packed integration run then supplied the meaningful native-lifecycle
red. An unmodified rc.7 `spawn` child deliberately called `write`. The body did
not execute, but the ordinary nils lifecycle rejected it before the reviewer
guard and finish-line repeatedly steered the child; the parent received
`partial`, the child reported `error`, and the smoke exited nonzero. The fix
lets only the exact `WeakMap`-authenticated reviewer bypass ordinary
edit/finish-line processing. Its scoped monotonic guard now supplies the
canonical pre-body denial, so the same child observes the error, answers, and
settles `completed`. The packed receipt asserts the marker file is absent, the
audit and final read-only sandbox events exist, exactly two reviewer model
requests occur, and the child is no longer live before the parent result is
reported.

The next packed run found a real rc.7 compatibility red before any reviewer
model request: DSH's supported `outputSchema` subset rejects numeric and length
keywords such as `minimum`, `maxItems`, and `minLength`. Those constraints now
remain in the runtime's defensive validator while the provider schema uses only
the rc.7-supported closed object subset. The rerun completes through the real
`structured_output` tool, writes a non-empty returned `findings_jsonl`
unchanged, and successfully executes nils `review-specialists validate` on
that artifact with one finding. The packed child uses the quick persona, so the
real structured seam also freezes the corrected quick verdict vocabulary.

The final DSH package suite passes 133/133, the focused reviewer suite passes
16/16, strict typechecking and diff checks pass, and `npm run test:smoke` packs
the current artifact into a clean profile on unmodified DSH `0.1.0-rc.7`. No
DSH source or installed dependency is patched.

Stage 1 integration preserved Issue #6/PR #7 byte-for-byte and moved specialist
review beside it as a second optional child plugin. The first integrated real
rc.7 smoke was meaningfully red: `review_specialists` was absent because the
child `apply()` returned a diagnostic object that Cordis rejected as an invalid
effect and immediately unloaded. The child now owns its effects without
returning that object; the focused reviewer suite passes 17/17 and the real
packed smoke completes the native reviewer/subagent path. Parent compatibility
preflight requires `ctx.plugin`, while `subagents.start/getProvider` remain
explicitly optional, so a host without subagents still activates the parent
policy and skills exactly as the Issue #6 contract requires.

## Task 5.1 operations evidence

The first operations run recorded the expected greenfield module-absence setup
failure. The first useful red then froze three behavior groups against the new
CLI: a full setup/update/rollback/remove matrix with unrelated profile and
private content; a manifest change between preview and apply; and a native DSH
mutation that exits after changing the profile but before the receipt commits.

Specialist review then produced seven independently meaningful red cases:
duplicate replay bypassed the profile lock; doctor ignored mutation-only
flags; changed local package bytes kept the same plan; an intermediate scope
symlink escaped fixed-path cleanup; a forged pending record could be adopted;
same-version package sources were treated as equivalent; and inherited
credentials plus raw child stderr crossed the management subprocess boundary.

Twenty-two focused tests now pass. Mutations default to dry-run, require an exact
reviewed digest to apply, reject profile or local-artifact drift before spawning
DSH, and replay the same applied digest as `duplicate` only under a live SQLite
transaction after terminal-state verification. Process exit releases that
kernel lock without stale-file deletion. Local targets are script-free packed;
their tarball SHA-256 is part of the plan, apply installs the matching private
content-addressed artifact, and rollback retains the exact previous target.
Remove retains unrelated dependencies, bundles, user patch bytes, and
private-skill content while refusing symlinked package parents. The interrupted
case leaves a durably renamed pending receipt; doctor accepts only a strict,
digest-consistent target and previews the recovered receipt before a separately
reviewed repair. Unknown, forged, or same-version/different-source terminal
state remains closed. Resolved child executables receive a minimal environment,
and failure envelopes contain stderr size/digest rather than raw stderr. The
matrix also covers an exact registry target and a same-path local source whose
new bytes must produce an update rather than a false no-op. Follow-up review
added strict SemVer rejection, an explicit source-free digest-only replay,
contradictory supplied-target rejection, absent-profile parent-symlink denial,
installed-tree tamper detection for local and registry targets, and global
reference-based artifact reclamation that retains only current/previous state
before deleting all artifacts after remove.

Stage 1 integration review added two final red cases. A timed-out fake DSH
could leave a delayed descendant alive after its direct parent died, and a
registry install could complete before the owner persisted its
`native-applied` marker. The management plane now runs every external command
under a dedicated POSIX process group whose PGID is retained by the outer
owner; timeout, normal-return descendants, and supervisor loss all settle that
group before locks unwind. Exact registry inputs are script-free
packed and digest-bound before the pending receipt and DSH mutation, just like
local inputs. The corresponding regressions prove no delayed descendant write,
and prove doctor finalization from a still-`prepared` registry receipt after
the native supervisor is lost between mutation and the second state write.
They also freeze the distinct `native-applied` path after terminal verification
fails for setup and update, preserve the update's prior snapshot, and prove
that registry doctor diagnosis/repair does not repack or consult the network.
The final red-team case supplied a small concatenated-gzip registry artifact
whose expansion exceeded 256 MiB. Operations now invokes the shared bounded
archive parser before system `tar`; the regression rejects the artifact before
materialization and then successfully reacquires both locks for the reviewed
retry.

The first real DSH operations smoke exposed one provider edge: pnpm removed the
authoritative dependency and DSH bundle row for a local file package but kept
its node_modules symlink. The corrected adapter verifies both authoritative
markers are absent, removes only the fixed runtime-kit package path, and then
rechecks complete absence. The rerun uses unmodified DSH `0.1.0-rc.7` for
setup, update, rollback, and remove; the unrelated bundle and user patch remain,
private content remains byte-identical, nils doctor confirms external DSH
registration ownership, and `git status --short` for the upstream checkout is
clean before and after.

With Task 5.1 included, the package suite passes 150/150; strict typechecking,
diff checks, the original packed runtime smoke, and the independent real DSH
operations smoke pass. No merge, release, local cutover, or legacy-runtime
retirement is authorized by this evidence.

## Task 5.2 compatibility and performance evidence

The first focused run failed at module resolution because no compatibility
contract or performance evaluator existed. Fourteen focused regressions now
freeze the required behavior: exact pinned/upstream-next selections and peer
alignment; an exact, lockfile-bound five-package non-workspace runtime closure;
typed runtime surface rejection; version-bound installed runtime exports;
digest-only built public-entrypoint inspection; fail-closed p95, per-batch
retained-heap, retained-growth, and live-resource budgets; a blocking CI matrix
containing both selected revisions; an absolute trusted pnpm launcher for
selected-peer packaging; and rejection of an unselected checkout before any
artifact is produced. They additionally require one parseable JSON document
from the advertised silent CLI and prove pre-existing-symlink rejection,
descriptor-anchored behavior after an install-scope swap, absence-only direct
extraction, and fail-closed preservation after a package-root swap. A real first
packaging attempt also supplied a useful
red: starting Corepack from the consumer selected pnpm 11.9 before `--dir`
entered DSH, whose root requires 11.7. The packer now starts in each contained
DSH package, so Corepack selects the package manager declared by that checkout.

The selected upstream repository currently resolves both
`refs/tags/dsh-v0.1.0-rc.7` and `refs/heads/master` to
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Both matrix identities are kept
explicit rather than claiming an unobserved future commit. Local checks against
the unmodified built checkout hashed the declared JavaScript and type
entrypoints for all ten public package roots without importing checkout bytes.
Pinned and upstream-next checks each returned a typed compatible report, and
Git status remained clean before and after. Packing derives all 37 reachable
DeepSeek workspace packages from the ten public roots, verifies package
identity and canonical artifact digest, and rechecks the selected Git identity
afterward. The authenticated receipt was staged as regular files into the
consumer after an `--omit=peer` install supplied only the exact external
runtime closure, without DSH registry resolution or lifecycle scripts; exact
public peer versions then passed strict typechecking and the full package suite.

Specialist review produced eleven meaningful contract reds before that result.
The source checker had executed unauthenticated build output; Git cleanliness
used ambient PATH/config and could run a repository-controlled fsmonitor;
runtime imports could fail at ESM link time before typed preflight; method shape
was not bound to installed versions; CI inspected source without installing the
selected artifacts; and the original benchmark disposed the runtime before
measuring retention. Follow-up also found manifest/loader drift, a one-batch
growth-gate bypass, an unbound pack receipt, interleaved partial version imports,
and registry-resolved DeepSeek transitives. The corrected flow hashes source,
invokes one resolved trusted Git binary with configuration disabled, validates
all ten peer identities before the first import, enforces exact manifest/loader/
peer equality, binds two measured batches, and stages the complete canonical-
digest workspace closure in both CI rows with no network resolver. The
benchmark measures live retained state before separate disposal.

Final API, maintainability, and security passes found additional concrete reds:
the documented npm wrapper polluted an otherwise typed JSON stream; Cordis was
advertised as `^4.0.1` while runtime accepted only `4.0.1`; a clean peer-omitting
consumer lacked DSH's external runtime dependencies; and staging first followed
install-ancestor symlinks, then retained pathname races around replacement and
cleanup. The public commands now use npm's silent mode, every advertised peer
and external runtime dependency is exact, and Linux staging retains verified
consumer and package-scope descriptors. Each final target must be absent;
extraction uses `O_EXCL`/`O_NOFOLLOW` beneath `/proc/self/fd/<fd>` and performs
no rename or pathname deletion. Deterministic scope/package swaps therefore
fail closed without touching the replacement tree; partial disposable consumers
are rebuilt. The final security follow-up found no material staging issue.

The controlled Node benchmark uses the production nils transport with a
deterministic in-memory provider. After 250 warmups and forced GC, two 1,000-
check batches produced p95 0.0695 ms, maximum retained heap 164,408 bytes, and
zero retained growth on this host. Active operations and provider handles were
zero before disposal and remained zero afterward. The blocking ceilings are
5 ms, 8,388,608 retained bytes per batch, 2,097,152 bytes retained growth, and
zero active/live resources. This budget isolates runtime-kit overhead; the
packed real DSH smoke remains the evidence for process startup and host
integration.

With Task 5.2 included, the package suite passes 164/164 and the focused
compatibility suite passes 14/14 against the staged selected closure. The
selected-source checks, benchmark, strict typecheck, and clean-upstream
assertions pass without a DSH patch or copied preset. The packed bundle also
passes the unmodified rc.7 smoke, including result-driven finish-line resume,
native reviewer mutation denial, skill precedence, pre-body policy denial, and
correlation-replacement rejection. Cancellation, failed-run cleanup, and
disposal remain independently covered by the focused lifecycle suites rather
than asserted by a controller that imports candidate modules.
CI action dependencies are pinned by commit. No commit, merge, release, cutover,
or legacy-runtime retirement is authorized by this evidence.

## Task 6.1 acceptance source-rehearsal evidence

The first acceptance design failed specialist review because it synthesized
scenario results from overlapping booleans, accepted replayable delivery
receipts, trusted version text instead of exact artifacts, executed mutable
ignored DSH build outputs, returned success for failed matrices, and exercised
operations with empty lookalike bundles. Regression tests captured those
bypasses before the contract and runner were rewritten.

The corrected `dsh-runtime-kit.acceptance-summary.v2` accepts ten exact
producer-owned functional scenarios and leaves semantic commit plus PR delivery
pending authorization. It rejects missing/duplicate scenario IDs, empty
evidence, unknown or tag-plus-commits nils provenance, mismatched artifact
digests, cross-repository or cross-run delivery, head mismatches, partial or
out-of-order delivery chains, and failed matrices disguised as successful CLI
results. The exact release set now contains six hashed binaries: `agent-hook`,
`agent-docs`, `git-cli`, `review-specialists`, `semantic-commit`, and
`forge-cli`.

The latest retained source rehearsal used run ID
`acceptance-source-20260819-fixed`, cloned and rebuilt DSH revision
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, and consumed an externally packed
runtime tarball with SHA-256
`7e7df22daee6e4f08124a0ddeec2ea2331f064ca86cff349b56cef6134e96f5a`.
It used two complete package variants for setup/update/rollback/remove and
passed all ten functional scenarios. A regression mutates the operations extraction
and requires a later runtime extraction to retain the authenticated bytes. The
green runner now creates each leg from a fresh extraction of the authenticated
package tarball. Each leg completed inside a transient user-systemd control
group before the runner revalidated its current control program, every
executable, the package tarball, and the pinned DSH public closure. The exact
rehearsal receipt is retained outside the repository at
`$HOME/agent-out/dsh-runtime-kit-6.1.0oK2Yy/source-rehearsal.json`; the summary reports 10 passed, 2
pending, 0 failed and remains `incomplete` with exactly three promotion
blockers: an independently authenticated nils release, disposable isolated
execution, and authorized live delivery. This evidence is scoped to one
trusted-code functional session; it makes no host-wide no-legacy-execution or
adversarial sandbox claim. No commit, PR, merge, release, cutover, or old-runtime
retirement was performed.

The external trust-root source is now implemented in private
`serenvia/sympoies-infra`. Its focused contracts validate strict candidate and
isolation receipts, released nils artifact binding, credentialless deny-all
egress execution, user-manager shutdown plus zero remaining candidate
processes, replay rejection, exact signed-head read-back, required checks, and
draft no-merge delivery. The independently hashed control manifest pins seven
candidate files; a regression forbids the trusted smoke controller from
importing any candidate-relative module. Candidate cleanup retains deny-all
egress if the disposable UID cannot be proved retired. Final provider read-back
requires exact run, trust-root, and package markers. The provider-mutating
delivery contract passes a stubbed end-to-end run. This is source evidence
only: the hosted workflow remains unexecuted and cannot produce final
acceptance until the nils changes are released and one exact candidate commit
plus live delivery are explicitly authorized.

The final source gate keeps nils' public Rust `Product` boundary at exactly
`Codex | Claude | Hermes`; DSH remains an isolated catalog projection. A
test-first integration repair replaced the pre-edit gate's obsolete generic
`session verify --product dsh` call with the additive, read-only
`agent_docs::dsh::session_intent_is_current` helper. The focused agent-docs and
agent-hook suites, clippy, and formatting pass; a workspace nextest run passes
8,566/8,566 tests across 168 binaries. Fourteen `agent_run_inspect` tests are
explicitly excluded because this host cannot create their Bubblewrap loopback
namespace; they are unrelated to DSH and are not counted as passing evidence.
The DSH package suite passes 217/217 plus typecheck, the real packed smoke and
external-tarball rehearsal pass, and the private trust root passes its full
`make validate` gate. Security and maintainability follow-ups report no
remaining material findings.

## Task 6.1 released-nils and coexistence correction evidence

The retained contract first added two focused regressions before changing the
manifest or acceptance code. The focused command
`node --test test/acceptance.test.mjs test/coexistence-contract.test.mjs`
reported 9 passed and 3 failed: the old summary accepted receipts without
coexistence markers, the compatibility manifest remained `pending-release`,
and the source/plan/state/README terminal contract still required retirement of
agent-runtime-kit. These are behavioral and retained-contract failures, not a
module-absence setup result.

The correction authenticates the official nils-cli `v1.27.0` tag and peeled
source commit, downloads the official Linux x86-64 release archive, verifies
its published SHA-256, and independently hashes the six acceptance binaries
extracted from that archive. The exact evidence is checked into
`compatibility/nils-cli.json`; no ambient nils checkout or installed binary is
used as release proof. Because v1.27.0 is the first published DSH-capable
contract, both the supported minimum and validated release are `1.27.0`.

Green acceptance now requires the existing 12-scenario receipt to carry three
additional assertions without inventing a synthetic scenario: DSH has zero
agent-runtime-kit dependency, Codex/Claude wiring remains untouched, and the
DSH run did not cross-load their hooks, skills, or session state. Operations and
packed-smoke programs prove those claims with isolated provider sentinels. The
focused suite then passed 37/37. Hosted isolated execution and its correlated
no-merge live delivery remain the final Task 6.1 promotion boundary; this source
evidence does not claim that hosted acceptance has run.

## Task 6.1 live-root isolation follow-up

Cutover preflight found that the prior smoke's temporary XDG roots concealed two
ambient fallbacks. Without an explicit docs home, `agent-docs` could derive its
catalog from the Codex or Claude Code home. Bare `agent-hook` dispatch,
finish-line, and doctor calls could likewise select the shared provider config,
policy, and state even though DSH engine support was installed. The first
focused regression run reported 50 passed and 3 failed: the package lacked a
DSH-only docs catalog, context construction accepted an absent docs home, and
policy dispatch omitted literal hook config/policy/state arguments. A separate
acceptance regression failed because a receipt without explicit hook/docs/state
isolation was still accepted.

The correction ships a compact DSH-only `agent-docs/` catalog, requires absolute
hook config/policy/state plus docs catalog/state paths at activation, and passes
the hook paths on every dispatch, finish-line, and doctor invocation. The
activation contract copies policy and catalog sources into owner-only DSH roots,
requires config/policy regular files with link count one, uses DSH's native
`headless` profile, and never implicitly migrates a Codex or Claude Code private
bundle. Packed smoke installs an invalid ambient hook config and provider-only
docs markers, then proves neither was selected.

The real operations smoke initially exposed a distinct store mismatch: its
bootstrap and managed mutations changed `HOME`, so pnpm rejected the second
installation with `ERR_PNPM_UNEXPECTED_STORE`. The smoke now preserves the
acceptance runner's single HOME for both phases. The standalone operations
matrix and packed rc.7 smoke pass with released nils-cli v1.27.0 binaries.

The final local source rehearsal, run ID
`issue1-coexistence-source-20260820b`, is `released` mode and binds runtime
package SHA-256
`af1c71a1205f5fd99cbc291a59ea0e2df679733859a5c26e54ad255f9433c1b6`.
It reports 10 passed, 2 pending, and 0 failed with exactly two honest promotion
blockers: disposable isolated execution and authorized live delivery. Its
private-project-skill scenario carries both zero-cross-loading and explicit
DSH hook/docs/state isolation evidence. This remains a local trusted-code
rehearsal, not the final hosted pass.
