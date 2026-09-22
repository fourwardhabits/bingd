# #196 final sign-off — founder delta QA (2026-09-21, final UI simplification)

**Only what changed since update `01a0c6a1`.** Same Android preview APK (`d84c78b3`), no
reinstall. Open twice, Settings ▸ About: the update id must start with **`01a0c6da`** (group
`a065ca09-c383-4e68-8d63-6810e0120076`, from `6b44ec4`). **Backend:** staging, still at
`20261018000100` (no SQL in this pass).

1. **Ranked or not, nothing else.** An untouched Letterboxd import (e.g. Blade Runner 2049)
   shows the ordinary Maroon **+** on its Search row, list row and Collection row, and
   **Rank** on its title page. No dashed ring, no Finish pill, no *Ranking not finished*
   anywhere.
2. **Unfinished looks the same, resumes.** Start ranking a film, pick a band, answer one or
   two comparisons, then close the sheet. Its rows show the same **+** and its title page the
   same **Rank**. Tap **+** (Search or list row) or **Rank** (title page): it goes straight
   back into the comparisons, with no *How was it?*, at the pair you left. Finish it: the
   score appears everywhere.
3. **Untouched starts fresh.** Tap **+** on a title you've never logged: the usual *How was
   it?* sheet.
4. **Re-rank still leaves cleanly.** On a ranked film, ⋯ ▸ Update your rating, answer one,
   close: the old score is unchanged.

The previous pass's other items (rerank rule, same score everywhere, list page, picker,
type, For You cold start) are untouched by this update and need no repeat.
