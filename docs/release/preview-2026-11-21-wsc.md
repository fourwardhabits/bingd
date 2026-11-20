# Preview 2026-11-21: #322 Workstream C, reactions and comments on follow stories

**Integration commit:** `5e5f55df` (`integration/preview-1121`). It is `main` `68095e99` (#319, #321, #324, #328) plus #322 at `b2dba1a8`, and its tree is identical to #322's head. #322 stays a draft and is not merged. No production action was taken.

## Migration renumbered

#322's migration was `20261130000100`, which sorts before #328's `20261130000200`. That one is already on staging and goes to production first, so `b2dba1a8` renames #322's migration to **`20261201000100_a_conversation_about_who_you_follow.sql`**. The rollback is now `docs/release/wsc/rollback-20261201000100.sql`, and it deletes the new version. Every test, comment and doc reference was updated. No SQL body changed.

**Merge.** `4d5709e0` merges `origin/main` `68095e99`. The only conflict was `supabase/tests/concurrency/races.test.mjs`, and both race modules are kept.

**Overlap check.** No function or policy is rebuilt both by this migration and by main's `20261129000100`–`000300` or `20261130000200`. None of those migrations call a function this one rebuilds. The migration's prior bodies, and so its rollback, are still the latest live definitions.

## Evidence

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors (on `b2dba1a8` and on `5e5f55df`) |
| `eslint app src supabase emails scripts config` | 0 errors (79 warnings, as on `main`) |
| Jest (`src`, `app`) | 7,143 passed, 2 skipped (on `b2dba1a8` and on `5e5f55df`) |
| Database (PGlite), full | 3,398 / 3,398 |
| Races (real PostgreSQL, as `nobody`) | First run 224 / 225: C5 (recommendation, double finalise) failed on a timing-only `unhandledRejection`. It is unrelated to #322 and passed on earlier rounds. Two full re-runs: **225 / 225** and **225 / 225**. |
| Mutation check | 25 / 25 detected, 4 / 4 controls held |
| `test:config` | 200 / 200 |
| CI on `b2dba1a8` | green (typecheck/lint/test/database, concurrency suite, Pages) |
| Codex on `b2dba1a8` | "Didn't find any major issues" |

## Staging (`fjxhcbowoxuzulwirzyr`)

- **Applied `20261201000100` only.** Dry run first, from the clean `b2dba1a8` checkout. The pending set was exactly `['20261201000100']`, and there were no unknown versions. The head is now `20261201000100` (208 versions).
- **Before the apply:** 16 follow stories, none engaged, so the `follow_story_engaged` backfill wrote 0 rows.
- **Follow-story smoke** (new, `follow-story-staging-smoke.mjs`): **33 / 33**. It uses five disposable accounts, deleted afterwards, with 0 profiles and 0 posts left. Its checks:
  - Grants: `_follow_story_open_to` and `claim_push_batch` are server-only, and `follow_story_open_to_me` is for authenticated only. `follow_story_engaged` has RLS and no client grant. Push jobs carry `feed_event_type`.
  - A follower reacts, changes the reaction and comments. The author is notified once per kind, and the inbox rows carry `subject_activity_type = follow_added`, which drives the "your follow activity" wording.
  - Q2: the only member cannot react or comment (`P0002`). A mention of them posts without a refusal. The member gets no reaction, comment or mention notification.
  - Q1: a follow after engagement opens a new story, and the engaged one does not grow. A reaction that is removed again does not thaw the story.
  - Q3: after the author unfollows the only member, the follower, the author and the member all see 0 reactions, 0 comments, 0 thread, 0 count and 0 names. Writes are refused, the author's inbox withholds the rows, and nothing is deleted. A re-follow restores everything.
  - Ordinary post: the reaction, comment, notifications and every read path work as before, and the predicate is open. Heart Magnet counts the post's reaction and not the story's.
- **`remote-smoke`:** 137 / 137.
- **`two-user-acceptance`:** 114 / 114.

**Rollback (staging):** `docs/release/wsc/rollback-20261201000100.sql` on #322's branch.

## Published

From a clean detached checkout of `5e5f55df`, after a real `npm ci`. The fingerprints equal the installed runtimes: Android `2503ffaa54ee67d81ce4ddcf8028715dbd4a0543`, iOS `ef07f4b898dc935a022f24c388a75358aa4fcc23`. The Preview environment's backend is `fjxhcbowoxuzulwirzyr`.

| Platform | Update | Group | Runtime |
|---|---|---|---|
| Android | `01a1f6ea-7758-7d92-8289-577aa7b5a8f5` | `15c2a381-6859-4fb1-9442-baa97ce3645e` | `2503ffaa…` |
| iOS | `01a1f6ea-7758-7d86-bef5-3da925a67628` | `a8ceecc7-2ce2-4c4a-abc6-b73f9a333725` | `ef07f4b8…` |

The live manifest serves both at `5e5f55df`. iOS: `config/live-runtimes.json` still records no iOS Preview binary, as before.

**Rollback (Preview):** republish `219e2953`:
- Android group `c3b6dcce-ce0b-4f28-8ff4-25efa735d123` (update `01a1f616-71fc-76c9-b2ff-7b26d5b77e60`);
- iOS group `420d6710-ae3b-4ebb-a81a-12d9c8de630c` (update `01a1f616-71fc-7d5f-8cfe-fec6f169c90f`).

The `219e2953` client keeps working against staging with `20261201000100` applied, because no signature changed. The SQL rollback is independent of it.

## Founder device QA (Android first, then iOS)

Use three accounts: an author A, a follower F who follows A, and a person B whom A follows.

1. **React and comment.** On F's Feed, A's follow story shows labelled **Like · Comment**, matching an award post.
   - A tap reacts, and a long press opens the picker.
   - The "… like this" line opens who reacted.
   - Neither control opens the people list. On a grouped story, tapping the sentence still does.
2. **Comment sheet.** Comment opens the shared sheet with **no "Contains spoilers"** toggle. A ranking post still has it.
3. **Notifications.** A gets "reacted to your follow activity" and "commented on your follow activity", in the inbox and as a push. A tap opens the activity page, with the follow row above the thread. B gets nothing.
4. **Q1.** After the first reaction, A follows someone new. That follow is a **new** story, and the engaged story keeps its names. This still holds if the reaction is removed.
5. **Q3.** A unfollows B, where B is the story's only member. The story's conversation disappears for F and for A. A re-follows B, and it comes back.
6. **Layout.** At the largest text size on a narrow phone, the sentence wraps, and the 44pt columns line up with the posts around them.
7. **Regression.** Ordinary posts behave exactly as before: reactions, comments, notifications and spoilers.
