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
  - **Red-team** — when the caller explicitly requests it or a broad diff
    crosses a material security, data, migration, public-contract, concurrency,
    or other safety boundary, include `reviewer-red-team` in the same call with
    the first-wave roles. Raw diff size alone is insufficient. Independently,
    the runtime automatically adds one red-team pass when structured first-wave
    output contains a critical finding. The runtime runs it only after the first wave
    and supplies bounded collected evidence. Never call
    `reviewer-red-team` alone.

## Workflow

1. Inspect status and choose the base ref.
2. Determine whether this is the generation's initial broad discovery or a
   follow-up to supplied findings. Each discovery generation gets at most one
   broad review; an ordinary repair or changed head stays in that generation.
3. For follow-up, re-check every supplied finding, its repair hunks, and their
   direct regression surface. Classify each as `resolved`, `unresolved`,
   `accepted`, or `residual-risk`. Admit a new finding only when concrete
   evidence shows that the repair introduced a material correctness, security,
   data, migration, or public-contract regression in a reachable supported
   scenario. Otherwise do not broaden scope, add lenses, or restart discovery.
4. For initial discovery, run scope detection and select the minimal relevant
   lenses. A follow-up reuses only affected lenses. When the released scope
   helper reports `red_team.required` solely because `diff_lines > 200`,
   normalize that legacy size-only result to not selected unless this change
   also crosses a material safety boundary. Raw size never overrides the
   activation rule above.
5. Select quick, focused, or specialist depth. Dispatch the selected fixed
   roles in one `review_specialists` call; the runtime owns parallelism,
   cancellation, cleanup, and any second-wave red-team ordering.
6. Inspect the complete disposition before interpreting findings. Require
   top-level `status: completed`; treat `partial` as incomplete and fail closed.
   In initial discovery, route an `escalate` verdict to the named next review
   depth. During closure, escalation permits at most the one named directly
   relevant specialist over the supplied finding, repair hunks, and direct
   regression surface; it does not rerun general scope discovery or the full
   profile. If that bounded lens cannot establish confidence and no
   new-generation trigger applies, stop with an explicit handoff instead of
   extending the loop. A completed `findings` verdict says rows exist; it does
   not itself make them blocking.
7. Write the returned `findings_jsonl` field unchanged to an artifact and
   validate that artifact with `review-specialists validate`. The artifact is
   findings-only evidence: an empty file is clean only when step 6 also passes.
8. Deduplicate by root cause and keep the highest supported severity.
9. Recheck high-confidence findings against the current diff and apply the
   admission rule in `references/SPECIALIST_REVIEW_CONTRACT.md`. Retain raw
   findings as review evidence, but create a separate admitted-blocking input
   containing only admitted `critical`, `high`, or `medium` findings for repair
   and delivery-ledger consumers. Low and informational rows remain report-only
   and terminal when no admitted blocker exists.
10. Report findings first, ordered by severity, with file and line evidence.

If the reviewer tool is unavailable, review inline and state that limitation;
do not imitate unavailable child-agent results.

Relative review schemas and reporting templates are in `references/`.
