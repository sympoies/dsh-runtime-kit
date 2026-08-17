---
name: screen-record
description: >
  Capture screenshots or recordings from windows or displays through the nils-cli `screen-record` command.
---

# Screen Record

## Contract

Prereqs:

- `screen-record` is installed from the released nils-cli package and available on `PATH`.
- The host supports the requested capture mode.
- macOS screen-recording permissions or Linux capture prerequisites are available before capture.

Inputs:

- Screenshot or recording mode.
- Window, app, active-window, display, or display-id selector.
- Output path or directory.
- Optional metadata, diagnostics, duration, audio, format, and if-changed settings.

Outputs:

- Screenshot image, recording file, metadata JSON, diagnostics artifacts, or selectable target list.

Failure modes:

- Capture permission is missing.
- The selected window or display cannot be resolved.
- Required recording backend is unavailable.

## Outcome Routing

The user requests a screenshot or recording. The workflow selects preflight,
target discovery, capture, and diagnostics from the requested claim. When no
path is supplied, allocate one project-scoped output directory; evidence
metadata and diagnostics are internal bookkeeping and are reported only when
they support the result or explain a failure.

## Entrypoint

Use the released CLI directly:

```bash
screen-record --preflight
screen-record --list-windows
RUN_DIR="$(agent-out project --topic screen-record --repo "$PWD" --mkdir)"
screen-record --screenshot --active-window --path "$RUN_DIR/window.png"
screen-record --display --duration 10 --path "$RUN_DIR/session.mov" --metadata-out "$RUN_DIR/session.json"
```

## Workflow

1. Run `--preflight` when host permissions or capture backend status is uncertain.
2. Use `--list-windows`, `--list-displays`, or `--list-apps` before selecting a target by id or name.
3. Prefer explicit `--path` for evidence artifacts that need to be linked from validation.
4. Use `--diagnostics-out` for failed or flaky recording checks.

## Boundary

`screen-record` owns capture and metadata mechanics. The caller owns choosing a non-sensitive target and deciding whether artifacts are temporary evidence or durable records.
