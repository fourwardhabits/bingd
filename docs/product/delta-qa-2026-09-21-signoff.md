# #196 final sign-off — founder delta QA (2026-09-21, third pass)

**Only what changed since update `01a0c5c8`.** Same Android preview APK (`d84c78b3`), no
reinstall. Open twice, Settings ▸ About: the update id must start with **`01a0c63c`** (group
`52c3aa28-bbfd-438e-97f0-22fb89da4ff5`, from `0cc60b8`). **Backend:** staging, now at `20261017000100`.

1. **Rerank rule.** A film with two watches: note both scores in Watch History. ⋯ ▸
   Update your rating to a different band. Watch History: **Watch 1 unchanged, Watch 2 =
   the new score**; the Feed's Watch 2 post shows the new score too; still 2 watches, no
   new post. Log another watch (Watch 3), then Update your rating again: only Watch 3
   moves.
2. **Same score everywhere.** After step 1, the title page, Collection, Search and that
   film's row on a list all show the same current score.
3. **Rated ≠ ranked (the "Rank" rows).** Open one of the Letterboxd imports that shows the
   dashed Rank ring (e.g. Blade Runner 2049): its title page says *Not ranked yet* and it is
   in Collection ▸ Unranked. That is the same state everywhere; tap Rank to place it and it
   shows its score in Search and on your list.
4. **List page:** no *Add N unseen to my Watchlist* button; unranked rows still have their
   bookmark.
5. **Add to List picker:** each list shows its cover, name and a one-line description.
6. **Type:** list descriptions and watch notes read one step smaller than before.
7. **For You cold start:** kill the app, open For You: a grid of pulsing poster tiles, never
   an empty area, until the wall arrives.
