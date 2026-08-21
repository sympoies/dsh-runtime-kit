---
name: execution-capsule
description: >
  Prepare a private, reviewable execution capsule for an already authorized
  local operation without expanding its authority.
---

# Execution Capsule

## Contract

- The underlying operation, exact target, access class, and allowed paths are
  already authorized.
- `agent-out` allocates the capsule outside the repository.
- A workspace capsule cannot equal or descend from its canonical working
  directory, and every allowed path must remain inside that directory.
- Never include credentials, auth payloads, private keys, or unrelated private
  content.

## Workflow

1. Resolve the exact operation, canonical working directory, allowed paths,
   preconditions, validation, and access class. Default to workspace access.
2. Allocate a private directory with
   `agent-out project --topic <topic> --mkdir`.
3. Create `run.sh` with `set -euo pipefail`, exact preconditions, idempotent
   mutation where practical, and essential post-validation.
4. Create `manifest.json` using schema `execution-capsule.v1`, the absolute
   working directory, entrypoint, SHA-256 digest, access class, allowed paths,
   and validation argv arrays.
5. Require directory/script mode `0700`, manifest mode `0600`, regular
   non-linked files, correct ownership, matching digest, and bounded paths.
6. Return the absolute capsule path and direct operator command:
   `bash <capsule>/run.sh`.

Do not execute the capsule unless the user explicitly requested execution.
DSH-supervised capsule execution is unavailable until the bundle exposes a
reviewed native runner; never substitute an ungoverned harness invocation.
