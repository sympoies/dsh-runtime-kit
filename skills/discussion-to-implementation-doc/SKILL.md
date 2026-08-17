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
  lessons learned, or fix-later backlog for later implementation or plan
  generation, not execute the implementation now.
- Discussion or review context is sufficient to separate confirmed facts,
  decisions, assumptions, open questions, findings, and recommendations.
- Target workspace is available and project rules allow writing docs after required preflight.

Inputs:

- User request and the discussion or review conclusions to preserve.
- Relevant local code, docs, issue, ticket, test, review, validation, or runtime
  evidence for material facts when available.
- Optional target docs area, filename, linked issue/plan/handoff, validation commands, retention intent, and project-specific documentation
  conventions.

Outputs:

- A repo-local discussion / implementation-readiness source document. Place it
  by destination — do not default it into the plan area:
  - Default (non-plan capture): `docs/discussions/<YYYY-MM-DD>-<slug>.md` for
    converged requirements, design, feasibility, product, architecture,
    customer-facing, review, risk, lessons-learned, or fix-later material that
    is captured for later work but is not an executed-and-archived plan bundle.
  - L2 plan source: only when the document will feed a plan that is executed and
    archived, save it inside the bundle as
    `docs/plans/<YYYY-MM-DD>-<slug>/<slug>-discussion-source.md` (or
    `<slug>-review-source.md` for review / risk / backlog material) and include
    the `Execution` plan lines below.
  - Durable canon: when the content is already authoritative knowledge rather
    than coordination, promote it to the owning domain docs area (or
    `docs/source/` for repo-wide architecture / specs / policy) — a deliberate
    promotion, not this skill's default.
- A source artifact that a plan-tracking or dispatch delivery workflow can link
  under `Read First` when execution sequencing is needed.
- A source document that avoids unresolved open questions; report any
  non-blocking open questions in the final response instead of writing them into
  the document.
- An `Execution` section with stable `Recommended plan` and
  `Recommended execution state` lines only for the L2 plan-source case; omit
  them for a `docs/discussions/` capture and for promoted canon.
- Updated local docs index or README only when the document is intentionally promoted as retained knowledge and should be discoverable
  outside the plan.
- When following the evidence-control-plane recording convention, a `skill-usage.record.v1` envelope that links the created document and validation
  evidence.
- A short response linking the document path, listing validation run, and
  presenting any response-only open questions as immediate decision prompts.

Exit codes:

- N/A (conversation/workflow skill)

Failure modes:

- The user actually needs phased tasks, sprint grouping, PR splitting, or
  detailed execution sequencing now; create or update the plan first, then use
  `deliver-plan-tracking-issue` or `deliver-dispatch-plan` as appropriate for
  the issue-backed workflow; each parent opens a missing tracker internally.
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
   - Do not turn the document into a task-by-task implementation plan. If execution sequencing is needed, write this document first, then use
     the appropriate plan-tracking or dispatch workflow and link this document
     as read-first context.
   - Treat this document as the primary source artifact for later plan
     generation when the source material is requirements, design, feasibility,
     product, architecture, customer-facing discussion, review findings, risks,
     lessons learned, validation guardrails, or fix-later backlog.
   - For unresolved HEURISTIC_SYSTEM workflow gaps that should be versioned but
     are not ready for a fix, use
     `core/policies/heuristic-system/error-inbox/<slug>/ENTRY.md` instead of a
     `docs/discussions/` capture.
   - Treat `docs/discussions/<YYYY-MM-DD>-<slug>.md` as the default home. Use a
     `docs/plans/<YYYY-MM-DD>-<slug>/` bundle only for a document that will feed
     an executed-and-archived plan; promote into domain docs/runbooks (or
     `docs/source/`) only when the content is durable canon.
   - Graduating a `docs/discussions/` capture to L2: when it later needs a
     tracked plan, move it into a `docs/plans/<YYYY-MM-DD>-<slug>/` bundle as
     `<slug>-discussion-source.md` (retire the `docs/discussions/` original),
     author the `<slug>-plan.md` + `<slug>-execution-state.md`, then run the
     selected plan delivery outcome. Promotion is a move, not a copy.
   - Do not use the document as a session prompt. If continuity is needed, write or reference this document first, then use
     `handoff-session-prompt`.
   - Do not use a `review-evidence` CLI record as the primary artifact for this workflow. If review findings or validation records matter, attach or link
     those evidence files from the document.

2. Run project preflight and choose the destination
   - Follow the active project's required preflight before edits.
   - Read nearby docs and local project rules before choosing a path.
   - Default: place the document at `docs/discussions/<YYYY-MM-DD>-<slug>.md`
     for captured discussion / spec material that is not an
     executed-and-archived plan.
   - L2 plan source: only when the document will feed a plan that runs and is
     archived, place it inside the bundle as
     `docs/plans/<YYYY-MM-DD>-<slug>/<slug>-discussion-source.md` (or
     `<slug>-review-source.md` for review / risk / backlog material).
   - Durable canon: promote to the owning domain docs area (or `docs/source/`
     for repo-wide) only when the content is authoritative knowledge meant to
     remain after execution.
   - Do not invent another top-level docs area; `docs/discussions/`,
     `docs/plans/`, and the canon homes already cover these cases.

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
     - execution, including recommended plan path, recommended execution-state path, status, and next-task source when this document should
       drive implementation
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
   - For an L2 plan source only (inside `docs/plans/<YYYY-MM-DD>-<slug>/`),
     include these stable machine-checkable lines in the `Execution` section:
     - `Recommended plan: docs/plans/<YYYY-MM-DD>-<slug>/<slug>-plan.md`
     - `Recommended execution state: docs/plans/<YYYY-MM-DD>-<slug>/<slug>-execution-state.md`
     Omit the `Execution` plan lines for a `docs/discussions/` capture.
   - When a plan's `Read First` section links a document produced by this
     skill, use `Source type: discussion-to-implementation-doc` for both
     `*-discussion-source.md` and `*-review-source.md`; do not use the retired
     `review-to-improvement-doc` source type.

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
   - For a `docs/plans/<YYYY-MM-DD>-<slug>/` source document, use the plan's
     `Read First` section as the discoverability path; for a `docs/discussions/`
     capture, link it from the PR or issue that acts on it. Do not update broad
     indexes by default.
   - Update the nearest docs index or README only when the document is promoted or intentionally retained after execution.
   - Link from broader docs entrypoints only when future maintainers should find the document without prior plan/session context.
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
- `deliver-plan-tracking-issue`: use when a lightweight issue-backed plan is
  ready to open or resume, execute, and deliver.
- `deliver-dispatch-plan`: use when implementation needs dispatch lanes,
  PR grouping, independent lane review, and final dispatch closeout.
- `handoff-session-prompt`: use after this skill when the user wants a copy-ready prompt for a fresh session; put this document under
  `Read First`.
