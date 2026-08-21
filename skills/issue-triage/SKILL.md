---
name: issue-triage
description: >
  Analyze open GitHub or GitLab issues from `forge-cli inbox`, classify
  readiness versus blockers, and recommend an execution order; read-only
  unless the user explicitly asks for follow-up.
---

# Issue Triage

Read-only issue work selection for deciding what an agent can do now, what is
blocked, and what order to recommend.

## Contract

Prereqs:

- Run inside the target provider-backed git repository, or pass explicit
  `--repo` and `--provider` options to `forge-cli`.
- `forge-cli >=1.11.2` is installed from the released nils-cli package and available on
  `PATH`.
- Provider authentication is available for non-dry-run inbox and issue reads.
- For implementation handoff, the normal implementation, issue follow-up, or
  PR/MR workflow is available.
- Shared close/comment rules in
  `../issue-follow-up/references/issue-lifecycle.md` are known for any handoff.

Inputs:

- User request to review current open issues, choose what to work on next,
  identify blocked items, or recommend execution order.
- Optional provider, repository, kind, item-type, limit, or GitLab host.
- Optional instruction to include PR/MR work; otherwise focus on issues.

Outputs:

- A concise triage report with candidate issues grouped by readiness.
- A recommended execution order with reason, risk, blocker, and first action
  for each ranked issue.
- Clear handoff suggestion when an issue should move into `issue-follow-up`,
  implementation, PR/MR delivery, or comment-only maintenance.

Failure modes:

- `forge-cli inbox` fails because provider auth, permissions, network, or host
  configuration is unavailable.
- Inbox data is too thin to classify an issue and issue detail reads fail.
- Issue state is ambiguous enough that proceeding would risk wrong provider
  comments, code changes, or prioritization.

## Entrypoint

Start with the normalized inbox issue surface:

```bash
forge-cli inbox list --item-type issue --format json
forge-cli inbox next --item-type issue --format json
```

Pass provider and repository selectors through when needed:

```bash
forge-cli inbox list --provider github --repo owner/name --item-type issue --format json
forge-cli inbox list --provider gitlab --gitlab-host gitlab.example.com --item-type issue --format json
```

When the inbox record does not contain enough context to judge readiness, read
issue detail before deciding:

```bash
forge-cli issue view "$ISSUE" --format json
```

## Workflow

1. Determine scope:
   - Default to open issues only: `--item-type issue`.
   - Include PR/MR only when the user asks for broader work inbox triage.
   - Keep provider selection inbox-local; use `--provider` only when the user
     or repository context narrows the target.
2. Collect candidates:
   - Run `forge-cli inbox list --item-type issue --format json`.
   - Run `forge-cli inbox next --item-type issue --format json` for the CLI's
     bounded ranking signal.
   - If a provider partially fails, continue with successful providers and
     report the failed provider as a data gap.
3. Enrich only as needed:
   - Read the top candidates or ambiguous items with
     `forge-cli issue view "$ISSUE" --format json`.
   - Inspect body, labels, assignees, latest comments when available, linked
     PR/MR references, and explicit blocker language.
4. Classify each candidate:
   - `ready-now`: scope and next action are clear; no external decision,
     permission, CI, review, or missing-data blocker is visible.
   - `needs-clarification`: outcome, acceptance, owner, or first action is
     unclear enough that execution should not start yet.
   - `blocked`: waiting on external decision, user input, provider access,
     review, CI, release, upstream issue, credentials, or unavailable evidence.
   - `stale-or-low-value`: old, low-signal, duplicate-looking, or weakly tied
     to the current repo or user request.
5. Rank recommendations:
   - Prefer ready-now issues that are small, well-scoped, high-impact, and have
     clear validation.
   - Prefer unblocking comments before implementation when a blocker can be
     resolved with one concise question or checkpoint.
   - Deprioritize issues that require broad planning, destructive operations,
     unavailable credentials, or multi-repo coordination unless the user asked
     for that scope.
6. Report with evidence discipline:
   - Separate facts from issue data, inferences from those facts, assumptions,
     and open questions.
   - For each recommended issue, include the issue URL or number, readiness
     bucket, why now, first action, and the next workflow to use.
   - Do not post comments, close issues, create branches, or start
     implementation unless the user explicitly asks.

## Handoff

- Use `issue-follow-up` when the next action is provider-visible issue
  maintenance, a blocker checkpoint, or a durable follow-up comment.
- Use normal implementation and PR/MR workflows when a ready-now issue has a
  clear code or docs change and validation path.
- If the best next action is a broader plan bundle or dispatch lane, say that
  explicitly instead of silently expanding triage into planning.

## Boundary

`issue-triage` is a read-only selection and recommendation workflow. It uses
`forge-cli inbox` as the candidate source and `forge-cli issue view` as optional
context enrichment. It does not replace `issue-follow-up`, mutate provider
state, or implement the selected issue unless the user explicitly asks for that
next step.

Shared rules for follow-up comments and closure live in
`../issue-follow-up/references/issue-lifecycle.md`.
