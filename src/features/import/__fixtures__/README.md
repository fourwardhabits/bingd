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
