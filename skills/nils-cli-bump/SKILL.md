---
name: nils-cli-bump
description: >
  Advance dsh-runtime-kit's validated nils-cli release with exact artifact,
  contract, and real-DSH compatibility evidence.
---

# nils-cli Bump

## Contract

- Target a published stable `sympoies/nils-cli` release and verify its source,
  assets, and SHA-256 metadata from authoritative release data.
- Do not infer the validated release from the ambient binary.
- Raise a minimum version only when a consumed contract requires it and the
  compatibility retirement is explicit.

## Workflow

1. Read this repository's nils compatibility declaration and current lock or
   release metadata.
2. Compare the current validated tag with the target and identify changed
   commands, flags, schemas, and exit codes consumed by this bundle.
3. Run focused `agent-hook` contract tests against the target artifact without
   replacing the user's system installation.
4. Run `npm test`, pack the public bundle, and execute the real DSH allow/block
   smoke with the target `agent-hook` binary.
5. Update version constraints and compatibility docs in one coherent change.
6. Run the repository's full package, discovery, policy, and compatibility
   gates before delivery.

Publishing nils-cli itself remains owned by the nils-cli repository's release
workflow.
