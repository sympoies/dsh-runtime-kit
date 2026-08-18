---
name: remove-skill
description: >
  Remove a public dsh-runtime-kit skill with dry-run reference inventory and
  package/discovery validation.
---

# Remove Skill

## Contract

- Run from the `dsh-runtime-kit` repository root.
- Start with a read-only inventory. Apply only with explicit authority.
- Preserve historical records by default.

## Workflow

1. Confirm `skills/<name>/SKILL.md` exists exactly once.
2. Search active source, tests, docs, policy, and package surfaces for the
   name and relative resource paths.
3. Classify active references separately from retained history.
4. Remove the skill directory and its entry from the exact catalog contract.
5. Update only maintained references that describe the live catalog.
6. Run `npm test`, pack the bundle, and confirm no owned files remain.
7. Run real DSH discovery and prove unrelated public, project, and private
   skills are unchanged.

Project-local skills belong to `remove-project-skill`.
