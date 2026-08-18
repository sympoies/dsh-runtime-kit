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

1. Read [the nils-cli compatibility manifest](../../compatibility/nils-cli.json)
   and current release metadata. Treat every command entry independently.
2. Compare each consumed command's status, contracts, flags, schemas, and exit
   codes with the target release. A `pending-release` command is not evidence
   for a release floor and keeps the package-level minimum and validated
   release unset.
3. Run focused `agent-hook` contract tests against the target artifact without
   replacing the user's system installation.
4. Run `npm test`, pack the public bundle, and execute the real DSH allow/block
   smoke with the target `agent-hook` binary.
5. Change a command to `released` only after the target artifact proves every
   listed contract. Update package-level status, minimum, validated release,
   version constraints, and compatibility docs in one coherent change; never
   infer them from a source checkout or ambient binary.
6. Run the repository's full package, discovery, policy, and compatibility
   gates before delivery.

Publishing nils-cli itself remains owned by the nils-cli repository's release
workflow.
