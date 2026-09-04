#!/bin/sh
# Repository-owned generic deploy dispatcher: the sole target of the shared
# `meta:deploy` skill (`agent-run exec --cwd <repo> -- ./.agents/scripts/deploy.sh ...`).
#
# This wrapper only locates the repository and execs the Node dispatcher. All
# scope validation, artifact authentication, and receipt handling live in
# src/deploy/index.js; every profile, package, and activation decision belongs to
# the digest-reviewed operations engine it invokes. Nothing is duplicated here.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)

exec node "$repo_root/scripts/deploy.mjs" "$@"
