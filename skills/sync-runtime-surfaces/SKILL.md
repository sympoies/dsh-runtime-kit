---
name: sync-runtime-surfaces
description: >
  Install, update, verify, or remove the dsh-runtime-kit bundle in a named DSH
  profile without modifying the upstream harness source.
---

# Sync Runtime Surfaces

## Contract

- `dsh`, `pnpm`, `agent-hook`, and the intended profile are explicit.
- Use only public profile plugin management; never edit the upstream harness
  checkout or its installed packages.
- Dry-run diagnostics precede mutation when replacing or removing an existing
  bundle.
- Private skill roots are configuration only and are never copied into the
  public package or receipts.

## Workflow

1. Run `dsh --version`, `agent-hook --version`, and inspect the current profile
   manifest and `dsh --profile <profile> --dump-config`.
2. Pack or resolve the intended `@sympoies/dsh-runtime-kit` release.
3. Install with `dsh plugin --profile <profile> add <package-spec>`, or update
   with the forwarded package-manager command.
4. Dump config again and require exactly one active runtime-kit bundle row.
5. Run bundle doctor plus a real tool allow/block policy smoke.
6. Verify public, project, and configured private skill discovery.
7. For removal, run `dsh plugin --profile <profile> remove
   @sympoies/dsh-runtime-kit`, then verify no owned rows remain.

The workflow never changes another profile, global authentication, or
unrelated package-manager dependencies.
