# Handoff: #319 final QA refinements and TV direct ranking (2026-11-20)

**Preview:** `219e2953` on the `preview` channel.
- Android update `01a1f616-71fc-76c9-b2ff-7b26d5b77e60`
- iOS update `01a1f616-71fc-7d5f-8cfe-fec6f169c90f`

**Staging migration head:** `20261129000300`.

**Not done:** #319 is not merged, and nothing has been deployed to production.

## Decisions taken

1. **Insertion point on the TV wall.**
   - A drop is read against the explicit shows on either side of where it lands.
   - Average posters in between are passed over.
   - The category is the displaced poster's (an average's is read from its score), clamped so the server never refuses it.
2. **A promoted show is "seen" through its seasons.**
   - Ranking a show needs a collection row, and W1 requires a watch for every seen title.
   - W1 now accepts a season's watch as the show's evidence. This is the rule `_viewer_has_seen` already used.
   - So a promotion creates no watch event.
   - If those seasons later leave the collection while the show stays ranked, the show gets the ordinary undated backstop event then.
3. **A promotion is a placement, not a watch signal.**
   - The show stays on the watchlist if it was there.
   - No award is unlocked or revoked.
   - Provenance is unchanged.
4. **Undo of a promotion** works only while the promotion is still the show's latest placement.
   - After any later move it is refused, and the bar says the ranking changed.
   - It removes the collection row the promotion created, unless the reader has since added a note or a watch to it.
5. **Visual-order limitation (documented).**
   - After a move the wall re-sorts by score.
   - A show can land a few posters away among the averages, but never past an explicit show.
   - The copy glides to where the show will actually be drawn.
   - A drag of an explicit show past averages only springs back with a notice.
6. **Silent updates.**
   - Only the TV `update: true` branch is removed. Movies were already silent.
   - The latest watch's existing post now takes a TV correction's score.
   - Historic posts are untouched.

## Founder QA checklist (Android first; about 15 minutes)

Cold-start the app twice, so the new update is the one running. Settings → Diagnostics shows `219e2953`.

**1. Top three (Movies, Watched, Rating highest first)**
- At the very top, long-press #1, #2 and #3 in turn and drag each a few places. Repeat five times.
- Each lifts under your finger every time.
- Scroll down, come back to the top, and do it again.
- Do the same in **List** view.

**2. Drop animation**
- Drop a title several places away. It glides into its slot and stays put, with no flash, no duplicate, no blank cell and no jump of the list.
- There is no "Move to …" label while dragging across a category. The bar after the drop still names the new category.
- With Reduce Motion (or Remove animations) on, the drop settles instantly.

**3. TV promotion (TV, Watched, Rating)**
- Long-press a poster with an **SN AVG** pill and drop it between two shows you ranked. The bar reads `Ranked "X" as a show · #N · score`, and the pill is now filled.
- Pull to refresh: it stays.
- Tap **Undo**: it is back to SN AVG, with the same score as before.
- Drag an explicit show onto another explicit show, including across a category. It moves, as on Movies.
- Drag an explicit show past SN AVG posters only. It springs back and the bar explains why.
- **Reorder → TV shows / TV seasons** still works.
- The old "ranked separately" message never appears.

**4. Season isolation**
- After a promotion, open the show: every season keeps its rank and score.
- Watch History shows no new entry for the show.
- **Reorder → TV seasons** is unchanged.

**5. Silent reranking (Feed, on a second account that follows you)**
- Drag a movie, promote a show, move a TV show across a category, and use **Update rating** on a season. None of these adds a Feed post.
- Your existing post for each title shows its new score.
- Log a rewatch of a movie: that **does** post.

**Optional:** with TalkBack on, an SN AVG poster offers **Rank as a show here**.

## After your QA
- **On approval:**
  - merge #319;
  - apply `20261129000100`, `000200` and `000300` to production, each with its rehearsed rollback;
  - publish to production after the fingerprint check.
- **#321:** merge and publish over the air only.
- **#322 (Workstream C):** its own staging round, on your word.
