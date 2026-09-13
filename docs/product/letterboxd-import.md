# Letterboxd import

**Status:** Phases 1–3 implemented on `feat/letterboxd-import`. Not merged, not on
production, **not physically tested**.

Staging (`fjxhcbowoxuzulwirzyr`) carries the whole pipeline: 128/128 migrations, the Edge
Function deployed, the drain scheduled and draining, 126/126 on the anon smoke. Production
(`abheeqyjzekiowkztfxv`) has none of it — all eight `2026091700xx` migrations are pending
there, by design.

Independent review of 2026-09-11 found ten defects; a second pass closed the rest and found
four more. All fourteen are fixed (§6a, §6b), including the security finding on the shared
match cache and a provider tier that could never have resolved a film on any project.

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

### Where the onboarding mention sits, and why it is a sentence

The direction was one optional, skippable discovery moment **after First Five**, with
*Import from Letterboxd* and *Not now* — and an explicit fallback to a Settings-only entry
if placing it inside onboarding would raise release risk.

It would, on three counts that are facts about this codebase rather than caution:

1. **A route cannot be pushed from inside the flow.** `nextRoute` in
   `src/features/auth/session.tsx` answers any group other than `onboarding` with
   `STAGE_ROUTES[stage]` while the stage is unfinished, so a push to `/settings/import` is
   replaced straight back to the current step. This is the same rule that forced the
   Diagnostics entrance on the payoff to be a long press rather than a route.
2. **A sheet cannot carry it either.** Reaching the importer that way puts
   `HowToExportSheet` — a `<Modal>` — inside another `<Modal>`, which is the
   two-presented-view-controller freeze of 2026-09-10.
3. **The payoff screen deliberately carries one action.** A fork there is what made the
   social half of onboarding optional in the first place, and `TasteOnboarding.test.tsx`
   asserts the absence of competing buttons.

So the mention is one line on the **payoff** — after the five are placed, not during the
run, where an earlier pass had put it. Skipping it is carrying on.

> **Open decision.** A true two-action moment needs the flow guard to admit one route out
> of the onboarding group. That is a change to the machine that stranded people twice
> (#131, #133), so it is not in this tranche. It is a small change and a separately
> reviewable one: an allowance in `nextRoute` for `/settings/import` while a stage is
> unfinished, plus a return path. Worth doing on its own, with its own review, once the
> importer has been physically tested.

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

**Corroborated on a second pass, 2026-09-11**, after the 403 was re-confirmed from a
different session — it is Letterboxd refusing scripted fetches outright, on both
`letterboxd.com` and `letterboxd.zendesk.com`, rather than anything fixable at our end.
What could be established from Letterboxd's *own* indexed material, as distinct from the
third-party blogs that disagree with each other:

- **Where the control sits.** The **Data** tab of Settings, and `letterboxd.com/settings/data/`
  resolves to a real Letterboxd page rather than a guessed path. The "Advanced Settings"
  label appears only in secondary write-ups and is most likely stale; the copy no longer
  carries it.
- **How the file is delivered.** Letterboxd's own *Importing data* page describes it as
  "click to generate a zip file containing CSVs of your profile, films, reviews, lists and
  more" — generated on demand, not queued to an inbox.
- **No subscription gate** appears in any official material, which agrees with the
  free-account evidence above.

**Still not verified, and deliberately soft in the copy:**

- Whether a very large account is emailed a link instead. One sentence allows for it rather
  than asserting either way.
- Whether the mobile app exposes the export at all. The copy does not mention the app: the
  export is a website URL, and sending somebody hunting through the app for it would be a
  dead end of our own making.

The sheet's button now opens `https://letterboxd.com/settings/data/` — the Data tab itself.
The root was right while the tab was a guess; it is not a guess now, and the deep link saves
the step people actually get lost on. The live page is the authority; our list is a
description.

### Open for the founder

> One thing left, and it is small: whether a large export arrives by email rather than as a
> download. Everything else in the steps is now corroborated from Letterboxd's own material.

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
| Foundations, provenance, pipeline | `supabase/migrations/20260917000{100,200,300}*.sql` |
| Retention and byte bound | `supabase/migrations/20260917000400*.sql` |
| Abandoning a half-staged job | `supabase/migrations/20260917000500*.sql` |
| Installing the worker, and redacting a failed job | `supabase/migrations/20260917000600*.sql` |
| `import_drain_status()` | `supabase/migrations/20260917000700*.sql` |
| `unschedule_import_drain()` | `supabase/migrations/20260917000800*.sql` |

---

## 6a. Independent review, 2026-09-11 — what was fixed and what was not

A read-only review of the whole branch found ten defects. Four are fixed on this branch;
the rest are recorded here honestly rather than quietly carried.

### Fixed

| # | Defect | Fix |
|---|---|---|
| 1 | **Nothing installed the cron job.** `schedule_import_drain()` was defined and never called — no self-install block, no `service_role` grant, no bootstrap step. On a real project no import could *ever* finish: `import_status` kept answering `matching` successfully, so the client's blind-poll bail-out never fired and the person sat on a buttonless screen; the 24-hour dead letter is inside the worker too, so the job never completed and `import_create` re-adopted it for ever. | `20260917000600` adds the grant and a best-effort install; `20260917000700` adds `import_drain_status()`; `bootstrap-production.mjs` schedules it deliberately. **Verified on staging:** job 3, active, last run succeeded. |
| 2 | **A failed job kept the whole payload for ever.** Every deletion and redaction lived in `_import_settle`, and the dead-letter path never calls it — so an exhausted import kept its film URIs, ratings, buckets, watch dates and every diary URI permanently, against Contract V3 §14. | A trigger on the transition into a completed job, so it covers the dead letter, the settle path and whatever writes `completed_at` next. |
| 4 | **"Close the app and come back" was false once the import finished.** The lookup filtered `completed_at is null`, and `_import_settle` writes `done` and `completed_at` together — so a finished job was excluded from the one query meant to find it. | The filter is gone; a job that completed within a day is restored, and the summary now offers *Import another file* so it is never a dead end. |
| 5 | **"Start over" failed exactly when it mattered.** The discard was fired and forgotten, so when the upload dropped *because the network went*, the discard went with it, the job survived `pending`, and the next archive merged into it. | A failed discard is remembered and settled before the next `import_create`; if it cannot be, the import stops rather than merging. |

Finding #4 is worth a second line: the test that claimed to cover it passed only because
the mocked query builder treated `.is()` as an identity. The mock now records its filters,
and a test asserts the absence of that predicate directly.

### Open, and deliberately not rushed

- **#3 — the shared match cache can be poisoned (security).** `letterboxd_matches` maps a
  Letterboxd film URI to a bingd title, is global across accounts, and is written from a
  `(filmUri, name, year)` triple the client supplies in full. Any signed-in account can
  stage one row binding a real film's URI to a different title; `on conflict do nothing`
  makes it permanent, no contributor is recorded, and RLS means nobody can read the table
  to audit it. Every later importer with that URI in their export gets the wrong film.
  Not fixed here because every cheap fix is wrong: scoping the cache per account throws the
  feature away, and a confirmation rule is a schema change that deserves its own review.
  **This should be settled before the importer reaches anyone but the founder.**
- **#6 — a second archive can be silently swallowed.** If `import_create` returns a job the
  worker already owns, the preview is dropped and the *first* job's summary is shown as
  though it were this import's result.
- **#7 — the summary overcounts.** "Added to your collection" counts rows marked `applied`,
  including those where nothing was written because the title was already ranked. A
  re-import of an archive you have since ranked reports every film as added.
- **#8 — no ceiling on rows per job.** Pages are bounded; the number of pages is not.
- **#9 — `pick()` has no double-press guard**, unlike `start()`. Two taps could present two
  document pickers, and iOS refuses the second. Physical QA item 1 covers it.
- **#10 — the provider tier is unconfigured on staging.** `provider_ready: false`, because
  staging has neither `functions.base_url` nor the vault key — for push either, so this
  predates the importer. Jobs settle immediately rather than stalling (by design), but the
  TMDB tier is not exercised on staging until those are set.

---

## 6b. Closing the six, 2026-09-12

Every finding left open above is now closed, and configuring staging to prove it turned up
three more.

### The six

| # | What it was | How it is closed |
|---|---|---|
| 3 | **Cache poisoning.** `letterboxd_matches` is global and was written directly by whichever import got there first, from a `(filmUri, name, year)` triple the client supplies in full. The guard checked `year` against the matched row's release date — i.e. name↔year — while the thing recorded was filmUri↔film. The URI was never part of the evidence. | `20260917000900`. The table splits: `letterboxd_match_claims` is what one account asserted, attributable on purpose; `letterboxd_matches` is what `import.match_trust_claims` (default 2, floored at 2 in code) distinct accounts agreed on. `_import_promote_match` is the only writer. |
| 6 | **A second archive was swallowed.** `import_create` returns the running job, and the screen settled to `working` — so the preview vanished and the *other* import's summary appeared under "Your history is in". | The client refuses with `already_running`, says this file was not sent, and offers to watch the running import. |
| 7 | **The summary overcounted.** Every row the worker finished with was `applied`, including the ones it deliberately left alone, and that number was rendered as "Added to your collection". | `20260917001000`. Five buckets that partition the archive, in stated units. |
| 8 | **No whole-job ceiling.** Pages were bounded; the number of pages was not. | `20260917001100`. 50,000 rows and 32 MiB, counted on `import_jobs` from the insert's own `returning`. |
| 9 | **`pick()` had no in-flight guard.** | A ref guard, released in a `finally`, tested at the hook level. |
| 10 | **The provider tier was unconfigured on staging.** | Configured — and then found to be broken everywhere. See below. |

### Why "trust only the provider" was not the answer to #3

It is the obvious fix and it does not work, which is worth recording so nobody reaches for
it again. `_import_provider_resolve` is handed a media item the Edge Function chose by
searching TMDB for **the row's own name and year** — the client's, exactly as in the local
tier. It never dereferences the URI either. Nothing in this system fetches a Letterboxd
page, so no tier can establish that binding alone, and trusting the provider would have left
the same attack reachable by naming a film the catalogue did not have yet.

What is available is independent agreement, and it is enough, because the attack it has to
stop is precisely "one account asserts".

Three properties fell out that are stronger than the rule required:

- two accounts disagreeing about one URI promote nothing, because neither *pair* reaches the
  bar — disagreement answered by abstention, the same answer T1 gives an ambiguous title;
- an established mapping is never displaced, so a second account buys an attacker nothing;
- a trusted URI cannot be contested at all: T0 runs before T1, so a later row carrying it
  resolves to the trusted film whatever it calls itself, and the rival claim is never even
  recorded.

The cost is smaller than it looks. The cache exists to spare the provider, and most of that
survives: the provider already populates `media_items`, so once any import has caused TMDB
to be asked about a film, every later importer matches it locally for free. The cache only
adds something where the local tier cannot reach — an alternate title, or a year more than
one out — which are exactly the bindings least supported by evidence.

### The read side, and what guarding it costs (`20260917001300`)

The split above made *writing* a shared mapping require two accounts and a year agreement.
Reading one back required nothing: T0 looked the URI up and set `matched` without comparing
the result against the row it was placing. So a mapping saying `<Godfather slug> → Cats
(2019)` was applied to an export row saying `The Godfather, 1972` — a film T1 would have
placed correctly. The victim's own archive contradicted the mapping and was never consulted.

T0 now applies the same year test T1 uses. This does not stop the attack; it decides what
the attack can buy:

| | before | after |
|---|---|---|
| what two accounts can bind | any URI to any film | a URI to a film released **within a year** of the real one |
| who it reaches | every later importer | only those whose export omits the year |

**What it costs, stated plainly.** `20260917000900` named the cache's value as resolving
"an alternate title, or a year more than one out". The guard removes the second half — and
since both claim writers also require agreement within a year, such a pair can no longer be
written either. A film Letterboxd dates to its festival year and TMDB to wide release two
years later is now a row the cache cannot help with: it falls to T1, then the provider, and
may end unmatched.

That is a real narrowing and the trade is deliberate. An alternate *title* — the common
case, and the one the cache was built for — still resolves, because the title is what T1
could not match and the year is what the export still carries.

**The residual.** Two colluding accounts can still mislabel a film inside a one-year window,
and a row with no year in the export is placed by the mapping unchecked, because there is
nothing to disagree with. Both have tests. Nothing after the fact distinguishes a poisoned
pair from an honest one: `letterboxd_match_claims` records who claimed what, which makes an
incident investigable, not preventable.

### The three found while proving it on staging

**The provider tier could never have resolved a single film**, on any project:

1. It read `TMDB_READ_TOKEN`, a name that appears in no other file, no deployed project and
   not in `supabase/functions/README.md`. The convention is `TMDB_ACCESS_TOKEN`.
2. It called `tmdb_upsert_titles` with `p_titles`; the argument is `p_items`. PostgREST
   answers an argument mismatch with a 404, and `upsert` turns any error into `null` —
   indistinguishable there from "the film could not be written". So every provider match was
   found, judged confident, and silently dropped.
3. It read `.id` from the result; that function returns `(media_item_id, item_kind,
   provider_id)`. Two mistakes producing one symptom, which is why fixing only the first
   would have looked like no fix at all.

The function now reports why a batch resolved nothing — `failed` with reasons, `noResults`
against `notConfident`, and `unwritable` — because those were one silence, and a cron tick
with nobody reading its logs should be able to say whether it met an unknown film or a
broken key.

### And a fourth retention path

Re-verifying retention across every terminal path found three closed and one open.
`import_create` clears an abandoned `pending` job only when the same person imports again,
`import_discard` is the button they did not press, and the worker's dead letter is
unreachable for it — the tick returns `idle` unless something is `matching` or `applying`.
So a half-staged archive from somebody who tried once and gave up was kept indefinitely, on
the account least likely to want it kept. `20260917001200` sweeps it.

### Staging, proven end to end

Configured on `fjxhcbowoxuzulwirzyr` only, verified before each write: `functions.base_url`,
and a vault `service_role_key` taken from the authenticated CLI and never written to disk.

A real import, through the actual pg_cron tick rather than a hand-driven worker:

| case | result |
|---|---|
| strong local match | *12 Angry Men* → collection, `source = imported` |
| provider tier | *Sansho the Bailiff* → TMDB, upserted, collection |
| controlled non-match | *Zzq Nonexistent Film* → unmatched, redacted to name and year |
| watchlist | *12 Monkeys* → watchlist |
| re-import | `watched 0`, `already 2`, collection still two rows |
| trust boundary | three claims from one account, **zero** trusted mappings |

---

## 6c. Deploying it, and turning it off

**The importer is the only feature here with a worker, and a worker has to be started.**
`20260917000300` shipped the installer and nothing that called it; this section exists so
that cannot happen again to whoever applies these migrations to production.

### On a fresh project, in order

1. **Apply the migrations** — `20260917000100` through `20260917000800`.
2. **Deploy the Edge Function** — `supabase functions deploy letterboxd-import --project-ref <ref>`.
   Nothing in the release path does this on its own; the thirteen-day `episode_count` drift
   is what that costs.
3. **Schedule the drain.** `scripts/bootstrap-production.mjs` now does it. On a project
   where the extensions were enabled *after* the migrations ran, call
   `schedule_import_drain()` again — the migration's own install is best-effort and will
   have logged a notice rather than failed.
4. **Check it** — `import_drain_status()`. A null `job` means nothing is draining and no
   import can ever finish. `provider_ready: false` means the TMDB tier is off, and films
   the local matcher cannot place will settle as unmatched rather than being looked up.

### If it misbehaves

`select unschedule_import_drain();` — the first thing to reach for, and reach for it rather
than a deploy. Nothing is lost: jobs stay exactly where they are and resume when it is
scheduled again.

It earns that status because the worker spends provider requests and writes
`letterboxd_matches`, which every account shares — so a bad drain is expensive and
contagious rather than merely slow.

The cost while it is off is that anybody mid-import sits on "Matching your films", which is
the same thing an absent job costs. The 24-hour dead letter is paused with it, so jobs
stranded during the outage settle as `failed` shortly after it comes back rather than while
it is down.

---

## 7. Physical QA checklist

Nothing in this feature has been run on a phone. Run against the **preview** lane, which
points at staging (`fjxhcbowoxuzulwirzyr`) — never the shipped app.

Staging is ready: 128/128 migrations, the edge function deployed, the drain scheduled and
its last run succeeded (`import_drain_status()`), and 126/126 on the anon smoke.

### The parts only a device can answer

| # | Check | Why it cannot be tested here | Watch for |
|---|---|---|---|
| 1 | **The picker**, on both platforms, from Files, Drive and Downloads — including a file in a cloud folder that must be materialised first | `File.pickFileAsync` is mocked | A file that cannot be selected at all; a picker that returns before the file is local |
| 2 | **Double-tap "Choose your export"** | Review #9: `pick()` has no press guard where `start()` does | Two pickers, or a spinner that never leaves `Reading your export` |
| 3 | **"How do I export?" from inside Settings** | Settings is a modal and the sheet is a `<Modal>` | The 2026-09-10 freeze: a screen that goes dead after the sheet closes |
| 4 | **The founder's real export, end to end** | The only archive that is genuinely real | Counts on the preview matching the summary |
| 5 | **A large export** (the generated 10,000-film fixture) | 22 pages; the read is synchronous | A spinner that never paints; "Part n of m" going backwards |
| 6 | **Leave the app mid-import, come back after it finishes** | The fix for review #4 is new and unproven on a device | The summary should be waiting, with *Import another file* on it |
| 7 | **Airplane mode during the upload, then "Start over", then a different archive** | The fix for review #5 is new | The second archive must not arrive with the first's films |
| 8 | **The Settings row and the payoff sentence** | — | Row present under Account; sentence on *Your First Five*, not during the ranking |

### What staging cannot show you

- **The TMDB tier.** `provider_ready: false` — staging has no `functions.base_url` and no
  vault service key (push is in the same state). Unmatched films will settle as unmatched
  rather than being looked up. Set both if the provider tier needs exercising.
- **Anything about production.** Production has none of the five migrations, by design.

---

## 8. Deliberately not built

- **Lists.** Custom lists are out of scope for the first import (Contract V3 §11).
- **Reviews.** They are `user_media.note` in Bingd's model and are somebody's own writing;
  importing them was declined rather than deferred.
- **A repair screen.** Unresolved rows keep their names for one, and the summary reports
  the count, but the screen that lets somebody place them by hand is not built yet.
- **Re-import / merge.** A second import of a changed export is idempotent per row but has
  no reconciliation of removals.
