# Repository maintenance

- Develop on `main`; create another branch only when the user explicitly requests one.
- Keep source, tests, and build configuration in Git. `dist/` and test reports are generated; preserve real `data/` stores.
- Back up and verify unique history and uncommitted files outside the repository before removing obsolete branches or worktrees.
- Preserve the public exports and package runtime during cleanup. Do not publish packages or push release tags as part of branch maintenance.
