# Importer fixtures

| File | Source | What it holds |
|---|---|---|
| `real-export.ts` | The founder's real Letterboxd export, 2026-09-10 | `watched`, `ratings`, `diary` and `watchlist` verbatim, plus the archive listing. The account had no lists. |
| `real-list-export.ts` | The founder's real Letterboxd export, 2026-09-21 22:08 UTC | The two custom lists, **scrubbed Letterboxd list export v7 files**, plus that archive's 18-member listing in stored order |

Neither fixture includes `profile.csv`, an email address, or anything else that identifies
the account.

In `real-list-export.ts`, the list names, list file names and list URLs are synthetic.
Everything else is byte-exact, including the CRLF line endings and the film rows. The
docblock at the top of that file lists exactly what was changed and why.

These fixtures document the format for the future list import (T6c,
`docs/product/letterboxd-lists-import.md`). The current importer reads none of the list
files.

## IMDb

| File | Source | What it holds |
|---|---|---|
| `imdb-synthetic.ts` | **Synthetic.** Written by hand for the IMDb import (2026-11-11) | An IMDb ratings export in the real 14-column schema, covering every Title Type in the founder's sample (Movie, TV Series, TV Mini Series, TV Episode, Short, Video, TV Movie, TV Special) plus a game, duplicate Consts, missing years, a BOM, CRLF, quoted titles with commas and quotes, and malformed rows |
| `imdb-qa-mirror.ts` | **Synthetic.** Written by hand for IMP1113-UI (2026-11-14) | A 7-row mirror of the *shape* of the founder's QA file (3 new movies, 1 already-ranked movie, 1 recognised TV series, 1 TV episode, 1 unmatched short), with the counts the server reports for a first import and a re-import, and each row's results bucket. Invented titles, `tt91…` ids |

**No real IMDb export is committed, and none may be.** The founder's sample is somebody
else's viewing history (spec §3). Every title, id, rating and date in the synthetic file is
invented; the `tt9…` ids are outside the range IMDb has issued for these names. Validation
against the real file is a private, local step recorded only as counts in the PR.
