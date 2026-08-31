# dsh-TUI 0.10.0-beta.2 Promotion Implementation Handoff

## Status

- Date: 2026-08-31
- Source: user-requested evaluation of dsh-TUI 0.10.0-beta.1 and the newer
  0.10.0-beta.2 release
- Status: ready for tracked implementation
- Intended next step: execute the linked L2 plan through compatibility,
  delivery, canary deployment, rollout, and rollback proof

## Purpose

Promote the exact `@deepseek-harness-tui/dsh-tui@0.10.0-beta.2` npm artifact
from the currently supported 0.9.3 Agent Console boundary. The promotion must
preserve the authenticated installed-package history-lock repair, prove the
existing DSH 0.1.1-rc.2 composition, and update the deployed Agent Console
contract only after runtime-kit validation and review succeed.

## Confirmed facts

- `compatibility/agent-console.json` owns the exact TUI package, source
  revision, artifact identity, ordered bundles, and required Agent Console
  surfaces.
- `compatibility/dsh-tui-patches.json` owns the authenticated installed-package
  history-lock repair and exact before/after package hashes.
- The compatibility workflow installs the exact TUI package and runs the real
  Agent Console composition smoke against DSH 0.1.1-rc.2.
- dsh-TUI 0.10.0-beta.2 supports Node `^22.19 || >=24` and includes the
  currently deployed DSH 0.1.1-rc.2 package line in its peer ranges.
- The deployed infra contract already uses Node 26.7.0 and DSH 0.1.1-rc.2, so
  neither dependency requires a coordinated version advance.
- The upstream nonblocking history-lock PR remains open. The beta.2 artifact
  still performs synchronous lock waits, while also adding 0600/0700 data-file
  permissions that the downstream repair must preserve.
- The beta.1 release has been superseded by beta.2, which repairs a beta.1
  startup crash. Promotion therefore targets beta.2 rather than beta.1.
- The beta.2 source tag is a lightweight tag pointing to exact commit
  `655c0f16088879890d9c6ce5d160651433223e09`; it has no annotated tag object.
  The compatibility contract must describe the actual tag shape without
  claiming annotated-tag provenance.

## Decisions

- Open one L2 tracking issue in `sympoies/dsh-runtime-kit`; runtime-kit owns the
  compatibility promotion and the issue remains open through the infra
  deployment follow-up.
- Pin beta.2 exactly by npm specifier, source tag commit, tarball URL, SRI, and
  shasum. Never consume the moving npm `latest` tag.
- Retain the history-lock patch for beta.2, rebase it onto the new security-mode
  changes, and refresh every authenticated digest. Do not weaken the new
  0600/0700 behavior.
- Prove runtime-kit first. Only a merged, reviewed runtime-kit head may be
  selected by the infra Agent Console contract.
- Roll out serially: provision and smoke sympoies first, then m4. Keep the
  previous 0.9.3 contract and receipts sufficient for rollback.
- Treat beta.2 as an explicit beta promotion. Full compatibility, startup,
  held-lock, profile-inspection, and live smoke gates are mandatory.

## Scope

- Exact beta.2 source and npm artifact authentication.
- Updated TUI patch bytes and patch lifecycle hashes.
- Test-first compatibility owner regressions and exact Agent Console smoke.
- Compatibility, operations, acceptance, and devlog documentation.
- Runtime-kit PR review, merge, and provider closeout.
- Infra runtime contract and dependency-lock update after runtime-kit merge.
- Serial sympoies and m4 provisioning, live smoke, and rollback proof.

## Non-scope

- Upgrading DSH beyond 0.1.1-rc.2, Node, pnpm, or nils-cli.
- Publishing or changing upstream dsh-TUI.
- Removing the history-lock repair before the upstream fix is released in the
  exact promoted artifact.
- Broadening generic runtime-kit compatibility based only on upstream peer
  ranges.
- Changing Agent Console provider, model, sandbox, approval, or credential
  authority.

## Requirements

1. The compatibility owner must fail before production edits while it still
   expects 0.9.3.
2. The beta.2 npm bytes must match the recorded SRI and shasum before they are
   patched or executed.
3. Patch apply, check, reverse, content drift, package drift, and held-lock
   behavior must remain fail-closed and tested.
4. The rebased patch must preserve beta.2's private directory and file modes.
5. The exact DSH 0.1.1-rc.2 Agent Console profile must expose all required
   runtime-kit tools, skills, services, route, and authority observations.
6. The enabled TUI must import, emit readiness output, and remain live for the
   bounded PTY smoke window.
7. Infra may select only the merged runtime-kit identity that authenticated
   beta.2, and its pnpm graph digest must be refreshed from the resulting exact
   dependency tree.
8. Sympoies and m4 must each pass provision/read-back/live smoke in serial
   order, with the prior 0.9.3 deployment remaining recoverable.

## Acceptance criteria

- Focused owner and patch tests pass with beta.2 and include a captured RED
  against the pre-change 0.9.3 contract.
- `npm test`, typecheck, policy-source verification, package inspection, and
  the repository compatibility workflow's exact TUI smoke pass.
- Independent pre-merge testing and maintainability review, plus any selected
  risk lenses, converge with no open finding.
- Runtime-kit PR merges through the governed delivery path.
- Infra pins the merged runtime-kit commit and beta.2, passes repository
  validation, and merges through its governed delivery path.
- Sympoies then m4 report the exact beta.2 profile, pass bounded live Agent
  Console smoke, and preserve existing session/profile state.
- A bounded rollback/read-back proves the prior 0.9.3 contract remains usable
  without deleting profile homes or unrelated state.
- The tracking issue closes only after provider-visible validation, review,
  deployment, and rollback evidence are complete.

## Validation plan

- Focused `agent-console-profile` and `dsh-tui-patch` tests.
- Full runtime-kit package tests, typecheck, policy-source verification, and
  package dry-run inspection.
- Exact authenticated DSH 0.1.1-rc.2 build plus keyless Agent Console TUI
  composition smoke using matching released nils-cli binaries.
- Runtime-kit pre-merge specialist review and provider review-loop closure.
- Infra `make validate`, exact contract tests, clean provision, second-run
  idempotency, and runtime-kit receipt verification.
- Live sympoies smoke followed by live m4 smoke, then rollback/read-back proof.

## Risks and guardrails

- Beta.2 is a large prerelease. Exact pinning, serial rollout, and rollback
  proof are required; no moving dist-tag is accepted.
- The lightweight unsigned source tag supplies weaker provenance than the old
  annotated tag. Bind the exact commit and npm artifact identities and document
  the actual provenance rather than inventing a tag object.
- A naive patch refresh could discard beta.2's file-mode hardening. Held-lock
  and mode assertions must both pass on the same patched artifact.
- Runtime-kit validation is not deployment acceptance. The tracker stays open
  until both live surfaces and rollback are proven.

## Execution

Recommended plan: docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-plan.md

Recommended execution state: docs/plans/2026-08-31-dsh-tui-beta-2-promotion/dsh-tui-beta-2-promotion-execution-state.md

- Profile: tracking
- Plan branch: `feat/dsh-tui-beta-2-promotion`
- Retention: archive with the closed tracker after runtime-kit and infra
  delivery; keep normative compatibility and operations documentation current.

## Read first

- `compatibility/agent-console.json`
- `compatibility/dsh-tui-patches.json`
- `docs/compatibility.md`
- `docs/operations.md`
- `test/agent-console-profile.test.mjs`
- `test/dsh-tui-patch.test.mjs`
- `test/smoke.mjs`
- `host/agent-console/dsh/runtime-contract.json` in `serenvia/sympoies-infra`
