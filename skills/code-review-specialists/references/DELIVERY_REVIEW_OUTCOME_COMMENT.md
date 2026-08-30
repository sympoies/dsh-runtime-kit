# Delivery Review Outcome Comment

Use this shared outcome contract after the delivery quick or full review gate has
enough information to decide whether delivery can merge, must stop, or can
continue with an accepted residual risk. The owning delivery workflow posts the
outcome through `forge-cli pr review`; `code-review-specialists` stays
read-only.

Disposition vocabulary and reason/evidence rules are canonical in
`references/DELIVERY_REVIEW_OUTCOME_SCHEMA.md`.
Provider posting ownership, bot identity, and optional issue mirroring are
canonical in `references/REVIEW_OUTCOME_POSTING_CONTRACT.md`.
Single-lens quick-finding or specialist progress comments use
`references/SPECIALIST_REVIEW_COMMENT.md` instead.
Resolvable GitHub review threads for actionable findings are attached to the
progress comments that first surface those findings, not to the final
combined approval summary.

## Ownership

- `deliver-pr` posts the outcome on the PR/MR before merging through
  `forge-cli pr review`.
- `deliver-plan-tracking-issue` records the PR/MR outcome comment URL in
  issue-hosted session or validation evidence instead of duplicating the full
  report.
- `code-review-specialists` supplies review evidence only. It must not post or
  update live PR/MR comments.

## Timing

- Post one final combined outcome comment after the review and repair pass,
  before final merge/close. Express the owner outcome through its final
  `--decision` and repeated selected `--lens` flags.
- If review blocks delivery, post a blocked outcome comment before stopping when
  provider auth and permissions allow it.
- Do not use this format for individual quick-finding or specialist reports. Those comments
  report findings only; the parent/main agent owns the dispositions recorded
  here.
- If outcome posting fails, stop before merge and report the provider command,
  exit status, and retry action. A delivery that requires this contract is not
  complete without the outcome.

## Provider Command

Use the provider-aware primitive for GitHub and GitLab. Follow
`references/REVIEW_OUTCOME_POSTING_CONTRACT.md` for the parent-owned posting
flow, portable identity boundary, and optional issue mirroring:

On GitHub with a governed `forge-review-publish` adapter, the final native
review body is the canonical `provider-review` table rendered with the combined
lens. Do not publish this delivery-outcome body as a second personal comment.
The App review carries the complete report once; the personal identity records
only verified metadata, while dispositions remain in the review-loop and
tracking evidence. The outcome-note body below remains the portable GitLab and
no-governed-publisher fallback.

```bash
# Native combined approval requires an environment-owned executable router that
# guarantees a GitHub review identity independent from the PR author. Other
# paths post an outcome note with the same semantic decision and lenses.
FINAL_SUBMIT_REVIEW=()
case "${AGENT_RUNTIME_FORGE_IDENTITY_ROUTER_REQUIRED:-}" in
  1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss])
    [ "$PROVIDER" = github ] && FINAL_SUBMIT_REVIEW=(--submit-review)
    ;;
esac
case "$REVIEW_PROFILE" in
  quick) SELECTED_REVIEW_LENSES=(quick) ;;
  full) SELECTED_REVIEW_LENSES=(testing maintainability) ;;
  *) echo "unsupported review profile: $REVIEW_PROFILE" >&2; exit 64 ;;
esac
REVIEW_LENS_ARGS=()
for selected_lens in "${SELECTED_REVIEW_LENSES[@]}"; do
  REVIEW_LENS_ARGS+=(--lens "$selected_lens")
done

forge-cli --provider "$PROVIDER" pr review "$PR_NUMBER" \
  --decision "$REVIEW_DECISION" \
  "${FINAL_SUBMIT_REVIEW[@]}" \
  --comment-file comment.md \
  "${REVIEW_LENS_ARGS[@]}"
```

Set `REVIEW_DECISION=approve` for `proceed-to-merge` or
`proceed-with-accepted-residual`, and `request-changes` for `blocked`. Use
provider repository flags when local remotes are ambiguous. When the independent
identity capability adds `--submit-review` on GitHub, the decision maps to a
native pull request review event
(`approve`→`APPROVE`, `request-changes`→`REQUEST_CHANGES`,
`comments-only`→`COMMENT`) authored by the active provider identity; on GitLab the
decision is recorded as outcome-note metadata only (no native approval state).
GitHub without that capability also uses the outcome-note path so the ambient
PR author is not asked to self-approve.
Use `SPECIALIST_REVIEW_COMMENT.md` with `--decision comments-only` for
non-decisional quick-finding or specialist notes, adding `--thread-file` only when that note
surfaces actionable findings that need owner changes.

## Required Comment Shape

```markdown
<!-- agent-kit:delivery-review-outcome:v1 -->
## Delivery Review Outcome

- Reviewable: PR #123
- Decision: proceed-to-merge | blocked | proceed-with-accepted-residual
- Lenses: quick | testing, maintainability, api-contract
- Validation: scripts/check.sh --all pass
- Provider checks: required checks pass

| Item | Disposition | Reason | Evidence |
| --- | --- | --- | --- |
| Missing edge-case test | fixed-now | Required for behavior coverage. | commit + validation |
| Minor wording note | no-action | N/A | reviewed docs diff |
| Cleanup opportunity | follow-up-linked | Outside this delivery scope. | issue URL |
```

Required fields:

- Marker: `<!-- agent-kit:delivery-review-outcome:v1 -->`
- Reviewable identifier: PR number/URL or MR number/URL.
- Decision: `proceed-to-merge`, `blocked`, or
  `proceed-with-accepted-residual`.
- Lenses used: `quick` for a terminal quick pass, or the full selected lens set
  including forced minimum lenses.
- Validation and provider check or pipeline status.
- Findings table. Use a single `none` row when there were no findings or
  residual risks to report.

## Dispositions

Use the shared disposition schema:
`references/DELIVERY_REVIEW_OUTCOME_SCHEMA.md`.

Keep the comment compact. Link to detailed specialist reports, validation logs,
issue evidence, or follow-up records instead of pasting long raw review output.
