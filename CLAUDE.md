@AGENTS.md

## Claude Code specifics

- **Know which role this session has.**
  - **Implementer** (the normal case): do not review your own work, including with a subagent or a forked context in the same session. Request review per the reviewer-selection rule in `AGENTS.md`.
  - **Independent reviewer**: only when a fresh Claude/Fable session is explicitly assigned to review, usually for foundational or architectural work. The reviewer must not have authored any part of the branch. Report findings only; do not modify files.
- Create worktrees under `C:\Users\saisu\Documents\bingd\worktrees`, not the default `.claude/worktrees/`.
- **Claude never merges.** This is narrower than the generic agent authority in the README and PRD §24, deliberately. Claude may push a feature branch and open a pull request. It must not merge one or push to `main`.
