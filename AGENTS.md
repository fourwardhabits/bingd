# Agent instructions

Read this before any work in this repo. It points at the canonical policy rather than restating it:

- `docs/product/decision-log.md` — outranks everything below it (see README "Precedence").
- `docs/product/PRD.md` §24 — environments, sensitive surfaces, review and merge rules.
- `README.md` — "For implementation agents" and "Working agreement".

If this file and those disagree, those win. Raise the disagreement; do not resolve it yourself.

## Roles

- **Claude Code normally implements. Codex normally reviews**, in a fresh context. Per the decision log, the latest Fable reviews foundational or architectural work, also in a fresh context.
- **The implementing agent never reviews its own work.** A reviewer that writes a fix becomes an author.
- One coherent change, one branch, one pull request.

## Sensitive surfaces — independent review always required

Auth · RLS · database migrations · privileged database/RPC code (`security definer`, grants) · offline sync · security-sensitive notification infrastructure · payments · invitations/sharing · moderation · production/release changes.

The implementer requests the review without waiting to be asked (PRD §24).

## Review procedure

1. Implementer completes the bounded change and its tests.
2. Implementer prepares the branch, the diff against `main`, and the context a reviewer needs (intent, touched surfaces, how it was tested).
3. A fresh Codex context reviews the branch against `main`.
4. Reviewer reports findings, each rated:
   - **BLOCKER**: wrong, unsafe, or leaks data. Must be fixed.
   - **MAJOR**: a real defect or risk that must be fixed before merge.
   - **MINOR**: worth fixing; does not block.
   - **NICE**: optional improvement.
5. **The reviewer does not modify files.** Report only.
6. Implementer addresses the findings.
7. Material fixes get a fresh re-review. The same cycle applies again.
8. The founder explicitly approves the merge.

BLOCKER and MAJOR findings block merge unless the founder explicitly accepts the risk. **No agent merges without founder approval.**

## Never, autonomously

No approval path exists for any of these (decision log, "Agent authority — hard limits"):

- deploy to production
- run a production migration
- modify or delete production data
- read, alter, or create production secrets
- change payment, store, or store-product configuration

## Environments

Ordinary development uses staging (`bingd-nonprod`), never production (`bingd-production`). See PRD §24.

## Paths

Keep all bingd working directories under `C:\Users\saisu\Documents\bingd`:

| Purpose | Path |
|---|---|
| Repo (canonical clone) | `C:\Users\saisu\Documents\bingd\app` |
| Git worktrees | `C:\Users\saisu\Documents\bingd\worktrees` |
| Builds / release clones | `C:\Users\saisu\Documents\bingd\builds` |
| Scratch | `C:\Users\saisu\Documents\bingd\scratch` |
| Non-Git assets | `C:\Users\saisu\Documents\bingd\workspace` |

Review packets and findings are local-only. `.agent-workflow/` is gitignored for that purpose. Don't commit them.
