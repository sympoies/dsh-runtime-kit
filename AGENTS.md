# Repository policy

This repository owns the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness (DSH). `CLAUDE.md` imports this file so every supported agent
uses the same repository policy.

## Invariants

- Do not fork or vendor DeepSeek Harness. Use public Cordis and DSH interfaces
  by default. A missing execution boundary may use only the version-scoped,
  hash-authenticated downstream patch declared in
  `compatibility/dsh-patches.json`.
- Patch apply and reverse must fail closed on unknown revisions, content drift,
  or unrelated checkout changes. Keep version-specific adapters under
  `src/compat/`, `patches/deepseek-harness/`, and `patches/dsh-tui/`.
- Before proposing work outside this repository, read
  `docs/policies/upstream-contribution.md` and exhaust its downstream-first
  order. Agents may only draft third-party issues or PRs; a human submits them
  and signs any DCO or CLA. Never publish a security defect or internal data.
- Do not commit private skill contents, credentials, auth state, local logs,
  machine paths, personal policy, or generated provider output. Public code may
  discover only explicitly configured private skill directories.
- Do not duplicate a policy engine in JavaScript when the rule belongs in the
  shared `nils-cli` policy boundary.
- Treat local acceptance as trusted-code rehearsal, not final promotion.
  External trust, isolation, artifact verification, and provider read-back
  remain separate acceptance requirements.

## Development workflow

- Read `DEVELOPMENT.md` for routine contributor principles and
  `docs/development-reference.md` for build, package, compatibility, patch,
  smoke, and delivery procedures.
- Inspect affected targets, callers, tests, manifests, compatibility evidence,
  package contents, and runtime boundaries before editing.
- Deliver the smallest observable contract change. Exclude hypothetical
  hardening, unsupported edge cases, architecture preference, and future
  flexibility from the current task.
  Possible improvement is not incompleteness.
- Keep provider and runtime mutations dry-run first. Never normalize or patch
  an upstream checkout during compatibility inspection.
- Use a pristine selected DSH checkout for patch or acceptance validation.
  Rebuild both typed and bundled host output after apply or reverse; source
  state alone does not prove the runtime changed.
- Run the declared routine gate before completion:

  ```sh
  npm test
  npm run typecheck
  npm run benchmark:policy
  ```

- Commits, worktrees, pull requests, reviews, and merges must use the governed
  delivery surfaces. Do not bypass signing, hooks, checkout leases, review
  convergence, or protected-branch controls.

## Documentation and history

- Keep product usage in `README.md`, contributor workflow in `DEVELOPMENT.md`,
  detailed maintenance procedures in `docs/development-reference.md`, and
  architecture, operations, compatibility, and acceptance facts in their
  existing `docs/` owners.
- Record non-trivial durable outcomes through the project-local
  `project-devlog` skill after current documentation is updated. Entries are
  English, newest-first, public-safe, and contain no credentials, private
  topology, personal identifiers, or machine-local paths.

## Project skills

- Project-local skills live under `.agents/skills/<name>/`.
- Search existing history with `scripts/devlog-search.sh <term> [YYYY-MM]`
  before adding a devlog entry.
