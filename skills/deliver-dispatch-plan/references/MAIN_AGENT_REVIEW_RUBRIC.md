# Main-Agent Review Rubric

## Review Owner

Main-agent owns review and acceptance decisions. Subagents own implementation
changes on assigned lanes. Main-agent should not repair product code while
reviewing unless an explicit corrective-fix exception is documented.

## Inputs

- Runtime-truth dispatch ledger row and latest dispatch state comment
- Assigned task prompt, plan task snippet, and dispatch record
- PR diff and PR body
- Validation evidence and provider checks
- Optional `code-review-specialists` report for high-risk, broad,
  security-sensitive, migration-heavy, or API-contract-heavy diffs

## Method

1. Verify the PR matches the assigned lane and task scope.
2. Pass hard gates first: PR linkage, body hygiene, validation evidence, and
   required checks.
3. Compare the diff against assigned task fidelity and acceptance intent.
4. Review correctness, regression risk, failure paths, and test adequacy.
5. Confirm integration readiness against current dispatch lifecycle gates.
6. Record decision-scoped review evidence with file/check/issue anchors.

## Decisions

- `merge`: hard gates pass, task fidelity is satisfied, and no unresolved
  blocker remains.
- `request-followup`: scope, validation, correctness, or integration risk is
  still correctable on the same lane.
- `close`: the PR is wrong-lane, superseded, or intentionally retired.

Specialist findings are supplemental evidence. They do not merge, close, or
request follow-up by themselves.
