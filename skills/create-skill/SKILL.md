---
name: create-skill
description: >
  Add a public DSH-native skill to dsh-runtime-kit with catalog, package, and
  real-harness acceptance coverage.
---

# Create Skill

## Contract

- Run from the `dsh-runtime-kit` repository root.
- The requested skill is public and reusable. Project or personal skills use
  `create-project-skill` or the configured private loader.
- The canonical name is unique kebab-case.

## Workflow

1. Inspect the existing `skills/` catalog and choose the final name.
2. Create `skills/<name>/SKILL.md` with exact `name` and a concise routing
   `description` in YAML frontmatter.
3. Add only resources directly owned by the skill. Use paths relative to the
   skill directory.
4. Keep deterministic or security-sensitive behavior in released nils-cli
   commands; the skill explains when and how to call them.
5. Add the name to the exact catalog contract test.
6. Run `npm test`, package the bundle, and verify the packed artifact contains
   the skill and resources.
7. Run the real DSH discovery smoke and load the complete body.

Do not add private names, local absolute paths, secrets, or runtime-specific
prompt boilerplate to the public catalog.
