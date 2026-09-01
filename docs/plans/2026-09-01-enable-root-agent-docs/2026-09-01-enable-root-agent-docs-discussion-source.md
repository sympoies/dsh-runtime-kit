# Repository agent-docs catalog implementation handoff

## Status

- Date: 2026-09-01
- Source: user-requested assessment and authorization to open an issue, implement, review, and merge
- Status: ready for tracked implementation
- Intended next step: execute the linked L2 plan through validation, review, merge, and strict issue closeout

## Purpose

Enable a repository-root `AGENT_DOCS.toml` for contributors working on
`dsh-runtime-kit`. The root catalog must make ordinary Codex, Claude, and
Hermes project-development preflight meaningful while preserving the separate
packaged `agent-docs/` catalog used by the DSH runtime.

## Confirmed facts

- `DEVELOPMENT.md` tells contributors to run
  `agent-docs preflight --intent project-dev` before editing.
- With no root `AGENT_DOCS.toml`, that command currently succeeds with no
  documents and no declared validation contract.
- `agent-docs/AGENT_DOCS.toml` is a shipped DSH runtime asset. Its
  `product = "dsh"` entries are intentionally excluded from the generic
  Codex, Claude, and Hermes CLI projection.
- Repository health and finish-line validation discovery activate only when a
  repository-root `AGENT_DOCS.toml` exists.
- `AGENTS.md` is loaded directly by Codex, Hermes, and DSH. Claude requires its
  native repository `CLAUDE.md` entrypoint to import that same policy. These
  always-on entrypoints must not be duplicated through agent-docs.

## Decisions

- Add a distinct repository-root catalog. Do not symlink, copy, or relocate
  the packaged DSH catalog.
- The root catalog owns repository-development routing; `agent-docs/` remains
  the published DSH runtime context asset.
- Standard products load a runtime-neutral compact project-development document
  only during `project-dev/edit`; DSH retains its separate packaged document.
- `DEVELOPMENT.md` is declared for `project-dev/edit` and
  `project-dev/delivery`, but remains optional and on demand because it is a
  contributor reference rather than prompt-mandatory context.
- `docs/policies/upstream-contribution.md` is declared only for
  `project-dev/delivery`, remains optional, and is mandatory through its
  explicit AGENTS.md trigger when cross-repository work is proposed.
- The repository validation contract applies to Codex, Claude, Hermes, and the
  isolated DSH catalog view. It declares the existing canonical routine gates:
  `npm test`, `npm run typecheck`, and `npm run benchmark:policy`.
- Path classes must classify the root catalog and shipped runtime assets as
  production, tests as test, contributor/policy/plan material as docs, and
  leave unmatched paths fail-closed.

## Scope

- Root `AGENT_DOCS.toml` with project documents, product and phase routing,
  validation commands, and path classes.
- Regression coverage for the complete catalog contract and the separation
  from the packaged DSH catalog.
- Claude's native repository policy import and a CI semantic resolver smoke
  using the pinned released `agent-docs` and `agent-hook` binaries.
- Contributor documentation that lists every catalog document, its owner,
  product, intent/phase, required status, and loading trigger.
- Provider issue, implementation PR, independent review, merge, strict
  closeout, and plan archive dry-run.

## Non-scope

- Changing the DSH selective-context wire protocol or widening its public
  intent allowlist.
- Moving or publishing the repository-root catalog in the npm package.
- Adding architecture, operations, acceptance, or historical evidence files
  to automatic model context; those remain on-demand references reached from
  `DEVELOPMENT.md`.
- Changing the canonical validation commands themselves.

## Requirements

1. Unqualified repository preflight must declare `project-dev` instead of
   returning a false-green empty result.
2. The compact required edit document must load for Codex, Claude, and Hermes
   only in the edit phase.
3. DSH must continue to obtain its compact required edit document from the
   packaged home catalog without receiving a duplicate project document.
4. `DEVELOPMENT.md` and the upstream-contribution policy must be listed with
   their exact optional loading phases.
5. All four product views must receive the same repository validation
   commands through their appropriate generic or isolated resolver.
6. The pinned released resolvers must reject missing documents, wrong products,
   wrong phases, wrong required flags, validation drift, catalog conflation,
   and an unclassified root catalog in CI; DSH validation selection must be
   proved through the authoritative finish-line resolver.
7. `DEVELOPMENT.md` must explain the two-catalog ownership boundary and the
   exact load timing without implying that a no-op preflight is valid.
8. Claude must load the complete repository policy through a tracked
   `CLAUDE.md` import of `AGENTS.md`.

## Acceptance criteria

- The pre-change regression fails because the root catalog is absent.
- Generic Codex, Claude, and Hermes strict preflight resolves the required
  compact edit document and declares the three validation commands.
- Generic delivery preflight exposes optional `DEVELOPMENT.md` and the
  upstream-contribution policy without force-injecting them.
- The DSH catalog contract remains product-isolated and package parity passes.
- Claude's native entrypoint imports `AGENTS.md`, the root compact document is
  runtime-neutral, and the DSH finish-line resolver selects exactly the three
  declared commands.
- `agent-docs audit --target project --strict`, the focused catalog test,
  `npm test`, `npm run typecheck`, and `npm run benchmark:policy` pass.
- Independent testing and maintainability review, plus any risk-selected lens,
  converge with no open finding before merge.

## Risks and guardrails

- A copied packaged catalog would be invisible to generic products and could
  resolve paths against the wrong root. Keep the catalogs separate and test
  both.
- Marking long contributor documents required would inflate every edit prompt.
  Only the compact edit contract is required; the other documents stay
  optional and phase-addressable.
- Adding DSH to the project document would duplicate the packaged DSH context.
  DSH participates only in the root validation contract.
- A validation list that differs from `DEVELOPMENT.md` creates finish-line
  drift. Freeze the exact current three-command sequence in tests.

## Execution

Recommended plan: docs/plans/2026-09-01-enable-root-agent-docs/2026-09-01-enable-root-agent-docs-plan.md

Recommended execution state: docs/plans/2026-09-01-enable-root-agent-docs/2026-09-01-enable-root-agent-docs-execution-state.md

- Profile: tracking
- Plan branch: `feat/enable-root-agent-docs`
- Retention: archive with the closed tracker after the catalog and normative
  contributor documentation merge.

## Read first

- `AGENTS.md`
- `CLAUDE.md`
- `PROJECT_DEV_EDIT.md`
- `DEVELOPMENT.md`
- `agent-docs/AGENT_DOCS.toml`
- `agent-docs/PROJECT_DEV_EDIT.md`
- `docs/policies/upstream-contribution.md`
- `test/skills.test.mjs`
- `test/coexistence-contract.test.mjs`
