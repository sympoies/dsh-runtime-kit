---
name: deploy
description: >
  Dispatch deploy requests to a repository-owned `.agents/scripts/deploy.sh`
  implementation.
---

# Deploy

## Contract

Prereqs:

- Run from the target repository root unless the user explicitly names another
  repository path.
- `agent-run` is installed from nils-cli 0.20.0 or newer and available on
  `PATH`.
- The target repository owns an executable `.agents/scripts/deploy.sh`.
- Deployment targets, credentials, approvals, and rollback rules are owned by
  the consuming repository.

Inputs:

- User-provided deploy arguments, passed through to the project-local script.
- Optional repository path when deployment should run from another checkout.

Outputs:

- The project-local script's stdout, stderr, exit code, and deployment evidence.
- A clear stop message when no project-local implementation exists.

Failure modes:

- `.agents/scripts/deploy.sh` is missing or is not executable.
- `agent-run` is unavailable or reports a blocked required project
  environment.
- The project-local script exits non-zero.
- The requested repository path is not a directory.

## Entrypoint

Resolve the repository root, then invoke the project-local script through
`agent-run` so repository `.envrc` / `.env` decisions are explicit:

```bash
agent-run exec --cwd "$repo_root" -- ./.agents/scripts/deploy.sh "$@"
```

When the script is missing or not executable, report:

```text
no project-local implementation: .agents/scripts/deploy.sh
```

## Workflow

1. Resolve the target repository root.
2. Verify `.agents/scripts/deploy.sh` exists and is executable.
3. Run the script through `agent-run exec --cwd "$repo_root" --`, passing
   through user arguments.
4. Report the script's deployment evidence and exit code.
5. Do not infer deployment commands when the project-local script is absent.

## Boundary

Runtime-kit owns only the dispatch contract. Each consuming repository owns the
actual deploy implementation and its safety gates.
