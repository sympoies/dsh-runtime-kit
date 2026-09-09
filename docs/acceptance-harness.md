# External DSH acceptance harness

This runbook is for Codex or Claude Code acting as the operator outside DeepSeek
Harness (DSH). The harness installs one reviewed runtime-kit candidate into a
clean profile, gives DSH a real task without human diagnostic hints, and reads
typed result rows from `dsh-runtime-kit acceptance-drive`.

Use the exact accepted identities recorded on the owning program issue. Do not
replace a pinned DSH checkout, nils-cli release, runtime-kit commit, or package
digest with a moving branch or tag. A local run is rehearsal evidence; only the
independently controlled hosted job can promote a candidate.

## Load this runbook

Inside this repository, prepare the dedicated intent before an acceptance edit
or delivery phase:

```sh
agent-docs preflight --intent acceptance-harness --phase edit \
  --product codex --strict --require-declared-intent
```

Use `--product claude` for Claude Code. The root `AGENT_DOCS.toml` owns this
intent. The installed DSH catalog remains separate and does not duplicate it.

## Fixed inputs

Resolve these before changing a profile:

- reviewed runtime-kit commit and expected package SHA-256;
- patched and fully rebuilt DSH checkout at the pinned revision;
- one owner-only directory containing all released nils-cli companions from the
  same generation;
- an owner-only Node 24 toolchain directory;
- a clean, owner-only `DSH_HOME`, runtime root, result directory, and scenario
  workdir;
- one absolute host wrapper that executes the pinned checkout's
  `apps/cli/lib/bin.js` with Node 24, and one task wrapper that runs that host
  wrapper through `dsh-runtime-kit-launch` with the accepted runtime root.

Keep each family's runtime root and staged companion directory beneath that
family's owner-only `DSH_HOME`. The packaged fixture provider may deliberately
change and exactly restore those inputs; it refuses a companion outside the
isolated family root. Set `DSH_RUNTIME_KIT_ACCEPTANCE_PRIMARY_PACKAGE` and
`DSH_RUNTIME_KIT_ACCEPTANCE_UPDATE_PACKAGE` to the two already-built, reviewed
artifacts used by the profile-lifecycle family.

Do not use Homebrew or fnm executable paths for authenticated companions when
an ancestor is group- or other-writable. Runtime health rejects that topology
even when the binary digest is correct. Put the environment in an owner-only
shell wrapper and invoke that wrapper by absolute path; do not rely on an
opaque `export PATH=... && npm run ...` command.

## Build before packing or setup

The npm package ships TypeScript build output under `dist/`. `npm pack` does
not build, and the operations engine refuses every lifecycle script that could
build during install. From a clean reviewed checkout, run:

```sh
npm ci --ignore-scripts
npm run build --ignore-scripts
npm run build:provenance
git diff --exit-code -- compatibility/build-provenance.json
npm pack --ignore-scripts --json --pack-destination /absolute/owner-only/artifacts
```

The provenance check must be clean. If it changes, the reviewed source and its
committed build provenance are not the same candidate; stop instead of
installing the regenerated file silently. Preserve the pack receipt and hash
the produced tarball with the same canonical builder used by the accepted
control plane when an exact accepted package digest is required.

`npm run build` also makes every `package.json#bin` target executable. Skipping
that step can make the extracted artifact and the post-install tree have
different identities even though their file contents match.

## Prepare the clean profile

The runtime-kit lifecycle is preview/apply. Bind the following environment in
the owner-only wrapper used for every command:

```text
PATH=<node-24-toolchain>:/usr/bin:/bin
DSH_HOME=<clean-dsh-home>
DSH_RUNTIME_KIT_RUNTIME_ROOT=<owner-only-runtime-root>
DSH_RUNTIME_KIT_DSH_BIN=<absolute-host-dsh-wrapper>
DSH_RUNTIME_KIT_AGENT_HOOK_BIN=<companions>/agent-hook
DSH_RUNTIME_KIT_AGENT_DOCS_BIN=<companions>/agent-docs
```

`DSH_RUNTIME_KIT_DSH_BIN` is the executable identity bound by setup and doctor.
For `--dump-config`, direct tasks, and `acceptance-drive --dsh-bin`, invoke DSH
through the package's launcher so it derives the exact activated policy,
agent-docs, config, and state paths instead of relying on hand-copied values:

```sh
/absolute/dsh-runtime-kit-launch --runtime-root /absolute/runtime-root -- \
  /absolute/host-dsh-wrapper --profile headless --dump-config
```

Because the driver accepts an executable path rather than a command prefix,
put that launcher command in a second owner-only wrapper and pass its absolute
path as `--dsh-bin`.

The Codex or Claude Code process is the external harness, not the DSH runtime
principal. Its DSH host wrapper must remove inherited provider/session identity
such as `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, and every `AGENT_SESSION_*`
selector before boot. Forwarding an ordinary managed Codex or Claude principal
into nested DSH makes DSH lifecycle events target the wrong provider runtime;
the authenticated activity boundary rejects that mismatch.

One-shot DSH checkout leases intentionally outlive the process that acquired
them. Therefore each `git-repo` and `managed-worktree` DSH process uses a
different physical scratch checkout: one for success, one for the induced
failure, and one for the clean retry. Pass the third path as
`--retry-workdir`. The driver verifies its folder kind, prepares and recovers
the same family fixture there, records the distinct cwd, and proves that the
induced run and retry received byte-identical `deliberate_failure_task` argv.
Do not delete a lease, weaken the guard, or present unrelated
`WORKSPACE_FOREIGN_ACTIVE` contention as family-specific recovery evidence.
For `managed-subagent-workspace` rows, provision a distinct host-issued child
for each primary. Export the repository identity as
`DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_REPOSITORY`, the failure pair as
`DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_PRIMARY` and
`DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_WORKTREE`, and export the clean pair as
`DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_PRIMARY` and
`DSH_RUNTIME_KIT_ACCEPTANCE_MAIN_AGENT_RETRY_WORKTREE`. The retry variables
must be supplied together, and the retry primary must equal the canonical
`--retry-workdir`; otherwise fixture setup fails closed instead of reusing the
failure child.

The managed-subagent controller records `review-complete` in the primary
checkout's `controller-review.txt` only after it has reviewed the submitted
child bytes. This bounded parent-owned edit creates the primary finish-line
generation that the final exact validation must satisfy; the implementation
target in the primary remains `subagent-before`. Independently attest all three
states after DSH exits: primary target unchanged, primary review recorded, and
child target changed to `subagent-after`.

The authenticated fixture provider validates the complete primary/child
topology before its first write: the child must be a registered linked Git
worktree sharing the primary's canonical Git common directory. It then stages
the child checkout itself during the primary `prepare` or `induce` transition.
The child therefore receives its own
`AGENT_DOCS.toml`, project document, `subagent-target.txt`, and executable
`fixture-validation.mjs`; no unpublished pre-seeding step is permitted. These
child files are retained for external attestation. After rerunning child
validation, remove the disposable child through the host-owned `git-cli
worktree` lifecycle; provider cleanup does not erase independently observable
child state before attestation.

The controller must not execute Bash in the child worktree. Closing the lane
releases that child and advances its workspace generation, which would make a
controller-owned pre-close child validation stale while a post-close command
would cross the released lease. The child runs its own registered validation
before submitting; after DSH exits, the external harness reruns the same
executable directly in the retained child checkout and records its output.

Preview setup with an already-built local checkout or exact package artifact:

```sh
/absolute/dsh-runtime-kit setup --profile headless \
  --package /absolute/reviewed-runtime-kit --format json
```

Read `data.plan_digest` from that JSON, then apply the unchanged command with:

```sh
/absolute/dsh-runtime-kit setup --profile headless \
  --package /absolute/reviewed-runtime-kit --format json \
  --apply --expected-plan-digest <64-hex-plan-digest>
```

Verify the installed state and composed layer before running a task:

```sh
/absolute/dsh-runtime-kit doctor --profile headless --format json
/absolute/activated-dsh-wrapper --profile headless --dump-config
```

`doctor` must report `ok: true`, `data.status: "healthy"`, an activated package,
the pinned DSH release, and healthy authenticated companion/document probes.
The dumped composition must contain a non-empty runtime-kit bundle layer.

For Agent Console, prepare its named profile through the same setup and doctor
sequence, then give that profile to the driver. The result contract is the same;
only the DSH front door changes.

## Drive one or more tasks

Select only scenarios whose declared `folder_kind` matches the explicit
workdir. Repeated `--scenario` flags run serially. One invocation uses one
workdir; use another invocation for a different folder kind and append to the
same output file.

For `git-repo` and `managed-worktree`, start from a clean minimal scratch
repository. Commit its ignore rules before the run so every provider-owned path
listed in `compatibility/acceptance-fixtures.json` is ignored; otherwise fixture
staging itself dirties the lease anchor before DSH can exercise the scenario.
Do not reuse a developer checkout whose unrelated tracked files or local
changes can affect repository policy or attestation.

Git-writing tasks need the DSH process to update Git metadata. A linked managed
worktree keeps that metadata outside the worktree directory, so the default
`workspace-write` sandbox cannot create its index lock. For these disposable
scratch repositories only, set `DSH_PERMISSION_MODE=danger-full-access` in the
owner-only DSH wrapper before boot. The headless profile has no interactive
approval answerer; leaving `workspace-write` active makes a legitimate
`git add` fail closed instead of testing the governed commit boundary. Keep the
workdir disposable and let agent-hook, the checkout lease, and the governed
commit tool continue to enforce repository authority.

For Git rows, allocate all three physical checkouts before starting. The
success invocation receives the success checkout. The deliberate-failure
invocation receives the induced-failure checkout as `--workdir` and the clean
checkout as `--retry-workdir`. Both Git paths must report the scenario's exact
folder kind. Non-Git rows reuse one directory and must not pass
`--retry-workdir`.

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --profile headless \
  --scenario automatic-prerequisite.git-repo \
  --workdir /absolute/scenario-repository \
  --output /absolute/results/baseline.jsonl \
  --artifact-dir /absolute/results/artifacts \
  --dsh-home /absolute/clean-dsh-home \
  --dsh-bin /absolute/activated-dsh-wrapper \
  --run-id baseline-real-1
```

To make installation part of the captured run, add
`--package /absolute/already-built-runtime-kit`. The driver performs setup
preview/apply before doctor. This is the local route that can reproduce
install-only failures such as stale build provenance or an executable-role
mismatch. Without `--package`, the driver does not mutate profile lifecycle
state.

The driver does not send explanatory hints to DSH. The catalog's task text is
the complete prompt. If DSH fails, record what DSH and runtime-kit exposed; do
not add a human explanation and retry. A failure that an external harness
cannot diagnose from those surfaces is a reporting defect for the diagnostics
child of the program, not an invitation to fix it during baseline capture.

## Run the #D feature scenario pack

`compatibility/acceptance-scenario-pack.json` is the executable accounting
contract for child #D. It maps all 33 #D catalog rows into twelve capability
families and gives each row two case identities:

- `<scenario-id>.success` runs the committed `task` and requires an
  independent observation of its natural-language outcome;
- `<scenario-id>.deliberate-failure` runs the committed
  `deliberate_failure_task` in the manifest's reversible degraded setup and
  passes only when the retained structured session outcome is failed and its
  recovery marker is absent. The driver restores the fixture and reruns the
  byte-identical `deliberate_failure_task`; only that clean retry may emit the
  declared recovery marker.

Both task byte streams are SHA-256-bound in the v2 scenario pack. The operator
must not supply phase prose or a cause hint. The phase distinction comes only
from committed catalog data, and recovery—not prompt drift—changes the failure
task's result.

Use one clean scratch profile per capability family. Do not reuse a family
profile for another family, and do not run two folder kinds in one driver
invocation. Every case gets a distinct run id. The installed driver discovers
its packaged `dsh-runtime-kit-acceptance-fixture` sibling by default and binds
its identity. `--fixture-bin` remains an authenticated override for provider
development; a fresh installed-package run does not need a machine-local
provider path. The driver invokes `prepare`/`cleanup` for a success row or
`induce`/`recover`/clean-retry/`cleanup` for a deliberate-failure row. First run
the success half:

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --profile headless \
  --scenario workspace-identity.non-git \
  --phase success \
  --workdir /absolute/scenario-directory \
  --output /absolute/results/feature-pack.jsonl \
  --artifact-dir /absolute/results/artifacts \
  --dsh-home /absolute/family-dsh-home \
  --dsh-bin /absolute/activated-dsh-wrapper \
  --run-id workspace-identity-non-git-success-1
```

Then run the failure half with a different id. The packaged fixture provider
applies only that family's `deliberate_failure.induction` and preserves the
exact inverse state for recovery:

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --profile headless \
  --scenario workspace-identity.non-git \
  --phase deliberate-failure \
  --workdir /absolute/scenario-directory \
  --output /absolute/results/feature-pack.jsonl \
  --artifact-dir /absolute/results/artifacts \
  --dsh-home /absolute/family-dsh-home \
  --dsh-bin /absolute/activated-dsh-wrapper \
  --run-id workspace-identity-non-git-failure-1
```

The corresponding Git form adds the distinct clean checkout:

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --profile headless \
  --scenario workspace-identity.git-repo \
  --phase deliberate-failure \
  --workdir /absolute/workspace-identity.git-repo-failure \
  --retry-workdir /absolute/workspace-identity.git-repo-retry \
  --output /absolute/results/feature-pack.jsonl \
  --artifact-dir /absolute/results/artifacts \
  --dsh-home /absolute/family-dsh-home \
  --dsh-bin /absolute/activated-dsh-wrapper \
  --run-id workspace-identity-git-repo-failure-1
```

The driver selects the catalog's digest-bound failure prompt without altering
it and rejects a marker-only or ordinary-success response. After the induced run stops at the
typed boundary, the external harness invokes `dsh-runtime-kit diagnose` without
a human cause hint and derives `code`, `component`, `evidence_reference`,
`next_action`, and `observable_state_check` from the result's diagnostic bundle.
The attestation append rejects diagnosis fields that do not match that exact
failed result.

`compatibility/acceptance-fixtures.json` is the public fixture ownership
contract. Its twelve family recipes cover every `#D` scenario exactly once,
name only bounded relative fixture files, select one closed failure kind, and
declare the fixed typed operation sequence for all four transitions. The
provider never executes manifest shell text. It writes an
`acceptance-fixture.json` plus the family inputs into the scenario workdir and
retains private, digest-bound transition receipts below the family DSH home,
keyed by a digest of the canonical workdir so induced and retry fixtures cannot
redirect or overwrite one another.
Existing caller paths fail as collisions. Cleanup removes digest-identical
provider scaffolding but retains the declared family inputs so the external
harness can inspect task mutations after the driver returns. Those retained
paths remain provider-owned across the phase pair: after the success
attestation, the next `success` to `deliberate-failure` transition resets only
those state-bound paths to their typed baseline. Any other phase transition,
workdir change within one fixture state, symlink, or ownership drift fails closed. The harness discards
the isolated scenario directory only after the final failure attestation.

The fixture provider receives only bounded arguments: `--schema`, `--stage`,
`--phase`, `--family`, `--scenario`, and `--profile`; the workdir is its current
directory and `DSH_HOME` selects the isolated family home. It must return one
strict JSON envelope with schema
`dsh-runtime-kit.acceptance-fixture-result.v1`, `ok: true`, matching identity
fields, `status: "pass"`, and one or more portable `{kind, reference, sha256}`
evidence rows. The driver refuses a missing, changed, non-executable, malformed,
or mismatched provider. A deliberate-failure result passes only when induction
produced a failed structured outcome, recovery succeeded, the byte-identical
`deliberate_failure_task` then passed as a clean retry, and cleanup succeeded.
All twelve failure kinds are executable: workspace lease ownership, governed
commit ordering, prerequisite digest, companion identity, authoritative
validation ordering, host workspace issuance, protected destination,
restricted-role mutation, artifact retrieval identity, lifecycle plan digest,
dispatcher executable role, and retired-surface invocation. Each non-global
fault is selected through a provider-owned phase input that the committed task
must read; recovery restores that input's exact prior bytes.

For provider development, override discovery with an absolute executable:

```sh
dsh-runtime-kit acceptance-drive ... \
  --fixture-bin /absolute/dsh-runtime-kit-acceptance-fixture
```

After each driver process returns, the external Codex or Claude harness—not the
DSH task—inspects the declared file, Git state, receipt, artifact, process,
lease, worktree, composed tree, or runtime-health state. It writes one bounded
attestation JSON and appends it through the driver:

```json
{
  "schema_version": "dsh-runtime-kit.acceptance-harness-attestation.v1",
  "run_id": "workspace-identity-non-git-success-1",
  "scenario_id": "workspace-identity.non-git",
  "phase": "success",
  "status": "pass",
  "observable_state": {
    "kind": "file-content",
    "reference": "workspace-identity.txt",
    "sha256": "<64 lowercase hex>",
    "summary": "The independently read file contains non-git-ok and no repository was created."
  }
}
```

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --output /absolute/results/feature-pack.jsonl \
  --attest /absolute/results/attestation.json
```

A `deliberate-failure` attestation adds exact `diagnosis` fields and a passing
`recovery` object with a portable evidence reference. The append rejects an
absolute/home path, a mismatched or non-passing result, an incomplete diagnosis,
and a second attestation for the same run/scenario/phase. It never edits an
earlier row.

After all families and folder kinds finish, append the aggregate proof:

```sh
/absolute/dsh-runtime-kit acceptance-drive \
  --output /absolute/results/feature-pack.jsonl \
  --summarize-pack
```

`dsh-runtime-kit.acceptance-drive-pack-summary.v1` passes only with all 66
distinct case ids, passing driver rows, passing external attestations, and
distinct result run ids. Retain failed attempts in the JSONL; fix only an
in-boundary defect already recorded on the child issue, recover through the
manifest action, and append the new run instead of truncating history.

## Diagnose a headless failure

After the failing DSH invocation, use the same scratch environment and profile:

```sh
/absolute/dsh-runtime-kit diagnose --profile headless --format json \
  --bundle /absolute/owner-only/results/diagnostic-bundle
```

The JSON is `dsh-runtime-kit.diagnostic-bundle.v1`. Its
`session_outcome` is `dsh-runtime-kit.session-outcome.v1` and names the stable
failure code, owning component, portable receipt reference, and next action.
Read that record first. Then inspect only the referenced section: `doctor` and
`native_runtime_health`, `policy.rules`/`policy.decisions`,
`operation_receipts`, or the bounded `session.typed_errors` and
`session.finish_line` projection. Missing owner evidence is explicitly
`unavailable`; absence never means success.

The composed profile is a key/type tree rather than raw configuration values.
Executables are represented by names, hashes, byte counts, and executable
roles. Policy decisions and typed session events are bounded tails. The
shareable JSON replaces credentials and machine-local absolute paths; the
bundle writes `diagnostic.json` and `session-outcome.json` with mode `0600` and
returns their bundle-relative names and hashes. Never attach the original
session transcript or companion configuration to a provider issue.

For a failed driver run, add a deterministic local draft without submitting:

```sh
/absolute/dsh-runtime-kit acceptance-drive ... \
  --report-issue /absolute/owner-only/results/heuristic-issue.md
```

The draft follows `docs/policies/heuristic-error-inbox.md` and merely suggests
`workflow::heuristic-records`. A human or explicitly authorized delivery flow
must review and submit it. The driver contains no provider mutation step.

The runtime-health failure runs retain the pre-model
`HealthProbeFailure` code from command stderr through an exact allowlist. The
driver restores the companion mode, reruns doctor through normal activation,
and executes the byte-identical failure task as its clean retry before
returning one paired result row.

## Result contract

The output is append-only JSONL. Every selected scenario produces one
`dsh-runtime-kit.acceptance-drive-result.v1` row, followed by one
`dsh-runtime-kit.acceptance-drive-summary.v1` row for the invocation. A rerun
appends a new run id and never replaces prior evidence.

A result row reports:

- scenario/catalog owner, profile, workdir and declared folder kind;
- `stage`: `profile-setup`, `profile-doctor`, `scenario-precondition`, or
  `dsh-task`;
- `status`: `pass`, `fail`, or `precondition-unmet`;
- DSH argv, exit code, signal and duration;
- SHA-256/byte-count pointers to bounded stdout and stderr artifacts;
- new or changed DSH session transcript pointers and runtime-kit state receipts;
- observed policy action/rule markers when the session transcript exposes them;
- expected marker/reminders, missing reminders, and forbidden outcomes seen.
- SHA-256 and filesystem identity for the DSH and runtime-kit executables, plus
  successful setup/doctor command artifacts and plan digest when `--package`
  is used.

The result row is the index. Read the referenced stdout, stderr, transcript, or
receipt only when the row says it is relevant. Do not paste raw local absolute
paths or unredacted transcripts into a provider comment; use `$HOME/...` for a
useful retained path and summarize private output.

`precondition-unmet` is a typed result, not a driver crash. Examples are an
unhealthy/uninstalled profile, a setup identity refusal, or a workdir whose
actual kind differs from the selected scenario. A missing success marker, a
non-zero DSH exit, an expected reminder that never appeared, or a forbidden
outcome produces `fail`.

`pass` is the DSH execution-protocol result: the command exited cleanly, the
task's success marker was reported, required structured reminder evidence was
seen, forbidden output was absent, and every captured transcript was scanned.
It is not the external harness's independent attestation of the natural-language
`expected.observable_outcome`. The row therefore declares
`outcome_verification.external_harness_verification_required: true`. Before
accepting a scenario, Codex or Claude must inspect the named file, git, receipt,
or provider state and record that observation in the child issue. A marker-only
row never promotes a candidate by itself.

Legacy `observed.policy_decisions` remains the additive-compatible transcript
projection. The row now also points to a redacted diagnostic bundle whose
policy section reads the activated agent-hook inventory and bounded trace. When
an installed generation exposes neither source, it says `unavailable`; it never
invents an allow.
Corrupt, truncated, oversized, over-deep, or otherwise unscannable evidence
fails the scenario with a typed capture/scan code instead of silently becoming
an empty transcript.

## Direct task and failure reading

For a one-off task outside the driver, the equivalent DSH call is:

```sh
/absolute/activated-dsh-wrapper --profile headless "<complete task text>"
```

DSH prints the final assistant message to stdout and reasoning/progress to
stderr. Persistent rc.1 session logs are normally compressed as
`$DSH_HOME/sessions/<workspace>/session-*/session.jsonl.zstd`; the driver also
recognizes older workdir `.dsh/sessions/` and `.sessions/` layouts. Runtime-kit lifecycle state is under
`$DSH_HOME/runtime-kit/state/`; `doctor --format json` is the supported summary
surface.

Read failures in this order:

1. acceptance result `stage`, `status`, and typed `error.code`;
2. captured exit/signal and stdout/stderr artifact hashes;
3. referenced operation state/receipt and session transcript;
4. a fresh `doctor --profile <name> --format json` and `--dump-config`.

An install-only identity failure occurs before DSH can run a task. The driver
captures it only when `--package` is supplied; otherwise the failing setup
command is separate evidence. Hosted acceptance remains the promotion proof
because it installs the package under the independent operations engine and
trust root after merge.

## Restart and rollback

Use a new `--run-id` and the same output path for a restart. Never truncate the
JSONL or reuse an artifact filename. A run that stopped after a setup failure
may require `doctor --repair`; follow its preview/apply plan and do not infer a
repair from filesystem state.

The driver never rolls back or removes a profile automatically. Running it
without `--package`, deleting its result directory, or removing the driver from
a later package leaves the installed profile untouched. Profile rollback and
removal remain explicit preview/apply operations through `dsh-runtime-kit`,
followed by `doctor` and a direct DSH boot of the resulting profile.

## Promotion boundary

For the owning child issue, retain the scripted-provider row that proves the
driver and the real-provider row produced by Codex or Claude Code acting alone.
Record failures without repairing them outside the child's scope. After the PR
merges, create the signed same-tree review anchor, reproduce the package digest,
purely repin the hosted control manifest, and run the hosted workflow. A pure
repin does not require reinstalling the acceptance runner; only a controller
script change does.
