# #196 final polish — founder delta QA (2026-09-21, second pass)

**Only what changed since update `01a0c527`.** Everything that passed last time (goals,
Search score, Lists mode, drag reorder, sharing, For You, other-profile privacy, empty
Profile sections) is untouched; don't re-walk it.

**Build:** the same Android preview APK (`d84c78b3`, runtime `0832dd3e`), no reinstall.
Open it twice, then Settings ▸ About: the update id must start with **`01a0c5c8`** (group
`f3b15ae8-49bb-4454-ac15-006ad08980b7`, from `5b116a3`). **Backend:** staging, now at `20261015000100`.

---

1. **Rewatch = the log sheet.** Ranked film ▸ ⋯ ▸ Log another watch. It looks like the
   normal log: header, *How was it?*, then Who I watched with / Note / Watch date, all
   closed. Open Note, type, pick a band → comparisons. Back out once: the watch count goes
   up, ranking unchanged.
2. **Watch History.** Each row: date (First watch on the earliest), companions, note (More
   if long), and a **score circle on the right**. Watch 1 keeps its old score, the rewatch
   shows its own. Tap the small **Edit**: the same rows as the log sheet.
3. **Pure rerank changes no history.** ⋯ ▸ Update your rating to a different band. The
   title page score changes; Watch History rows and the old Feed posts **don't**, and no
   new watch or post appears.
4. **Same score everywhere.** After ranking a new film and after the rerank in 3: title
   page, Collection and Search (and that film's row on a list) all show the same current
   score, no restart.
5. **Covers.** Your six-title list shows a full 2×2 of four posters; a 1–3 title list shows
   the first poster full; an empty list shows the neutral glyph. Collection ▸ Lists and the
   Profile shelf both.
6. **List page.** Opens on the first title's artwork; the list name is in the page, and
   appears in the top bar only once it scrolls away. **Add titles | Share list** side by side
   (Share maroon, right).
7. **Numbered.** Toggle Numbered: posters and titles do not move; the number sits on the
   poster's lower edge. Drag still renumbers.
8. **Row actions.** On a list and in Search: a title you ranked shows only its score circle;
   an unranked one shows Log/Rank + bookmark.
9. **Remove.** On your list, swipe a row left → *Remove from list* → tap it. A short swipe
   springs back; vertical scrolling and long-press drag still work.
10. **Title page.** The action row is Rank · bookmark · list-plus · share. The list-plus
    opens Add to list at once. On a title you've never logged there's no ⋯.

**Still not proven by a person:** second-account privacy (link-only / public / only-you
on another device).
