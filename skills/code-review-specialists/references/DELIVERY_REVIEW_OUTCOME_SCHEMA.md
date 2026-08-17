# Delivery Review Outcome Schema

Purpose: one shared disposition vocabulary for delivery review outcomes posted
through `forge-cli pr review` and for dispatch lane PR review evidence.

## Dispositions

Use these dispositions for every meaningful review item:

- `fixed-now`: repaired in the active delivery branch or dispatch lane before
  merge.
- `accepted-residual`: real risk accepted for this delivery because it is low
  enough to close honestly.
- `follow-up-linked`: actionable work moved outside this delivery with a linked
  issue or durable follow-up.
- `deferred-task`: issue-backed work left in an explicit deferred task row with
  evidence.
- `no-action`: reviewed observation with no required change or follow-up.
- `blocked`: cannot continue until a user, project, provider, or policy action
  occurs.

## Reason And Evidence Rules

- `fixed-now`: evidence and validation are required; reason is optional.
- `no-action`: evidence is required; reason may be `N/A` for trivial reviewed
  observations.
- `accepted-residual`: reason and evidence are required.
- `follow-up-linked`: reason, evidence, and follow-up link are required.
- `deferred-task`: reason, evidence, and deferred task row are required.
- `blocked`: reason, evidence, and exact unblock action are required.

## Table Shape

```markdown
| Item | Disposition | Reason | Evidence |
| --- | --- | --- | --- |
| No findings | no-action | N/A | review evidence + validation |
```

Keep evidence compact: use file paths, command summaries, PR/MR URLs, issue
comments, check names, or retained artifact paths instead of long raw logs.
