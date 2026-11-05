# Cinematic Social Feed — release record

Branch `feature/feed-cinematic`, based on `505ae33` (final polish, live on Android Preview
group `4212ffa9`). Local only: not pushed, not merged, not published.

**Status:** implemented and verified locally (2026-11-04). Awaiting the founder's approval and
inclusion in the combined Android Preview candidate (below).

## What changed

Feed tab only. Profile, the conversation page (`/activity/[id]`), Collection, Search, For You
and the title page are untouched and keep `ActivityRow`.

| File | Change |
| --- | --- |
| `src/features/feed/FeedCard.tsx` | New. The cinematic card for title activity. |
| `src/features/feed/feed-artwork.ts` | New. Artwork choice (own backdrop → series backdrop → poster → initials), the 150–190pt height rule, and which activity types get a card. |
| `src/features/feed/use-latest-comments.ts` | New. Newest readable comment per card, from the existing `activity_comments` RPC. |
| `src/features/feed/use-feed.ts` | Selects `backdrop_path` (title and parent) and the parent `poster_path`. Read-only columns on `media_items`, whose policy is `using (true)`. |
| `app/(tabs)/feed.tsx` | Title activity renders `FeedCard`; awards, goals and follow stories keep their rows. Pull-to-refresh also refreshes comment previews. |
| `src/features/profile/use-social.ts` | Follow, unfollow, block and unblock now also invalidate `['comments', viewer]` and `['comment-counts', viewer]`, so a blocked commenter's preview and count disappear at once. |
| `src/features/feed/CinematicFeed.test.tsx`, `feed-artwork.test.ts` | New tests (27). |

No migration, no new RPC, no schema, policy, notification or reaction-backend change.

### The card

1. Avatar, name, verb, title, year (the existing sentence grammar), then
   `time · 2nd watch · rating · length · genres`.
2. Artwork, 16:9 of the card width clamped to 150–190pt (190 at 390pt, 185 at 360pt,
   162 at 320pt). TV seasons use the series backdrop. With no backdrop, the poster sits at its
   true 2:3 shape over a blurred copy of itself. With no artwork at all, a compact 120pt frame
   with the initials poster.
3. Personal score: the Maroon `ScoreBadge` (48pt, scales with text size) in a 2pt Paper ring,
   bottom-right, inset 12pt.
4. The published review (`public_notes`), three lines with the existing "… more" expansion and
   spoiler mask. No review means no review area.
5. Reaction summary (glyphs + count, opens who reacted), then one action row: Like, Comment,
   Save, Share — each a 44pt-tall, equal-width target. Tap the heart to like; press and hold for
   the six reactions (the existing picker and `set_reaction` write). Share opens the existing
   Recommend sheet, which ends in "Share off bingd". Save is the existing watchlist write and is
   not offered on the reader's own activity.
6. Latest-comment preview, under the actions, only when comments exist: the commenter's avatar
   and name, two lines of text, time, and "View all N comments". Tapping opens the existing
   comment sheet.

### Privacy and spoilers

- The preview uses `activity_comments`, so blocked and hidden authors are excluded on the
  server exactly as in the sheet. Tombstones (retracted comments) are skipped.
- Comment spoilers are masked by `shouldMask` with the same arguments the sheet uses; a masked
  preview shows "Contains spoilers · tap to view" and never the body.
- A comment is always shown under the commenter's name, below the actions, never as the
  actor's review.
- Preview queries live under `['comments', viewer, …]`, so every existing comment write
  invalidates them; `staleTime: 0` like the thread.

## Backend concerns (not built; need approval)

### Grouped watchlist activity — blocked on backend

`set_watchlist` writes one durable `watchlist_added` event per title, and reactions and
comments attach to an event id. Grouping existing events on the client would either hide their
reactions and comments or attach a group's reaction to one arbitrary title, which the brief rules
out. So grouping is **not implemented**. Today a burst of twelve adds is twelve full cards.

Smallest viable approach, reusing the `ranking_batch` / `follow_added` model:

1. Migration: membership table `feed_watchlist_titles (event_id, media_item_id, added_at)`, RLS
   on with no policy (like `feed_ranking_titles`), and a definer read
   `watchlist_batch_titles(p_event_ids)` that applies the same visibility as `feed_events_read`.
2. `set_watchlist` appends to the actor's newest `watchlist_added` event when it is inside a
   short window (e.g. 30 minutes) **and has no reactions or comments yet**; otherwise it opens a
   new event. Existing events stay single, so nothing loses its reactions or comments, and a
   reaction can never be re-attached to a larger group after the fact.
3. Client: the card shows a horizontal strip of the first 10 posters, each opening its own title,
   a "+N / See all" tile opening a sheet (the `RankingBatchSheet` pattern), the true total in the
   sentence, and one reaction row and conversation for the post.
4. Open decision: whether an appended title moves the post to the top of the feed (Strava-like)
   or keeps its original position (safer for keyset pagination).

A render-only concept of step 3 is in the QA renders (`c13*`). It is not in the branch.

### Comment-preview read cost

One `activity_comments` call per card that has comments (zero for quiet cards; at most 20 per
page). Acceptable for launch volumes. If threads grow long, a batched definer function
`activity_latest_comments(p_feed_event_ids)` mirroring `activity_comments`' joins would make it one
read per page. Not built: it is a new database function.

## Verification

- `tsc --noEmit`: clean. ESLint: 0 errors (warnings unchanged from `505ae33`, none in new files).
- Jest: see the commit message for the full-suite count.
- Real app renders (react-native-web against a local mock, 390/360/320pt, text 1.0 and 1.3):
  ranking with review and comments, ranking without either, single watchlist add, poster
  fallback, no artwork, TV season, a 12-add burst as it renders today, long-press picker, preview
  opening the thread, and the grouped-watchlist concept.
- Independent Codex regression review of `68b1b6b` (`.agent-workflow/codex-reviews/feed-cinematic.md`,
  gitignored): **needs-attention**, four findings, all fixed in the follow-up commit with
  regression tests that fail without the fixes:
  1. a blocked commenter's preview stayed until the next pull (social writes now invalidate
     comments and counts);
  2. a preview could start from a cached body that had since been withdrawn (now `gcTime: 0`
     and only results read during this mount and not since failed are shown);
  3. a reply whose root author is hidden could be previewed although the sheet drops it (the
     preview now applies the sheet's thread rule);
  4. "and N more" on a long grouped-ranking sentence could be truncated away at 320pt (the
     sentence is no longer clamped when it ends in that control).

- Codex re-check of the fixes (`feed-cinematic-recheck.md`): the four fixes hold; one gap —
  an already-visible preview kept its text while the post-block refetch ran (up to ~33s with
  retries). Fixed in the next commit: social writes now **reset** the preview entries, so no
  preview is drawn until a read made after the change succeeds. Test fails without the fix.

### Residuals (unchanged from `505ae33`, not introduced here)

- Reaction summaries are not invalidated by block/unfollow either; a blocked person's reaction
  can stay in a card's count until the next pull, as it already could on `ActivityRow`.

## Rollback

- Code: revert the Feed commit; it touches only the files above.
- Preview: republish group `4212ffa9` (505ae33) or whichever group was live before the combined
  candidate (recorded in the combined plan).

## Combined Android Preview candidate

Assembled by the session that owns the title-page experiment (app-09) on its own integration
branch, from these commits, all based on `505ae33`:

| | Component | Commit | Branch |
| --- | --- | --- | --- |
| A | Final UI polish | `505ae33` | `polish/final-spec` |
| B | Ranking-start Option A | `0144268` | `feature/rank-start-option-a` |
| C | Cinematic Social Feed | see commit log | `feature/feed-cinematic` |
| D | Immersive title page (opt-in experiment, Original stays default) | `02f713d` | `experiment/immersive-title` |

No file overlaps between C and B or D. Nothing is published, merged, pushed or built for iOS
until the founder approves the combined OTA. The fingerprint must be computed in the real-install
publish worktree, not a junctioned one.

### One-session device QA checklist

Feed

- [ ] Feed opens on Activity; Leaderboard and People icons still switch modes; Back and
      re-tapping the tab return to Feed.
- [ ] A ranking card shows the backdrop, the Maroon score with its light ring, readable on dark
      and pale artwork.
- [ ] A TV-season card shows the series' artwork and `Show, S1`.
- [ ] A title without a backdrop shows its poster upright over a blurred field, not stretched.
- [ ] A shared review shows under the artwork; "… more" expands it; a spoiler review is masked
      for a title you haven't seen.
- [ ] A ranking with no review has no empty text area.
- [ ] Tap the heart: it fills and the count goes up; tap again removes it. Press and hold: the
      six reactions appear; choosing one replaces the heart with that glyph and its label.
- [ ] Tap the reaction summary: the who-reacted sheet opens.
- [ ] Comment opens the sheet; post a comment; the preview under the card updates to it.
- [ ] The preview names the commenter (not the poster), truncates at two lines, shows
      "View all N comments" when there are several, and opens the conversation.
- [ ] A spoiler comment on a title you haven't seen shows "Contains spoilers" in the preview.
- [ ] Delete your comment: the preview falls back to the previous comment or disappears.
- [ ] Save adds the title to your watchlist (bookmark fills); not offered on your own posts.
- [ ] Share opens Recommend; "Share off bingd" still reaches the system sheet.
- [ ] Watchlist adds appear as cards with Save and Share; a burst appears as separate cards
      (grouping is pending backend approval).
- [ ] Pull to refresh; scroll to the end ("You're all caught up"); nothing duplicated or missing.
- [ ] Awards, goals and follow stories still render in their compact rows.
- [ ] Settings → Display size at its largest: cards, score and actions still fit.

Ranking start (Option A)

- [ ] Log sheet: Note, Watch date, Who I watched with, then the bucket choices at the foot.
- [ ] Writing a note before choosing a bucket keeps it; first-ever note opens with Share as a
      review on, and turning it off keeps the note private (it must not appear in the Feed).
- [ ] Choosing a bucket waits for any pending date or companion save; double tap does nothing
      extra.

Title page

- [ ] Original title page is the default.
- [ ] Settings → Labs → Title page → Immersive; open the same film, a TV season and a title
      without a backdrop, and compare with Original (first screen, score strip, actions, sections).
- [ ] Ranking from the immersive page opens the same log sheet (Option A order).
- [ ] Switch back to Original; the original page returns. (The Labs row is hidden in
      production, which always renders Original.)

Navigation and polish (505ae33)

- [ ] For You and Collection share one row; Movies | TV toggle works; Lists hides the toggle.
- [ ] Header spacing identical on all five tabs; Leaderboard chips scroll; rank-1 trophy shows.

### Combined-candidate review (2026-11-04)

Codex on the combined head `9942738` found one more Feed issue [high]: a preview loaded before
its comment was withdrawn (or its author went private) stayed under the card even after opening
the conversation showed it gone. Fixed in the next commit: every fresh read of a thread now sets
that card's preview from the same answer, including to nothing. Regression test fails without
the fix.

Codex re-check of that fix found a race [high]: a thread request made before a block could
answer after the block's preview reset and restore the blocked author's words. Fixed in the
following commit: every privacy reset bumps a per-reader visibility generation, and a thread
read may only update the preview if no reset happened while it was in flight and no newer
preview answer has landed since it began. Regression test (`preview-race.test.tsx`) releases a
pre-block response after the reset; it fails on the previous code.

A second re-check found two more orderings [high] and a test that passed for the wrong reason.
All comment reads now share one per-reader **read revision**, taken when a read starts: a
card applies an answer only if it is newer than the last one applied to it, in either completion
order, and a visibility reset raises a floor so everything in flight is too old to apply. A
conversation read that straddles a reset reads again before returning rows, so a conversation
reopened around a block cannot show its pre-block answer. That last race already existed at
`505ae33`, where nothing reset comment queries on a block. `preview-race.test.tsx` drives the
real card and conversation queries with responses released in each order and a hand-stepped
clock; all four cases fail on the previous fix and pass on this one.

**Final design (after the combined review's third round).** Each round of reconciling two
caches found another ordering, so the card's preview stopped being a read of its own. The
card now observes **the conversation's own query** (one entry per thread, `readThread` its only
writer) and derives its line with `select`. Ordering, cancellation and sign-out are the query
library's own guarantees: a refetch cancels the read it supersedes, a cancelled or reset read is
never committed, and sign-out clears the client. A visibility change resets every thread. The
conversation draws only an answer read since it was opened (object identity, structural sharing
off for threads), so it never opens onto words the card read earlier. `preview-race.test.tsx`
replays every ordering the reviews found — including two answers in one turn — on the real
hooks; giving the card its own cache again fails five of six cases.

## Decision: no latest-comment preview in this Preview (founder, 2026-11-04)

After the fifth independent review still found orderings in which a card preview could show a
withdrawn or blocked comment, the founder chose to ship this Preview **without** the
latest-comment line on Feed cards. Everything else on the card stays: artwork, score, review,
reaction summary, Like / Comment (with its count) / Save / Share.

- `use-comments.ts`, `CommentThread.tsx` and `CommentSheet.tsx` are byte-identical to `505ae33`,
  so comments behave exactly as on today's Preview.
- `use-latest-comments.ts` and its race tests are removed. The one remaining comment-related
  change versus `505ae33` is in `use-social.ts`: follow, unfollow, block and unblock also
  invalidate `['comments', viewer]` and `['comment-counts', viewer]`, which only makes counts and
  an open conversation refresh sooner.
- Known baseline (unchanged from `505ae33`, not introduced here): a conversation request still in
  flight when the reader blocks someone can answer with pre-block rows until the next read.
- The QA checklist's preview items no longer apply; see the combined record.
- The preview returns later on a design reviewed on its own (research note to follow).
