# Two posts per shared window (20261130001000)

This corrects #354 (`20261130000900`, "an activity session is one post") on the founder's
final decisions of 2026-11-22. Those decisions replace the mixed-session spec.

> **Status (2026-11-22).** Applied on **staging** in one transaction, with its
> `schema_migrations` row. **Not applied to production.** The historical split has been run
> only in PGlite. The production numbers below come from a read-only dry run.

## The rule

- **One window per author.** It is fixed at `feed.ranking_group_minutes` (30). It is
  anchored at the first qualifying event of either kind: a first-time ranking (reviewed or
  not) or a watchlist save. Both kinds share it.
- **The window never restarts.** Switching between ranking and saving doesn't restart it.
  The next qualifying event at or after the anchor + 30:00 opens the next window.
- **At most two posts per window, one per kind:**
  - the **ranking post** is a `ranking_batch`, or a single `title_ranked` until a second
    ranking arrives, and it holds rankings only;
  - the **watchlist post** is a `watchlist_added`, a single save until a second one arrives,
    and it holds saves only.

```
3:00 rank A · 3:04 save B · 3:07 save C · 3:10 rank D · 3:14 save E · 3:18 rank F
  ->  "Suraj ranked Show F + 2 more"                    (F, D, A)
  ->  "Suraj added Movie E + 2 more to their watchlist"  (E, C, B)
```

- **Alternating updates the existing post** of the same kind, and that post keeps its id,
  reactions, comments, notification references and deep links. Growing a post notifies
  nobody: a post grows by UPDATE, and only inserts notify.
- **Each post moves on its own.** Each post moves forward on `causal_at` to its own kind's
  latest activity, never backwards. Within a post, titles run newest first. Reordering
  happens only on refresh, as in #354.
- **Each kind has its own post.** A title that was saved and then ranked in one window
  appears in each kind's post, because those are two different activities. No title ever
  appears twice in one post.
- **Reviews play no part in grouping.** A first ranking joins its ranking post whether or
  not it has a review. Nothing is split or regrouped because of a review.
  - No forward writer calls `_feed_title_reviewed`. It is kept only for the operator path:
    the founder flag of the retired 0900 consolidation plan.
  - The reviews themselves are untouched: text, visibility, spoilers, the title page and
    profiles. A ranking group's sheet still shows each review under its row.
- **Unchanged from #354 and earlier:**
  - rewatches, TV updates, corrections and reranks keep their own posts;
  - a referenced event is never hidden;
  - a hidden event that gains a reference gets its card back;
  - privacy and blocks work as before;
  - the kill switch `feed.activity_sessions_enabled`: when false, each kind opens its own
    windows, which is the `20261130000800` rule.

### How the shared window is kept

Every row that opens or holds a window records the window's anchor as `payload.started_at`:
a ranking group, a watchlist post, and (new) a first ranking still on its own. The new
helpers are:

- `_window_posts(actor, since, family)` returns the actor's visible rows that hold a window,
  with the anchor and kind of each.
- `_window_anchor(actor, at, family)` returns the anchor of the window that holds `at`.
- `_claim_window_start(actor, at, family)` is how every writer finds its window, because any
  of them can reach the server after a later event has already opened one:
  - A ranking note is sent without waiting. A sitting is published at its end.
  - A save's time is `now()`, its transaction's start. A save that began before another
    device's writer but took the actor's keys after it has a time earlier than the window
    that writer committed. Reading the window instead of claiming it, as the save path first
    did, missed that window and started a second post (WG1 failed intermittently on main;
    WG5 and RS5 force the interleaving; mutant 21 restores the read).
  - When no window holds `at`, but one opened within 30 minutes after it, this event is
    that window's first. The anchor moves back to `at` on every row that carries it.
  - The anchor moves back only if every member still lies within 30 minutes of the new
    anchor, so no window ever spans more than 30 minutes.

Behaviour change in one existing case: two Unranked sittings that end out of start order
are now **one** ranking post, anchored at the sitting that began first. Before, they were
two posts. This is the founder's rule (the window starts at the first event). The 30-minute
bound above still holds. The PR 311 test now asserts the new behaviour.

All writers take the actor's two keys in one order, `ranking_story` then `watchlist_story`,
before reading anything. The keys now guard the shared anchor, so whichever writer decides
second sees the first writer's window (races RS1, RS4 and RS5, WG5, and mutants 20 and 21).

### Writers

| Function | Change |
|---|---|
| `_open_session` | Returns a post of the event's own kind only. Same signature. |
| `rank_group_note` | Joins the window's ranking group, or pairs with a lone first ranking of the same window, or records the window's anchor on itself. Never joins a watchlist post. No review test. Same answers. |
| `_post_watchlist_activity` (`set_watchlist`) | Claims its window (`_claim_window_start`), then joins that window's watchlist post, or starts one anchored on the window. Never pairs with a ranking. |
| `rank_batch_finalize` | Joins the window's ranking group. If there is none, it publishes on the window's anchor and presents the window's lone first rankings. It no longer presents watchlist posts. |
| `rank_batch_note`, `_session_refresh`, `_unpresent`, the readers, the catalogue trigger | Unchanged. A post of one kind reads as one kind. A legacy mixed post reads as before until it is split. |
| `consolidate_feed_sessions` | Retired: it refuses to apply unless `feed.session_consolidation_enabled` is true (seeded false). Its dry run still answers. |
| `revert_feed_session_consolidation` | Refuses a batch while a split still holds any of its posts. |

Every signature is unchanged, and no client call changes.

## Presentation (new JS)

- **Headlines.** A post names its newest title with a count: "ranked Show F + 2 more",
  "added Movie E + 2 more to their watchlist".
  - The mixed sub-line ("9 ranked · 7 saved") is gone.
  - A post is never named by a bare count such as "ranked 16 titles".
  - A pre-session group keeps "ranked Sheroes and 2 more" / "added Dune and 3 others to
    their watchlist", with the count as its link.
- **The reader's bookmark** sits on every title poster in the Feed: each tile of a ranking
  rail, each tile of a watchlist rail, and a single title's artwork, including the ranking
  hero with its score badge. That covers movies, whole shows and seasons. It doesn't appear
  on follow stories, awards or goals.
  - **The control.** It is the For You tile's control, extracted as `PosterSaveButton`:
    - a 44pt target with a compact 28pt Maroon square glyph;
    - selection haptic and a pulse on add;
    - `accessibilityState.selected`;
    - labels "Add <title> to your watchlist" / "Remove <title> from your watchlist".
  - **Position.** Top-right. The author's score keeps bottom-right.
  - **State.** It shows the **reader's** watchlist (`useWatchlist`), never the author's. The
    #354 marker for the author's save is removed, so nothing can be mistaken for the
    control.
  - **Writes.** It uses the Feed's existing `toggleWatchlist`:
    - `set_watchlist`;
    - one write at a time, so a tap while a write is in flight does nothing;
    - `mustReconcile`, which refetches the watchlist when an outcome is unknown, so the
      bookmark ends up showing what the server holds;
    - an alert on a refused write.
  - **Consistency.** The Feed, the title page and the Collection read the same watchlist
    query.
  - **Tapping.** A tap toggles the bookmark and opens nothing, including inside a horizontal
    rail. A tap anywhere else on the poster opens the title.
  - **On your own posts.** It is shown there too: any title can be watchlisted.
  - **Duplicates.** The Save button that used to sit under a single title's artwork is gone,
    because the bookmark replaces it. Like, Comment and Share stay.
- **The "Review" corner label** on rail posters (#347) is gone, along with its
  `public_notes` read (`useGroupReviews`). The group sheet still shows reviews.

## Compatibility: what older bundles show

The production OTA `8e66e9ca` (#354's JS), the OTA `55db8b2b` before it (#347's JS) and the
pending 1.2.0 binary all render the separated posts sensibly:

| Bundle | Ranking post | Watchlist post |
|---|---|---|
| `8e66e9ca` | "ranked F + 2 more", scores on posters, no split line (it draws one only when both counts are above zero) | "added E + 2 more to their watchlist"; its own author-save marker on each poster |
| `55db8b2b` | "ranked 3 titles", scores on posters | "added 3 titles to their watchlist" |

Both bundles keep the Save button under the artwork and show no bookmark on posters until
they receive the new OTA. `supabase/tests/activity-sessions.test.mjs` ("what the bundles in
the field read") holds every field they read to one kind per post. Signatures are
unchanged and no native dependency is added, so the fingerprint is unchanged.

## The historical correction: `split_mixed_sessions`

### What exists in production (read-only inspection, 2026-11-22)

There are 7 visible mixed posts. All 7 come from the two consolidation batches. None was
formed live after the apply, none has engagement (comments, reactions, notifications,
proactive items or causes), none holds a title that was both saved and ranked, and none has
nested or mixed hidden members.

| Shape | Posts |
|---|---|
| A watchlist post that a batch reused, with hidden rankings | 6 |
| … of which also hide an original ranking group | 1 |
| … of which also hide single saves | 1 |
| An original ranking group that a batch reused, with a hidden watchlist post | 1 |

### The procedure (operator-only, inert)

For each visible post that holds both kinds, in its own membership or in the posts it
presents:

1. **It keeps its id, its conversation, and its original kind.** The original kind is the
   kind it had before a session batch reused it. It is `ranking` if a batch or a session
   writer created the post. A live post keeps `watchlist` only if it began as a watchlist
   post.
2. **The other kind moves to a partner post.** The procedure prefers an original hidden post
   of that kind (the largest, then the earliest) and unhides it. When the other kind is a
   single ranking, the partner is that ranking's own card. Otherwise it makes a new post,
   dated by its first member and placed at its last. The other kind's hidden posts and
   membership rows (saves, sitting placements and sitting joins) move to the partner.
3. **Both posts are refreshed.** Each holds one kind, newest first. Each carries the window's
   anchor and sits at its own kind's last activity. This one-off operator step may move the
   kept post backwards.
4. **Old links stay one hop.** Every hidden member resolves in one hop to its own kind's post
   (`feed_event_presentation`).
5. **Nothing is lost.** No row is deleted, no hidden member is lost, nobody is notified, and
   privacy is the author's own.

**Exceptions.** A post is left exactly as it is, and listed, in any of these cases:

- `nested_member`: a hidden member presents posts of its own;
- `mixed_member`: a hidden member is itself mixed;
- `unknown_member`: a hidden member is of an unexpected type;
- `title_conflict`: a ranking would land twice in a reused group;
- `no_watchlist_title`: no title can carry the watchlist post (`feed_events_watchlist_once`);
- `window_open`: the window is still open.

**Engagement.** A post's conversation stays on that post. It is never moved.

**Bounds.**

- at most 31 days per call;
- the range must end at least one window ago;
- at most 25 posts per call;
- `p_actor` limits a batch to one author, for the founder-first batch;
- a batch name is used once.

**Logging.** Every changed row is logged in `feed_consolidation_log` with
`kind = 'split'`. The `split_role` column says what each row is:

- `post`: the mixed post;
- `partner`: the post the other kind moved to;
- `member`: a hidden post that moved;
- `row`: a membership row that moved, with `member_table` and `member_row_id` (or
  `member_row_key`) and `prior_event_id`.

Each row also records its prior state.

### Revert, in both orders

- **Undoing a split.** `revert_session_split(batch)` restores every row exactly. A partner
  the split created is deleted, unless it has since gained a conversation. In that case the
  pair stays split, its log is kept, and the pair is reported.
- **A split, then the consolidation.** `revert_feed_session_consolidation` refuses a batch
  while a split holds any of its posts: "revert that split first". Once the split is
  reverted, the consolidation batch reverts exactly (tested).
- **The consolidation, then a split.** If the consolidation batch is reverted first, nothing
  is left mixed except live posts, which the split handles alone (tested).

### Production dry run (read-only, 2026-10-23 to 2026-11-22, aggregates only)

| | All | `sessions-20261122-f01` (founder) | `sessions-20261122-w01` |
|---|---|---|---|
| Mixed posts | 7 | 5 | 2 |
| To split | 7 | 5 | 2 |
| Kept as watchlist / ranking | 6 / 1 | 4 / 1 | 2 / 0 |
| Partners reused | 4 (2 single rankings, 1 ranking group, 1 watchlist post) | 4 | 0 |
| Partners created | 3 (ranking groups) | 1 | 2 |
| Titles | 23 ranked, 12 saved | | |
| With engagement | 0 | | |
| Exceptions | 0 | | |

After the split, the batches' 11 session posts are 18 visible posts: the 4 that were never
mixed, the 7 kept posts, and 7 partners (4 of them originals unhidden, 3 new).

### Running it (operator, production)

Run these steps after the migration is applied and recorded, and after the new OTA is
published.

```sql
-- 1. Dry run (no writes); compare with docs/feed/session-split-candidates.sql.
select split_mixed_sessions('split-20261122-f01', :since, :until, false, :'founder_uuid');
-- 2. The founder first.
select split_mixed_sessions('split-20261122-f01', :since, :until, true, :'founder_uuid');
--    Check the Feed as a follower; if anything is wrong:
select revert_session_split('split-20261122-f01');
-- 3. Everyone else (repeat with a new name until applied_posts is 0).
select split_mixed_sessions('split-20261122-w01', :since, :until, true);
```

## Rollback

`docs/release/session-split/rollback-20261130001000.sql` is rehearsed by
`supabase/tests/session-split-rollback.test.mjs`. It:

- restores, word for word, the 0900 bodies of `_open_session`, `rank_group_note`,
  `_post_watchlist_activity`, `rank_batch_finalize`, `consolidate_feed_sessions` and
  `revert_feed_session_consolidation`, with their comments and grants;
- drops the window helpers and the split;
- removes the setting and the log columns.

Posts formed in the meantime stay as they are. The rollback refuses while a split batch is
logged. The operator deletes the `schema_migrations` row. To roll back `20261130000900`
too, roll back this migration first.

## Tests

| Suite | Covers |
|---|---|
| `supabase/tests/activity-sessions.test.mjs` | the founder's example (exactly two posts); rank, save, rank, save; rankings only; saves only; neither kind joining the other; reviewed and unreviewed rankings behaving identically; the same title saved and ranked; 29:59, 30:00, and the window shared across kinds and never restarted; the kill switch; a late note; rewatches; references; engagement and silence; one-hop links; privacy and blocks; catalogue deletes; sittings; pagination; the field bundles' fields |
| `supabase/tests/session-split.test.mjs` | the dry run held to the function; the founder-first batch; the original kind kept; hidden originals reused; engagement preserved; one-hop links; exact revert in both orders; exceptions |
| `supabase/tests/session-split-rollback.test.mjs` | the rollback rehearsal |
| `supabase/tests/session-consolidation.test.mjs` | the retired consolidation refusing without its flag |
| `supabase/tests/concurrency/races/activity-sessions.mjs`, `watchlist-grouping.mjs`, mutants 20 and 21 | races RS1–RS5 and WG1–WG5 on the shared anchor, including a writer whose transaction began first but took the keys second |
| `src/features/feed/ActivitySessions.test.tsx` | two cards and their headlines; the bookmark on every ranking tile, watchlist tile and hero, showing the reader's state only; no navigation from a tap in a carousel; rapid taps; an unknown write outcome; refresh-only reordering; legacy mixed posts |
| `PosterRails`, `CinematicFeed`, `FeedEngagement`, `ReviewedRankingGroup` tests | updated for the new headlines, the hero bookmark, no Save under the artwork, and no Review label |
