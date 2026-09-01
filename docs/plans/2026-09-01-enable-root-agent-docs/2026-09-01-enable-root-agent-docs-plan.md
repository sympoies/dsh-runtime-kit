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
2. Repository policy remains harness-owned always-on context rather than an
   agent-docs document: Codex, Hermes, and DSH read `AGENTS.md`; Claude imports
   it through the native `CLAUDE.md` entrypoint.

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
  - `CLAUDE.md`
  - `PROJECT_DEV_EDIT.md`
  - `test/agent-docs-catalog-smoke.mjs`
  - `test/skills.test.mjs`
- **Description**: Capture a failing absence regression, then add the root
  catalog with the complete document, validation, and path-class contract.
- **Dependencies**:
  - none
- **Complexity**: 4
- **Acceptance criteria**:
  - Generic products resolve the compact edit contract only during edit.
  - DSH retains the packaged document and shares only the project validation.
  - The released semantic resolvers reject product, phase, required-status,
    command, and ownership drift; Claude has a complete native policy entrypoint.
- **Validation**:
  - `node --test --test-name-pattern='repository agent-docs' test/skills.test.mjs`
  - `npm run test:agent-docs-catalog`
  - phase/product-specific strict preflight, project audit, isolated DSH
    context, and authoritative DSH validation classification.

### Task 1.2: Document load timing and complete repository validation
- **Location**:
  - `DEVELOPMENT.md`
  - `docs/devlog/2026-09.md`
  - `.github/workflows/compatibility.yml`
  - `package.json`
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
- Unit: documentation and CI-wiring ownership in `test/skills.test.mjs`.
- Integration: pinned released `agent-docs` audit, preflight, and DSH context
  plus `agent-hook` authoritative validation classification in
  `test/agent-docs-catalog-smoke.mjs`.
- E2E/manual: full package routine validation and provider CI matrix.

## Risks & gotchas
- Generic `agent-docs --product` intentionally has no `dsh` option; use DSH
  session context for document isolation and authoritative finish-line probes
  for the root DSH validation selection.
- Avoid duplicate DSH model context by excluding DSH from project documents.
- Keep optional long documents listed but not force-injected.

## Rollback plan
- Revert the root catalog, its semantic tests, and the contributor routing
  section together. The packaged DSH catalog remains unchanged throughout.
