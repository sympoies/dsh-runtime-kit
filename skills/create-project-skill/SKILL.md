---
name: create-project-skill
description: >
  Create a project-local DSH skill under a repository's `.agents/skills` or
  `.dsh/skills` tree with focused validation.
---

# Create Project Skill

## Contract

- Run inside the target git work tree.
- Default to `.agents/skills/<name>/SKILL.md` for portable project skills.
  Use `.dsh/skills` only when the user explicitly wants DSH-only scope.
- Use a kebab-case name and do not overwrite an existing skill.
- Keep private content in the consuming repository; never copy it into the
  public runtime bundle.

## Workflow

1. Resolve the repository root and inspect both supported skill roots.
2. Confirm the skill name, one-line routing description, and intended scope.
3. Create `<root>/<name>/SKILL.md` with YAML frontmatter containing exact
   `name` and `description`, followed by concise instructions.
4. Add skill-owned `scripts/`, `references/`, or assets only when required.
5. Resolve every relative resource from the skill directory.
6. Validate frontmatter, unique discovery, referenced files, and executable
   syntax where applicable.
7. Boot DSH in the project and verify the skill appears in the catalog and its
   body loads.

This workflow owns project-local creation only. Public bundled skills belong
to `create-skill`.
