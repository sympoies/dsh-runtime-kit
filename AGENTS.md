# Repository policy

This repository owns the public, out-of-tree Sympoies runtime layer for
DeepSeek Harness (DSH).

## Invariants

- Do not fork or vendor DeepSeek Harness. Integrate through public Cordis and
  DSH bundle, plugin, tool, event, and service interfaces.
- Keep DSH compatibility code isolated when version-specific adapters become
  necessary. Pin every tested DSH release candidate in compatibility evidence.
- Keep private skill contents, credentials, machine paths, and personal policy
  out of this repository. Public code may discover and load explicitly
  configured private skill directories.
- Do not duplicate a policy engine in JavaScript when the rule belongs in the
  shared `nils-cli` policy boundary.

## Validation

Run the keyless end-to-end smoke test against a prepared DSH source checkout:

```sh
DSH_SOURCE_ROOT=/path/to/deepseek-harness \
AGENT_HOOK_BIN=/path/to/nils-cli/target/debug/agent-hook \
AGENT_DOCS_BIN=/path/to/nils-cli/target/debug/agent-docs \
npm run test:smoke
```

The smoke also resolves `review-specialists` as a sibling of `AGENT_HOOK_BIN`,
so build all three from the same nils-cli checkout
(`cargo build --bin agent-hook --bin agent-docs --bin review-specialists`).
Binaries older than the contracts under test fail as typed bridge errors
(`policy-output-invalid`, `finish-line response invalid`), not as version
warnings.

The test must install this package into a clean temporary DSH profile, verify
the composed bundle layer, and execute `runtime_kit_plus_one` through DSH's real
tools pipeline.
