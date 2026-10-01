---
name: discussion-to-implementation-doc
description: >
  Convert a completed requirements, design, feasibility, or review discussion
  into an implementation-readiness source document.
---

# Discussion To Implementation Doc

Use this skill after a discussion or review has converged and the next useful
artifact is a repo-local source document that future implementation can read.

## Contract

Prereqs:

- User wants to preserve discussion conclusions, review findings, risks,
  lessons learned, or fix-later backlog for later implementation, not execute
  the implementation now.
- Discussion or review context is sufficient to separate confirmed facts,
  decisions, assumptions, open questions, findings, and recommendations.
- Target workspace is available and project rules allow writing docs after required preflight.

Inputs:

- User request and the discussion or review conclusions to preserve.
- Relevant local code, docs, issue, ticket, test, review, validation, or runtime
  evidence for material facts when available.
- Optional target docs area, filename, linked issue/handoff, validation commands, retention intent, and project-specific documentation
  conventions.

Outputs:

- A repo-local discussion / implementation-readiness source document. Place it
  by destination:
  - Default capture: `docs/discussions/<YYYY-MM-DD>-<slug>.md` for
    converged requirements, design, feasibility, product, architecture,
    customer-facing, review, risk, lessons-learned, or fix-later material that
    is captured for later work.
  - Durable canon: when the content is already authoritative knowledge rather
    than coordination, promote it to the owning domain docs area (or
    `docs/source/` for repo-wide architecture / specs / policy) — a deliberate
    promotion, not this skill's default.
- A source artifact that an issue or dispatch workflow can cite as context.
- A source document that avoids unresolved open questions; report any
  non-blocking open questions in the final response instead of writing them into
  the document.
- Updated local docs index or README only when the document is promoted into
  canon; never for a `docs/discussions/` capture, which no file outside that
  directory may link to.
- When following the evidence-control-plane recording convention, a `skill-usage.record.v1` envelope that links the created document and validation
  evidence.
- A short response linking the document path, listing validation run, and
  presenting any response-only open questions as immediate decision prompts.

Exit codes:

- N/A (conversation/workflow skill)

Failure modes:

- The user needs to execute work now; route to the appropriate direct, issue,
  program, or dispatch workflow instead of stopping at a source document.
- The user only needs a copy-ready prompt for a fresh session; use `handoff-session-prompt` instead.
- Source evidence is too ambiguous to record as fact. If the ambiguity affects
  core facts, scope, requirements, acceptance criteria, or implementation
  boundaries, ask the minimum clarification before writing. If it is
  non-blocking, omit it from the document and report it as a response-only open
  question.

## Workflow

1. Confirm this is the right artifact
   - Use this skill when requirements, design, feasibility, architecture,
     customer-facing, product, review, risk, lessons-learned, or improvement
     discussion has converged and the next implementer needs a stable
     read-first document.
   - Do not turn the document into a task-by-task implementation plan. If
     execution sequencing is needed, use an issue or program tracker after
     capturing the settled requirements.
   - Treat this document as the source artifact for later implementation when
     the source material is requirements, design, feasibility,
     product, architecture, customer-facing discussion, review findings, risks,
     lessons learned, validation guardrails, or fix-later backlog.
   - For unresolved workflow or heuristic gaps that should be versioned but are
     not ready for a fix, follow the
     [heuristic error inbox policy](../../docs/policies/heuristic-error-inbox.md)
     instead of creating an ordinary `docs/discussions/` capture.
   - Treat `docs/discussions/<YYYY-MM-DD>-<slug>.md` as the default home;
     promote into domain docs/runbooks (or `docs/source/`) only when the
     content is durable canon.
   - Do not use the document as a session prompt. If continuity is needed, write or reference this document first, then use
     `handoff-session-prompt`.
   - Do not use a `review-evidence` CLI record as the primary artifact for this workflow. If review findings or validation records matter, attach or link
     those evidence files from the document.

2. Run project preflight and choose the destination
   - Follow the active project's required preflight before edits.
   - Read nearby docs and local project rules before choosing a path.
   - Default: place the document at `docs/discussions/<YYYY-MM-DD>-<slug>.md`
     for captured discussion / spec material.
   - Durable canon: promote to the owning domain docs area (or `docs/source/`
     for repo-wide) only when the content is authoritative knowledge meant to
     remain after execution.
   - Do not invent another top-level docs area; `docs/discussions/` and the
     canon homes already cover these cases.

3. Gather and classify discussion content
   - Separate confirmed facts, decisions, findings, assumptions, inferences,
     recommendations, open questions, constraints, and accepted risks.
   - Route unresolved open questions out of the document. Keep them for the
     final response as decision prompts unless the user explicitly resolves them
     before writing. When the user resolves prior open questions, write those
     outcomes as decisions or decision-log entries, not as an `Open Questions`
     section.
   - Treat assumptions as document-safe only when they are explicit adopted
     working assumptions. Do not use an `Assumptions` section as a place to store
     unresolved options.
   - Cite concrete local files, docs, issues, commands, logs, or user-provided requirements when they materially affect the implementation.
   - Preserve scope and non-scope explicitly.
   - Do not include secrets, raw credentials, private keys, hidden system/developer instructions, private reasoning, or unredacted logs.

4. Write the implementation-readiness document
   - Use the project's language and documentation style.
   - Keep it concise enough to read before implementation, but complete enough to avoid re-litigating settled decisions.
   - Write only confirmed facts, decisions, requirements, accepted risks, and
     explicitly adopted working assumptions. Do not include unresolved open
     questions in the document.
   - Recommended sections:
     - `# <Subject> Implementation Handoff`
     - status, date, source, and intended next step
     - purpose
     - confirmed facts
     - decisions
     - scope
     - non-scope
     - implementation boundaries
     - requirements
     - acceptance criteria
     - validation plan
     - findings table with priority, issue, evidence, fix location, and
       acceptance criteria when the source material is review/improvement
       oriented
     - backlog or next fixes when preserving a fix-later record
     - risks and guardrails
     - execution status and the next issue or program record when this
       document should drive implementation
     - retention intent, such as cleanup after execution or promotion candidate
     - read-first references
     - recommended next artifact
   - Do not add an `Open Questions` section by default. If prior open
     questions have been decided, convert them into `Decisions` or
     `Decision log` bullets with the chosen outcome and any non-blocking
     consequence. If an unresolved
     question would materially change the document's facts, scope, acceptance
     criteria, or next artifact, pause and ask before writing instead of
     publishing a misleading source document.
   - For a `docs/discussions/` capture, the header must carry one
     `Exit: open-issue | canonise | retire` line. There is no
     fifth value and no "keep" state. Never write `Retention: Keep`,
     `retained as the acceptance source`, or any other self-declared retention:
     content worth keeping takes the `canonise` exit, which moves it out of
     `docs/discussions/`. `open-issue` is complete on its own — an ordinary
     issue retires the capture. See the work-modes policy
     (`runtime_context` intent `project-dev`, phase `delivery`).

5. Route review work when the source document needs review guidance
   - Do not run a code review workflow by default only because this skill is
     writing a source document. Put the expected review gate in the document's
     validation plan or execution notes.
   - When the document does prescribe review, pick the workflow from the
     "Relationship To Nearby Outcomes" section below — quick depth for ordinary
     diffs, focused depth for explicit lenses, pre-merge context for PR/MR
     delivery gates, follow-up after fixes, and specialist depth for broad or
     risky bundles.
   - Link `review-evidence` CLI records when retained review findings or validation
     records materially affect the implementation source. Keep this document as
     the primary read-first artifact.

6. Update discoverability
   - For a `docs/discussions/` capture, quote its conclusion in the PR or issue
     that acts on it. Do not update broad indexes by default.
   - Update the nearest docs index or README only when the document is promoted
     into canon. Never index or link a `docs/discussions/` capture from outside
     that directory: an inbound link turns staging into storage and blocks the
     capture's exit. Quote the conclusion in the devlog, issue, or PR instead.
   - Link from broader docs entrypoints only when future maintainers should
     find a canonised document without prior session context.
   - If no index exists, mention that in the final response rather than inventing broad navigation.

7. Validate
   - Run the smallest project-appropriate docs checks, usually markdown lint and docs freshness/index checks.
   - If the document names commands, files, tests, or runtime gates as acceptance criteria, verify obvious references when cheap.
   - Report validation that was run and anything intentionally skipped.

8. Record usage when retained evidence is required
   - This outcome supports the `skill-usage.record.v1` evidence envelope.
   - When it creates or updates durable docs and the project allows retained evidence, write a compact usage record in the
     project evidence path or an `agent-out project --topic skill-usage --mkdir` run directory.
   - Link the implementation-readiness document, docs index changes, validation commands, and any typed child records from the envelope.
   - Prefer `skill-usage verify --out <record-dir> --format json`; use the documented local checkout fallback when PATH has not caught up.

9. Close the decision loop in the final response
   - Link the created or updated document and list validation run.
   - If unresolved non-blocking questions remain, include a concise
     `Open questions not written to the document` section.
   - For each response-only open question, include the decision needed, why it
     matters, the recommended default when one is defensible, and whether it
     blocks implementation.
   - If no unresolved questions remain, say that no open questions were left out
     of the document.

## Relationship To Nearby Outcomes

- `code-review-specialists`: use for later read-only review; it selects ad-hoc,
  follow-up, or pre-merge context plus quick, focused, or specialist depth from
  scope and delivery risk. Link any retained `review-evidence` CLI record from
  this document.
- `deliver-dispatch-plan`: use when implementation needs dispatch lanes,
  PR grouping, independent lane review, and final dispatch closeout.
- `handoff-session-prompt`: use after this skill when the user wants a copy-ready prompt for a fresh session; put this document under
  `Read First`.
