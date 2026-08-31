# Acceptance boundary

Acceptance proves more than the ordinary unit, type, compatibility, and packed
smoke gates. It correlates the exact package artifact, DSH revision, released
nils executables, isolated scenario execution, governed Git delivery, and
provider read-back into one promotion result.

## Local source rehearsal

`npm run acceptance` produces a
`dsh-runtime-kit.acceptance-summary.v2` result. The local runner:

- snapshots and hashes the candidate package and six nils executables;
- clones the manifest-selected DSH revision without hardlinks;
- installs the frozen DSH dependency graph offline and builds its pristine
  libraries for source compatibility evidence;
- applies the authenticated execution-boundary patch, rebuilds DSH, and binds
  its typed patch receipt into the acceptance summary;
- authenticates the exact Agent Console TUI artifact, applies its
  package-level history-lock patch, and proves contended history persistence
  cannot delay input dispatch;
- runs operations and runtime scenarios from separate fresh package
  extractions;
- executes each scenario in a bounded transient user-systemd control group;
- rechecks the candidate, executable, and DSH identities between scenarios;
  and
- proves the functional DSH session, skills, reviewer, lifecycle, operations,
  and coexistence boundaries.

The command requires `--acknowledge-trusted-code` because the candidate runs
with user-systemd and network authority during local rehearsal. It does not
make a host-wide process-isolation claim.

## What local rehearsal does not prove

An honest local result remains `incomplete`. The candidate repository cannot
attest its own isolation, released nils provenance, or provider delivery. Local
success therefore must not be described as final acceptance or promotion.

Final `pass` additionally requires:

- a disposable OS-isolated execution environment;
- independently authenticated nils-cli v1.27.29 artifacts;
- the exact pinned DSH source and dependency closure;
- the exact reviewed DSH patch artifact, revision, target hashes, and patched
  state throughout every runtime scenario;
- the exact reviewed TUI artifact and package-patch receipt for Agent Console
  promotion;
- a clean repository head bound to the tested package digest;
- explicitly authorized semantic-commit and no-merge PR delivery; and
- direct provider read-back correlated to the same run, repository, head,
  trust root, and package.

## External trust root

The selected promotion driver lives outside this public candidate repository.
It authenticates official release artifacts before candidate execution, runs
the candidate under a credentialless and network-denied disposable identity,
proves that identity process-free afterward, and keeps credentialed provider
operations in a separate phase that never executes candidate code.

The provider record must expose exact standalone `Acceptance-Run`,
`Acceptance-Trust-Root`, and `Acceptance-Package` markers. Caller-supplied
legacy receipt flags are rejected.

Routine contributor gates and the keyless packed smoke command are documented
in [`DEVELOPMENT.md`](../DEVELOPMENT.md). Detailed historical scenario evidence
is retained in [the test-first evidence note](test-first-evidence.md).
