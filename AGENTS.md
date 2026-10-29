# Agent instructions

Read this before any work in this repo. It points at the canonical policy rather than restating it:

- `docs/product/decision-log.md` — outranks everything below it (see README "Precedence").
- `docs/product/PRD.md` §24 — environments, sensitive surfaces, review and merge rules.
- `README.md` — "For implementation agents" and "Working agreement".

If this file and those disagree, those win, **except** where this file is stricter. The extra sensitive surfaces and hard limits below are intentional, stronger local safeguards. Precedence never weakens them. Raise any disagreement; do not resolve it yourself.

## Roles and reviewer selection

- **Claude Code normally implements.**
- **Reviewer selection:**
  - Contained changes get a fresh **Codex** review.
  - Foundational or architectural changes go to the reviewer the decision log names ("Reviewer selection", currently the latest **Fable**), in a fresh context.
- **The reviewer must not have authored any part of the branch.** The implementing agent never reviews its own work, and a reviewer that writes a fix becomes an author.
- One coherent change, one branch, one pull request.

## Sensitive surfaces — independent review always required

Auth · RLS · database migrations · privileged database/RPC code (`security definer`, grants) · offline sync · security-sensitive notification infrastructure · payments · invitations/sharing · moderation · production/release changes.

This list is wider than PRD §24 on purpose (see the precedence note above). The implementer requests the review without waiting to be asked (PRD §24).

## Review procedure

1. Implementer completes the bounded change and its tests.
2. Implementer prepares the branch, the diff against `main`, and the context a reviewer needs (intent, touched surfaces, how it was tested).
3. A fresh reviewer, chosen by the reviewer-selection rule above, reviews the branch against `main`.
4. Reviewer reports findings, each rated:
   - **BLOCKER**: wrong, unsafe, or leaks data. Must be fixed.
   - **MAJOR**: a real defect or risk that must be fixed before merge.
   - **MINOR**: worth fixing; does not block.
   - **NICE**: optional improvement.
5. **The reviewer does not modify files.** Report only.
6. Implementer addresses the findings.
7. A fix gets a fresh re-review if it addresses a BLOCKER or MAJOR finding, or if it touches a sensitive surface. **When uncertain, re-review.**
8. The founder explicitly approves the merge (see "Merging to `main`" below).

BLOCKER and MAJOR findings block merge unless the founder explicitly accepts the risk. **No agent merges without founder approval.**

## Merging to `main`

**Default:** no agent merges a pull request or pushes directly to `main` without the founder's explicit approval, and no agent deploys production without it.

**Founder-approved PR merge.** If the founder explicitly approves merging a specific pull request, an agent may merge that pull request into `main`.

- **The approval must identify the PR,** or refer unmistakably to the PR under discussion.
  - Valid: "Approved to merge PR #215 once CI is green."
  - Not valid on its own: "Looks good." or "Ship when ready." Treat a statement like these as approval only if the context makes both the PR and the merge unmistakable.
- **The approval is single-use.** It covers that one merge and authorizes no other PR.
- **Before merging, confirm all of these.** If any fails, stop, and ask for renewed approval once it is resolved.
  - The PR being merged is the exact PR approved.
  - Required CI and checks are green.
  - There are no merge conflicts.
  - The head SHA is the one reviewed and has not unexpectedly changed.
  - The PR's scope has not materially changed since review or approval.
- **Merge method:** use the repository's default merge strategy unless the founder names another.
  - Never force-push `main`.
  - Never bypass required checks or branch protection.

**The deployment a merge causes.** If merging the approved PR triggers the normal automatic production deployment, the founder's approval of that merge also authorizes that deployment. It does not authorize:

- manually triggering any other production deployment
- deploying additional commits
- modifying production infrastructure or configuration
- changing secrets
- bypassing deployment protections
- a rollback or any other production mutation

Each of these stays under "Founder-only" below, or needs separate approval.

**After merging:**

- Report the merge commit and the resulting `main` SHA.
- Observe the normal production deployment.
- Run any read-only smoke checks already authorized.
- If production fails, report it. Do not patch it or roll it back unless separately authorized.

**Precedence.** This section records a founder decision of 2026-10-28. The decision log, PRD §24 and the README still say agents may not deploy, with no approval path. Because they outrank this file, the deployment exception above takes effect only once they record it too. Until then, an agent may merge a founder-approved PR only where the merge triggers no production deployment.

## Founder-only — no agent approval path

No agent may do any of these, whether autonomously or because another agent approved it. Only the founder can (decision log, "Agent authority — hard limits", widened here as a local safeguard):

- deploy to production, except the automatic deployment caused by a founder-approved merge (see "Merging to `main`")
- run a production migration
- create, modify or delete production data
- access, alter or create production secrets, or change production configuration
- change payment, store, or store-product configuration

**Read-only production inspection** is allowed only when the founder explicitly authorizes it for the task. It must use the credentials and tools the founder approves, and it must not mutate anything.

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
