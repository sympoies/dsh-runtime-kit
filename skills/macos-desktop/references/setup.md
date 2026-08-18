# macOS Computer Use Setup

## Install The Released Adapter

Install the released nils-cli package on every controller and Mac that will
execute desktop actions:

```bash
brew tap sympoies/tap
brew install sympoies/tap/nils-cli
macos-agent --version
```

The Peekaboo release, commit, assets, hashes, architectures, signatures,
minimum macOS, and capability probes are embedded in the nils-cli lock. Do not
install Peekaboo through a separate package, floating tag, or package runner.

Review the backend lifecycle before applying it:

```bash
macos-agent backend status --format json
macos-agent backend install --dry-run --strict --format json
macos-agent backend install --strict --format json
macos-agent backend verify --strict --format json
```

The exact locked v3.9.3 standalone CLI may report the reviewed
`notary=waived` / `security_posture=reduced` posture. That result is disclosed,
not equivalent to notarization success. App notarization, Gatekeeper, archive
and executable hashes, architecture, version, bundle metadata, signing
identities, and locked capability checks remain enforced.

## Permissions

In **System Settings > Privacy & Security**, grant the effective runtime
authority:

- **Accessibility** for AX and input actions.
- **Automation** when macOS requests control of another app.
- **Screen & System Audio Recording** for screenshots and UI observation.

`macos-agent` never changes TCC. Run readiness through the same runtime and
transport that will perform the action:

```bash
macos-agent doctor --strict --format json
macos-agent capabilities --strict --format json
```

Permission changes can require the app/runtime or graphical login session to
restart. Do not repeatedly retry a denied mutation.

## SSH

Configure host verification and authentication in the operator's normal SSH
configuration. Keep hostnames, usernames, keys, and machine paths out of source
and evidence. The remote Mac must have an active, unlocked graphical login.

The controller and remote target require the same released `macos-agent` and
embedded backend lock. Supply the trusted alias only at runtime:

```bash
macos-agent backend status --host "$MACOS_SSH_HOST" --format json
macos-agent backend verify --host "$MACOS_SSH_HOST" --strict --format json
macos-agent doctor --host "$MACOS_SSH_HOST" --strict --format json
macos-agent capabilities --host "$MACOS_SSH_HOST" --strict --format json
```

The adapter owns batch SSH, fixed remote commands, request framing, private
staging, digest-checked artifact transfer, cleanup audit, and host redaction.
Do not wrap these commands in a second transport layer.

## Cold GUI Bridge Recovery

`doctor --strict` intentionally observes readiness without launching the app
runtime. When its only blocked check is `bridge` with
`Peekaboo GUI Bridge exact build is unavailable`, and backend verification,
runtime, permissions, and every capability probe pass, run one bounded
read-only observation through the intended app runtime:

```bash
out="$(agent-out project --topic macos-adapter-verify --repo "$PWD" --mkdir)"
macos-agent exec \
  --out-dir "$out" \
  --intent "Bootstrap the verified GUI Bridge and inspect the target" \
  --runtime app \
  -- see --app "$TARGET_APP" --json
macos-agent doctor --strict --format json
macos-agent capabilities --strict --format json
```

For SSH, pass the same trusted runtime alias to every command. The read-only
`exec` asks the adapter to start the owned stable app when the exact Bridge is
cold, then verifies the locked handshake before observation. Do not reinstall
an already verified backend for this state. If observation fails, another
doctor check remains blocked, or any other hard check is not passing, stop and
classify the failure as backend, Peekaboo/adapter, runtime-skill, or TCC
environment work before attempting a mutation.

## Functional Verification

Allocate a private evidence root and prove one read-only observation before
mutating the desktop:

```bash
out="$(agent-out project --topic macos-adapter-verify --repo "$PWD" --mkdir)"
macos-agent exec \
  --out-dir "$out" \
  --intent "Inspect Calculator" \
  --runtime app \
  -- see --app Calculator --json
macos-agent journal summarize --out-dir "$out" --format json
macos-agent journal review --out-dir "$out" --format json
```

For SSH, add `--host "$MACOS_SSH_HOST"` to `exec`. A valid run contains
`manifest.json`, `steps.jsonl`, `artifacts/index.json`, `summary.json`, and
`redaction.json` without the alias, user/home paths, keys, or raw remote
commands.

## Rollback Readiness

Rollback is limited to the exact previous release embedded in the adapter
allowlist. Review without changing live state:

```bash
macos-agent backend rollback --dry-run --strict --format json
```

Apply rollback only as part of a reviewed runtime rollback, then run strict
verify, strict doctor, and one read-only observation. Never replay a mutation
automatically during rollback.
