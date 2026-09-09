# DSH project development

Follow the current repository instructions and implement the smallest complete
change that satisfies the user's request. For testable behavior, capture a
meaningful regression failure before production edits, run focused checks while
iterating, then run the repository's declared validation gates. Treat runtime
policy denials as authoritative and use the governed Git, review, and delivery
surfaces exposed by the DSH runtime. A commit from a session-owned non-default
managed worktree uses `runtime_kit_governed_commit`; direct or otherwise unsafe
delivery to the default branch remains refused.
