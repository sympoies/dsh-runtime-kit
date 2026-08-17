---
name: deliver-plan-tracking-issue
description: >
  Open or resume one lightweight issue-backed plan tracker and carry it through
  implementation, review, PR delivery, strict closeout, and archive handoff.
---

# Deliver Plan Tracking Issue

## Contract

Prereqs:

- Profile: `tracking`.
- CLI floors: `plan-issue >=1.0.13`, `plan-tooling >=1.0.1`,
  `forge-cli >=1.25.13`, `git-cli >=1.25.13`, `review-specialists`.
- The tracking issue is absent and ready to open, or open, visible, and
  reconcilable with `run-state.json`; FSM is not blocked or stale.
- PR delivery runs the generic code-review outcome in pre-merge context with the
  full profile and posts
  native review events per
  [the review outcome posting contract](../code-review-specialists/references/REVIEW_OUTCOME_POSTING_CONTRACT.md).
  Every tracking PR runs the full gate; there is no single-author self-review
  shortcut.
- Shared family rules apply from
  [the plan issue family contract](../deliver-dispatch-plan/references/skill-family.md).
- Internal role ordering and single-writer boundaries apply from
  `references/outcome-routing.md`.

Inputs:

- `OWNER_REPO`, optional `ISSUE`, `RUN_STATE` (derived when opening a tracker;
  required when resuming `ISSUE`), `PLAN_BUNDLE`, `SLUG`,
  `BRANCH`, `PR_NUMBER`, `PROVIDER`, `BASE_REF`, and post-close read-back paths
  `CLOSED_ISSUE_VIEW_JSON`, `CLOSED_ISSUE_JSON`, and `CLOSED_ISSUE_BODY`.
- Optional `LINKED_PR` when a PR already exists and should be verified
  instead of created.
- Approval evidence for the later close-ready probe.
- Review-gate artifacts: per-lens `REVIEW_LENS`,
  `SPECIALIST_REVIEW_COMMENT_FILE`, optional GitHub `REVIEW_THREAD_FILE` for
  actionable findings, `REVIEW_DECISION`, and `DELIVERY_REVIEW_OUTCOME`
  (combined outcome body).
- On GitHub, `REVIEW_LEDGER_FINDINGS`, the delivery-mode specialist merge envelope for
  the reviewed head (including the generated empty envelope for a clean
  review), plus `REVIEW_LEDGER_DISPOSITIONS` when genesis has open findings.
- `REVIEW_OUTCOME_COMMENT`: the native review event URL produced by
  `forge-cli pr review --submit-review` (or a retained evidence path).
  `REVIEW_FINDINGS_JSON` is optional and contains finding rows when findings
  exist.
- Local terminal identity captured before merge: checkout root, branch,
  delivered head SHA, base ref, and primary-versus-managed-worktree kind.

Outputs:

- `record open|attach --profile tracking` and `tracking run init` when the
  tracker does not yet exist or has no run state.
- Progress checkpoints: `tracking checkpoint --live --post
  state[,session[,validation]]`.
- PR delivery through `forge-cli pr deliver --no-merge`, or adoption of an
  already linked PR, so the review gate runs before merge.
- Provider review activity through `forge-cli pr review`: one native GitHub
  `COMMENT` per specialist lens and one combined semantic outcome, expressed
  only through portable provider / decision / lens flags, with a
  `--mirror-issue` breadcrumb to the tracking issue. The combined outcome is a
  native GitHub approval only when an environment-owned router guarantees an
  identity independent from the PR author; otherwise it is an outcome note.
- On GitHub, current-head native review summaries read through
  `forge-cli pr reviews` and semantically dispositioned before the combined
  owner outcome. GitLab retains the outcome-note flow because native snapshots
  are GitHub-only in v1.
- Delivery checkpoint: `tracking checkpoint --live --post state,review`, whose
  `review` role records the provider review outcome URL and is posted before merge.
- Per-task ledger sync through `plan-tooling ledger-update`.
- `forge-cli pr merge` after semantic review and the issue-side review
  checkpoint and, on GitHub, a closed review-loop ledger; the CLI owns convergence,
  thread/task enforcement, ledger enforcement, and head binding.
- Strict `tracking close-ready --expect-visible`, followed by
  `record close --profile tracking` only when readiness and approval are complete.
- Post-close provider read-back plus `record audit --expect-visible`, followed
  by `plan-archive discover` and dry-run-first `plan-archive migrate` routing;
  apply remains confirmation-gated.
- After all plan-required post-merge activation/deployment, closeout, archive,
  and evidence duties, one terminal cleanup result under
  `core/policies/git-delivery.md`: safe removal/restoration, or explicit
  retained state with its failed proof and recovery command.

Failure modes:

- Stop on `run-state-stale`, `issue-evidence-missing`, `RECORD_BLOCKED`,
  `visible-completeness-failed`, PR delivery failure, or any
  `close-ready` blocker.
- Stop on provider payload privacy failures such as `local_path_present`; rewrite
  useful evidence paths to `$HOME/...` and omit remote-useless local artifact
  paths before retrying.
- Stop when `github_pending_review_exists` reports an existing pending draft
  but `data.pending_reviews[]` does not identify exactly one abandoned
  current-viewer review for this PR; never delete ambiguous review state.
- Stop on `ledger-rows-pending`; repair the named task rows with
  `plan-tooling ledger-update` before retrying the gate.
- Stop when `pr merge` fails closed on review convergence, native change
  requests, unresolved threads, unchecked tasks, or head drift. Read the
  matching provider surface, disposition the evidence, update the owner
  outcome/checkpoint when it changed, and only then retry.
- Forbidden writes: dispatch-profile posts, raw lifecycle comments, raw
  `gh pr review` / `glab mr approve` for recorded review evidence, or merging before the review
  gate and `review` checkpoint complete.
- Stop cleanup when the checkout is dirty/locked, provider merge truth does not
  match the captured delivered head, or a downstream terminal duty is still
  pending. Never force-remove or delete ambiguous local work.

## Outcome Routing

The user selects the L2 plan outcome, never tracker creation, execution,
review, closeout, or archive substeps. This parent selects those phases using
`references/outcome-routing.md` and preserves their
separate CLI write authorities.

When no tracker exists, validate the bundle, open or attach it through
`plan-issue record`, and initialize run state before implementation. When a
tracker exists, reconcile live evidence before any mutation. After delivery and
independent review, merge only after the issue-side review checkpoint and all
provider sweeps pass. Close only after `tracking close-ready` returns
`ready: true`; then run archive discovery and migration directly through
`plan-archive`, dry-run first and apply only with explicit confirmation.

## Entrypoint

```bash
plan-tooling validate --file "$PLAN_BUNDLE/$SLUG-plan.md" --format text --explain

# Open and capture a tracker only when ISSUE is absent. An explicit ISSUE is
# read back and resumed; it must never pass through record open.
PROVIDER="$(forge-cli repo view --repo "$OWNER_REPO" --format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["provider"])')"
case "$PROVIDER" in
  github) PLAN_LABEL_ARGS=(--label workflow::plan --label workflow::tracking) ;;
  gitlab) PLAN_LABEL_ARGS=(--label workflow::tracking --label plan) ;;
  *) echo "unsupported tracker provider: $PROVIDER" >&2; exit 64 ;;
esac

if [ -z "${ISSUE:-}" ]; then
  TRACKER_JSON="$(plan-issue --repo "$OWNER_REPO" --format json record open \
    --profile tracking --bundle "$PLAN_BUNDLE" --title "$TITLE" \
    --label type::chore --label area::docs \
    --label state::needs-triage \
    "${PLAN_LABEL_ARGS[@]}")"
  ISSUE="$(printf '%s\n' "$TRACKER_JSON" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["result"]["issue"]["number"])')"
  ISSUE_URL="$(printf '%s\n' "$TRACKER_JSON" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["result"]["issue"]["url"])')"

  RUN_INIT_JSON="$(plan-issue --format json tracking run init \
    --provider-repo "$OWNER_REPO" --issue "$ISSUE" \
    --bundle "$PLAN_BUNDLE" \
    --execution-state-file "$PLAN_BUNDLE/$SLUG-execution-state.md" \
    --branch "$BRANCH" \
    --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  RUN_STATE="$(printf '%s\n' "$RUN_INIT_JSON" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["payload"]["result"]["run_state_path"])')"
else
  : "${RUN_STATE:?RUN_STATE is required when ISSUE is supplied}"
  TRACKER_JSON="$(forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json issue view "$ISSUE")"
  ISSUE_URL="$(printf '%s\n' "$TRACKER_JSON" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["url"])')"
fi

plan-issue --format json tracking status \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile tracking \
  --run-state "$RUN_STATE" \
  --expect-visible

plan-tooling ledger-update \
  --execution-state "$PLAN_BUNDLE/$SLUG-execution-state.md" \
  --task "$TASK_ID" \
  --status done \
  --evidence "$EVIDENCE"

plan-issue --format json tracking run update \
  --run-state "$RUN_STATE" \
  --phase validating \
  --validation-overall pass \
  --validation-command "$VALIDATION_COMMAND" \
  --validation-status pass \
  --validation-evidence "$VALIDATION_LOG" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

plan-issue --format json tracking checkpoint \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile tracking \
  --run-state "$RUN_STATE" \
  --live \
  --post state,session,validation \
  --repair-dashboard

# Deliver the PR without merging so the review gate has a window (adopt and
# verify LINKED_PR through pr deliver existing-PR adoption when it already exists).
forge-cli pr deliver --repo "$OWNER_REPO" \
  --kind feature --title "$PR_TITLE" \
  --head "$BRANCH" --base main \
  --body-file "$PR_BODY_FILE" \
  --test-first-evidence "$EVIDENCE_DIR" \
  --no-merge --format json

# Shared read-only specialist gate (min testing + maintainability).
review-specialists scope --base "$BASE_REF" --testing --maintainability --format json

# Native review events (GitHub) per REVIEW_OUTCOME_POSTING_CONTRACT.md: one
# COMMENT per semantic lens as each lens returns, then the combined
# APPROVE/REQUEST_CHANGES outcome. The local head is the reviewed specialist
# diff; forge-cli rejects the write if the provider head has drifted.
REVIEWED_PR="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr view "$PR_NUMBER"
)"
REVIEWED_HEAD="$(
  printf '%s\n' "$REVIEWED_PR" |
    jq -er 'select(.ok == true) | .data.head_sha'
)" || exit $?
readonly REVIEWED_HEAD
SUBMIT_REVIEW=()
[ "$PROVIDER" = github ] &&
  SUBMIT_REVIEW=(--submit-review --expected-head "$REVIEWED_HEAD")
FINAL_SUBMIT_REVIEW=()
REVIEW_CONVERGENCE_ARGS=()
[ "$PROVIDER" = gitlab ] && REVIEW_CONVERGENCE_ARGS=(--review-convergence=false)

SELECTED_REVIEW_LENSES=(testing maintainability)
# Append every risk lens selected by the full pre-merge review.
REVIEW_LENS_ARGS=()
TRACKING_LENS_ARGS=()
for selected_lens in "${SELECTED_REVIEW_LENSES[@]}"; do
  REVIEW_LENS_ARGS+=(--lens "$selected_lens")
  TRACKING_LENS_ARGS+=(--review-lens "$selected_lens")
done

# Repeat this specialist block once for each returned lens: testing,
# maintainability, plus any risk lens selected by the full pre-merge review.
THREAD_FILE_ARGS=()
if [ "$PROVIDER" = github ] && [ -n "${REVIEW_THREAD_FILE:-}" ]; then
  THREAD_FILE_ARGS=(--thread-file "$REVIEW_THREAD_FILE")
fi
forge-cli --provider "$PROVIDER" pr review "$PR_NUMBER" \
  --repo "$OWNER_REPO" \
  --decision comments-only \
  "${SUBMIT_REVIEW[@]}" \
  "${THREAD_FILE_ARGS[@]}" \
  --comment-file "$SPECIALIST_REVIEW_COMMENT_FILE" \
  --lens "$REVIEW_LENS" \
  --issue "$ISSUE" --mirror-issue --format json

# GitHub-only review-loop ledger: GitLab v1 has no ledger surface or merge gate.
if [ "$PROVIDER" = github ]; then
: "${REVIEW_LEDGER_FINDINGS:?set to delivery-mode findings.merged.json}"
REVIEW_LEDGER_INSPECT="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
    pr review-loop inspect "$PR_NUMBER"
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
    pr review-loop observe "$PR_NUMBER" \
    --expected-head "$REVIEWED_HEAD" \
    "${REVIEW_LEDGER_STATE_ARGS[@]}" \
    --findings-file "$REVIEW_LEDGER_FINDINGS" \
    --dry-run
)" || exit $?
printf '%s\n' "$REVIEW_LEDGER_GENESIS_DRY_RUN" |
  jq -e '.ok == true and .data.preflight_ok == true' >/dev/null
REVIEW_LEDGER_GENESIS="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
    pr review-loop observe "$PR_NUMBER" \
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
# and the affected lenses, then provide REVIEW_LEDGER_DISPOSITIONS for the new
# head. GitLab retains its outcome-note path without ledger calls.

# Read native review bodies after specialist posting and repair. Disposition
# actionable current-head summaries before the combined owner outcome; stale
# summaries are informational. When summary_truncated is true, retrieve the
# full review body through provider read tooling and stop if it is unavailable.
PRE_SUBMIT_PR="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr view "$PR_NUMBER"
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
      pr review-loop observe "$PR_NUMBER" \
      --expected-head "$EXPECTED_REVIEW_HEAD" \
      --expected-state "$REVIEW_LEDGER_STATE_TIP" \
      --findings-file "$REVIEW_LEDGER_DISPOSITIONS" \
      --dry-run
  )" || exit $?
  printf '%s\n' "$REVIEW_LEDGER_CLOSE_DRY_RUN" |
    jq -e '.ok == true and .data.preflight_ok == true' >/dev/null
  REVIEW_LEDGER_CLOSE="$(
    forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json \
      pr review-loop observe "$PR_NUMBER" \
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
      --format json pr reviews "$PR_NUMBER"
  )"
  printf '%s\n' "$PRE_SUBMIT_REVIEWS"
  printf '%s\n' "$PRE_SUBMIT_REVIEWS" |
    jq -e --arg head "$EXPECTED_REVIEW_HEAD" \
      '.ok == true and .data.head_sha == $head' >/dev/null
fi

# Bind a routed combined native outcome to the provider head just inspected.
case "${AGENT_RUNTIME_FORGE_IDENTITY_ROUTER_REQUIRED:-}" in
  1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss])
    [ "$PROVIDER" = github ] &&
      FINAL_SUBMIT_REVIEW=(--submit-review --expected-head "$EXPECTED_REVIEW_HEAD")
    ;;
esac

# Capture the outcome bytes once. Initial submission, guarded recovery, and
# the single retry must all use this immutable value rather than rereading a
# mutable file path. Preserve capture failures before freezing the value, and
# use `--option=value` below so hyphen-leading Markdown remains one argv value.
EXPECTED_REVIEW_BODY="$(cat "$DELIVERY_REVIEW_OUTCOME")" || exit $?
readonly EXPECTED_REVIEW_BODY
NATIVE_REVIEW_CMD=(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json
  pr review "$PR_NUMBER"
  --decision "$REVIEW_DECISION"
  "${FINAL_SUBMIT_REVIEW[@]}"
  --comment="$EXPECTED_REVIEW_BODY"
  "${REVIEW_LENS_ARGS[@]}"
  --issue "$ISSUE" --mirror-issue
)
# Clear stale selector state, then preserve the failed command status and JSON.
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
        --format json pr reviews "$PR_NUMBER"
    )"
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
          --format json pr pending-review delete "$PR_NUMBER" \
          --review "$PENDING_REVIEW_ID" \
          --expected-head "$EXPECTED_REVIEW_HEAD" \
          --expected-commit "$EXPECTED_REVIEW_HEAD" \
          --expected-body="$EXPECTED_REVIEW_BODY" \
          --confirm-abandoned
      )"
      POST_DELETE_REVIEWS="$(
        forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
          --format json pr reviews "$PR_NUMBER"
      )"
      printf '%s\n' "$POST_DELETE_REVIEWS" |
        jq -e --arg head "$EXPECTED_REVIEW_HEAD" \
          --arg id "$PENDING_REVIEW_ID" '
            .ok == true
            and .data.head_sha == $head
            and (.data.pending_reviews | map(.id) | index($id) | not)
          ' >/dev/null

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
REVIEW_OUTCOME_COMMENT="$(
  printf '%s\n' "$NATIVE_REVIEW_JSON" | jq -er '.data.pr_comment_url'
)"
# Record issue-side review evidence from the native outcome, then post the final
# state + review checkpoint before merging.
plan-issue --format json tracking run update \
  --run-state "$RUN_STATE" \
  --phase ready-for-close \
  --linked-pr "$OWNER_REPO#$PR_NUMBER" \
  --review-decision approve \
  "${TRACKING_LENS_ARGS[@]}" \
  --review-outcome-comment "$REVIEW_OUTCOME_COMMENT" \
  --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

plan-issue --format json tracking checkpoint \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile tracking \
  --run-state "$RUN_STATE" \
  --live \
  --post state,review \
  --repair-dashboard

# Merge only after semantic disposition and the review checkpoint pass. The
# CLI owns observed quiet timing, native change requests, thread/task gates,
# and provider-head binding. Reuse the inspected/reviewed provider head so a
# later push cannot enter the merge.
forge-cli --provider "$PROVIDER" pr ready "$PR_NUMBER"
forge-cli --provider "$PROVIDER" pr merge "$PR_NUMBER" --method squash \
  --expected-head "$EXPECTED_REVIEW_HEAD" \
  "${REVIEW_CONVERGENCE_ARGS[@]}"

plan-issue --format json tracking close-ready \
  --provider-repo "$OWNER_REPO" \
  --issue "$ISSUE" \
  --profile tracking \
  --run-state "$RUN_STATE" \
  --linked-pr "$OWNER_REPO#$PR_NUMBER" \
  --approval "$APPROVAL" \
  --expect-visible

# Only after close-ready reports ready=true and blockers=[].
plan-issue --repo "$OWNER_REPO" --format json record close \
  --profile tracking --issue "$ISSUE" --bundle "$PLAN_BUNDLE" \
  --linked-pr "$OWNER_REPO#$PR_NUMBER" --approval "$APPROVAL" \
  --add-label state::closed --remove-label state::needs-triage

# Read back the closed provider issue body and comments, then require visible
# closeout evidence before archive maintenance.
forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json issue view "$ISSUE" --with-comments \
  >"$CLOSED_ISSUE_VIEW_JSON"
jq '{body:.data.body, comments:(.data.comments // [])}' \
  "$CLOSED_ISSUE_VIEW_JSON" >"$CLOSED_ISSUE_JSON"
jq -r .body "$CLOSED_ISSUE_JSON" >"$CLOSED_ISSUE_BODY"

plan-issue --repo "$OWNER_REPO" --format json record audit \
  --profile tracking \
  --body-file "$CLOSED_ISSUE_BODY" \
  --comments-json "$CLOSED_ISSUE_JSON" \
  --expect-visible

plan-archive discover --source-repo "$PWD" --format json
plan-archive migrate --plan "$PLAN_BUNDLE" --issue "$ISSUE_URL" --format json
```

When the caller supplies an ordinary provider issue that has not yet received
tracking lifecycle records, do not enter the resume branch yet. Read the issue
and audit its comments first. After confirming that the source, plan, and state
roles are absent, run `record attach --profile tracking` exactly once,
initialize its run state, and then resume with the resulting `RUN_STATE`. Never
attach to an issue that already carries those roles, because attachment posts a
new lifecycle set rather than resuming the existing tracker.

`forge-cli pr deliver --no-merge` creates or adopts the draft and completes its
check wait without merging, leaving the window for review. On GitHub, inspect
native summaries, append review-loop genesis before repair, and close every
finding at the repaired head; a clean review still appends genesis with the
generated empty delivery envelope. On GitLab, do not require ledger artifacts
or call `pr review-loop`; retain the outcome-note path and pass
`--review-convergence=false` to merge. On either provider, post the owner outcome
before the issue-side `review` checkpoint, then mark the PR ready and call
`forge-cli pr merge`. The merge primitive owns
the observed quiet window, complete/final native-review reads, native change
requests, thread/task gates, and provider-head binding. When `LINKED_PR` already
exists, adopt and verify it through `pr deliver` existing-PR adoption instead of
re-creating it, and record the ref with `tracking run update --linked-pr`.
Observed convergence is GitHub-only in v1, so GitLab merge calls explicitly pass
`--review-convergence=false` to neutralize any user-global GitHub policy.

Post one compact specialist review comment per lens as it returns — before any
repair — using `--decision comments-only` plus the semantic `--lens`, with
`--thread-file "$REVIEW_THREAD_FILE"` for actionable GitHub findings; the
combined delivery outcome posts last with the final decision and selected lenses.
On GitHub, read native summaries before the combined outcome; on GitLab, retain
the outcome-note path and do not invoke the unsupported snapshot. A
`summary_truncated` item requires the full review body before disposition; stop
if it cannot be read. If native submission returns
`github_pending_review_exists`, preserve the failed command status and JSON and
fetch a fresh post-conflict snapshot.
The command binds the native review to the inspected head with
`--expected-head`. Choose a recovery id only when
`data.pending_reviews[]` identifies exactly one current-viewer abandoned node
for this PR and the intended body, decision, and head remain current. Run `pr
pending-review delete`, refresh `pr reviews`, and retry the unchanged outcome
once; stop on an ambiguous node, a failed guard, or a second rejection. The generic review
outcome owns the read-only lenses and
mode selection; this
skill owns the provider writes, semantic disposition,
review-loop observations, checkpoint, and merge, and reviewer subagents never post. On
`review_convergence_activity_changed`, read `forge-cli pr reviews` again,
disposition the new evidence, refresh the final outcome/checkpoint, and retry.
For `unresolved_review_threads` or `unchecked_task_items`, call the matching
`pr review-threads list` or `pr tasks` read surface, disposition the returned
items, and retry. Outdated unresolved threads are auto-dispositioned `stale` by
`pr merge` (`data.stale_thread_dispositions`) and do not block, so only
non-outdated threads need disposition; the `--allow-unresolved-threads` bypass
now requires a paired `--allow-unresolved-threads-reason` (recorded as
`data.unresolved_threads_override_reason`). Do not duplicate quiet-period polling
in skill prose.

Plan-tracking PRs are `--kind feature` records, so when the test-first gate is
enabled (`[test_first].require = true` in a repo `.forge-cli.toml` or the
user-global `${XDG_CONFIG_HOME:-~/.config}/forge-cli/config.toml`) the deliver
above requires `--test-first-evidence "$EVIDENCE_DIR"` — the `verify`-clean
directory the policy-owned `test-first-evidence` CLI flow produces — or it fails closed with
`test_first_evidence_required`.

## Workflow

1. **Open / preflight** — validate the bundle. Open or attach the tracker and
   initialize run state when absent; otherwise run `tracking status
   --expect-visible`. Stop on stale, blocked, or non-visible evidence.
2. **Implementation / validation** — do local work, update the task ledger
   after every task transition, and checkpoint only changed roles.
3. **PR branch** — deliver with `forge-cli pr deliver --no-merge` (or adopt and
   verify `LINKED_PR` through `pr deliver` existing-PR adoption). Do not merge
   yet; the review gate runs first.
4. **Review gate** — run the generic code-review outcome in pre-merge context with the full profile (min `testing` +
   `maintainability`; add risk lenses per scope). Post each lens's specialist
   review comment through `forge-cli pr review` as it returns (native `COMMENT`
   on GitHub via `--submit-review`, semantic `--lens`; `--thread-file`
   for actionable findings). After repairs, read `forge-cli pr reviews` and
   disposition every actionable current-head summary; stale summaries are
   informational. Then post the combined delivery outcome (native GitHub
   approval only with the independent-identity capability; repeated selected
   lenses; `--mirror-issue`), per
   `REVIEW_OUTCOME_POSTING_CONTRACT.md`. Every tracking PR runs the full gate —
   there is no single-author self-review shortcut. Repair concrete findings in
   this delivery branch and rerun affected lenses before continuing. A pending
   native draft uses only the exact-node recovery above; never delete an
   ambiguous draft or replace the requested native outcome with a note.
5. **Review + final checkpoint** — set `phase=ready-for-close`, record the linked
   PR, review decision, lenses, and `--review-outcome-comment` (the provider
   outcome URL); add `--review-findings-file "$REVIEW_FINDINGS_JSON"` when findings
   exist; then post `state,review` in one live checkpoint. This issue-side
   `review` evidence is posted before merge.
6. **Merge** — mark the PR ready, then call `forge-cli pr merge` once semantic
   review and the issue-side checkpoint pass. Let the CLI enforce convergence,
   native state, threads, tasks, and head binding. On a typed failure, read and
   disposition the matching evidence; `review_convergence_activity_changed`
   requires a refreshed owner outcome/checkpoint before retry.
   `review_convergence_head_changed` requires rebinding delivery evidence to
   the new head, then re-run validation and affected review lenses, read the
   current-head summaries, post a new owner outcome, and refresh the
   validation/review checkpoint before retry.
7. **Close-ready / closeout** — run `tracking close-ready --expect-visible`.
   Stop on every blocker. On `ready: true`, write the closing summary, perform
   only controller-authorized final-role/dashboard repair, and call `record
   close --profile tracking` with linked PR and approval evidence.
8. **Closeout read-back** — fetch the closed provider issue with comments and
   run `record audit --profile tracking --expect-visible`; stop unless the
   closeout role is visible and lint-clean.
9. **Archive maintenance** — only after closeout read-back succeeds, run
    `plan-archive discover`, then the default dry-run `plan-archive migrate`;
    apply only
    after explicit confirmation and a clean plan.
10. **Terminal local cleanup** — after archive and every plan-required
    post-merge deployment, activation, evidence, or local closeout duty, recheck
    provider merge/head truth and local status. Restore a clean primary checkout
    to base, or run `git-cli worktree remove <path-or-slug> --format json` from
    the primary checkout through the supported hooked shell; the target-aware
    lease guard must confirm no live foreign owner before removal. If that proof
    or hook is unavailable, retain the worktree. Delete the local
    branch only when its tip equals the provider-confirmed delivered head,
    including after squash merge. When the merge left the primary checkout's
    default branch behind its remote, advance it with
    `git-cli sync-default --format json`. Retain and report dirty, locked,
    missing, or unverifiable state.

## Boundary

Owns:

- Delivery-scope judgement, validation strength, review-gate orchestration and
  the provider review writes (per-lens specialist comments + the combined native
  outcome), native-summary disposition, typed merge-failure repair, final
  state/review checkpoint timing, the merge, strict closeout, read-back, and
  archive routing.
- Plan-required post-merge duties and exactly-once terminal local cleanup after
  strict provider closeout/read-back.

Must not:

- Use dispatch-profile semantics, let reviewer subagents post provider comments,
  close with any blocker, archive before close read-back, or merge before the
  review gate and `review` checkpoint complete.

Internal phases:

- Open, execution, delivery, independent review, closeout, and archive phases
  follow `references/outcome-routing.md`; they are not separate user
  choices.
