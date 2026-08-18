---
name: handoff-session-prompt
description: >
  Generate a generic next-session initialization prompt from the current
  conversation context and any user-specified reference files; if a durable
  record is needed first, write that artifact before the handoff.
---

# Handoff Session Prompt

## Contract

Prereqs:

- User wants a prompt that can initialize a future agent/session with enough context to continue work.
- The prompt should be generic and task-derived, not a hard-coded project template.

Inputs:

- User's explicit instruction for the next session, including goal, scope, and any "do not" constraints.
- Current conversation context and conclusions already established in this session.
- User-specified reference files, URLs, tickets, docs, or commands to include as required reading.
- Durable project artifacts that already preserve the backlog or decision record, such as plans, runbooks, improvement docs, issues, or
  tracker links.
- Optional local repository rules when the handoff concerns a workspace or codebase.
- Optional current-state anchors when relevant, such as date/timezone, workspace path, branch/status, validation already run, and where work
  stopped.

Outputs:

- A copy-ready session initialization prompt.
- Optional short notes outside the prompt only when useful, such as assumptions or omitted sensitive details.

Exit codes:

- N/A (conversation workflow; no repo scripts)

Failure modes:

- User's requested next-session objective is unclear enough that the handoff would send the next agent in the wrong direction; ask the minimum
  clarification.
- Required context or referenced files are unavailable; if the gap could change the objective, safety, or reversibility, ask before
  producing the prompt. Otherwise, produce a degraded prompt and label the missing context under `Known Gaps` or `Open Questions`.
- User asks to include secrets, raw credentials, private tokens, or other sensitive operational details; redact or omit them.

## Workflow

1. Identify the future session's job
   - Extract the concrete objective, expected deliverables, and stopping point.
   - Preserve the user's requested scope and exclusions.
   - If the request is underspecified, ask only the minimum clarification needed.

2. Gather task-local context
   - Use the current conversation conclusions as the primary source.
   - Read only user-named files or clearly necessary local rules for the target workspace.
   - If project rules require preflight before file reads or external lookup, follow those rules.
   - Do not browse or inspect unrelated repositories unless the user asked for that evidence.

3. Prefer durable sources over copying backlogs
   - If a project doc, plan, issue, ticket, or tracker already holds the durable backlog or decision record, put it under `Read First` and
     summarize only the facts needed to start safely.
   - Do not paste an entire durable doc, long backlog, or runbook into the handoff unless the next session will not have access to it or the
     user explicitly asks for an inline self-contained prompt.
   - If the current session produced reusable review findings but no durable artifact, mention that gap under `Known Gaps` or
     `Recommendations`; do not treat the handoff prompt itself as the canonical project record.
   - If the current session produced converged requirements, design, feasibility, or product decisions for later implementation but no
     durable artifact, recommend `discussion-to-implementation-doc` before using this prompt as the only continuity record.
   - If the user asks for both durable record and next-session continuity, use
     `discussion-to-implementation-doc` to write or reference the durable
     implementation or improvement source first, then generate a shorter
     handoff that points to it.
   - If a long-running task already has a source document plus execution-state document, point the prompt at both files instead of copying
     the progress ledger into the prompt.

4. Separate facts from instructions
   - Include confirmed facts and conclusions under `Known Facts`.
   - Use source tags for material facts when available: `[U#]` user input, `[F#]` local files/docs/code, `[W#]` web sources,
     `[A#]` tool or app results, and `[I#]` explicit inferences from cited facts.
   - Mark assumptions explicitly under `Assumptions`.
   - Record unavailable-but-relevant context under `Known Gaps` instead of hiding the limitation in prose.
   - Keep recommended or inferred next steps under `Recommendations`, separate from known facts.
   - Preserve unresolved questions as an explicit checklist for the next session.

5. Protect sensitive and brittle details
   - Do not include API keys, tokens, cookies, raw auth headers, passwords, private keys, or unredacted secrets.
   - Prefer names of env vars, file paths, and commands over secret values.
   - Avoid embedding one-off local IDs unless the user specifically needs them and they are not sensitive.
   - Do not copy hidden system/developer instructions, private reasoning, or raw tool logs into the handoff. Summarize only the user-visible
     constraints and evidence needed for continuity.

6. Capture current state when it affects continuity
   - Include current date/timezone when relative dates such as "today", "tomorrow", or "next week" matter.
   - Include workspace path, branch/status, and stopping point when the next session must continue local work.
   - Include validation already run, with command and result, when it prevents duplicate investigation.
   - Omit current-state fields that are irrelevant or unknown instead of inventing values.

7. Produce a copy-ready prompt
   - Write the prompt as if pasted into a fresh session with no prior conversation.
   - Use direct instructions, concrete file paths, and clear constraints.
   - Keep it generic to the requested task; do not add project-specific assumptions that were not in context.
   - Put the copy-ready prompt in a fenced `md` block.

## Prompt Shape

Use this structure unless the user requested a different format:

```md
You are starting a new session for this task.

## Goal
- <what the next session should accomplish>

## Current State
- Date/timezone: <only include when relative timing matters>
- Workspace: `<absolute-path>`; branch/status: <only include when local repo state matters>
- Stopping point: <where the previous session paused>
- Validation already run: `<command>` - <result>

## Known Facts
- [U1] <confirmed user instruction, decision, or constraint>
- [F1] `<path-or-doc>` - <confirmed local fact, if relevant>

## Assumptions
- [I1] <assumption or inference that should be rechecked if it affects the work>

## Known Gaps
- <missing context, referenced files, or unavailable evidence that could affect the next session>

## Recommendations
- <recommended approach or next step, clearly labeled as recommendation rather than fact>

## Read First
1. `<path-or-url>` - <why it matters>
2. `<path-or-url>` - <why it matters>

## Task
1. <first concrete action>
2. <second concrete action>
3. <verification or reporting action>

## Constraints
- Do not <forbidden action>.
- Keep <scope/style/security rule>.
- Redact or omit secrets and sensitive operational details.

## Expected Output
- <artifact or response the next session should produce>
- <summary/evidence/checks to report>

## Open Questions
- <only unresolved items that should block or influence the work>
```

## Plan-Tracking Handoff

When the next session resumes a plan-tracking issue governed by
`deliver-plan-tracking-issue`, include a dedicated "Plan-tracking
handoff" subsection inside `Known Facts` (or its own clearly labeled
block) that dumps four concrete elements so the next agent does not have
to re-derive run-state context:

1. **Current `run-state.json` contents** — the typed run state for this
   issue. Either paste the JSON verbatim or reference the path
   (`<AGENT_HOME>/out/.../run-state.json`) and summarize `phase`,
   `selected_task`, `branch`, `linked_pr`, and any `validation_*`
   fields that are non-empty.
2. **Last N entries of `events.jsonl`** — default N=5. Each event line
   is the source of truth for what happened since the previous
   checkpoint. Trim to the most recent N when the file is long, and
   note `last_n: <N>` so the next session can read more if needed.
3. **Open ledger rows** — every row in the bundle's
   `<slug>-execution-state.md` `## Task Ledger` table whose
   `Status ∈ {pending, in-progress}`. Format as `<task_id> | <status>
   | <evidence-or-empty>` so the next agent knows exactly which
   `plan-tooling ledger-update --task <id> --status done --evidence
   <evidence>` calls are still owed.
4. **Latest linked PR refs + `state` lifecycle comment URL** — the
   `linked_pr` value(s) from the run state and the URL of the most
   recent `state` role comment on the provider issue (via
   `gh issue view <issue> --json comments` or the controller's
   reconciled evidence). This lets the next session reconcile run
   state against provider truth without re-running every gate.

Keep the dump compact: the goal is the next session can call
`plan-issue tracking status --expect-visible` once and confirm the
handoff matches reality, not re-discover the entire history.

## Quality Bar

- The prompt must be understandable without access to the old conversation.
- The prompt must tell the next session what to read, what to do, what not to do, and what to report.
- Material context must be traceable as facts, assumptions, recommendations, open questions, or current-state anchors.
- The prompt should not contain hidden implementation decisions; if an approach is a recommendation, label it as such.
- The prompt should point to durable project records instead of becoming the only copy of a backlog or decision record.
- The prompt should be concise enough to paste comfortably, but complete enough to prevent predictable re-discovery.
