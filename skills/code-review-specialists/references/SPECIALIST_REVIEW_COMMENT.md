# Specialist Review Comment

Use this comment contract when the owning parent workflow posts provider-visible
activity for exactly one reviewer lens. The reviewer subagent remains read-only;
the parent posts the comment with `--decision comments-only` and that semantic
`--lens`.

This is not a delivery decision. It reports what one specialist lens found or
verified. The parent/main agent owns repair, tradeoff decisions, and final
delivery disposition in `DELIVERY_REVIEW_OUTCOME_COMMENT.md`.
Post specialist review comments with `--decision comments-only` — on GitHub add
`--submit-review` so the report posts as a native `COMMENT` review event
(`#pullrequestreview-`) authored by the active provider identity; on GitLab it posts
an outcome note. The lens verdict inside the body carries the specialist result.
When the specialist found actionable items that require owner changes, GitHub
posts should include `--thread-file` so those findings become resolvable review
threads. When the specialist found nothing to change, omit `--thread-file` and
post only the summary review body. See `REVIEW_OUTCOME_POSTING_CONTRACT.md` for
the provider-guarded command.

## Timing

- Post one specialist review comment after each reviewer lens returns when the
  delivery workflow has provider write access and provider-visible progress is
  desired.
- If the lens reports findings, repair and commit in the owning workflow, rerun
  focused validation and that lens, then post a follow-up specialist review
  comment for the rerun.
- Create GitHub review threads only for actionable findings in the first report
  that surfaces them. Follow-up pass comments should normally omit
  `--thread-file` and resolve the existing threads after the repair is verified.
- Keep comments compact: summarize the lens result and link or cite evidence
  instead of pasting raw subagent output.

## Required Comment Shape

```markdown
<!-- agent-kit:specialist-review-report:v1 -->
## Review Report

- Reviewable: PR #123
- Lens: testing
- Lens verdict: pass | findings | blocked | follow-up-pass
- Scope: files and behavior reviewed
- Evidence reviewed: validation, diff, provider checks, or prior findings

| Finding | Severity | Confidence | Evidence | Recommendation |
| --- | --- | --- | --- | --- |
| Missing edge-case test | medium | 0.86 | file/path + command | Add regression coverage |
```

Required fields:

- Marker: `<!-- agent-kit:specialist-review-report:v1 -->`
- Reviewable identifier: PR number/URL or MR number/URL.
- Exactly one `Lens`.
- Lens verdict:
  - `pass`: no concrete findings for this lens.
  - `findings`: concrete findings should be repaired, accepted, or followed up
    by the parent before final delivery.
  - `blocked`: the lens could not complete and needs an exact unblock action.
  - `follow-up-pass`: the lens rechecked earlier findings and found them
    resolved.
- Evidence reviewed.
- Findings table. Use a single `No findings` row when there are no findings.
  The `Confidence` column uses the numeric `0.0` to `1.0` confidence value from
  `SPECIALIST_REVIEW_CONTRACT.md`, not a display label.

## Boundary

Specialist review comments must not use the delivery disposition vocabulary
(`fixed-now`, `accepted-residual`, `follow-up-linked`, `deferred-task`,
`no-action`, or `blocked` as a disposition). They must not include a final
delivery decision such as `proceed-to-merge`, and they must not use the provider
review decision as approval or request-changes metadata. The parent/main agent
translates specialist findings into final dispositions in the delivery review
outcome.
