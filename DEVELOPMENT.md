# Development

Contributor guide for maintaining `dsh-runtime-kit`. Product behavior and
supported versions live in [`README.md`](README.md). Detailed source ownership,
build, packaging, compatibility, patch, smoke, acceptance, and delivery
procedures live in
[`docs/development-reference.md`](docs/development-reference.md).
The mandatory validation order, evidence rules, and failure routing live in
[`docs/development-testing.md`](docs/development-testing.md) and are applied by
the project-local `project-runtime-development` skill.

## Before editing

- Read [`AGENTS.md`](AGENTS.md), the canonical repository policy.
  [`CLAUDE.md`](CLAUDE.md) imports it for Claude Code.
- Load the required compact edit contract and declared validation:

  ```sh
  agent-docs preflight --intent project-dev --phase edit \
    --strict --require-declared-intent
  ```

- Classify the change against package behavior, public DSH/Cordis interfaces,
  compatibility evidence, version-scoped patches, runtime policy, operations,
  or documentation before choosing its owner.

## Maintenance principles

- Keep this project an out-of-tree runtime layer. Prefer public Cordis and DSH
  extension interfaces; use only the reviewed, hash-authenticated patches owned
  by `compatibility/` where an upstream boundary is missing.
- Keep version-specific adaptation isolated. Update the closed supported
  version window, peer ranges, patch evidence, and acceptance rows together.
- Put deterministic shared policy in `nils-cli`; this package integrates that
  policy with DSH and must not grow a second JavaScript policy engine.
- Treat TypeScript under `src/` and `scripts/` as source and `dist/` as build
  output. Preserve package provenance and inspect the actual `npm pack` result.
- Run dependency installation without lifecycle scripts. Package installation
  must never execute a build or another lifecycle mutation.
- Keep compatibility inspection read-only. Patch, smoke, acceptance, deploy,
  and provider operations require their explicit procedure and authority.

## Change workflow

1. Use the `project-runtime-development` skill to define the observable
   contract delta and a validation map: earliest proving layer, owner, focused
   command, expected receipt, identities, and permitted side effects.
2. For testable behavior, capture a meaningful regression failure before the
   implementation change when practical. Documentation-only work records a
   concise waiver and validates links, package visibility, and whitespace.
3. Make the smallest source change and keep every affected DSH release row and
   generated or packed surface aligned.
4. Run focused tests while iterating. Use a pristine selected DSH checkout for
   compatibility or patch work, and keep source and runtime rebuild evidence
   distinct.
5. Run the complete routine gate once for the final candidate:

   ```sh
   npm test
   npm run typecheck
   npm run benchmark:policy
   ```

6. Deliver from a managed non-default worktree through `semantic-commit` and
   `forge-cli`. Do not present a local source rehearsal as final acceptance.

## Change routing

| Need | Canonical document |
| --- | --- |
| Layered development and testing | [`Layered development and testing`](docs/development-testing.md) |
| Detailed build, package, patch, smoke, and delivery commands | [`Development reference`](docs/development-reference.md) |
| Runtime design and trust boundaries | [`Architecture`](docs/architecture.md) |
| Activation, update, rollback, repair, and removal | [`Operations`](docs/operations.md) |
| Supported DSH, Cordis, Node, and `nils-cli` versions | [`Compatibility`](docs/compatibility.md) |
| Local rehearsal versus final promotion | [`Acceptance boundary`](docs/acceptance.md) |
| External harness promotion | [`Acceptance harness`](docs/acceptance-harness.md) |
| Upstream contribution boundary | [`Upstream contribution policy`](docs/policies/upstream-contribution.md) |
| Durable implementation history | [`Development log`](docs/devlog/README.md) |

## Documentation-only validation

In addition to the routine gate, check whitespace, local links, and published
package contents when documentation changes:

```sh
git diff --check
npm pack --dry-run --json
```

Repository-visible files are not automatically part of the npm package; inspect
the pack result when adding a root document or changing `package.json#files`.
All committed repository content is written in English.
