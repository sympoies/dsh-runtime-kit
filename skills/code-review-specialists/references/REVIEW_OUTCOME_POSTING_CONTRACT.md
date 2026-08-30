# Review Outcome Posting Contract

Use this contract when a review workflow needs provider-visible PR/MR review
activity for either a single-lens quick-finding/specialist report or a combined
delivery-owner outcome. `review-specialists` is the only report renderer, and
`forge-cli pr review` is the only provider primitive below an optional
environment-owned publisher. On GitHub finding reports pass `--submit-review`
so each post is a native
`COMMENT` pull request review event (the `#pullrequestreview-` object) authored
by the active provider identity. A combined delivery-owner outcome becomes a
native `APPROVE` / `REQUEST_CHANGES` review only when an environment-owned
router guarantees an identity independent from the PR author; otherwise it is
an outcome note with the same semantic decision and lenses. On GitHub,
actionable findings that need owner
changes should be passed as `--thread-file` so they become native, resolvable
review threads under the same review event; clean or informational reviews omit
`--thread-file` and keep the summary-only review body. GitLab has no equivalent
single review event or resolvable-thread creation surface, so it omits
`--submit-review` and `--thread-file` and posts an outcome note (provider parity
is preserved by the guards in the snippets below).

The canonical provider artifact is the `provider-review` profile: the marker,
metadata, and exact five-column findings table are one contract. `pr-comment`
is a compatibility alias for that profile, not a second renderer. Never hand
write a bullet-list alternative or transform the rendered table before
publication.

Reviewer subagents remain read-only. The owning parent, dispatch, or delivery
workflow writes every provider-visible comment. Quick-finding and specialist
review comments are pre-disposition `comments-only` reports posted after one
lens returns. A clean quick pass skips that redundant progress post and appears
once in the final outcome with `--lens quick`. Combined
delivery-owner outcomes are post-disposition comments posted after the owner has
synthesized findings, decided repairs or tradeoffs, and chosen the final review
decision.

## Canonical Report Artifacts

Render the complete body and actionable thread file from the same admitted,
merged findings. Keep raw reviewer output as evidence; it is not a provider
comment body.

```bash
review-specialists bundle \
  --mode delivery \
  --input "$REVIEW_FINDINGS_JSONL" \
  --out-dir "$REVIEW_BUNDLE_DIR" \
  --profile provider-review \
  --repo "$OWNER_REPO" \
  --ref "$EXPECTED_REVIEW_HEAD" \
  --reviewable "$REVIEWABLE" \
  --lens "$REVIEW_LENS" \
  --lens-verdict "$REVIEW_LENS_VERDICT" \
  --scope "$REVIEW_SCOPE" \
  --evidence-reviewed "$REVIEW_EVIDENCE" \
  --format json

REVIEW_COMMENT_FILE="$REVIEW_BUNDLE_DIR/provider-review.md"
REVIEW_THREAD_FILE="$REVIEW_BUNDLE_DIR/review-threads.json"
```

Before any GitHub publication, validate the immutable body snapshot and diff
anchors. Add `--thread-file` only when the generated array has actionable
entries; a clean `[]` means omit the flag.

```bash
forge-cli --provider github --repo "$OWNER_REPO" --format json \
  pr review validate "$PR_NUMBER" \
  --check-diff \
  --specialist-report \
  --comment-file "$REVIEW_COMMENT_FILE" \
  "${THREAD_FILE_ARGS[@]}"
```

## Actionable Finding Threads

Use `--thread-file` only for concrete, actionable findings that require a code,
doc, test, or config change and can be resolved after the owner handles them.
Do not create threads for pass/no-finding reports, summary-only approvals,
informational notes, accepted residual risks, or already-repaired follow-up
summaries. Those stay in the review body.

The thread file is a JSON array. Each item must include `path` and `body`; add
`line` for line-level comments, or omit it for a file-level thread. Optional
fields are `side`, `startLine`, `startSide`, and `subjectType`. Keep bodies
compact and specific enough that the owner can fix and then resolve the thread:

```json
[
  {
    "path": "src/lib.rs",
    "line": 42,
    "body": "This branch can leave the pending review behind if submit fails. Add cleanup coverage for the final submit step."
  }
]
```

`forge-cli` validates this file before provider mutation, caps it at 256 KiB
and 50 threads, caps each path at 1024 bytes and each body at 16 KiB, applies
the local-path / escaped-control privacy guards, and rejects invalid input with
`invalid_review_thread_spec`. If a thread or submit mutation fails after the
pending GitHub review is created, `forge-cli` attempts to delete that pending
review before returning the backend error.

## Cross-Run Thread Idempotency

Re-posting the same finding threads against an unchanged head is safe. On
GitHub, `pr review --submit-review` is idempotent across runs: before creating
threads it reads the PR's existing review threads and, on the current head,
skips creating any thread whose `(path, body)` already matches a **live**
(non-resolved, non-outdated) thread. When every thread in the request is such a
duplicate, the whole review event is skipped; the number of suppressed threads
is reported as `data.threads_skipped_idempotent`. It never deletes, edits, or
sweeps prior reviews or threads — a re-run on an unchanged head is a no-op.

A match against a thread that is already resolved or outdated does **not**
suppress the post: the finding re-posts fresh, because a resolved or outdated
match carries no live conversation to duplicate.

This is a cross-run property; it does not weaken the within-run ordering below.
The first run still posts each finding the moment its lens returns. Idempotency
only stops a *later* re-run — a retry after a transient failure, or a follow-up
pass on the same head — from duplicating threads that already exist. It relieves
the workflow of hand-guarding against duplicate posts on retry.

## Posting order is non-negotiable

A review finding is both work-progress and evidence: it is the cause a fix
commit responds to. Post it the moment the lens that produced it returns —
before repairing, committing, or moving to the next lens. The fix is the reply
to the comment, so the comment must already exist when the fix lands.

Never invert this. Do not repair and commit first and post the comment after. A
comment posted after its fix reads as caused by nothing, inverts the PR/MR
timeline, and is lost entirely if the run stops between the fix and the post.
Posting is not a closing summary of work already done; it is the record that the
finding existed before anyone acted on it.

Only the final combined delivery-owner outcome — the disposition (`approve` or
`request-changes`) — is posted after repairs, because a disposition can only be
decided once the findings it resolves exist. Findings post first as they return;
the disposition posts last.

For a clean quick pass, the parent posts only the final delivery-owner outcome
with `--lens quick`; there is no finding to preserve before repair. For quick
findings and full-profile review, the required posting order is:

1. After each reviewer lens returns, the parent posts a compact single-lens
   finding/specialist review comment with that semantic `--lens`.
2. If the lens blocks delivery, the parent repairs in the delivery branch,
   commits, reruns validation, and reruns the affected lens.
3. The parent posts the follow-up review comment with the same
   semantic lens.
4. After all selected lenses pass or are explicitly dispositioned, the parent
   posts one combined delivery-owner outcome with the selected lenses and final
   `--decision`.

The subagent never calls the provider. This keeps provider credentials in the
parent workflow while still making review progress visible in PR/MR and optional
issue activity. Finding comments report findings and evidence only; the
combined delivery-owner outcome records final dispositions.

## Inputs

- `PROVIDER`: `github` or `gitlab`. The snippets below expect this variable to
  be non-empty. To rely on remote auto-detection, remove the whole
  `--provider "$PROVIDER"` pair instead of passing an empty value.
- `OWNER_REPO`: provider repository slug such as `owner/name`.
- `PR_NUMBER`: numeric PR/MR id.
- `REVIEW_DECISION`: `comments-only`, `approve`, or `request-changes`.
  Specialist review comments use `comments-only`; combined owner outcomes map
  the final delivery decision to `approve` or `request-changes`.
- `REVIEW_COMMENT_FILE`: immutable canonical `provider-review.md` produced by
  the bundle for GitHub specialist/native publication. The delivery outcome
  fallback for GitLab or an environment without a governed publisher follows
  `DELIVERY_REVIEW_OUTCOME_COMMENT.md`.
- Optional `REVIEW_THREAD_FILE`: GitHub-only JSON array of actionable findings
  to create as resolvable review threads. Omit this when there are no requested
  changes or when posting to GitLab.
- `REVIEW_LENS`: `quick` for a quick finding, or the single specialist lens for
  a specialist review comment. For combined owner outcomes, pass repeated
  `--lens` flags from the selected lens list.
- Optional `ISSUE`: tracking or dispatch issue that should receive a compact
  activity mirror.

## Identity

Runtime-kit expresses review identity only through portable forge semantics:
`--provider`, `--decision`, and repeatable `--lens`. Do not set or document
environment-specific identity-profile variables in public skills.

By default, `forge-cli` uses the provider CLI's ambient identity. An optional
environment-owned adapter may map semantic lens and decision flags to separate
accounts, but that configuration stays outside runtime-kit, must be
provider-aware, and must fail closed when a required identity cannot be
selected. Public workflows must continue to work when no adapter exists.

Environments that install an executable forge identity router may export
`AGENT_RUNTIME_FORGE_IDENTITY_ROUTER_REQUIRED=1`. The router should occupy the
canonical `forge-cli` position on PATH so interactive calls, subprocesses, and
nested shells share the same policy. Runtime-kit does not parse arbitrary shell
execution or enforce a private wrapper. Exporting the capability asserts that
the environment selects a GitHub review identity independent from the PR author
for combined native approval outcomes. When the environment also provides a
governed `forge-review-publish` adapter, the owning workflow delegates GitHub
publication to it. The adapter publishes the complete report body exactly once
as the owner App's native review, including actionable diff threads, then uses
the canonical personal identity only for a concise `--metadata-only`
breadcrumb. That personal invocation must not pass `--comment-file`; it binds
`--expected-head`, `--native-review-url`, and `--native-review-author` and
verifies the native review before mutation. Without the governed publisher,
runtime-kit posts the combined decision as an outcome note instead of
attempting native self-approval.

Do not let a reviewer subagent post directly. If the active provider identity
cannot write the review, stop and surface the provider error.

The governed publisher's semantic interface is:

```bash
forge-review-publish --provider github --repo "$OWNER_REPO" \
  pr review-publish "$PR_NUMBER" \
  --decision "$REVIEW_DECISION" \
  --submit-review \
  --expected-head "$EXPECTED_REVIEW_HEAD" \
  --comment-file "$REVIEW_COMMENT_FILE" \
  "${THREAD_FILE_ARGS[@]}" \
  "${REVIEW_LENS_ARGS[@]}" \
  --issue "$ISSUE" \
  --mirror-issue \
  --format json
```

The adapter owns credentials, native-review read-back, receipt/resume, and the
personal metadata-only call. Public skills never set its private identity
profiles. If the adapter is unavailable, use the portable direct commands below
and do not claim the two-identity publication contract was exercised.

## Command

Native finding/specialist review events and `--thread-file` are GitHub-only. A combined
native approval additionally requires the environment capability that promises
an independent review identity. Without it, the final semantic decision is an
outcome note, which keeps ambient-identity workflows usable without asking a PR
author to approve their own change:

```bash
EXPECTED_REVIEW_HEAD="$(git rev-parse HEAD)"
SUBMIT_REVIEW=()
FINAL_SUBMIT_REVIEW=()
THREAD_FILE_ARGS=()
[ "$PROVIDER" = github ] &&
  SUBMIT_REVIEW=(--submit-review --expected-head "$EXPECTED_REVIEW_HEAD")
case "${AGENT_RUNTIME_FORGE_IDENTITY_ROUTER_REQUIRED:-}" in
  1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss])
    [ "$PROVIDER" = github ] &&
      FINAL_SUBMIT_REVIEW=(--submit-review --expected-head "$EXPECTED_REVIEW_HEAD")
    ;;
esac
if [ "$PROVIDER" = github ] && [ -n "${REVIEW_THREAD_FILE:-}" ]; then
  THREAD_FILE_ARGS=(--thread-file "$REVIEW_THREAD_FILE")
fi
```

Single quick-finding or specialist-lens report:

```bash
forge-cli --provider "$PROVIDER" pr review "$PR_NUMBER" \
  --repo "$OWNER_REPO" \
  --decision comments-only \
  "${SUBMIT_REVIEW[@]}" \
  "${THREAD_FILE_ARGS[@]}" \
  --comment-file "$REVIEW_COMMENT_FILE" \
  --lens "$REVIEW_LENS" \
  --format json
```

Build the selected lens list once, then reuse its repeated flags for the
combined owner outcome. Quick uses only `quick`; full starts with `testing` and
`maintainability` and includes every risk lens chosen by scope:

```bash
case "$REVIEW_PROFILE" in
  quick) SELECTED_REVIEW_LENSES=(quick) ;;
  full) SELECTED_REVIEW_LENSES=(testing maintainability) ;;
  *) echo "unsupported review profile: $REVIEW_PROFILE" >&2; exit 64 ;;
esac
# Append every selected risk lens, for example: SELECTED_REVIEW_LENSES+=(security)
REVIEW_LENS_ARGS=()
for selected_lens in "${SELECTED_REVIEW_LENSES[@]}"; do
  REVIEW_LENS_ARGS+=(--lens "$selected_lens")
done

forge-cli --provider "$PROVIDER" pr review "$PR_NUMBER" \
  --repo "$OWNER_REPO" \
  --decision "$REVIEW_DECISION" \
  "${FINAL_SUBMIT_REVIEW[@]}" \
  --comment-file "$REVIEW_COMMENT_FILE" \
  "${REVIEW_LENS_ARGS[@]}" \
  --format json
```

Add issue mirroring only when an owning tracking or dispatch issue should show a
compact activity breadcrumb:

```bash
--issue "$ISSUE" --mirror-issue
```

The issue mirror records the PR/MR review URL and metadata. It does not
duplicate the full review body.

Keep identity selection out of the command. Single-lens and combined-owner posts
are distinguished by semantic `--lens` cardinality and `--decision`.

## Pending Draft Recovery

`forge-cli >=1.22.12` separates provider-valid pending drafts into
`data.pending_reviews[]`; they are not submitted-review activity and do not
participate in convergence. Recovery is exceptional and must never run merely
because a pending item is visible.

Only after a GitHub `pr review --submit-review` call returns
`github_pending_review_exists`, preserve the failed command status and JSON,
then inspect a fresh post-conflict `pr reviews` snapshot.
The command binds the native review to the provider head inspected through
`pr view` with `--expected-head`; GitHub's review snapshot must report that
same head before submission. It captures the review body once, then uses
those immutable bytes for initial submission, exact-body deletion, and the
single retry. Continue only when exactly
one current-viewer pending node is the abandoned attempt for this PR and the
intended body, decision, and head are still current. Clear stale selector state
before the native submission, then delete only the freshly selected exact node.
The delete primitive revalidates PR head, draft commit and body, current-viewer
ownership, and abandonment confirmation immediately before mutation:

```bash
PRE_SUBMIT_PR="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr view "$PR_NUMBER"
)"
EXPECTED_REVIEW_HEAD="$(
  printf '%s\n' "$PRE_SUBMIT_PR" |
    jq -er 'select(.ok == true) | .data.head_sha'
)" || exit $?
readonly EXPECTED_REVIEW_HEAD
PRE_SUBMIT_REVIEWS="$(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" \
    --format json pr reviews "$PR_NUMBER"
)"
printf '%s\n' "$PRE_SUBMIT_REVIEWS" |
  jq -e --arg head "$EXPECTED_REVIEW_HEAD" \
    '.ok == true and .data.head_sha == $head' >/dev/null
# Capture the intended body once so submission, guarded deletion, and retry
# compare and send the same immutable bytes. Preserve capture failure before
# freezing it; use `--option=value` so hyphen-leading Markdown remains data.
EXPECTED_REVIEW_BODY="$(cat "$REVIEW_COMMENT_FILE")" || exit $?
readonly EXPECTED_REVIEW_BODY
NATIVE_REVIEW_CMD=(
  forge-cli --provider "$PROVIDER" --repo "$OWNER_REPO" --format json
  pr review "$PR_NUMBER"
  --decision "$REVIEW_DECISION"
  --submit-review
  --expected-head "$EXPECTED_REVIEW_HEAD"
  --comment="$EXPECTED_REVIEW_BODY"
  "${REVIEW_LENS_ARGS[@]}"
)
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
      [ "$NATIVE_REVIEW_RETRY_STATUS" -eq 0 ] || {
        printf '%s\n' "$NATIVE_REVIEW_RETRY_JSON" >&2
        exit "$NATIVE_REVIEW_RETRY_STATUS"
      }
      NATIVE_REVIEW_JSON="$NATIVE_REVIEW_RETRY_JSON"
    fi
  fi
fi

printf '%s\n' "$NATIVE_REVIEW_JSON"
```

The primitive verifies PR membership, pending state, current-viewer authorship,
and delete permission before mutation. Retry the unchanged failed review once
only after read-back confirms the node is absent. Stop on multiple candidates,
an ownership/permission failure, head or outcome drift, refresh failure, or a
second rejection. Never delete submitted reviews, sweep pending drafts, or
downgrade a requested native review to an outcome note.

## Read-Back

For live identity-adapter smoke tests, read the created comment back from the
provider and confirm its author. Portable runtime-kit validation checks the
semantic command shape and does not require a bot account.
