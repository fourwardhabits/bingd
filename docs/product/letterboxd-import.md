# Letterboxd import

**Status:** Phases 1–3 implemented on `feat/letterboxd-import`. Not merged, not on
production, not physically tested. Staging carries the pipeline; one migration is pending.

The full specification is Contract V3, agreed across the audit sessions of 2026-09-08 to
2026-09-11. This document is the part a reader needs *after* the contract: what is
verified, what is assumed, and what is still open.

---

## 1. What the import is

Somebody's Letterboxd export, brought into Bingd as collection history. Films they have
watched, the dates they watched them, their ratings — turned into the three taste buckets —
and their watchlist.

It is **optional and always available**. It is not a step in onboarding; the first-run
flow mentions in one sentence that it exists, and the importer itself lives at
**Settings ▸ Import from Letterboxd** and can be run at any time.

---

## 2. What is read, and what is never opened

A real export contains far more than the import wants: `reviews.csv`, `comments.csv`,
`profile.csv`, three `likes/` files, every custom list, and a `deleted/` folder holding
diary entries, reviews and comments the person **deliberately deleted**.

Four files are read. Everything else is *never extracted* — a stronger claim than *not
imported*, and the one worth making, because a decompressor that inflates everything and
discards most of it has still put somebody's deleted activity into memory.

| Read | Never opened |
|---|---|
| `watched.csv` | `reviews.csv`, `comments.csv`, `profile.csv` |
| `ratings.csv` | `likes/films.csv`, `likes/reviews.csv`, `likes/lists.csv` |
| `diary.csv` | `deleted/` — diary, reviews, comments |
| `watchlist.csv` | `orphaned/` — diary, reviews, comments |

The mechanism is in `src/features/import/zip.ts`: the archive's central directory is
walked with a filter that returns `false` for everything, so the listing costs nothing but
header parsing; the bounds are applied to the *declared* sizes; and only then are the four
wanted members inflated, one at a time. `zip.test.ts` proves it rather than asserting it —
an archive whose `reviews.csv` is patched to an unsupported compression method lists fine
and throws only when read.

Matching is by name and year against the local catalogue, through a shared
`letterboxd_matches` cache keyed on the **film** URI. A diary-entry URI identifies a
viewing rather than a film and can never enter that cache.

---

## 3. What is kept, and for how long

Contract V3 §14: the export source is not retained indefinitely.

- The `.zip` never leaves the device. What crosses the wire is the projected payload —
  names, years, film URIs, ratings, buckets, dates, and diary URIs for viewings.
- `import_stage` projects field by field: anything the client sends that the RPC does not
  name is discarded rather than stored.
- On settle, applied and duplicate staging rows are **deleted**.
- Rows that could not be matched are **redacted** down to name and year — the film URI,
  rating, bucket, watch date and every diary URI go. Name and year survive because
  `imported_titles` already keeps exactly those two, permanently, for every film that
  *did* match, and because the repair surface needs them: "182 films we couldn't place" is
  a count of nothing without the names.

---

## 4. What is verified about the Letterboxd export, and what is not

The founder's instruction was not to write the export steps from memory. Every
`letterboxd.com` and `letterboxd.zendesk.com` URL answers a scripted fetch with **HTTP 403**,
so the live UI could not be read. The user-facing copy is therefore written to be true
under either of the conflicting accounts, and the split is recorded here.

**Verified** — from the founder's own export, committed at
`src/features/import/__fixtures__/real-export.ts`:

- the export is a **ZIP of CSV files**;
- it contains `watched.csv`, `ratings.csv`, `diary.csv`, `watchlist.csv` and more;
- it was produced by a **free** account. Several secondary sources claim Letterboxd Pro is
  required; that claim is contradicted by this evidence, so no copy anywhere in the app
  mentions Pro.
- `Date` in `diary.csv` is an activity stamp in Letterboxd's own timezone, not a watch
  date; `Watched Date` is the watch date.

**Not verified, and hedged in the copy:**

- **Where the control sits.** Sources disagree between Settings ▸ Data and Settings ▸
  Advanced Settings. The sheet names Data and admits the other label in the same sentence.
- **How the file is delivered.** Sources disagree between an immediate download and an
  emailed link. The sheet covers both in one sentence rather than asserting either.

The sheet's button opens `https://letterboxd.com/settings/` — the settings root rather than
a deep link, because a root that has been stable for the life of the site cannot 404 the
way a guessed sub-path can. The live page is the authority; our list is a description.

### Open for the founder

> Confirm, from a real Letterboxd account: the current menu label, and whether the export
> downloads immediately or arrives by email. With that, `HowToExportSheet` can lose its
> hedge and name one path.

---

## 5. Native surface

**The importer moves the fingerprint by nothing.** It is deliverable by OTA to the builds
already on TestFlight and in closed testing.

This was not free. The obvious dependency, `expo-document-picker`, is native and took the
Android fingerprint from `b860e0b55c572a25320de8f726320aa379fe4870` (170 sources) to
`2e70327e832ac685866960c6b1adaf284fb0c5b3` (171). It was removed:
`expo-file-system@~57.0.2` is **already a dependency**, is in every shipped binary, and
provides `File.pickFileAsync`, implemented natively on both platforms. With it removed the
fingerprint returns to `b860e0b5…` at 170 sources exactly.

`fflate` is pure JavaScript and moves nothing.

> Source counts are worktree-relative. A clean worktree lacks `.env` and
> `google-services.json`, so it reports 170 where the beta lane reports 172. What matters
> is the before/after within one worktree, which is what the two hashes above are.

---

## 6. Where it lives

| Piece | Path |
|---|---|
| Archive policy (what may be read) | `src/features/import/archive.ts` |
| Decompressor | `src/features/import/zip.ts` |
| CSV parser | `src/features/import/csv.ts` |
| Letterboxd semantics, buckets, keys | `src/features/import/letterboxd.ts` |
| Wire payload and page bounds | `src/features/import/payload.ts` |
| Bytes to preview | `src/features/import/read-archive.ts` |
| State machine | `src/features/import/use-import.ts` |
| Screen | `src/features/import/ImportScreen.tsx` |
| Export instructions | `src/features/import/HowToExportSheet.tsx` |
| Route | `app/settings/import.tsx` |
| Foundations, provenance, pipeline | `supabase/migrations/2026091700010{0,2,3}*.sql` |
| Retention and byte bound | `supabase/migrations/20260917000400*.sql` |

---

## 7. Remaining QA

Nothing in this feature has been run on a phone. What the automated suite cannot cover:

1. **The picker itself.** `File.pickFileAsync` is mocked in tests. Needs checking on both
   platforms, from Files/Drive/Downloads, including a file that lives in a cloud folder and
   has to be materialised first.
2. **A real export, end to end.** The founder's own archive, on a device, against staging.
3. **Sheet over modal.** Settings is presented modally and `HowToExportSheet` is a `Sheet`
   inside it. The pattern is established (`DiagnosticsSheet` does the same), but the
   2026-09-10 freeze came from two presented view controllers, so it is worth a look.
4. **A large import.** Ten thousand films is 22 pages; the read is synchronous and the
   yield before it is what stops the spinner from never painting.
5. **The worker actually draining** on staging, and the summary counts arriving.

---

## 8. Deliberately not built

- **Lists.** Custom lists are out of scope for the first import (Contract V3 §11).
- **Reviews.** They are `user_media.note` in Bingd's model and are somebody's own writing;
  importing them was declined rather than deferred.
- **A repair screen.** Unresolved rows keep their names for one, and the summary reports
  the count, but the screen that lets somebody place them by hand is not built yet.
- **Re-import / merge.** A second import of a changed export is idempotent per row but has
  no reconciliation of removals.
