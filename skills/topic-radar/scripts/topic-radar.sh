#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
skill_root="$(cd -- "${script_dir}/.." && pwd)"

exec python3 "${skill_root}/bin/topic_radar.py" "$@"
