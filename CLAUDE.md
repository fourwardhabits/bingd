@AGENTS.md

## Claude Code specifics

- **Know which role this session has.**
  - **Implementer** (the normal case): do not review your own work, including with a subagent or a forked context in the same session. Request review per the reviewer-selection rule in `AGENTS.md`.
  - **Independent reviewer**: only when a fresh Claude/Fable session is explicitly assigned to review, usually for foundational or architectural work. The reviewer must not have authored any part of the branch. Report findings only; do not modify files.
- Create worktrees under `C:\Users\saisu\Documents\bingd\worktrees`, not the default `.claude/worktrees/`.
- **Claude merges only a PR the founder has explicitly approved for merge**, following "Merging to `main`" in `AGENTS.md`: one named PR, single-use, with the pre-merge checks.
  - Without that approval, Claude may push a feature branch and open a pull request, but must not merge one.
  - Claude never pushes directly to `main` without the founder's explicit approval, and never force-pushes it.
