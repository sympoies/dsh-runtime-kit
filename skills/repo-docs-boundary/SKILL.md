---
name: repo-docs-boundary
description: >
  Audit or maintain README, contributor setup, and durable repository docs
  placement while preserving the active repository policy.
---

# Repository Docs Boundary

## Contract

Prereqs:

- Resolve the target git repository from the current working directory or an
  explicit path.
- Before writing, inspect the active repository policy and documentation
  entrypoints: `AGENTS.md`, `AGENT_DOCS.toml`, `README.md`,
  `DEVELOPMENT.md`, `CONTRIBUTING.md`, `docs/`, package manifests, CI config,
  and project-owned validation scripts when present.
- Activate and follow the repository's required docs intent before editing.
  A closer repository rule overrides this general placement guide.

Inputs:

- Mode:
  - `audit` inspects and recommends changes without writing.
  - `apply` makes a narrow requested documentation change after inspection.
  - `new-repo` proposes or creates minimal first-pass entrypoints.
- Optional repository path; default is the current working directory.
- User constraints such as audience, package type, install surface, maturity,
  validation command, or preferred language.

Outputs:

- In `audit` mode, a concise section inventory with `keep`, `move`,
  `summarize+link`, `split`, `delete`, or `create` recommendations.
- In `apply` or `new-repo` mode, narrowly edited root docs and only the
  supporting `docs/**` files that need a durable owner, plus validation results.
- Focused open questions when repository purpose, audience, install path, or
  contributor validation cannot be verified.

Failure modes:

- Repository purpose or workflow is too unclear to document concretely.
- Existing prose conflicts with live manifests, scripts, CI, or tests.
- A proposed edit would duplicate an authoritative rule in multiple places.
- Repository policy requires a different placement or validation path.

## Entrypoint

Choose one mode before acting:

```text
repo-docs-boundary audit [repo-path]
repo-docs-boundary apply [repo-path]
repo-docs-boundary new-repo [repo-path]
```

Default ambiguous or broad requests to `audit`. Treat a narrow explicit edit
as `apply`. Resolve the repository root, run its declared preflight, and inspect
the relevant definitions and call sites before changing documentation.

## Source Priority

Use the strongest available source for each claim:

1. User requirements for audience, positioning, and requested scope.
2. Local manifests, package metadata, scripts, CI, hooks, docs catalogs, and
   tests.
3. Existing documentation after checking it against live project files.
4. Inference, labeled when it affects placement or wording.

For external, unstable, or version-sensitive facts, activate the repository's
`task-tools` intent and run `agent-docs preflight --intent task-tools`, then
follow `core/policies/external-facts.md` before asserting them.

## Placement Rules

### README.md

Keep `README.md` user-facing. It should quickly establish repository identity,
audience, value, install or run path, shortest useful example, major
capabilities, and links to contributor or detailed documentation.

Avoid full development setup, exhaustive validation matrices, agent or PR
policy, long troubleshooting trees, internal design rationale, generated-file
rules, and release ceremony unless ordinary users truly need them.

### DEVELOPMENT.md

Keep `DEVELOPMENT.md` contributor-focused and short enough to read before a
normal edit. Retain the setup prerequisites, required preflight, exact build or
generation commands, finish-line validation, source-of-truth boundaries,
high-risk gotchas, and release or delivery boundaries needed for routine work.

Move rare runbooks, long rationale, complete troubleshooting trees, historical
background, and tool reference detail outward. Do not reduce
`DEVELOPMENT.md` to a link catalog: mandatory rules and exact everyday commands
remain inline.

### docs/

Use the repository's existing docs area for durable architecture, operations,
advanced configuration, troubleshooting, API or protocol reference, historical
decisions that remain useful, and feature-specific guides. When no closer rule
exists, prefer lowercase kebab-case filenames and avoid new root-level Markdown
files.

## Workflow

1. Classify the request as `audit`, `apply`, or `new-repo`.
2. Resolve the repository root and inspect policy, root docs, docs indexes,
   manifests, build scripts, CI, and validation surfaces relevant to the claims.
3. Inventory each meaningful section by current location, target audience,
   must-read-before-edit status, user-facing value, and long-form detail.
4. Select one canonical owner for each rule or command. Keep short summaries in
   root entrypoints and link to long-form detail instead of duplicating it.
5. For `audit`, report evidence-backed placement findings and proposed actions
   without editing.
6. For `new-repo`, draft the smallest complete `README.md` and
   `DEVELOPMENT.md`; create `docs/` files only when necessary to prevent root
   entrypoint bloat.
7. For `apply`, edit narrowly and preserve the established tone, headings,
   language, and link style. Do not rewrite unrelated sections to fit a generic
   template.
8. Run the repository's declared docs or development validation. If none
   exists, check changed Markdown links and obvious stale references; report
   any skipped validation and why.

## Review Checklist

- A non-contributor can understand and try the project from `README.md`.
- Contributors can find setup, preflight, source-of-truth, and validation gates
  in `DEVELOPMENT.md` without reading a long runbook first.
- Long-lived detail has one stable owner under `docs/` or a narrower existing
  project area.
- Root docs link to canonical detail without maintaining duplicate rules.
- Relative links resolve and claims agree with current project files.
- The result distinguishes verified facts, assumptions, and open questions.

## Boundary

This skill owns documentation placement judgment, audits, and narrow docs
edits. It does not own product strategy, package design, CI design, release
automation, or repository policy changes beyond documenting the current source
of truth. When the documentation review reveals a behavior gap, name and route
the gap through the repository's implementation workflow instead of papering
over it with prose.
