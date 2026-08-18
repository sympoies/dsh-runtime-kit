# Deliver Dispatch Plan Local Rehearsal

Use this playbook only when the user explicitly requests offline rehearsal.

## Contract

- Use `plan-tooling` for plan validation and PR split modeling.
- Use `plan-issue record` for issue-backed lifecycle preview, audit,
  dashboard repair, and closeout rehearsal.
- Pass `--state-dir "$STATE_DIR"` or set `PLAN_ISSUE_HOME` so rehearsal
  artifacts stay in the intended runtime root.
- Keep the live branch model: lane PRs target `PLAN_BRANCH`; the final
  integration PR targets the default branch.

## Commands

```bash
plan-tooling validate --file "$PLAN" --format text --explain
plan-tooling split-prs --file "$PLAN" --scope plan --strategy auto --default-pr-grouping group --format json
plan-issue --repo "$OWNER_REPO" --dry-run --format json --state-dir "$STATE_DIR" record open --profile dispatch --bundle "$PLAN_BUNDLE" --title "$TITLE"
plan-issue --repo "$OWNER_REPO" --dry-run --format json --state-dir "$STATE_DIR" record post --issue "$ISSUE" --profile dispatch --kind state --payload-file "$DISPATCH_STATE_PAYLOAD" --summary-file "$DISPATCH_STATE_MD"
plan-issue --format json --state-dir "$STATE_DIR" record audit --profile dispatch --body-file "$ISSUE_BODY" --comments-json "$COMMENTS_JSON"
plan-issue --repo "$OWNER_REPO" --dry-run --format json --state-dir "$STATE_DIR" record close --issue "$ISSUE" --profile dispatch --approval "$APPROVAL" --linked-pr "$OWNER_REPO#$FINAL_PR" --bundle "$PLAN_BUNDLE"
```

## Exit Criteria

Local rehearsal proves command shape, split modeling, lifecycle preview, audit,
and closeout command shape. It does not complete production delivery; live
completion still requires provider mutation through `plan-issue record` and PR
mutation through `forge-cli`.
