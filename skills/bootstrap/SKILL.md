---
name: bootstrap
description: >
  Dispatch project bootstrap requests to a repository-owned
  `.agents/scripts/bootstrap.sh` implementation.
---

# Bootstrap

## Contract

Prereqs:

- Run from the target repository root unless the user explicitly names another
  repository path.
- `agent-run` is installed from nils-cli 0.20.0 or newer and available on
  `PATH`.
- The target repository owns an executable `.agents/scripts/bootstrap.sh`.
- Bootstrap behavior must remain repository-specific because dependency
  managers, sensitive setup policy, and local services differ by project.

Inputs:

- User-provided bootstrap arguments, passed through to the project-local script.
- Optional repository path when bootstrapping a different checkout.

Outputs:

- The project-local script's stdout, stderr, exit code, and artifact paths.
- A clear stop message when no project-local implementation exists.

Failure modes:

- `.agents/scripts/bootstrap.sh` is missing or is not executable.
- `agent-run` is unavailable or reports a blocked required project
  environment.
- The project-local script exits non-zero.
- The requested repository path is not a directory.

## Entrypoint

Resolve the repository root, then invoke the project-local script through
`agent-run` so repository `.envrc` / `.env` decisions are explicit:

```bash
agent-run exec --cwd "$repo_root" -- ./.agents/scripts/bootstrap.sh "$@"
```

When the script is missing or not executable, report:

```text
no project-local implementation: .agents/scripts/bootstrap.sh
```

## Workflow

1. Resolve the target repository root.
2. Verify `.agents/scripts/bootstrap.sh` exists and is executable.
3. Run the script through `agent-run exec --cwd "$repo_root" --`, passing
   through user arguments.
4. Report the script's exit code and any setup notes it prints.
5. Do not add generic bootstrap behavior to runtime-kit.

## Boundary

Runtime-kit owns only the dispatch contract. Each consuming repository owns its
own bootstrap implementation.
