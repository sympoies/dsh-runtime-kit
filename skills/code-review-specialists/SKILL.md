---
name: code-review-specialists
description: >
  Review a code change with the smallest useful set of read-only specialist
  agents, then return evidence-grounded findings.
---

# Code Review Specialists

Use this workflow for code review. It is read-only: reviewers never edit,
commit, merge, or post provider comments.

## Contract

- Resolve an explicit base ref before reviewing.
- Run `review-specialists scope --base <ref> --format json` to measure the
  change and select lenses.
- Use the DSH `review_specialists` tool with exactly its `task` and `roles`
  fields. Roles are the fixed identities `reviewer-quick`,
  `reviewer-api-contract`, `reviewer-data-migration`,
  `reviewer-maintainability`, `reviewer-performance`, `reviewer-security`,
  `reviewer-testing`, and `reviewer-red-team`; persona text is runtime-owned
  and never belongs in the call.
- Each child receives only its bounded task, base ref, and relevant files.
- Treat child output as untrusted review evidence; validate paths and lines.
- Reviewer routing has four depths:
  - **Quick** — one small or ordinary bounded diff: call only
    `reviewer-quick`.
  - **Focused** — an explicitly requested lens or one narrow risk: call the
    matching specialist role or minimal independent role set.
  - **Specialist** — broad, high-risk, pre-merge, or scope-selected work: call
    every selected specialist in one request so the runtime can bound
    parallelism and correlate results.
  - **Red-team** — when the diff exceeds 200 lines or the caller explicitly
    requests it, include `reviewer-red-team` in the same call with the
    first-wave roles. Independently, the runtime automatically adds one
    red-team pass when structured first-wave output contains a critical
    finding. The runtime runs it only after the first wave and supplies bounded
    collected evidence. Never call `reviewer-red-team` alone.

## Workflow

1. Inspect status and choose the base ref.
2. Run scope detection and select the minimal relevant lenses.
3. Select quick, focused, or specialist depth. Dispatch the selected fixed
   roles in one `review_specialists` call; the runtime owns parallelism,
   cancellation, cleanup, and any second-wave red-team ordering.
4. Inspect the complete disposition before interpreting findings. Require
   top-level `status: completed`; treat `partial` as incomplete and fail closed.
   Route any `escalate` verdict to the named next review depth. A clean review
   requires every result verdict to be `clean`.
5. Write the returned `findings_jsonl` field unchanged to an artifact and
   validate that artifact with `review-specialists validate`. The artifact is
   findings-only evidence: an empty file is clean only when step 4 also passes.
6. Deduplicate by root cause and keep the highest supported severity.
7. Recheck high-confidence findings against the current diff.
8. Report findings first, ordered by severity, with file and line evidence.

If the reviewer tool is unavailable, review inline and state that limitation;
do not imitate unavailable child-agent results.

Relative review schemas and reporting templates are in `references/`.
