---
name: setup-project
description: >
  Adopt a repository's `.agents` conventions for DSH project skills and
  project-owned lifecycle scripts.
---

# Setup Project

## Contract

- Run inside the target git work tree.
- Dry-run is the default; never overwrite an existing project file without
  explicit approval.
- An apply that creates `.agents/scripts/pre-pr.sh` requires the real project
  validation command. A successful no-op gate is forbidden.

## Entrypoint

Resolve this skill's resource base, then run:

```bash
bash scripts/setup-project.sh --repo "$repo_root" --dry-run
```

Apply only after the validation command is known:

```bash
bash scripts/setup-project.sh --repo "$repo_root" --apply \
  --pre-pr-command "bash scripts/ci/all.sh"
```

## Workflow

1. Inspect `.agents/scripts`, `.agents/skills`, and project validation entrypoints.
2. Review the helper's dry-run classification.
3. Apply only the approved directories and explicit dispatcher commands.
4. Validate shell syntax and execute the project-owned validation gate.
5. Boot DSH and verify `.agents/skills` discovery from the project root.

Host bundle installation remains owned by `sync-runtime-surfaces`.
