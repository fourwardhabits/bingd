# IMDb import (and the multi-provider entry)

**Status (2026-11-11):** implemented on `claude/admiring-fermi-0wkpe0`. **Not merged, not
deployed, not physically tested.** No production release is authorized. Founder spec:
*Multi-Provider Import: IMDb + Letterboxd* (2026-11-10).

The Letterboxd importer is documented in [`letterboxd-import.md`](./letterboxd-import.md).
This file covers what the IMDb import adds and what it changed in shared code.

---

## 0. Whole TV shows: matched and reported, not added (founder decision, 2026-11-11, provisional)

> **Decided (provisional), 2026-11-11:** whole TV shows are matched and accurately reported
> but **not added to the collection this release**. No season rankings, no show-level
> collection model. The import preview labels the count "TV shows, not added" and says why;
> the summary reports them on their own line, "TV shows matched, not added", separate from
> "Not supported" (the title is supported; the destination is not). The section below is the
> escalation as it was written, kept for the reasoning and for the switch if this changes.

**What the spec asks:** TV Series and TV Mini Series rows go to "the bingd TV show", join
the collection unranked, and TV is in the first release "wherever a canonical destination
exists".

**What the code base says:** bingd's collection (`user_media`) holds **movies and seasons
only**. `_assert_loggable` refuses a series ("a series cannot be logged; log a season"),
and PRD §10 makes this canon: *"A series is a grouping and watchlist object. It is the one
thing `set_watchlist` accepts that can never be logged."* Leaderboards, TV goals, awards,
profile counts and the Unranked backlog all assume a logged TV item is a season; *Start
ranking* on a series fails.

The spec also forbids every way round it: no season ratings, never Season 1, never spread
across seasons, no reclassifying, no TV-ranking architecture changes, and the show-vs-season
redesign is out of scope.

**What this branch does (the conservative reading):** every TV Series / TV Mini Series row is
**matched to the canonical bingd show** (IMDb id → TMDB `/find` → the `series` media item,
created through the trusted catalogue upsert if missing), and **reported, not added**: the
row settles `unsupported` with its media item kept so the summary can say *"139 TV shows
weren't added. bingd tracks TV by season, so find a show in Search and log the seasons
you've watched."* The preview says the same before anything is sent. Nothing is written
to `user_media`, `rankings` or any season.

**The one switch:** `_import_imdb_destination_supported(media_kind)` returns `kind = 'movie'`.
If the founder decides that an imported whole show may sit in the collection as unranked
history, that function (plus the apply branch and an audit of the season-assuming readers
listed above) is the change. Matching, provenance and copy are already in place, and
because series rows are already sent and matched, it is a server-only change with no app
update needed. **This is a product decision, so it is escalated rather than made here.**

TV Movies, Videos, Shorts and TV Specials *are* movies on TMDB, and become bingd movies
when TMDB's `/find` says so: that is a canonical destination, not a reclassification.

---

## 1. Audit answers (spec §4)

| # | Question | Answer, from the code |
|---|---|---|
| 1 | Provider-agnostic | `csv.ts` (RFC-4180 reader, BOM, quotes), `payload.ts` page/job bounds, the job machine (`import_create/stage/ready/status`, `_drain_import_jobs`, provider claim/resolve/release, settle, redaction trigger, sweep, notifications, poster nudge), `use-import.ts`'s upload/poll/resume, most of `ImportScreen`. |
| 2 | Assumes a Letterboxd ZIP | `zip.ts`, `archive.ts`, `read-archive.ts`, `letterboxd.ts`; `import_stage`'s projection (`filmUri`, star `rating`, `watches`); `_import_match_batch` (film-URI cache, title+year); `letterboxd_match_claims/matches`; copy everywhere. |
| 3 | Assumes movies only | `_import_match_batch` (`kind = 'movie'`), the Edge Function (`/search/movie`, `catalogueItem` kind `movie`), "films" copy. The apply path itself is kind-agnostic. |
| 4 | Letterboxd-specific DB fields | `imported_titles.letterboxd_uri`, `imported_titles.rating numeric(2,1)` with `imported_titles_rating_is_a_letterboxd_star` (0.5–5.0 halves), `imported_watches.diary_uri`. None can hold IMDb data honestly. |
| 5 | Job tracking / resume | `import_jobs` (one live per account, `pending → matching → applying → done/failed`), `import_rows_once` makes re-posting a page free, `findLiveJob` restores a running or recently finished job, notifications deep-link `/settings/import?job=`. Unchanged and shared. |
| 6 | TMDB / IMDb ids in the catalogue | `media_items.tmdb_id`, unique per `(kind, tmdb_id)` for movie/series. **No IMDb id anywhere** before this branch. |
| 7 | Movie vs TV collection | Movie: one `user_media` row. TV: per **season** (`kind = 'season'`, `parent_id` → series); a series is watchlist/list-only (§0). |
| 8 | Cross-source dedupe | `user_media` PK `(user_id, media_item_id)`: canonical id is the dedupe key, so two providers resolving to one title cannot produce two rows. Provenance needed widening (§3). |
| 9 | On-device parsing and privacy | Kept: the CSV is read on the phone (`read-imdb.ts`), only projected fields cross the wire, the server projects again, staging rows are deleted or redacted on settle. |
| 10 | Settings + onboarding | One row "Import from" + both marks → the choice; onboarding asks *Already tracking movies somewhere else?* with Letterboxd / IMDb / Not now. Same importer machine in both. |

---

## 2. Decisions (engineering, made here)

| Decision | Why |
|---|---|
| **One importer, a provider on the job.** `import_jobs.provider`; `import_create(p_provider default 'letterboxd')`. | Reuses the whole job machine. An installed app calling `import_create()` is unchanged. |
| **Provider-specific functions beside shared ones.** `_import_match_batch` and `_import_apply_batch` dispatch to `_imdb` twins on the first line; the Letterboxd bodies are copied verbatim (generator asserts each edit lands once). | Letterboxd behaviour provably unchanged; IMDb rules readable on their own. |
| **IMDb id on the catalogue, written only from TMDB `/find`.** `media_items.imdb_id`, set by `_import_provider_resolve` only when `/find` for that tt returned that title, never overwriting, never on a second title, never from a title search. | The client supplies an id; *which title it denotes* is TMDB's answer, so no account can bind an id to the wrong film (the poisoning class `letterboxd_matches` needed two-account trust for). |
| **Tiers:** 1 local `imdb_id` (kind + title/year checked) → 2 TMDB `/find` → 3 conservative title search (`pick`, `/search/movie` or `/search/tv`). | Spec §5. No local title tier ahead of the provider: with an id on the row, a cache guess is the weaker evidence. |
| **Type is evidence.** IMDb Movie/TV Movie/Video/Short/TV Short/TV Special → may only resolve to a movie; TV Series/Mini Series → only a series; anything else unsupported. A disagreement is unmatched, final. | Spec §2A. The database re-checks the Edge Function's answer. |
| **Identity check** on every hit: a squashed title or original title in common, years within ±1. | Guards against a TMDB mismatch or a tampered row without breaking localised titles. |
| **Rating → `imported_titles.imdb_rating smallint 1..10`.** The Letterboxd star column is untouched; IMDb rows never write it. | Spec §2B. Never a bucket, position or score. |
| **`imported_titles.providers text[]`** (default `{letterboxd}` backfills every existing row). | One provenance row per title can say both sources. |
| **No watch date.** `Date Rated` is never read or sent. The collection trigger gives an undated "watched at some point" event, as for a Letterboxd title without a diary entry. | Spec §3. |
| **Only absent titles are inserted.** Ranked, native and previously-imported titles are left alone (provenance still recorded). | Spec §2B/§2C. |
| **New row states `unsupported` and `failed`**; IMDb-only summary keys `duplicate`, `unsupported`, `unsupported_tv`, `unsupported_episode`, `failed`. Added only to IMDb jobs. | Spec §10's six outcomes; Letterboxd summaries byte-identical. |
| **Unsupported rows are sent (without rating)** so the summary can count them; malformed/invalid-id rows can't be sent and are reported on the preview. | Accurate server-side counts; minimal data. |
| **Watchlist / list exports refused** (`Position` column) with a clear message. | Spec §3: a ratings export is not a backup. Architecture allows a later watchlist provider. |
| **Edge Function keeps its name** (`letterboxd-import`) and routes IMDb claims by `provider`. | The drain posts to it; renaming is deploy risk for nothing. |
| **Marks drawn from Views**, colours in `partnerMark` tokens. | No SVG renderer in the binary; adding one breaks OTA. Drop-in replaceable by official brand-kit PNGs. |
| **Chooser is the importer's idle state**, one route `/settings/import`. | Notification deep links unchanged; a running import shows instead of the question. |
| **Onboarding stage name stays `letterboxd`.** | A stored stage is what a relaunch resumes from. |

---

## 3. Data changes (`20261113000100_an_import_from_more_than_one_place.sql`)

Additive: `import_jobs.provider`, `media_items.imdb_id` (+ shape check, partial index),
`imported_titles.imdb_id / imdb_rating / providers` (+ checks), two row statuses.
Replaced (same behaviour for Letterboxd): `import_create` (new signature), `import_stage`,
`import_status` (adds `provider` column), `_import_match_batch`, `_import_apply_batch`
(adds the `providers` append on the Letterboxd provenance upsert, nothing else),
`_import_provider_claim` (adds four trailing columns), `_import_provider_resolve` (adds
`p_imdb_id`, `p_unsupported`), `_import_settle`, `_import_redact_on_complete`,
`_import_notify` (payload gains `provider`), `claim_push_batch` (import payload for all
three import pushes). **`claim_push_batch` is #254's two-argument function** (this branch is
built on #254): the generator copies it from `20261101000100` and applies the one import
edit, and no one-argument form is created
(`docs/release/claim-push-batch-reconciliation.md`). New: `_import_imdb_title_type`, `_import_imdb_kind`,
`_import_imdb_destination_supported`, `_import_imdb_identity_agrees`,
`_import_match_batch_imdb`, `_import_apply_batch_imdb`.

Regenerate/verify: `node scripts/migration-generators/imdb-import.mjs` rewrites the file;
`git diff` must be empty.

**Ops runbook change:** the importer entry switch is now
`revoke/grant execute on function import_create(text), import_stage(uuid, jsonb), import_ready(uuid)`
(`letterboxd-production-promotion.md` updated).

---

## 4. Release order and rollback

Built on #254 (`claude/imdb-import-on-254`), so this ships with #254's migrations and its
push-sender. The combined order, per environment (staging first; each step a founder
decision), is in [`docs/release/claim-push-batch-reconciliation.md`](../release/claim-push-batch-reconciliation.md):

1. Deploy `letterboxd-import` **first**. Against the old schema it behaves exactly as today:
   a claim without `provider` takes the Letterboxd path, and resolve is called with the same
   three arguments. (The reverse order is lossy: the old function would title-search IMDb TV
   rows as movies, the database would refuse the kind, and those rows would settle unmatched
   for that import. Found by the independent review.)
2. Apply the migrations in **one** `db push`, in date order, after a `--dry-run`: #254's five
   files and then `20261113000100`. Old app builds keep working: `import_create()` resolves
   through the default, and `import_status` gains a trailing column.
3. Deploy **one** `push-sender` built from this branch, carrying #254's goal and proactive
   copy and this branch's provider naming. A payload without `provider` reads as Letterboxd.
4. Ship the app update (OTA-eligible: no native change. `package.json` scripts,
   `app.config.ts` and `.gitignore`, all fingerprint inputs, are unchanged; #256's
   `private-samples/` ignore line was dropped in the rebuild for exactly that reason). The new client needs step 2, because it selects
   `import_jobs.provider`.

**Rollback:** the switch above (or `unschedule_import_drain()`) stops imports without a
deploy. Reverting the app is OTA. The migration is additive; its function replacements
can be reverted by re-applying the previous definitions from the migrations named in the
generator. IMDb provenance columns can stay (nullable, unread by old code).

---

## 5. Privacy

On device: only `Const`, `Title`, `Original Title` (when different), `Year`, `Title Type`
and `Your Rating` are read; `Date Rated`, the community `IMDb Rating`, genres, directors,
votes, runtime, URL and release date are never read. The file is not uploaded or retained.
Wire: `{kind, correlation, name, originalTitle?, year, imdbId, titleType, imdbRating?}`;
no rating for unsupported types. Server: re-projects field by field, drops a rating on an
unsupported type, deletes applied/duplicate/unsupported/failed rows on settle and reduces
unmatched rows to name and year, replacing the `correlation` (the tt id) with an opaque
value, so an IMDb row keeps exactly what a Letterboxd row keeps; a failed job keeps nothing.
A rating is sent and kept only for a movie (a show is recognised and not added, so its
rating has nowhere to live). Episode and other unsupported rows are still sent, without a
rating, so the server's summary can count them; they are deleted on settle. RLS unchanged; provider functions service-role
only; `imported_titles` and `import_jobs` cascade on account deletion; `media_items.imdb_id`
is catalogue data and stays. Nothing logs titles or ratings.

---

## 5a. Independent review (2026-11-11)

A separate review pass diffed every copied function against its source, re-ran the
generator byte-for-byte, and reproduced its findings against PGlite and Jest.

| # | Finding | Outcome |
|---|---|---|
| 1 | A failed IMDb job reopened from its notification read as Letterboxd and offered the Letterboxd picker | **Fixed.** The server failure keeps the job's status; a job's provider chooses the service. Test in `ImdbImport.test.tsx`. |
| 2 | `import_create('imdb')` cleared a Letterboxd job another device was still sending (and vice versa) | **Fixed.** A pending other-provider job with staged rows is refused with 22023 ("already running; this file wasn't sent"); an unused one is still cleared. DB test. |
| 3 | A Const duplicate was shown as "Already in your collection" beside the title it duplicated | **Fixed.** Counted once, as added. |
| 4 | The tt id survived redaction in `import_rows.correlation` | **Fixed.** Replaced on settle and on the completion trigger. DB test. |
| 5 | Ratings sent for TV series that are never kept; unsupported rows sent | **Fixed** for ratings (movies only, client and server). Unsupported rows still sent, deliberately, for server-side counts (§5). |
| 6 | Old Edge Function + new schema loses IMDb TV rows for that import | **Release order** changed (§4). |
| 7 | Some "Not supported" rows had no sentence; preview promised shows "listed in your summary" | **Fixed.** A sentence for every remainder; the preview promise removed. |
| 8 | Preview "Ratings" counted show ratings | **Fixed** with 5. |
| 9 | IMDb picker cancel / too large / unreadable events untagged | **Fixed.** |
| 10 | Claim comments said provider is null on Letterboxd rows; the Letterboxd "single CSV isn't enough" refusal doesn't mention IMDb | Comments **fixed**. The Letterboxd copy is left as shipped (no Letterboxd regression); worth a line pointing to IMDb in a later copy pass. |

## 6. Tests

- `supabase/tests/import-imdb.test.mjs` (47): staging projection, provider on jobs, every
  matching tier and refusal, TV recognised-not-added, episodes, integrity (ranking, native
  log, no score/bucket, no watch date, no feed, lifecycle-only notifications), idempotency,
  duplicates, Letterboxd⇄IMDb in both orders, Letterboxd summary unchanged, RLS, anon,
  retention, failed job, account deletion, no client write of `imdb_id`.
- `supabase/tests/import-imdb-provider-match.test.mjs` (25): `/find` decisions, identity,
  TV search, type folding.
- `src/features/import/imdb.test.ts`, `read-imdb.test.ts` (29): exact columns, BOM, CRLF,
  quotes and commas, missing fields, malformed rows, invalid ids and ratings, duplicates,
  10,000-row file, every Title Type, ZIP/list/non-IMDb refusals.
- `src/features/import/ImdbImport.test.tsx` (16): the choice, IMDb page, preview, upload
  payload, refusals, six-outcome summary, onboarding Not now.
- Updated: `LetterboxdStep.test.tsx` (new question, Letterboxd flow one tap later),
  `SettingsScreens.test.tsx`, `NotificationsInbox.test.tsx`, `push.test.ts`,
  `function-grants`, `import-entry-switch`, `import-notifications`.

---

## 7. Open for the founder

1. **§0, whole TV shows.** Decided provisionally on 2026-11-11: matched and reported, not
   added this release. One switch to change if that decision changes.
2. **IMDb's export steps are unverified.** imdb.com and help.imdb.com are unreachable from
   the build environment, so the copy is written to hold under both of IMDb's recent flows
   (immediate download, or prepared and listed under *Your exports*). Check on a device.
3. **Marks.** Drawn approximations of the Letterboxd dots and the IMDb badge; swap in the
   official brand-kit rasters if brand guidelines require exact files.
4. **Real-file validation is outstanding.** The friend's 811-row export was not available to
   this session and must never be committed. To validate privately, keep the file outside the
   checkout (or, inside it, list the folder in your own `.git/info/exclude`: a line added to
   `.gitignore` moves every lane's native fingerprint, `founder-todo.md`) and run
   `IMDB_PRIVATE_SAMPLE=/path/to/ratings.csv npx jest imdb-private-sample`, which prints counts
   only. Expected from the spec's description: 811 parsed; 660 Movie + 2 TV Movie + 1 Video +
   1 Short + 1 TV Special = 665 movie-eligible; 118 + 21 = 139 TV shows (recognised, not
   added); 7 episodes unsupported. Then import it on staging for matched / unmatched / added /
   already counts.
5. **No local title fallback without a provider.** On a project with no TMDB key, IMDb rows
   not already carrying an id settle unmatched (staging today, per `letterboxd-import.md`
   §6a #10).

---

## 8. Manual QA (preview lane, staging)

1. Settings: the row reads *Import from* with both marks; tap opens *Bring your watch history*
   with Letterboxd and IMDb; no other services.
2. Letterboxd: choose → the same page as before → ZIP → preview → import → summary. Repeat
   the Letterboxd physical checklist items 1–7 in `letterboxd-import.md` §7.
3. IMDb: choose → instructions → *Need help* sheet → open IMDb ratings → export → pick the CSV
   (from Files, Drive, Downloads) → preview shows Movies / TV shows / Ratings / Not supported
   with the TV and episode notes → import → leave the app → notification *Your IMDb history is
   ready* → tap opens the summary with the six outcomes.
4. Pick the Letterboxd ZIP on the IMDb page, and an IMDb watchlist CSV: both refused clearly.
5. Import the same IMDb file again: *already here*, nothing added. Import Letterboxd then IMDb
   with overlapping films: no duplicates in Collection; a film ranked before import keeps its
   score and position.
6. Onboarding: after *Your First Five*, *Already tracking movies somewhere else?* with
   Letterboxd / IMDb / Not now; Not now goes to People; start an IMDb import, Continue, kill the
   app: relaunch lands on People, the import's notifications still arrive; kill before Continue:
   relaunch lands on the step showing the running import.
7. Imported movies appear in Collection ▸ Unranked with no score; the title page shows no
   IMDb number as a bingd score; no Feed posts for the import.
