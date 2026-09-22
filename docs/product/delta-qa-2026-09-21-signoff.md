# #196 final sign-off — founder delta QA (2026-09-21, third pass)

**Only what changed since update `01a0c5c8`.** Same Android preview APK (`d84c78b3`), no
reinstall. Open twice, Settings ▸ About: the update id must start with **`01a0c6a1`** (group
`fec14bbe-128d-4276-8ab2-2c50149b5f93`, from `6ba7772`). **Backend:** staging, now at `20261018000100`.

1. **Rerank rule.** A film with two watches: note both scores in Watch History. ⋯ ▸
   Update your rating to a different band. Watch History: **Watch 1 unchanged, Watch 2 =
   the new score**; the Feed's Watch 2 post shows the new score too; still 2 watches, no
   new post. Log another watch (Watch 3), then Update your rating again: only Watch 3
   moves.
2. **Same score everywhere.** After step 1, the title page, Collection, Search and that
   film's row on a list all show the same current score.
3. **Three ranking states.** An untouched Letterboxd import (e.g. Blade Runner 2049) now reads
   **Rank** everywhere (Search, list row, Collection, title page) and has no bucket: stars are
   provenance only. Start ranking a title, pick a band, then back out of the comparisons: it
   reads **Finish** (title page: *Finish ranking* / *Ranking not finished*). Finish it: the score.
4. **List page:** no *Add N unseen to my Watchlist* button; unranked rows still have their
   bookmark.
5. **Add to List picker:** each list shows its cover, name and a one-line description.
6. **Type:** list descriptions and watch notes read one step smaller than before.
7. **For You cold start:** kill the app, open For You: a grid of pulsing poster tiles, never
   an empty area, until the wall arrives.
