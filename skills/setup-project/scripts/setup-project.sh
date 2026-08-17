#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  setup-project.sh [--repo PATH] [--dry-run]
  setup-project.sh [--repo PATH] --apply --pre-pr-command COMMAND [options]

Options:
  --repo PATH                 Target repository. Defaults to the current git root.
  --dry-run                   Report adoption state without writing files (default).
  --apply                     Create requested project-local runtime files.
  --pre-pr-command COMMAND    Command for .agents/scripts/pre-pr.sh.
  --bootstrap-command COMMAND Command for .agents/scripts/bootstrap.sh.
  --deploy-command COMMAND    Command for .agents/scripts/deploy.sh.
  --release-command COMMAND   Command for .agents/scripts/release.sh.
  --replace-existing          Allow replacing existing generated dispatcher scripts.
  -h, --help                  Show this help.
USAGE
}

die() {
  echo "setup-project: error: $*" >&2
  exit 1
}

usage_error() {
  echo "setup-project: error: $*" >&2
  usage >&2
  exit 2
}

repo_arg=""
mode="dry-run"
replace_existing=0
pre_pr_command=""
bootstrap_command=""
deploy_command=""
release_command=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || usage_error "--repo requires a path"
      repo_arg="$2"
      shift 2
      ;;
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --apply)
      mode="apply"
      shift
      ;;
    --pre-pr-command)
      [ "$#" -ge 2 ] || usage_error "--pre-pr-command requires a command"
      pre_pr_command="$2"
      shift 2
      ;;
    --bootstrap-command)
      [ "$#" -ge 2 ] || usage_error "--bootstrap-command requires a command"
      bootstrap_command="$2"
      shift 2
      ;;
    --deploy-command)
      [ "$#" -ge 2 ] || usage_error "--deploy-command requires a command"
      deploy_command="$2"
      shift 2
      ;;
    --release-command)
      [ "$#" -ge 2 ] || usage_error "--release-command requires a command"
      release_command="$2"
      shift 2
      ;;
    --replace-existing)
      replace_existing=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown argument: $1"
      ;;
  esac
done

if [ -n "$repo_arg" ]; then
  [ -d "$repo_arg" ] || die "target repository path is not a directory: $repo_arg"
  repo_root="$(cd "$repo_arg" && git rev-parse --show-toplevel 2>/dev/null)" ||
    die "target path is not inside a git work tree: $repo_arg"
else
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
    die "current directory is not inside a git work tree"
fi

agents_dir="$repo_root/.agents"
scripts_dir="$agents_dir/scripts"
skills_dir="$agents_dir/skills"
pre_pr_path="$scripts_dir/pre-pr.sh"

script_status() {
  local path="$1"
  if [ -x "$path" ] && [ -f "$path" ]; then
    printf 'executable'
  elif [ -e "$path" ]; then
    printf 'present-not-executable'
  else
    printf 'missing'
  fi
}

dir_status() {
  if [ -d "$1" ]; then
    printf 'present'
  else
    printf 'missing'
  fi
}

candidate_commands() {
  local found=0
  if [ -x "$repo_root/scripts/ci/all.sh" ]; then
    echo "setup-project: candidate pre-pr command: bash scripts/ci/all.sh"
    found=1
  fi
  if [ -f "$repo_root/package.json" ]; then
    echo "setup-project: candidate pre-pr command: npm test"
    found=1
  fi
  if [ -f "$repo_root/Cargo.toml" ]; then
    echo "setup-project: candidate pre-pr command: cargo test"
    found=1
  fi
  if [ -f "$repo_root/pyproject.toml" ]; then
    echo "setup-project: candidate pre-pr command: uv run pytest"
    found=1
  fi
  if [ "$found" -eq 0 ]; then
    echo "setup-project: candidate pre-pr command: none detected"
  fi
}

pre_pr_status="$(script_status "$pre_pr_path")"
if [ ! -d "$agents_dir" ]; then
  adoption="unadopted"
elif [ "$pre_pr_status" = "executable" ]; then
  adoption="adopted"
else
  adoption="partial"
fi

echo "setup-project: repo=$repo_root"
echo "setup-project: adoption=$adoption"
echo "setup-project: .agents=$(dir_status "$agents_dir")"
echo "setup-project: .agents/scripts=$(dir_status "$scripts_dir")"
echo "setup-project: .agents/skills=$(dir_status "$skills_dir")"
for name in bootstrap deploy pre-pr release; do
  echo "setup-project: script=$name status=$(script_status "$scripts_dir/$name.sh") path=.agents/scripts/$name.sh"
done
candidate_commands

if [ "$mode" = "dry-run" ]; then
  if [ "$adoption" = "partial" ]; then
    echo "setup-project: block adopted repo missing executable .agents/scripts/pre-pr.sh" >&2
    exit 1
  fi
  echo "setup-project: dry-run complete"
  exit 0
fi

[ -n "$pre_pr_command" ] || [ "$pre_pr_status" = "executable" ] ||
  die "apply requires --pre-pr-command to create .agents/scripts/pre-pr.sh"

mkdir -p "$scripts_dir" "$skills_dir"

write_dispatcher() {
  local name="$1"
  local command="$2"
  local path="$scripts_dir/$name.sh"

  [ -n "$command" ] || return 0
  if [ -e "$path" ] && [ "$replace_existing" -ne 1 ]; then
    die "refusing to overwrite existing script without --replace-existing: .agents/scripts/$name.sh"
  fi
  cat >"$path" <<SCRIPT_EOF
#!/usr/bin/env bash
set -euo pipefail

repo_root="\$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "\$repo_root"
# Run the configured command under this shell's \`set -euo pipefail\` rather
# than \`exec\`-ing it: a compound command (&&, ||, ;, |) then runs every stage
# and any failure aborts the gate. \`exec\` would bind only the first simple
# command and silently drop the rest, turning a partial run into a green gate.
$command "\$@"
SCRIPT_EOF
  chmod +x "$path"
  echo "setup-project: wrote .agents/scripts/$name.sh"
}

if [ "$pre_pr_status" != "executable" ] || [ "$replace_existing" -eq 1 ]; then
  write_dispatcher "pre-pr" "$pre_pr_command"
fi
write_dispatcher "bootstrap" "$bootstrap_command"
write_dispatcher "deploy" "$deploy_command"
write_dispatcher "release" "$release_command"

if [ ! -x "$pre_pr_path" ]; then
  die "post-apply validation failed: .agents/scripts/pre-pr.sh is not executable"
fi

echo "setup-project: apply complete"
