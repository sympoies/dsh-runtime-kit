---
name: remove-project-skill
description: >
  Remove a project-local DSH skill after a dry-run reference inventory and
  explicit apply authority.
---

# Remove Project Skill

## Contract

- Work inside the target git repository.
- The target must be exactly one directory under `.agents/skills` or
  `.dsh/skills`.
- Inventory first. Deletion requires explicit authority from the user or the
  active accepted plan.
- Historical plan records are retained unless cleanup is explicitly requested.

## Workflow

1. Resolve the repository root and exact skill directory.
2. Search active project files for the skill name and path; classify owned
   scripts, maintained docs, and historical references.
3. Present or retain the dry-run inventory before applying deletion.
4. Remove only the skill directory and explicitly approved wrappers.
5. Update maintained active references, leaving historical records intact.
6. Re-run the inventory and the project validation gate.
7. Boot DSH and prove the skill no longer appears while unrelated project and
   private skills remain discoverable.

Public bundled skills belong to `remove-skill`.
