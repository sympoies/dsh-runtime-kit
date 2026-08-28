---
name: deliver-dispatch-plan
description: >
  Open or resume one shared dispatch plan issue, coordinate independently
  reviewed lane PRs, integrate approved work, and close through strict gates.
---

# Deliver Dispatch Plan

## Contract

Prereqs:

- Profile: `dispatch`.
- CLI floors: `plan-issue >=1.0.13`, `plan-tooling >=1.0.1`,
  `forge-cli >=1.27.16`, `git-cli >=1.25.13`.
- The dispatch issue is either not opened yet, or the existing issue is
  the same shared plan being resumed by the orchestrator.
- Dispatch `run-state.json` is either uninitialized or reconciled.
- Shared family rules apply from
  [the plan issue family contract](references/skill-family.md).
- Internal role ordering and single-writer boundaries apply from
  `references/outcome-routing.md`.

Inputs:

- `OWNER_REPO`, `PLAN_BUNDLE`, `PLAN`, `SLUG`, optional `ISSUE`, `PROVIDER`,
  and post-close read-back paths `CLOSED_ISSUE_VIEW_JSON`,
  `CLOSED_ISSUE_JSON`, and `CLOSED_ISSUE_BODY`.
- `RUN_STATE` for the dispatch run.
- Lane assignments with `TASK_ID` / sprint / PR group, `PLAN_BRANCH`,
  exact task context, `LANE_PR_NUMBER`, and the dispatch bundle
  (`TASK_PROMPT_PATH`, `PLAN_SNAPSHOT_PATH`, `DISPATCH_RECORD_PATH`).
- Dispatch labels. GitHub uses `workflow::plan` plus
  `workflow::dispatch`; GitLab uses only `workflow::dispatch` plus bare
  `plan` because scoped labels collapse per `key::` scope.
- Lane approval URLs, review evidence paths, linked PRs, and final
  integration evidence for close-ready.
- Reviewer-owned lane outcome inputs: `LANE_REVIEW_DECISION`,
  `LANE_REVIEW_OUTCOME`, and `LANE_REVIEW_LENS_ARGS`.
- On GitHub, `REVIEW_LEDGER_FINDINGS`, the lane review's delivery-mode
  specialist merge envelope produced from admitted blocking findings only
  (including its generated empty envelope when none exist), plus
  `REVIEW_LEDGER_DISPOSITIONS` when genesis has open findings. Raw reviewer
  evidence remains separate; rejected and low/info rows never enter genesis.
- Captured terminal identity for each lane and the integration checkout:
  checkout root, branch, delivered head SHA, base ref, and
  primary-versus-managed-worktree kind.

Outputs:

- `record open|attach --profile dispatch` for source, plan, and initial
  state snapshots.
- `tracking run init --profile dispatch --execution-state-file ...`.
  Always pass `--execution-state-file`; otherwise later dispatch state
  checkpoints render a synthesized single-row ledger instead of the
  accumulative task table.
- Dispatch-level checkpoints through `tracking checkpoint --profile
  dispatch --live --post state[,session[,validation[,review]]]`.
- Final per-lane ledger repair through `plan-tooling ledger-update`.
- Independent lane review, GitHub review-loop observations, and
  orchestrator-owned merge after approval.
- On GitHub, current-head native review summaries inspected through
  `forge-cli pr reviews` and semantically dispositioned before lane approval;
  GitLab retains the outcome-note flow. The merge primitive owns observed
  convergence and provider gate mechanics.
- Strict `tracking close-ready --profile dispatch --expect-visible`, followed
  by `record close --profile dispatch` only when every lane and integration
  gate passes.
- Post-close provider read-back plus
  `record audit --profile dispatch --expect-visible` before completion.
- After all dispatch-required post-merge activation/deployment, closeout,
  archive, and evidence duties, terminal cleanup for every safe completed
  managed checkout under the [git delivery policy](../../docs/policies/git-delivery.md),
  with retained-state
  diagnostics for every unsafe one.

Failure modes:

- Stop on `run-state-stale`, `RECORD_BLOCKED`,
  `visible-completeness-failed`, or any close-ready blocker.
- Stop on provider payload privacy failures such as `local_path_present`; rewrite
  useful evidence paths to `$HOME/...` and omit remote-useless local artifact
  paths before retrying.
- Stop when `github_pending_review_exists` reports an existing pending draft
  but `data.pending_reviews[]` does not identify exactly one abandoned
  current-viewer review for the lane PR; never delete ambiguous review state.
- Stop on `ledger-rows-pending`; repair only the named task rows before
  retrying close-ready.
- Stop on typed review-convergence, native change-request, thread/task, or head
  gate failures. Read and disposition the matching evidence under the
  closed-set admission rule; on
  `review_convergence_activity_changed`, refresh lane review approval before
  retrying merge without extending the repair loop for a non-admitted concern.
- Forbidden writes: lane-scoped implementation posts by the orchestrator, lane
  review posts by lane executors, lightweight-tracking closeout rules, multiple
  shared issues for one dispatch plan, or raw lifecycle comments.
- Stop cleanup when a checkout is dirty/locked, provider merge truth does not
  match its captured delivered head, or any downstream terminal duty is still
  pending. Never force-remove ambiguous lane or integration work.

## Outcome Routing

The user selects the L3 outcome, never a lane lifecycle substep. This parent
applies `references/outcome-routing.md` to route lane
execution, plan-branch PR creation, independent review, orchestrator merge,
plan-level checkpoints, and strict closeout while keeping one writer for every
role.

Lane executors stop after implementation, validation, PR creation, and their
lane-scoped state/session/validation checkpoint. An independent reviewer owns
provider review activity and the lane review checkpoint. Only the orchestrator
may merge an approved lane PR with `--allow-non-default-base`, update
plan-level integration truth, and enter dispatch closeout.

For feature/bug lane PRs, the parent allocates a policy-owned v2 evidence
directory before production edits. When `[test_first].require = true`, the
internal lane PR create/deliver call must thread
`--test-first-evidence "$EVIDENCE_DIR"`; exempt PR kinds omit it. The CLI record
is internal workflow state, not a lane lifecycle outcome exposed to the user.

## Entrypoint

```bash
plan-tooling validate --file "$PLAN" --format text --explain

# GitHub label form. For GitLab, drop workflow::plan and keep
# workflow::dispatch plus the bare plan marker.
plan-issue --repo "$OWNER_REPO" --format json record open \
  --profile dispatch \
  --bundle "$PLAN_BUNDLE" \
  --title "$TITLE" \
  --label type::chore \
  --label area::docs \
  --label state::needs-triage \
  --label workflow::plan \
  --label workflow::dispatch \
  --label plan

plan-issue --format json tracking run init \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile dispatch \
  --bundle "$PLAN_BUNDLE" \
  --execution-state-file "$PLAN_BUNDLE/$SLUG-execution-state.md" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

plan-issue --format json tracking checkpoint \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile dispatch \
  --run-state "$RUN_STATE" \
  --live \
  --post state,session \
  --repair-dashboard

plan-tooling ledger-update \
  --execution-state "$PLAN_BUNDLE/$SLUG-execution-state.md" \
  --task "$TASK_ID" \
  --status done \
  --evidence "$LANE_PR_1"

REVIEWED_PR="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr view "$LANE_PR_NUMBER"
)"
REVIEWED_HEAD="$(
  printf '%s\n' "$REVIEWED_PR" |
    jq -er 'select(.ok == true) | .data.head_sha'
)" || exit $?
readonly REVIEWED_HEAD
# GitHub-only review-loop ledger: bundle admitted blocking findings only and
# retain raw reviewer JSONL separately. GitLab v1 has no ledger surface or merge gate.
if [ "$PROVIDER" = github ]; then
: "${REVIEW_LEDGER_FINDINGS:?set to admitted-blocking delivery findings.merged.json}"
REVIEW_LEDGER_INSPECT="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
    pr review-loop inspect "$LANE_PR_NUMBER"
)" || exit $?
REVIEW_LEDGER_STATE_TIP="$(
  printf '%s\n' "$REVIEW_LEDGER_INSPECT" |
    jq -er 'if .ok == true then (.data.state_tip_digest // "") else error("inspect failed") end'
)" || exit $?
REVIEW_LEDGER_STATE_ARGS=()
[ -n "$REVIEW_LEDGER_STATE_TIP" ] &&
  REVIEW_LEDGER_STATE_ARGS=(--expected-state "$REVIEW_LEDGER_STATE_TIP")

# Review-loop genesis: dry-run before live append and before any repair.
REVIEW_LEDGER_GENESIS_DRY_RUN="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
    pr review-loop observe "$LANE_PR_NUMBER" \
    --expected-head "$REVIEWED_HEAD" \
    "${REVIEW_LEDGER_STATE_ARGS[@]}" \
    --findings-file "$REVIEW_LEDGER_FINDINGS" \
    --dry-run
)" || exit $?
printf '%s\n' "$REVIEW_LEDGER_GENESIS_DRY_RUN" |
  jq -e '.ok == true and .data.preflight_ok == true' >/dev/null
REVIEW_LEDGER_GENESIS="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
    pr review-loop observe "$LANE_PR_NUMBER" \
    --expected-head "$REVIEWED_HEAD" \
    "${REVIEW_LEDGER_STATE_ARGS[@]}" \
    --findings-file "$REVIEW_LEDGER_FINDINGS"
)" || exit $?
REVIEW_LEDGER_STATE_TIP="$(
  printf '%s\n' "$REVIEW_LEDGER_GENESIS" |
    jq -er 'select(.ok == true) | .data.state_tip_digest'
)" || exit $?
REVIEW_LEDGER_OPEN_COUNT="$(
  printf '%s\n' "$REVIEW_LEDGER_GENESIS" |
    jq -er '[.data.state.findings[] | select(.status == "open")] | length'
)" || exit $?
fi

# On GitHub, stop here when findings are open. Repair, publish with
# `git-cli push --format json`, rerun validation
# and the affected lane review, then provide REVIEW_LEDGER_DISPOSITIONS. GitLab
# retains its outcome-note path without ledger calls.

# After independent lane review, inspect native review bodies once. Repair,
# accept with rationale, or move actionable current-head feedback to a
# follow-up before the lane approval/checkpoint is final. Stale reviews are
# informational. When summary_truncated is true, retrieve the full review body
# through provider read tooling and stop if it is unavailable. Do not poll for
# absent observed bots.
PRE_SUBMIT_PR="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr view "$LANE_PR_NUMBER"
)"
EXPECTED_REVIEW_HEAD="$(
  printf '%s\n' "$PRE_SUBMIT_PR" |
    jq -er 'select(.ok == true) | .data.head_sha'
)" || exit $?
readonly EXPECTED_REVIEW_HEAD

# Review-loop closing observation: after repair/push and before merge.
if [ "$PROVIDER" = github ] && [ "${REVIEW_LEDGER_OPEN_COUNT:-0}" -gt 0 ]; then
  : "${REVIEW_LEDGER_DISPOSITIONS:?set repaired/accepted finding dispositions}"
  REVIEW_LEDGER_CLOSE_DRY_RUN="$(
    forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
      pr review-loop observe "$LANE_PR_NUMBER" \
      --expected-head "$EXPECTED_REVIEW_HEAD" \
      --expected-state "$REVIEW_LEDGER_STATE_TIP" \
      --findings-file "$REVIEW_LEDGER_DISPOSITIONS" \
      --dry-run
  )" || exit $?
  printf '%s\n' "$REVIEW_LEDGER_CLOSE_DRY_RUN" |
    jq -e '.ok == true and .data.preflight_ok == true' >/dev/null
  REVIEW_LEDGER_CLOSE="$(
    forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
      pr review-loop observe "$LANE_PR_NUMBER" \
      --expected-head "$EXPECTED_REVIEW_HEAD" \
      --expected-state "$REVIEW_LEDGER_STATE_TIP" \
      --findings-file "$REVIEW_LEDGER_DISPOSITIONS"
  )" || exit $?
  REVIEW_LEDGER_STATE_TIP="$(
    printf '%s\n' "$REVIEW_LEDGER_CLOSE" |
      jq -er 'select(.ok == true) | .data.state_tip_digest'
  )" || exit $?
  printf '%s\n' "$REVIEW_LEDGER_CLOSE" |
    jq -e '.ok == true and ([.data.state.findings[].status] | index("open") | not)' \
      >/dev/null
fi
if [ "$PROVIDER" = github ]; then
  PRE_SUBMIT_REVIEWS="$(
    forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
      --format json pr reviews "$LANE_PR_NUMBER"
  )"
  printf '%s\n' "$PRE_SUBMIT_REVIEWS"
  printf '%s\n' "$PRE_SUBMIT_REVIEWS" |
    jq -e --arg head "$EXPECTED_REVIEW_HEAD" \
      '.ok == true and .data.head_sha == $head' >/dev/null
fi

LANE_SUBMIT_REVIEW=()
[ "$PROVIDER" = github ] &&
  LANE_SUBMIT_REVIEW=(--submit-review --expected-head "$EXPECTED_REVIEW_HEAD")
# Capture the outcome bytes once. Initial submission, guarded recovery, and
# the single retry must all use this immutable value rather than rereading a
# mutable file path. Preserve capture failures before freezing the value, and
# use `--option=value` below so hyphen-leading Markdown remains one argv value.
EXPECTED_REVIEW_BODY="$(cat "$LANE_REVIEW_OUTCOME")" || exit $?
readonly EXPECTED_REVIEW_BODY
NATIVE_REVIEW_CMD=(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json
  pr review "$LANE_PR_NUMBER"
  --decision "$LANE_REVIEW_DECISION"
  "${LANE_SUBMIT_REVIEW[@]}"
  --comment="$EXPECTED_REVIEW_BODY"
  "${LANE_REVIEW_LENS_ARGS[@]}"
  --issue "$ISSUE" --mirror-issue
)
# The independent lane reviewer owns this command block. Clear stale selector
# state, then preserve the failed command status and JSON.
unset PENDING_REVIEW_ID
set +e
NATIVE_REVIEW_JSON="$("${NATIVE_REVIEW_CMD[@]}" 2>&1)"
NATIVE_REVIEW_STATUS=$?
set -e

if [ "$NATIVE_REVIEW_STATUS" -ne 0 ]; then
  if [ "$PROVIDER" != github ] || ! printf '%s\n' "$NATIVE_REVIEW_JSON" |
    jq -e '.ok == false and .error.code == "github_pending_review_exists"' \
      >/dev/null; then
    printf '%s\n' "$NATIVE_REVIEW_JSON" >&2
    exit "$NATIVE_REVIEW_STATUS"
  fi

  # Fetch a fresh post-conflict pr reviews snapshot.
  if [ "$PROVIDER" = github ]; then
    POST_CONFLICT_REVIEWS="$(
      forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
        --format json pr reviews "$LANE_PR_NUMBER"
    )"
    # Select exactly one pending body/head match; the delete primitive then
    # proves current-viewer ownership. Keep the intended body, decision, and head.
    PENDING_REVIEW_ID="$(
      printf '%s\n' "$POST_CONFLICT_REVIEWS" |
        jq -er --arg head "$EXPECTED_REVIEW_HEAD" \
          --arg body "$EXPECTED_REVIEW_BODY" '
            select(.ok == true and .data.head_sha == $head)
            | [.data.pending_reviews[]
                | select(.state == "PENDING")
                | select(.commit_sha == $head)
                | select(.summary_truncated == false)
                | select((.summary | rtrimstr("\n")) == ($body | rtrimstr("\n")))]
            | select(length == 1)
            | .[0].id
          '
    )"
    if [ -n "${PENDING_REVIEW_ID:-}" ]; then
      DELETE_REVIEW_JSON="$(
        forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
          --format json pr pending-review delete "$LANE_PR_NUMBER" \
          --review "$PENDING_REVIEW_ID" \
          --expected-head "$EXPECTED_REVIEW_HEAD" \
          --expected-commit "$EXPECTED_REVIEW_HEAD" \
          --expected-body="$EXPECTED_REVIEW_BODY" \
          --confirm-abandoned
      )"
      POST_DELETE_REVIEWS="$(
        forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
          --format json pr reviews "$LANE_PR_NUMBER"
      )"
      printf '%s\n' "$POST_DELETE_REVIEWS" |
        jq -e --arg head "$EXPECTED_REVIEW_HEAD" \
          --arg id "$PENDING_REVIEW_ID" '
            .ok == true
            and .data.head_sha == $head
            and (.data.pending_reviews | map(.id) | index($id) | not)
          ' >/dev/null

      # Retry the unchanged command once; any nonzero result is a second rejection.
      set +e
      NATIVE_REVIEW_RETRY_JSON="$("${NATIVE_REVIEW_CMD[@]}" 2>&1)"
      NATIVE_REVIEW_RETRY_STATUS=$?
      set -e
      if [ "$NATIVE_REVIEW_RETRY_STATUS" -ne 0 ]; then
        printf '%s\n' "$NATIVE_REVIEW_RETRY_JSON" >&2
        exit "$NATIVE_REVIEW_RETRY_STATUS"
      fi
      NATIVE_REVIEW_JSON="$NATIVE_REVIEW_RETRY_JSON"
    fi
  fi
fi

printf '%s\n' "$NATIVE_REVIEW_JSON"
APPROVAL="$(
  printf '%s\n' "$NATIVE_REVIEW_JSON" | jq -er '.data.pr_comment_url'
)"
# The orchestrator merges only after approval. forge-cli owns observed quiet
# timing, native change requests, thread/task gates, and provider-head binding.
REVIEW_CONVERGENCE_ARGS=()
[ "$PROVIDER" = gitlab ] && REVIEW_CONVERGENCE_ARGS=(--review-convergence=false)
forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
  pr ready "$LANE_PR_NUMBER"
# Keep merge on the same provider head that was inspected and reviewed.
forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
  pr merge "$LANE_PR_NUMBER" --allow-non-default-base \
  --expected-head "$EXPECTED_REVIEW_HEAD" \
  "${REVIEW_CONVERGENCE_ARGS[@]}"

plan-issue --format json tracking close-ready \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile dispatch \
  --run-state "$RUN_STATE" \
  --linked-pr "$LANE_PR_1" \
  --linked-pr "$LANE_PR_2" \
  --approval "$APPROVAL" \
  --expect-visible

# Only after close-ready reports ready=true and blockers=[].
plan-issue --repo "$OWNER_REPO" --format json record close \
  --profile dispatch --issue "$ISSUE" \
  --linked-pr "$LANE_PR_1" --linked-pr "$LANE_PR_2" \
  --approval "$APPROVAL" \
  --add-label state::closed --remove-label state::needs-triage

forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json issue view "$ISSUE" --with-comments \
  >"$CLOSED_ISSUE_VIEW_JSON"
jq '{body:.data.body, comments:(.data.comments // [])}' \
  "$CLOSED_ISSUE_VIEW_JSON" >"$CLOSED_ISSUE_JSON"
jq -r .body "$CLOSED_ISSUE_JSON" >"$CLOSED_ISSUE_BODY"

plan-issue --repo "$OWNER_REPO" --format json record audit \
  --profile dispatch \
  --body-file "$CLOSED_ISSUE_BODY" \
  --comments-json "$CLOSED_ISSUE_JSON" \
  --expect-visible
```

Replace `area::docs` with the dispatch plan's primary `area::` label.

## Workflow

1. **Preflight** — run `plan-tooling validate`; when resuming, also run
   `tracking status --profile dispatch --expect-visible`. Stop on stale
   or blocked state.
2. **Provider branch** — choose labels:
   - GitHub: `workflow::plan` + `workflow::dispatch`.
   - GitLab: `workflow::dispatch` + bare `plan`.
3. **Open / resume** — open or attach the shared dispatch issue, then run
   `tracking run init` with `--execution-state-file`.
4. **Lane execution** — assign each lane its exact scope, worktree, branch,
   run state, task packet, and `PLAN_BRANCH`. The lane executor implements,
   validates, creates the plan-branch PR, posts lane state/session/validation,
   and stops ready for independent review.
5. **Independent lane review** — a different reviewer runs the generic review
   outcome with retained evidence and posts provider review activity. On
   GitHub, for every lane generate the delivery-mode findings envelope and
   append review-loop genesis at the reviewed head before any repair. A clean
   lane uses the generated empty envelope. After the repair is published, rerun
   affected lenses as closed-set closure without restarting full-diff discovery;
   only the generic review outcome's explicit new-generation conditions may
   reopen discovery. Then append the closing dispositions with exact state-tip
   and repaired-head CAS before approval. On
   GitLab, do not require ledger artifacts or call `pr review-loop`; retain the
   outcome-note path and pass `--review-convergence=false` to merge. On
   GitHub, read `forge-cli pr reviews` and disposition actionable current-head
   summaries under the closed-set admission rule; route a non-admitted new
   concern to follow-up or an explicit critical-risk handoff without extending
   the repair loop. On GitLab, retain the outcome-note path. Then finalize lane
   approval and the review checkpoint. If native submission returns
   `github_pending_review_exists`, use `data.pending_reviews[]` plus `pr
   pending-review delete` only for one exact abandoned node, refresh the
   snapshot, and retry the unchanged review once. Ambiguous or repeated failure
   stops the lane; it never downgrades to an outcome note. The lane executor
   never self-reviews. The command binds the native review to the inspected head
   with `--expected-head`.
6. **Orchestrator merge** — after approval and provider gates, the orchestrator
   merges the lane PR through `forge-cli pr merge
   --allow-non-default-base`. On GitHub, the CLI requires the closed review-loop
   ledger for that exact head. It owns observed convergence, native state,
   threads/tasks, and head binding — outdated unresolved threads are
   auto-dispositioned `stale` (`data.stale_thread_dispositions`) so only
   non-outdated threads block, and any `--allow-unresolved-threads` bypass on a
   lane requires a paired `--allow-unresolved-threads-reason`
   (`data.unresolved_threads_override_reason`). On
   `review_convergence_activity_changed`, re-read summaries, disposition them
   under the closed-set admission rule, and refresh lane approval/checkpoint
   before retrying without extending the repair loop for a non-admitted
   concern; other typed failures route to their matching read/disposition path.
   Observed convergence is GitHub-only in v1,
   so GitLab merge calls explicitly pass `--review-convergence=false` to
   neutralize any user-global GitHub policy.
   `review_convergence_head_changed` requires rebinding lane delivery evidence
   to the new head. For an ordinary head change, re-run validation and affected
   closure lenses; when the head materially changes the accepted design, public
   contract, trust boundary, or migration strategy, rerun initial scope
   selection as a new generation. Then read current-head summaries, post a new
   owner outcome, and refresh lane approval/checkpoint before retry. A reviewer
   does not merge.
7. **Dispatch checkpoints** — post plan-level state/session/validation/review
   only when orchestration truth changes across lanes.
8. **Ledger finalize branch** — before close-ready, patch any lane row not
   already updated by its lane executor.
9. **Read-back** — run `tracking status --profile dispatch
   --expect-visible` after dispatch checkpoints.
10. **Close-ready / closeout** — run the non-mutating close-ready gate. Stop on
    every blocker. On `ready: true`, write the closing summary, optionally
    repair only a stale dashboard, and call `record close --profile dispatch`.
11. **Closeout read-back** — fetch the closed provider issue with comments and
    run `record audit --profile dispatch --expect-visible`; stop unless the
    closeout role is visible and lint-clean.
12. **Terminal local cleanup** — after dispatch-required deployment,
    activation, archive, evidence, and local closeout duties, recheck each
    provider-confirmed delivered head and local checkout. Restore a clean
    primary integration checkout to base. From the primary checkout, run
    `git-cli worktree remove <path-or-slug> --format json` through the supported
    hooked shell for each safe managed lane/integration worktree; the
    target-aware lease guard must confirm no live foreign owner before removal.
    If that proof or hook is unavailable, retain the worktree. Delete a local branch only when its tip equals
    the provider-confirmed delivered head. When the merge left the primary
    checkout's default branch behind its remote, advance it with
    `git-cli sync-default --format json`. Retain and report dirty, locked,
    missing, or unverifiable state.

## Boundary

Owns:

- Plan-level orchestration, lane assignment, integration judgement,
  dispatch dashboard freshness, native-summary disposition, typed merge retry,
  approved lane integration, and strict closeout.
- Dispatch-required post-merge duties and exactly-once terminal cleanup for
  safe lane and integration checkouts after strict provider closeout/read-back.

Must not:

- Implement lane tasks, let a lane executor review or merge its own PR, close
  with any blocker, merge PRs outside the active delivery workflow, or apply lightweight tracking
  closeout rules.

Internal phases:

- Open/resume, lane execution, lane PR creation, independent review,
  orchestrator merge, and closeout follow `references/outcome-routing.md`;
  they are not separate user choices.
