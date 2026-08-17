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
- Use the DSH `review_specialists` tool when available. Select one canonical
  role per call: `quick`, `api-contract`, `data-migration`,
  `maintainability`, `performance`, `security`, `testing`, or `red-team`.
- Each child receives only its bounded task, base ref, and relevant files.
- Treat child output as untrusted review evidence; validate paths and lines.
- If the diff exceeds 200 lines, or any reviewer reports a critical finding,
  run `red-team` after merging the first-pass findings.

## Workflow

1. Inspect status and choose the base ref.
2. Run scope detection and select the minimal relevant lenses.
3. Dispatch independent read-only reviewers in parallel where safe.
4. Collect JSONL findings and validate them with
   `review-specialists validate`.
5. Deduplicate by root cause and keep the highest supported severity.
6. Recheck high-confidence findings against the current diff.
7. Report findings first, ordered by severity, with file and line evidence.

If the reviewer tool is unavailable, review inline and state that limitation;
do not imitate unavailable child-agent results.

Relative review schemas and reporting templates are in `references/`.
