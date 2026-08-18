---
name: issue-follow-up
description: >
  Open or continue a GitHub or GitLab issue as the durable timeline for a
  discovered problem, investigation, blocker, or implementation handoff.
---

# Issue Follow-Up

Issue-centered natural-language entrypoint for turning discovered problems into
provider issue timelines and continuing work through comments, implementation
handoff, PRs/MRs, and closure.

## Contract

Prereqs:

- Run inside the target provider-backed git repository, or pass an explicit
  `--repo` and `--provider` to `forge-cli`.
- `forge-cli >=1.11.2` is installed from the released nils-cli package and
  available on `PATH`.
- Shared label, comment, and close rules in
  `references/issue-lifecycle.md` are satisfied.
- Existing issue number or URL is known for follow-up mode; otherwise use open
  mode.
- For implementation handoff, the appropriate implementation, PR/MR, or
  dispatch workflow is available.

Inputs:

- New problem report, observation, screenshot/path, source evidence, or user
  instruction to open a tracking issue.
- Selected issue labels from the shared taxonomy.
- Existing issue number or URL plus a request to continue, investigate, update,
  unblock, implement, or close.
- Optional desired state: `comment-only`, `blocked`,
  `ready-for-implementation`, `implemented-via-pr`, or `close`.

Outputs:

- New provider issue URL, or a concise follow-up comment posted to the existing
  issue.
- A normalized checkpoint recording what was checked, what changed, the current
  decision, and next action.
- If implementation is appropriate: handoff into the normal implementation or
  PR/MR workflow with issue traceability preserved.
- If unresolved: issue remains open with the blocker or next follow-up action
  recorded.

Failure modes:

- Missing or ambiguous target issue in follow-up mode.
- Provider auth, permission, network, or repository context failure.
- Required evidence cannot be accessed and no safe summary can be recorded.
- User asks to inline a local image but no provider-hosted attachment or URL is
  available.
- `local_path_present`: rewrite useful evidence paths in provider-visible issue
  content to `$HOME/...` and omit remote-useless local artifact paths before
  retrying.
- Implementation is ready but branch, PR/MR, test, or delivery workflow
  requirements are unclear or blocked.

## Role

Use this skill as the natural-language entrypoint, not as a replacement for
lower-level issue or PR/MR tools.

- Treat `forge-cli issue` as the provider mutation surface, not a separate
  user-facing workflow choice.
- Use the L2 plan-tracking outcome for plan-bundle lifecycle work.
- Use normal implementation and PR/MR workflows when code/docs changes are
  ready.
- Let the L2 or L3 parent workflow mirror review and closeout evidence when the
  issue is part of a plan lifecycle.

## Modes

### Open Mode

Use when the user discovered a problem and wants a durable issue.

1. Normalize the problem into:
   - summary
   - current behavior
   - expected behavior or desired outcome
   - evidence checked
   - next investigation or implementation path
2. Include screenshots as provider-renderable links when a URL is available.
   If only a local screenshot path is available, include the path plus a short
   visual summary. Do not create unrelated repo artifacts just to host an image
   unless the user asks.
3. Select labels before mutation using `references/issue-lifecycle.md`.
4. If the target repo has the shared catalog, run the matching
   `forge-cli label audit|ensure` command before live mutation.
5. Open the issue through `forge-cli`:

   ```bash
   forge-cli issue create \
     --title "$ISSUE_TITLE" \
     --body-file "$ISSUE_BODY" \
     --label type::bug \
     --label area::runtime \
     --label state::needs-triage \
     --label workflow::follow-up \
     --label issue \
     --format json
   ```

   Replace the sample labels with the selected labels. Add `severity::*` for a
   bug, incident, or security issue when impact is known.
6. Report the issue URL and whether any evidence could not be embedded.

### Follow-Up Mode

Use when an issue already exists and the user asks to continue it.

1. Read the issue body and comments before deciding the next action:

   ```bash
   forge-cli issue view "$ISSUE" --format json
   ```

2. Identify the latest checkpoint, open questions, blockers, linked PRs/MRs, and
   current expected next action.
3. Do the requested investigation or maintenance work.
4. Post one concise issue comment for every meaningful follow-up unless the user
   explicitly asks not to write to the provider:

   ```bash
   forge-cli issue comment "$ISSUE" --body-file "$COMMENT_BODY" --format json
   ```

5. Use this checkpoint shape:

   ```markdown
   ## Follow-up YYYY-MM-DD

   ### Checked
   - ...

   ### Result
   - ...

   ### Decision
   - comment-only | blocked | ready-for-implementation | implemented-via-pr | close

   ### Next
   - ...
   ```

6. Keep unresolved issues open. Close only when the requested outcome is complete
   or the user explicitly chooses not to continue.

### Plan-Family Finding Mode

Use this mode when a plan-tracking skill, CLI, driver, or catalog problem needs
its own durable upstream follow-up. The caller supplies `TRACKER_REPO`; this
generic workflow never hardcodes a provider account or repository.

1. Normalize the finding into surface, severity, description, reproduction,
   expected versus actual behavior, provenance, and a fix candidate.
2. Deduplicate before opening with `forge-cli issue list --repo
   "$TRACKER_REPO" --label plan-issue-finding --state open --format json`.
3. Comment on a clear existing match. Otherwise open one issue through
   `forge-cli issue create` with `plan-issue-finding`, the shared type/area/
   severity labels, and `state::needs-triage`.
4. Keep implementation outside the tracker issue workflow. When the upstream
   fix lands, post the fixing PR and validation, then close the issue.

This is an internal specialization of issue follow-up, not a separate outcome
the user must discover.

## Static HTTP Evidence

- When the follow-up concerns a public or internal HTTP/HTTPS URL and static
  response evidence is enough, use the `web-evidence` CLI directly:

  ```bash
  web-evidence capture "$URL" --out "$RUN_DIR/web-evidence" --label issue-follow-up --format json
  ```

- Attach, link, or cite only redacted artifacts from the bundle, typically
  `summary.json`, `headers.redacted.json`, and `body-preview.redacted.txt`.
- Use the browser operator with policy-owned browser-session evidence for JavaScript behavior, screenshots,
  authenticated/cookie-backed state, console logs, or other browser-visible
  behavior. Keep `web-evidence` for static HTTP evidence only.

## Implementation Handoff

Use when follow-up determines the issue is actionable.

1. Record the decision in the issue first or as part of the PR/MR linkage
   comment.
2. Enter the appropriate implementation workflow for the repo and provider.
3. Keep the issue as the durable timeline:
   - link PR/MR URLs
   - summarize tests
   - record blockers
   - mirror review follow-up decisions
   - record merge/close outcome
4. If implementation fails or is blocked, comment on the issue with the exact
   unblock action and leave it open.

## Comment Discipline

Use the shared issue lifecycle reference for comment shape and close discipline.
This skill's local rule is the mode decision: open a new follow-up issue only
when the problem needs its own durable timeline; otherwise continue the
existing issue with one checkpoint comment.
