# Plan: Enable the repository agent-docs catalog

## Overview
Add a repository-root agent-docs catalog for contributors without changing the
separate catalog shipped to DSH. Freeze document ownership, product selection,
phase timing, validation, and path classification in one semantic contract,
then align contributor guidance and deliver through the tracked review path.

## Read First
- Primary source: `docs/plans/2026-09-01-enable-root-agent-docs/2026-09-01-enable-root-agent-docs-discussion-source.md`
- Source type: discussion-to-implementation-doc
- Open questions carried into execution: none

## Scope
- In scope: root catalog, semantic tests, contributor routing documentation,
  validation, review, merge, and issue closeout.
- Out of scope: DSH protocol changes, automatic loading of large architecture
  or operations references, and npm publication of the root catalog.

## Assumptions
1. The current canonical routine validation remains `npm test`,
   `npm run typecheck`, and `npm run benchmark:policy`.
2. `AGENTS.md` remains harness-owned always-on context rather than an
   agent-docs document.

## Sprint 1: Repository catalog activation
**Goal**: Make project-development preflight and finish-line discovery
meaningful for this repository while preserving DSH catalog isolation.
**Demo/Validation**:
- Command(s): focused Node test, product/phase-specific `agent-docs preflight`,
  strict project audit, full routine validation.
- Verify: every declared document and validation command resolves only for its
  intended product and phase.

### Task 1.1: Freeze and implement the root catalog contract
- **Location**:
  - `AGENT_DOCS.toml`
  - `test/skills.test.mjs`
- **Description**: Capture a failing absence regression, then add the root
  catalog with the complete document, validation, and path-class contract.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - Generic products resolve the compact edit contract only during edit.
  - DSH retains the packaged document and shares only the project validation.
  - Tests reject product, phase, required-status, command, and ownership drift.
- **Validation**:
  - `node --test --test-name-pattern='repository agent-docs catalog' test/skills.test.mjs`
  - phase/product-specific strict preflight and project audit.

### Task 1.2: Document load timing and complete repository validation
- **Location**:
  - `DEVELOPMENT.md`
  - `docs/devlog/2026-09.md`
- **Description**: List the two catalogs, every declared document, its loading
  phase and trigger, and record the durable workflow correction.
- **Dependencies**:
  - Task 1.1
- **Complexity**: 3
- **Acceptance criteria**:
  - Contributor guidance no longer describes a false-green preflight.
  - Required versus optional loading and the DSH isolation rule are explicit.
  - Complete local and provider validation passes.
- **Validation**:
  - `npm test`
  - `npm run typecheck`
  - `npm run benchmark:policy`
  - `git diff --check`

## Testing Strategy
- Unit: semantic catalog assertions in `test/skills.test.mjs`.
- Integration: real `agent-docs` list, preflight, and audit for supported
  product/phase combinations.
- E2E/manual: full package routine validation and provider CI matrix.

## Risks & gotchas
- Generic `agent-docs --product` intentionally has no `dsh` option; use the
  catalog contract and existing DSH integration coverage for the isolated view.
- Avoid duplicate DSH model context by excluding DSH from project documents.
- Keep optional long documents listed but not force-injected.

## Rollback plan
- Revert the root catalog, its semantic tests, and the contributor routing
  section together. The packaged DSH catalog remains unchanged throughout.
