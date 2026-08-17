# Private and project skills

The public package contains only the public `skills/` catalog.

Project skills use DSH's native roots:

- `<git-root>/.dsh/skills`
- `<git-root>/.agents/skills`

An additional personal directory may be selected with
`DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR`. It must be an absolute existing directory,
must be owned by the current user, and neither it nor its contents may be
group/world writable or symbolic links. Unsafe writable ancestors are rejected;
a root below a sticky system temp directory is accepted. Windows private-root
loading is disabled until an ACL trust check is available. Its expected layout
is one level of `<name>/SKILL.md` bundles.

The directory is read at runtime. Its path, catalog, bodies, and telemetry are
not copied into this repository or package. Discovery precedence is project,
then configured private, then bundled public.

Private discovery is intentionally not watched. Restart DSH after changing the
private catalog so the trust boundary is revalidated before it is loaded.
