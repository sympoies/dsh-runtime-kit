# Migration status

The replacement is staged behind executable gates:

1. Complete: external bundle installation and real DSH boot without a fork.
2. Source complete, release pending: strict nils-cli DSH ingress and fail-closed
   allow/block bridge. The package release floor remains unset until the
   matching nils-cli capability is published and artifact-validated.
3. Complete: 29 public skills plus project/private discovery and precedence.
4. In progress: context activation, post-tool/finish-line policy events, and
   deterministic parity for the retained policy handlers.
5. Pending: one DSH-native reviewer tool with eight read-only personas.
6. Pending: setup/update/rollback diagnostics, performance budget, full
   compatibility CI, and local runtime cutover.

The previous runtime remains untouched until the new path passes every gate
and no active configuration points to it. At that point it can be marked
read-only and retained only as migration history.
