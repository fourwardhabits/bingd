# The stopping-point production cutover

**Prepared 2026-09-23 overnight. Not executed. Every step below needs the founder awake.**

This is the procedure for putting Watch History + native Lists (#196) and the unified
Backlog + Refine ranking (#203) into production. It is written to be read top to bottom
while doing it: each phase has the exact command, what to expect, and the condition that
stops the cutover.

The numbers marked **baseline** were read from production at 05:40 UTC on 2026-09-23,
read-only. If a baseline no longer matches when you start, that is not automatically
wrong — people use the app overnight — but the *ratios* below must still hold.

---

## What production is today

| | |
| --- | --- |
| Project | `abheeqyjzekiowkztfxv` |
| Migrations applied | **155**, head `20261002000100` |
| Pending | **13** migrations, `20261003000100` … `20261019000100` |
| iOS on the App Store | 1.0.0 (7), runtime `971caf34`, from `ba14bd0` |
| iOS latest TestFlight | 1.0.1 (12), runtime `61efbf17`, from `89a1d8c` |
| Android on Play | 1.0.1, versionCode 12, runtime `da3c7f47`, from `6d2f845` |
| `goals.count_watch_events` | false (row does not exist until `20261006000100`) |
| `leaderboard.monthly_from_events` | false (same) |
| `ranking.backlog_enabled` | false (row does not exist until `20261019000100`) |
| `ranking.refine_enabled` | false (same) |

**Baseline counts (05:40 UTC):** `user_media` 1547 rows, 1369 with a bucket, **252** of
them `source = 'imported'` with a star-derived bucket; `rankings` 1106; `ranking_sessions`
1; `imported_titles` 826, **516** carrying a Letterboxd star.

---

## Read this before phase 1: who the step-9 OTA actually reaches

**Corrected 2026-09-23 07:20 UTC.** An earlier draft of this file said no runtime-compatible
production OTA could exist. That was computed **without the EAS environment**, which
truncates the fingerprint's source list and produces a hash that means nothing. Measured
properly — the four `EXPO_PUBLIC_*` values from `eas env:list production` exported first —
**both production runtimes are unchanged**:

| lane | runtime at this head | shipped binaries carrying it |
| --- | --- | --- |
| production / iOS | `61efbf17` (170 sources) | 1.0.1 builds 8–12 — **TestFlight only** |
| production / Android | `da3c7f47` (173 sources) | 1.0.1 vc11 and **vc12, which is what Play serves** |

So the step-9 OTA is real, and it is not the same event on the two platforms:

- **Android users get the release from the OTA.** Play serves vc12 on `da3c7f47`, and an
  update published from this head carries that runtime. It reaches them on the next
  foreground. This is the fastest path to Watch History, Lists and ranking for the Android
  audience, and it waits for no review.
- **iOS App Store users do not.** The App Store serves **1.0.0 (7)**, runtime `971caf34` — a
  different number, from before the 1.0.1 line began. Nothing published from here will ever
  reach it. Those users get the release when 1.0.1 (13) is approved.
- **iOS TestFlight users do**, because builds 8–12 are all on `61efbf17`.

Two consequences worth holding on to:

1. **The OTA comes after the migrations, never before.** It delivers a client that calls RPCs
   the live database does not have until phase 1 has run. The founder's order already does
   this; the reason is written here so nobody reorders it.
2. **Until it is published, every phone in the field keeps running its current bundle against
   the migrated schema.** That is safe by construction and it is asserted rather than assumed:
   `supabase/tests/legacy-client-compat.test.mjs` resolves the RPC surface of both shipped
   commits — `ba14bd0` (App Store 1.0.0) and `6d2f845` (Play vc12) — against the merged
   schema, and both pass.

## Phase 1 — the #196 migrations

**Apply from the repository root, with `db push`.** Never `db query` for a bundle of
migrations: a single rolled-back statement inside a multi-statement `db query` has
committed five migrations on staging before (see `db query is not atomic`).

```bash
# from the repo root, on the final main
npx supabase link --project-ref abheeqyjzekiowkztfxv
npx supabase migration list --linked        # confirm 155 applied, head 20261002000100
npx supabase db push --linked               # applies all 13
npx supabase migration list --linked        # expect 168 applied, head 20261019000100
```

This applies `20261019000100` (the ranking migration) as well. That is deliberate and
safe: every flag it inserts starts **false**, so it adds tables and functions that nothing
calls. Splitting the push to hold 019 back buys nothing and costs a second window.

### The `20261018000100` star-bucket report — before and after

This is the migration that deletes user-visible data, so it gets its own evidence. Run
this **before** the push and again **after**:

```sql
select (select count(*) from user_media)                                   as media_rows,
       (select count(*) from user_media where bucket is not null)          as buckets_total,
       (select count(*) from user_media
         where source = 'imported' and bucket is not null)                 as imported_with_bucket,
       (select count(*) from rankings)                                     as rankings_rows,
       (select count(*) from ranking_sessions)                             as sessions_rows,
       (select count(*) from imported_titles where rating is not null)     as stars_retained;
```

| | before (baseline) | after — required |
| --- | --- | --- |
| `media_rows` | 1547 | **1547**, unchanged. The backfill clears buckets; it deletes no rows. |
| `buckets_total` | 1369 | **1117** — exactly `1369 − 252`. |
| `imported_with_bucket` | 252 | **0**. |
| `rankings_rows` | 1106 | **1106**, unchanged. |
| `sessions_rows` | 1 | **1**, unchanged. |
| `stars_retained` | 516 | **516**, unchanged — the star is provenance and stays. |

### The four proofs

Run all four after the push. Each must return **0**.

```sql
-- 1. Zero ranked rows cleared: nothing with a ranking lost its bucket.
select count(*) from rankings r
  join user_media um on um.user_id = r.user_id and um.media_item_id = r.media_item_id
 where um.bucket is null;

-- 2. Zero placement-ledger rows improperly cleared: the ledger is append-only and the
--    backfill writes to user_media alone. Every ranking must still have its placements.
select count(*) from rankings r
 where not exists (select 1 from ranking_placements p
                    where p.user_id = r.user_id and p.media_item_id = r.media_item_id);

-- 3. Zero ranking-session rows improperly cleared.
select count(*) from ranking_sessions where false;   -- and compare sessions_rows above

-- 4. Raw Letterboxd star provenance retained: every cleared row still has its star.
select count(*) from user_media um
 where um.source = 'imported' and um.bucket is null
   and not exists (select 1 from imported_titles it
                    where it.user_id = um.user_id and it.media_item_id = um.media_item_id);
```

Proof 2 is the one to read carefully: `20261004000100` backfills a placement row for every
existing ranking, so after the push it is a statement about the backfill having run, not
only about nothing being deleted. If it returns non-zero, **stop** — the ledger is
incomplete and Watch History will misreport.

Proof 4 can legitimately return non-zero for rows imported from a source with no rating at
all. If it does, narrow it: `and exists (select 1 from imported_titles it where … and
it.rating is not null)` and require 0.

### The normal invariants

```sql
select assert_placements_valid();          -- all users
select assert_watch_history_valid();       -- all users
-- and per category for a handful of the heaviest accounts:
select assert_ranking_valid(u.id, 'movies') from (select id from profiles limit 20) u;
```

### Stop conditions for phase 1

Stop, do not proceed, and do not flip any flag if:

- `db push` reports a failure on any migration — **the push is transactional per
  migration, not per bundle**, so note the last version that applied and stop there;
- `buckets_total` fell by anything other than exactly `imported_with_bucket`;
- any of the four proofs returns non-zero;
- `rankings_rows` or `stars_retained` moved at all;
- any `assert_*` raises.

### Rollback

**There is no down-migration and you should not write one at 3am.** The recoverable part
is the bucket clear, and it is recoverable *because* the star is retained: the exact rows
cleared are reconstructable with `_legacy_star_bucket(imported_titles.rating)`. Take a
PITR restore point before the push (Supabase dashboard → Database → Backups) so the
option exists; use it only for a structural failure, never for a number you have not
finished reading.

---

## Phase 2 — the #196 flags

Both default false and both are read per call.

```sql
update app_config set value = 'true'::jsonb where key = 'goals.count_watch_events';
update app_config set value = 'true'::jsonb where key = 'leaderboard.monthly_from_events';
select key, value from app_config
 where key in ('goals.count_watch_events','leaderboard.monthly_from_events');
```

**Consider leaving both false until the new binaries are live.** They change what a goal
counts and how the monthly leaderboard is derived; with no client in the field that draws
the new surfaces, flipping them today only changes numbers the current client is already
showing. If you do flip them, phase 3's smoke must include a goal and the monthly board.

**Stop condition:** a goal total or a leaderboard position that moves by more than the
watch events explain. Set the flag back — it is a single `update` and takes effect on the
next call.

---

## Phase 3 — production smoke (current binary)

On a phone running the **store** build, not a preview:

- open Collection, Feed, a title page, and your profile — nothing empty that was full;
- log a title; confirm it appears with its score;
- rank two titles through a comparison and confirm the reveal;
- open the leaderboard and a goal.

**Stop condition:** any screen that fails to load, or any RPC error in Diagnostics. This
is the phase that would catch a legacy-client break the differential test missed.

---

## Phase 4 — the unified migration

Already applied in phase 1. Confirm it and read the config rows:

```sql
select version from supabase_migrations.schema_migrations
 where version = '20261019000100';

select key, value from app_config where key like 'ranking.%' order by key;
```

Expected, all inserted by the migration and all starting values rather than product
truths:

| key | value |
| --- | --- |
| `ranking.backlog_enabled` | `false` |
| `ranking.backlog_checkpoint` | `10` |
| `ranking.refine_enabled` | `false` |
| `ranking.refine_min_ranked` | `20` |
| `ranking.refine_min_priority` | `0.08` |
| `ranking.refine_cta_min_priority` | `0.25` |
| `ranking.refine_cta_min_candidates` | `3` |
| `ranking.refine_crossed_min` | `2` |
| `ranking.refine_resurface_placements` | `3` |
| `ranking.refine_daily_targets` | `30` |
| `ranking.refine_cooldown_days` | `30` |

**Stop condition:** any row missing, or any value that is not the above. The migration
uses `on conflict do nothing`, so a pre-existing row with a different value would survive
silently — which is exactly how staging ended up with `backlog_enabled = true` before
anybody meant it.

---

## Phases 5–8 — Backlog on, Refine after smoke

**Recommended flag order, and it is the founder's:**

```sql
-- 5. Backlog on.
update app_config set value = 'true'::jsonb  where key = 'ranking.backlog_enabled';
-- 6. Refine stays off. Assert it rather than assume it.
update app_config set value = 'false'::jsonb where key = 'ranking.refine_enabled';
```

**7. Backlog smoke** — on a binary that draws it, which means after the store builds are
out. Collection → Unranked shows a count and *Start ranking*; a sitting places titles;
**nothing appears in the Feed** (backlog placements are opened silently, and this is the
one to check deliberately); closing mid-comparison resumes.

```sql
-- 8. Refine on, only after 7 passes.
update app_config set value = 'true'::jsonb where key = 'ranking.refine_enabled';
```

**Stop conditions:** a backlog placement that posts to the Feed; a count that disagrees
with Unranked; a Refine card offered to an account with fewer than 20 ranked titles. Each
is one `update` away from off, and turning either flag off takes effect on the next call
— no deploy, no OTA.

---

## Phases 9–11

**9. The production OTA** — see the note at the top. Publish it only once the new store
binaries are live, with `node scripts/release.mjs update production --message "…"` (there is no
`npm run update:production` script — only preview and beta have one), from `main` or a
`release/*` branch with the release gate green on that exact commit.

**Check the runtime it prints.** `da3c7f47` for Android means it reached Play's vc12;
anything else means it reached nobody, and the cause is almost always a missing local
`EXPO_PUBLIC_*` (see the fingerprint note above) or `google-services.json`.

**10. Final smoke** — the phase 3 list again, plus Watch History on a rewatched title,
a list created and shared, and the Refine card appearing for an eligible account.

**11. Submit the store binaries** — both are built and waiting (see the morning report for
ids). Neither was submitted overnight, deliberately.

---

## The one decision left open

**The marketing version is still `1.0.1`.** It was chosen on 2026-09-08 for "correction
and polish on shipped surfaces", and this release adds Watch History, native Lists and a
whole ranking flow. 1.0.1 has never been released to the App Store, so it is still
submittable — but **1.1.0 is the honest number** for what this contains.

It was deliberately not changed overnight: the version string is in the fingerprint, so
moving it moves the production runtime and both binaries have to be rebuilt. That is
twenty minutes, and it is the founder's call, not a thing to decide while they sleep. If
you want 1.1.0: edit the one line in `app.config.ts`, rebuild both, and the build numbers
keep auto-incrementing from EAS.
