# Release awareness: design

**Status:** v1 DECIDED by the founder, 2026-09-19. **SHADOW tranche built**: migrations
`20260930000100` and `20260930000200` plus the `tmdb-adapter` `release-refresh` action.
Release data refreshes and candidate decisions are recorded. **Real proactive sending is
OFF and cannot be switched on without a new migration.** See [§S](#s-the-shadow-tranche-as-built).
**Audited against:** `origin/main` @ `c77d524` (149 migrations), and re-checked at
`28aee9a` before the migrations were numbered.
**Extends:** [`notifications.md`](./notifications.md), the canonical doctrine. This document
is the build plan for three rows it holds as DEFERRED: `watchlist_release_day`, "New season
of a series you ranked", and `watchlist_now_streaming`.

---

## Founder decisions (2026-09-19). AUTHORITATIVE

These decisions override anything below that disagrees. The planning text (§A–§L) is kept
as the reasoning, and where it proposed something different it is marked **superseded**.

| # | Decision | What it means in the build |
|---|---|---|
| 1 | **v1 = both event types**: (A) new-season awareness and (B) watchlisted-movie **US theatrical** release. One release-state system for both. Streaming availability stays later. | `release_events.event_kind` ∈ `season_premiere`, `theatrical_release` (region `US`). New seasons are the higher-priority case: in arbitration, a caught-up premiere beats a film. |
| 2 | **Cap**: at most **2 proactive pushes per rolling 7 days**, at least **36 hours** apart. A release that loses the push to the cap **keeps its in-app event**. Push is delivery, not the source of truth. | The shadow ledger records such a row as `inbox_only`, with reason `global_cap` / `cap_spacing` / `lost_to_priority`. |
| 3 | **Series depth, explicit tiers, no numeric score.** **Tier A, caught up**: watched or ranked the most recently released prior season → inbox, and push-eligible under all normal gates. **Tier B, behind**: watched or ranked some season, but not the most recent prior one → **inbox only, never pushed in v1**. **No history** → no new-season notification at all. **Never auto-add** a new season to the Watchlist. | "Watched/ranked" is the series-watchlist rule's watch signal: a ranking, or a log with a bucket, a watch date, or `progress = 'completed'`. A season merely `watching` is not history. A Watchlist entry with no history is `no_history` (skipped); the shadow counts those accounts so the rule can be revisited with data. |
| 4 | **Kill switch**: real send **OFF**, shadow evaluation **ON**. The first production deployment must be **incapable** of sending a proactive push, even when it detects a release. Real sending needs a later explicit founder approval after the shadow review. | Structural, not just a setting: no release function writes `notifications` or `push_outbox`, and neither release type is in `_push_eligible`. `release.push_enabled = false` is recorded on every decision and acted on by nothing. Tests prove both. |
| 5 | **Send window 10:00–20:00** in the account's local time. **Unknown timezone** → the in-app event may be recorded, **no proactive push**. Never guess a timezone from server location. | `account_context.timezone` (IANA, validated) from the device. Missing → `inbox_only / no_timezone`. |

**Migration range reserved:** `20260930000100` onward. Existing migrations are never edited.

---

## A. Recommended v1 scope

**Build in v1:**

| # | Event | Who | Why v1 |
|---|---|---|---|
| A | **New season premiere** (`season_premiere`) | Has watched or ranked an earlier normal season of the series, or saved the series or that season | Highest-signal event the product can know. The interest is already recorded in `rankings` / `user_media`, so nobody has to opt in. |
| B | **Watchlist movie in theaters** (`theatrical_release`) | The movie is on their Watchlist, and their device region has a TMDB wide-theatrical date | It uses the same pipeline. The TMDB request that detail already makes returns the data, so it costs no extra requests. Volume is low: 6 watchlisted movies in production have a future date today. |

**Defer:**

| # | Event | Why not v1 |
|---|---|---|
| C | Watchlist movie **streaming** | You need a stored snapshot of availability to spot a *change*, and none exists: `watch-providers` is read live and never stored. The JustWatch data flaps, so you'd also need a stability rule. Attributing JustWatch data on a lock screen is an open terms question. v1 lays the groundwork (region capture, per-region events, the `digital_date` field), so C becomes an add-on and not a redesign. |
| — | Announcement or date-change pushes ("Season 3 dated for March") | These are countdown-shaped. v1 shows the date passively on the title page and sends no notification. |
| — | Passive "Out now for you" shelf | Good follow-up (v1.1). The inbox already covers people without push. |

**Product rules this plan holds to:** TV stays season-level. No episode tracking, no
next-episode reminders, no calendar tab, no countdowns. **One notification per release,
per person, ever.**

**Ship order inside v1:** A and B share every table and function, and each has its own
mode switch. A goes first through the shadow period, B follows.

---

## B. Current-system audit

### B1. Release dates in the catalogue: present, but frozen when first cached

| Fact | Where | Consequence |
|---|---|---|
| `media_items.release_date` holds the TMDB **primary** date for a movie (often a festival premiere), `first_air_date` for a series, and the season `air_date` for a season | `supabase/functions/tmdb-adapter/normalize.ts` (`fromMovieDetail`, `fromSeriesDetail`, `seasonsOf`, `fromSeasonDetail`) | A movie's primary date is not a theatrical date. Season air dates **are** stored; notifications.md §6 says "`tmdb_upsert_seasons` does not write them today", which is wrong. It does, via `seasonsOf`. |
| Every upsert runs `release_date = coalesce(excluded, old)` | `20260815000000` (titles), `20260820000400` (seasons, latest body) | If a date goes back to TBD, it can **never be cleared**. A date change overwrites the old one with no history. You can't build "date changed" or "TBD" on `media_items`. |
| The movie detail already appends `release_dates`, but `certificationOf` reads the US certification and **discards the per-country release events** (type 1 Premiere, 2 Limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV) | `tmdb.ts` `movieDetail`, `normalize.ts` `certificationOf` | You get theatrical and digital dates **per region** for no extra request. The normalizer just has to keep them. |
| `TmdbSeriesDetail` doesn't declare `status`, `in_production`, `next_episode_to_air`, `last_episode_to_air` or `number_of_seasons`, and neither detail type declares a movie `status` | `tmdb.ts` types | The fields that say "returning / ended / canceled" and "what's next" are in the response and dropped at the type boundary. |
| No region on any catalogue date. `CERTIFICATION_REGION = 'US'` and `language=en-US` are hardcoded | `normalize.ts`, `tmdb.ts` | Theatrical events must be keyed per region. |
| No concept of "unreleased" anywhere in the client. Nothing stops a future season from being logged or ranked | grep of `src/`, `app/` | A title page for an upcoming season has nothing to say. See G5. |

### B2. Refresh: nothing keeps a future date current

| Mechanism | What it does | Useful for releases? |
|---|---|---|
| Client re-read of a series whose season list is older than 7 days (`SEASON_LIST_MAX_AGE_MS`, `src/features/title/use-enrichment.ts`) | Re-fetches series detail **when somebody opens the series page** | No. It's driven by demand. In production, series with watch history were last fetched a median of **11.4 days** ago (p90 **19.9**). |
| `refresh` adapter action → `media_refresh_due` (older than 150 days, referenced by a collection) | The PRD §19 retention refresh | No. Wrong cadence, and **nothing schedules it**. Only `npm run catalogue:enrich -- --refresh` runs it, by hand. |
| `hydrate-seasons` → `season_hydration_due` | A one-off walk to backfill `episode_count` | No. It's a repair tool, run by hand. |
| `_import_enrich_nudge()` on the `bingd-import-maintenance` pg_cron tick | **pg_cron → pg_net → `tmdb-adapter` (service_role, ids by name)**, fails soft, reports `unconfigured` | **Yes. This is the pattern to copy.** `20260917001400`. |
| `trending-refresh.yml`, `welcome-email.yml` (GitHub Actions cron) | Daily/hourly jobs | **Don't copy.** GitHub runs this repo's schedules **4.5 to 5.5 hours late** (welcome-email memory, measured 09-11..09-18). You can't time a release around that. |

### B3. Push and notifications: reusable almost entirely

| Piece | State | Reuse |
|---|---|---|
| `notifications` table (actorless rows allowed, `subject_type`/`subject_id`, `payload`) | LIVE | Yes. A release row is actorless like `award_earned`, with `subject_type='media_item'` pointing at the season or movie. |
| `_apply_notification_preference` BEFORE-insert gate. One preference axis: a switched-off category is never created | LIVE, latest body `20260917001500` | Yes. Add two categories. |
| `_push_eligible(type)`, the AFTER-insert `_enqueue_push` → `push_outbox` (PK = notification_id) | LIVE, latest `20260917001500` | Yes, but release types are **deliberately left out of `_push_eligible`**. The arbiter (F) enqueues them directly into `push_outbox`, so the push waits for a local send window and the cap. `claim_push_batch` doesn't re-check eligibility. |
| `claim_push_batch` already joins `subject_type='media_item'` → `media_title` + parent `series_title` | LIVE, latest `20260920000200` | Yes. The rebuild only adds two payload fields (`release_kind`, `release_on`). **SQL rebuild trap applies:** rebuild from `20260920000200`, then diff. |
| `push-sender` `copy.ts` (pure, tested) | LIVE, v6 on staging | Yes. Add two copy branches. The edge function deploy is **not in any release path** (edge-function-deploy-gap). |
| pg_cron `bingd-push-drain`, every minute | LIVE | Yes, unchanged. |
| `push.delivery_enabled` kill switch | **Not on main.** PR #119 / `20260911000200` is still unmerged; the `_push_delivery_enabled` symbol doesn't exist | Land #119 first, or at least decide on it. A release push is the first proactive push, and it's the one you might need to stop. |
| Client `hrefForPush` → `targetFor` | An unknown kind routes to `/settings/notifications` (the inbox) | New kinds need an OTA. See I (old clients). |
| Client inbox `KINDS.has(row.kind)` filter | Old clients **silently hide** unknown kinds | Safe to write rows before the OTA reaches everyone. |
| Notification settings: 3 sections, 8 toggles, `_notification_default` = on for all | LIVE | notifications.md §5 already plans a "Watching" section and the Social / Watching / Progress regroup "in the same change that adds the first Watching type". This is that change. |

### B4. What doesn't exist

- **The global proactive cap and suppression ledger.** Specified in notifications.md §7 ("PR C") and never built. The first proactive type has to ship with it.
- **A stored timezone.** The week streak reminder is blocked on the same thing (§4).
- **A stored region.** `src/lib/region.ts` reads the device locale for where-to-watch and never sends it to the server.
- **Analytics for a notification open** or attribution of a ranking to a notification (§8 says to decide this before the first proactive type).

Timezone and region can both come from `expo-localization` 57 (`getCalendars()[0].timeZone`,
`getLocales()[0].regionCode`). It's been in every binary since 2026-08-13, so capturing them
is **OTA-deliverable and doesn't move the fingerprint**.

### B5. User interest: where it lives

| Signal | Table | Notes |
|---|---|---|
| Ranked a season | `rankings` (category `tv_seasons`, `bucket`) | Strongest. |
| Logged a season | `user_media` (`bucket`, `watched_on`, `progress` ∈ `watching`/`completed`) | `_leave_series_watchlist` (`20260906000100`) already defines a "watch signal" as ranking OR bucket OR watched_on OR progress='completed'. Reuse that exact predicate, plus `progress='watching'`. |
| Saved a series, season or movie | `watchlist` (any `media_item_id`) | A series leaves the watchlist once every released season is met. So **"series on watchlist" can't be the TV signal**: finishing a show removes it. |
| Lists | `list_items` | Lists PRD: "no notifications". Excluded. |
| Recommendation received | `recommendations` | That was the sender's intent, not the reader's, and it already produced its own notification. Excluded. |

### B6. Production sizing (read-only aggregate query, 2026-09-19, `environment_name()='prod'`)

| | |
|---|---|
| Profiles | 40 |
| Users with a live push token | **11** (17 tokens) |
| `media_items` | 17,113 |
| Watchlist rows | 677 movie (663 distinct), 40 series, 6 season |
| Watchlisted movies with a **future** date | **6** (0 undated, 3 released in the last 60 days) |
| Series where someone has watched or ranked a season | **74**, across **10** users |
| …of which have a future or undated normal season in the catalogue | **8** |
| Notifications, last 7 days | 49 (follow 20, award 9, reaction 7, …) |

What this means: v1 volume will be a handful of notifications a month. The refresh budget
is tens of TMDB requests a day. Only about a quarter of accounts can receive a push, so
**the inbox row is the notification and the push is transport**, as the doctrine says.

---

## C. Data and state model

Three new catalogue-side tables, one generic notification ledger, and one per-account
context table. None of them are readable by other users.

### C1. `release_subjects`: what gets polled

One row per TMDB object that is polled. That's a **movie** or a **series** (seasons are
read through their series, as one request).

| Column | Purpose |
|---|---|
| `media_item_id` PK → media_items (movie or series) | |
| `tmdb_status` text | Series: `Returning Series` / `In Production` / `Planned` / `Pilot` / `Ended` / `Canceled`. Movie: `Rumored` / `Planned` / `In Production` / `Post Production` / `Released` / `Canceled`. Stored as TMDB's text, and the tier logic reads it. |
| `in_production` bool | Series only |
| `last_read_at`, `last_ok_at` | Last attempt and last success |
| `next_check_at` | Drives the poll queue (D2) |
| `failures` int | Consecutive failures, for backoff |

The rows are reconciled from the **interest view** (D1). They're never written from a
client.

### C2. `release_events`: the state machine

One row per **(media_item_id, event_kind, region)**:

| Column | Purpose |
|---|---|
| `id` uuid PK | |
| `media_item_id` → media_items | The **season** row for `season_premiere`, the **movie** row for `theatrical_release` |
| `event_kind` | `season_premiere` · `theatrical_release` (later: `digital_release`, `streaming_available`) |
| `region` text | `''` for `season_premiere` (TMDB season dates have no region). ISO-3166 for movie events |
| `state` | `announced` · `scheduled` · `released` · `withdrawn` (see below) |
| `scheduled_date` date null | The date as last observed. **Can be cleared**, unlike `media_items` |
| `date_first_seen_at` | When the *current* `scheduled_date` was first seen. Measures how stable a date is |
| `date_changes` int, `previous_date` date | Delay tracking |
| `released_on` date, `released_observed_at` timestamptz | Set at the transition |
| `fanout` | `none` · `pending` · `done` · `skipped_stale` · `skipped_off` |
| `last_observed_at` | The read that last touched this row |

`unique (media_item_id, event_kind, region)`. **This is event-level dedupe:** no matter how
many refreshes see "Season 3", there's one row.

**States:**

| State | Meaning | How you get here |
|---|---|---|
| `announced` | TMDB lists the object and has no date (TBD) | The season appears with a null `air_date`, or the region has no type-3 date; or a `scheduled` date was cleared |
| `scheduled` | A date in the future | A fresh read gives a date later than today |
| `released` | The date has been reached, confirmed by a fresh read | See the transition rule. **Terminal.** |
| `withdrawn` | Canceled, or removed from TMDB | Movie `status='Canceled'`; season gone from the list for 2 consecutive reads |

**The release transition (the one that notifies):**
`scheduled|announced → released` happens only when all of these are true:

1. **A read within the last 12 hours** (`last_observed_at ≥ p_now − 12h`) says the date is
   today or earlier. A stale read never releases anything.
2. The date has been reached: `p_now ≥ scheduled_date 00:00` at UTC+14. That's the earliest
   instant the date exists anywhere. Personal delivery is gated later, per local date (F4).
3. A sanity check passes: the series isn't `Canceled`, the movie isn't `Canceled`, the
   season is a normal season (`season_number > 0`), and the movie event is type 3 (wide).
   Type 2 (limited) never counts: "in theaters" to someone in Ohio about a two-city release
   is false.
4. **Freshness:** `released_on ≥ p_now::date − 7 days`. Otherwise the event still becomes
   `released`, but with `fanout='skipped_stale'`.

Rule 4 is what makes these safe: first-ever observation at go-live, a back catalogue that
TMDB adds late, season renumbering, and a series nobody polled until today. **An old date
never notifies.**

**`release_event_log`** is append-only: `(release_event_id, from_state, to_state, old_date,
new_date, observed_at, source)`. It's the audit trail for "date changed" and delay
analysis. It's also the anomaly counter for the shadow period (a `released` row whose date
later moves into the future).

### C3. `proactive_ledger`: dedupe, cap, suppression log, measurement (the §7 "PR C" table)

This is generic across every proactive type, now and later (`friend_watched_your_watchlist`
uses it unchanged).

| Column | Purpose |
|---|---|
| `id`, `user_id` → profiles, `type` | |
| `dedupe_key` text | For releases: `release_event.id`. `unique (user_id, type, dedupe_key)` means **once per person per event, ever** |
| `priority` smallint | For arbitration (F3) |
| `notification_id` → notifications, null | The inbox row, if one was written |
| `created_at`, `not_before`, `expires_at` | When the push may go (local send window, release instant) and when it stops being worth sending |
| `outcome` | `pending` · `pushed` · `inbox_only` · `suppressed` · `shadow` |
| `reason` | Doctrine vocabulary: `preference_off` · `global_cap` · `type_cooldown` · `duplicate` · `already_completed` · `stale` · `higher_priority_candidate_won` · `quiet_window` · plus `no_timezone`, `already_seen`, `no_device` |
| `decided_at`, `pushed_at` | The cap reads `pushed_at` over a rolling 7 days |

Rows are never deleted, except by the account cascade. This is the `comment_mentions`
pattern: a ledger row is permanent, so no re-run can ring twice.

### C4. `account_context`: timezone and region, owner-private

`(user_id PK, timezone text check ∈ pg_timezone_names, region text check ^[A-Z]{2}$,
reported_at)`. Written by `report_device_context(p_timezone, p_region)` (authenticated,
`assert_can_write`), called on session ready. **Not on `profiles`**: profiles are readable
by other people, and a timezone plus region is coarse location. It follows the
device-token rule (no read policy for other users).

### C5. What stays unchanged

`media_items` keeps its coalesce semantics. The release refresher still upserts titles and
seasons, so the catalogue gets fresher as a side effect. But **`release_events` is the
authority for release state**, and the title page reads it for "Premieres Mar 5".
(Optional clean-up, not required: let a detail-sourced season write clear a date. It's a
separate change with its own blast radius, because `_leave_series_watchlist` reads
`media_items.release_date`.)

---

## D. Hydration and update mechanism

### D1. Interest view (what's worth polling)

`release_interest` (a view, `security_invoker`, service_role reads):

- **Series:** any active profile has a watch signal (B5) on a normal season of it, or has
  the series or one of its seasons on the watchlist. **Plus** `tmdb_status` isn't
  `Ended`/`Canceled`, or the last check is more than 30 days old (a revival is rare but
  real).
- **Movies:** on any active profile's watchlist and `(release_date is null or release_date ≥
  current_date − 365)`. A festival premiere can come months before theatrical. A
  decades-old watchlisted film is never polled.

A daily reconciliation inserts `release_subjects` rows for new interest and lets
`next_check_at` age out for subjects that have dropped out. This view makes "seasons that
appear after the user originally ranked the series" work with no special case: the series
is polled because of *the user*, not because a future season was already known.

### D2. Cadence tiers (`next_check_at`)

| Subject | Condition | Next check |
|---|---|---|
| Series | Returning / In Production / Planned, with no dated future season | 3 days |
| Series | Next season dated more than 30 days out | 7 days |
| Series | Next season dated 2 to 30 days out | 1 day |
| Series | Within ±1 day of a season date, or a `scheduled` event past its date and not yet confirmed | **6 hours** |
| Series | Ended / Canceled | 30 days |
| Movie | No date in any interested region, or more than 60 days out | 7 days |
| Movie | 2 to 60 days out | 1 day |
| Movie | Within ±1 day of an interested region's date | **6 hours** |
| Movie | Every interested region released more than 14 days ago | Leaves the set (C re-admits it) |
| Any | Read failed | Backoff 1h → 3h → 12h → 24h, capped; `failures` shown in status |

The ±1-day tier gives at least two fresh reads around every release date. That's what rule
1 of the transition needs, and it catches a delay announced on the day.

**Horizon:** there's no look-ahead limit. Anything in the interest set is polled, and
distance only picks the cadence. A season announced two years out costs one request a week.

**Budget:** today, about 74/3 + 8 + 6 ≈ **40 requests a day**. At 100× the users, a few
thousand a day, well under TMDB's per-second limit. If it ever matters, TMDB's `/tv/changes`
and `/movie/changes` (IDs changed in a window) can move stable subjects to a change-driven
check. That isn't needed for v1.

### D3. The job

```
pg_cron 'bingd-release-refresh'  (hourly, :07)
  └─ _release_refresh_nudge()             same shape as _import_enrich_nudge
       ├─ reads release_poll_due (next_check_at ≤ now, ≤ 50 ids, oldest first)
       └─ pg_net POST tmdb-adapter {action:'release-refresh', ids:[…]}   service_role
             └─ adapter, per id:
                  series → GET /tv/{id}                          (no appends: lean)
                  movie  → GET /movie/{id}?append_to_response=release_dates
                  ├─ upsertTitles / upsertSeasons (catalogue stays fresh)
                  └─ rpc release_observe(observation jsonb)     ← all state logic is SQL
pg_cron 'bingd-release-fanout'   (every 15 min)
  └─ _release_fanout(now())         pending events → ledger + inbox rows   (pure SQL)
pg_cron 'bingd-proactive-arbiter' (every 15 min)
  └─ _proactive_arbiter(now())      window + cap → push_outbox             (pure SQL)
pg_cron 'bingd-push-drain' (existing, every minute) → push-sender → Expo
```

**The adapter only fetches and normalizes. SQL owns every transition.** This follows the
split AD-8 already uses ("the function speaks HTTP, the database holds the writes"), and
it's the thing that makes D and F testable against a fixed clock.

**The observation payload** (normalized in `normalize.ts`, pure, Deno-tested):

```
series: { media_item_id, status, in_production, read_at,
          seasons: [{ season_number, air_date|null, episode_count|null }],
          next_episode: { season_number, episode_number, air_date } | null }
movie:  { media_item_id, status, primary_date|null, read_at,
          regions: [{ region, theatrical: date|null /*type 3 min*/,
                      limited: date|null /*type 2*/, digital: date|null /*type 4*/ }] }
```

`digital` is kept and ignored in v1. It's free, and C and a future "rent it now" read it.

`regions` is filtered to the regions that watchlisting users have reported (C4), so the
payload stays small.

### D4. Delays, TBD, same-day changes

| Case | Behaviour |
|---|---|
| Date moves later before release | `scheduled_date` updated, `date_changes++`, logged. **No notification.** The title page shows the new date. |
| Date moves earlier | Same, and the cadence tier re-derives, so a date pulled into ±1 day gets 6-hour checks. |
| Date cleared (TBD) | `scheduled → announced`, `scheduled_date = null`, logged. |
| Same-day change (morning read says today, afternoon read says +7) | If the transition hasn't fired, it can't: rule 1 needs the *latest* read to say ≤ today. If it already fired, it's terminal. The log records the anomaly, `released_on` stays, and no second notification is possible (C2 unique + C3 unique). The 6-hour tier plus rule 1 makes this window a few hours wide. |
| Released, then TMDB moves the date into the future (data correction) | An anomaly transition is logged. The event stays `released` and the delivered notification stands. **The shadow period (J) measures how often this happens before anything goes live.** |
| Movie re-release (an anniversary run adds a new type-3 date) | Events are terminal per (movie, kind, region), and the earliest type-3 date wins. A re-release can't reopen one. Old films aren't polled anyway (D1). |
| Season renumbered, or TMDB splits one season into "Part 1 / Part 2" | A new `season_number` with a fresh date is a new event, which is correct. One with an old date is `skipped_stale` (rule 4). |

---

## E. Eligibility: exactly who cares

Computed in `_release_fanout` **at release time**, from the tables as they are then. Not
from any snapshot taken when the event was first seen.

### E1. `season_premiere` for season N of series S

**As decided (decision 3), and as built in `_release_fanout_event`.** "Watched" means a
ranking, or a `user_media` row with a `bucket`, a `watched_on` date, or `progress =
'completed'`. That's exactly `_leave_series_watchlist`'s watch signal. The prior season
P is the highest normal season below N.

| Tier | Condition | In-app event | Push |
|---|---|---|---|
| **caught_up** | watched P | yes | eligible, subject to preference, timezone, window, cap |
| **behind** | watched some season below N, not P | yes | **never in v1** (`inbox_only / behind_tier`) |
| **no_history** | watched no season below N (a Watchlist entry or a season `watching` alone doesn't count) | no | no (`skipped / no_history`) |

**Also skipped:** anyone already touching season N (logged or in progress:
`already_watched`); preference off (`preference_off`); suspended accounts (not evaluated at
all).

*Superseded:* the planning text had the Watchlist as a trigger and "behind" as low-priority
push-eligible. It also had a `not_for_me` exclusion; that is deferred, and the shadow's
`behind` / `caught_up` counts are the data to decide it with.

Not a signal: browsing, searching, opening the title page, trending, similar-taste users,
lists, recommendations received.

### E2. `theatrical_release` for movie M in region R

**As built (R = US in v1).** Watchlist only, on an active account.

| Account region | Outcome |
|---|---|
| `US` | push-eligible, subject to preference, timezone, window, cap |
| unknown | **in-app event only** (`inbox_only / region_unknown`). The date isn't claimed to be theirs, so it isn't pushed. |
| another country | skipped (`region_mismatch`). A US date isn't their date. |

Also skipped: a watch signal on M (`already_watched`), preference off. Only a TMDB **type 3**
(wide theatrical) US date makes a release. A limited run (type 2), a premiere or a digital
date never does.

### E3. Explicit non-goals

No "Recommendation received" trigger, no List membership, no series-level "you might like"
trigger. Each one is a weaker signal than the ones above, and each is how a release push
turns into marketing.

---

## F. Dedupe and caps

### F1. Three layers of dedupe, each one sufficient on its own

1. **Event:** `release_events unique (media_item_id, event_kind, region)`, plus `released`
   is terminal and `fanout` moves `pending → done` once. However many refreshes run, there's
   one event and one fan-out.
2. **Person × event:** `proactive_ledger unique (user_id, type, dedupe_key)`. Fan-out does
   `insert … on conflict do nothing` and **writes the inbox row only if its own ledger insert
   won**. This is what makes concurrent fan-outs safe; it needs a race test (J4).
3. **Push:** `push_outbox` PK = `notification_id`, so a notification can be queued once.

**Belt and braces:** a partial unique index `notifications (recipient_id, type, subject_id)
where type in ('season_premiere','theatrical_release')`. It's cheap, and `block()` never
deletes actorless rows.

### F2. The global proactive cap (notifications.md §7, as written)

- **At most 2 proactive pushes per rolling 7 days** per person, and **at least 36 hours
  between them**. Read from `proactive_ledger.pushed_at`.
- Class A (direct social) is exempt and isn't counted.
- The cap limits **pushes, not inbox rows.** A release that loses to the cap still gets its
  inbox row. The information isn't lost, only the interruption. This keeps the doctrine's
  "losers are dropped, not queued": the *push* is dropped, and the fact stays where the
  reader already looks.

### F3. Arbitration (deterministic, no model)

Among one person's `pending` candidates that are inside their send window:

1. P1 (time-sensitive: releases, and later the streak) before P2 (friend moments) before P3
   before P4.
2. Within P1: `season_premiere/caught_up` > `theatrical_release` > `season_premiere/behind`.
3. Then the more recent `released_on`, then the lower `id`. That makes the order total.

The winner gets pushed. The rest **stay pending until they expire**, so tomorrow's window
can take the next one if the cap allows. When they expire they settle as `inbox_only` with
`higher_priority_candidate_won` / `global_cap` / `stale`. `expires_at` is at most 48 hours
after the release instant, and that's where the doctrine's "no stale nudges" is enforced.

### F4. When a push may go: the local send window and quiet hours

`not_before` = the later of:

- 10:00 local time on the release date. The date is the regional date for movies, and the
  TMDB date for seasons, never earlier than that date's 00:00 in America/Los_Angeles, so a
  US premiere is never announced to Asia the evening before it airs.
- The arbiter's window: **10:00 to 20:00 in the person's `account_context.timezone`.**
  Nothing outside it. These are quiet hours, and they aren't configurable in v1.

**Unknown timezone means inbox only (`no_timezone`).** That's deliberate, and it's also
the old-client gate (I1): only a build that can route the new kinds reports a timezone.

**Already seen:** if the inbox row's `read_at` is set before the window opens, the push is
skipped (`already_seen`). They already know.

### F5. Preferences by type

Handled by the one existing axis (§4 of push.md). An off category means the before-insert
trigger drops the row, and fan-out checks `_notifies()` first so the ledger records
`preference_off`. See H.

### F6. Postponement after notification, and re-release

A person is notified at most once per event, for good. A later correction doesn't produce
a "sorry, delayed" message in v1. A re-release can't reopen a terminal event. How often a
date moves after release is measured in shadow before launch (J5). If it's material, the
answer is a stricter rule 1 (two reads, 6 hours apart), not a correction push.

---

## G. In-app UX

### G1. Copy

The lock screen already shows "bingd". The push title is the **title's name**, as with
every title push.

| Event | Push, sent on the release date | Push, sent the next day (still inside the expiry) | Inbox row |
|---|---|---|---|
| `season_premiere` | **Severance**<br>Season 3 premieres today. | **Severance**<br>Season 3 is out now. | **New season** · Severance, Season 3<br>*Premieres today* / *Premiered Sep 19* · You watched Season 2 |
| `theatrical_release` | **Dune: Part Three**<br>In theaters today. It's on your Watchlist. | **Dune: Part Three**<br>Now in theaters. It's on your Watchlist. | **In theaters** · Dune: Part Three<br>*Opened Dec 18* · On your Watchlist |

Rules behind the copy:

- **The day, not the hour.** TMDB dates are dates. "Premieres today" is true for a streaming
  drop at 00:00 PT and for a 9pm broadcast. "Is out now" at 10am isn't true for the
  broadcast, so it's only used from the next day.
- **The inbox renders its date line from `released_on` at render time,** so a row read three
  days later still says something true.
- **No availability claims.** Never "streaming on Netflix" (§6). Never "in theaters near
  you". The region match is the whole claim.
- **The reason line** ("You watched Season 2" / "On your Watchlist") goes in the inbox
  always, and in the push only for the Watchlist, which is a benign fact the reader chose.
  A lock screen doesn't list someone's viewing history. That extends `copy.ts`'s privacy
  rule, it doesn't bend it.
- **No emoji in the push** (the `invite_welcome` / award rule).
- **Brand in plain text** where it appears ("bingd", no period), per the brand memory.

### G2. Tap destination

| Event | Route | Why |
|---|---|---|
| `season_premiere` | `/title/<season id>` | The season page already has season-specific where-to-watch (with no series fallback, by design), Episodes, and the watchlist control. The notification promised Season 3, so it opens Season 3. |
| `theatrical_release` | `/title/<movie id>` | Same, through the existing `targetFor → 'title'`. |

No new route. `hrefForPush` gets the kind through the existing `mediaItemId` field.

### G3. Auto-add to the Watchlist: **no** (agrees with the founder)

1. **The PRD already decided it.** On the series-watchlist rule (PRD §"terminating rule",
   2026-09-03): *"when the next season arrives, re-adding it is the same deliberate act it
   always was."*
2. **The Watchlist is the product's explicit-intent signal.** Machine-written rows would
   feed every future type that reads it (C, `friend_watched_your_watchlist`,
   `mutual_watchlist_match`) with intent nobody expressed. The spam would compound.
3. **It would fight `_leave_series_watchlist`.** That rule removes a finished series, and
   auto-add would put it back.

**Instead:** the destination page is where the reader decides. The existing watchlist
control is right there, one tap, and `watchlist_added` records `surface: 'notification'`.

### G4. A passive surface: yes, but in v1.1, not v1

A For You shelf, **"Out now for you"**: released in the last 21 days, eligible per E, not
yet logged. Read-only from `release_events` + the E predicates (one RPC), with no push. It
serves the 29 of 40 accounts with no push token, and anyone who turned push off. It's v1.1
because the inbox row already covers the same people for v1, and a shelf needs its own
design pass.

### G5. Title page: release state (small, v1)

- An **upcoming season or movie** shows a status line: "Premieres Mar 5, 2027" / "In
  theaters Dec 18" (region) / "Announced" (TBD), read from `release_events`.
- An upcoming season **doesn't offer Rank/Log.** That guard doesn't exist today (B1). It's
  the honest counterpart to announcing a release.
- The **series page** marks a season that came out in the last 14 days, which the reader
  hasn't logged, with a quiet "New" tag. That's display only.

---

## H. Preferences

Two new categories, both **default on** through `_notification_default`, which is already
true for every category. There's no backfill (§9). An account with no row gets the default.

| Category | Types | Toggle label |
|---|---|---|
| `new_seasons` | `season_premiere` | New seasons |
| `watchlist_releases` | `theatrical_release` (later `streaming_available`) | Watchlist releases |

Settings regroup, per notifications.md §5 and in the same change:

| Section | Toggles |
|---|---|
| **Social** | Follows · Follow accepted · Comments · Reactions · Watched with · Recommendations · Friend joined via invite |
| **Watching** | New seasons · Watchlist releases |
| **Progress** | bingd Awards |

That's 3 sections and 10 toggles, inside the guardrail. The existing categories keep their
keys, so only grouping and labels change. `follow_request` stays exempt.

No per-channel (inbox vs push) switch; one axis is preserved. Quiet hours aren't
user-configurable in v1.

---

## I. Failure modes

| # | Failure | Guard |
|---|---|---|
| 1 | **A stale cached date gives "out today" on the wrong day.** | Transition rule 1 (a read within the last 12 hours), the 6-hour tier around the date, and `release_events` owns the date instead of the coalesced `media_items`. |
| 2 | TMDB placeholder dates (`YYYY-12-31`, `YYYY-01-01` for "sometime that year") | A placeholder far out is harmless: it's polled weekly and can't release early. The title page shows only **month + year** for a date more than 90 days away. The shadow log shows how common placeholders are. |
| 3 | The primary movie date is a festival premiere | B keys on type 3 per region, never on `media_items.release_date` or `status='Released'` alone. |
| 4 | Limited release sent as "in theaters" | Type 2 never qualifies. |
| 5 | Back catalogue, renumbering, first observation at go-live | The 7-day freshness rule means `skipped_stale`. |
| 6 | **The refresh job dies quietly.** This is the push-drain lesson: 1,221 `succeeded` runs that did nothing. | `release_status()` returns `healthy`, `problems[]`, `oldest_due_age`, `last_ok_read_age` and `failures_by_subject`. The nudge **raises** when it has due work and is `unconfigured`, so cron records `failed`. An acceptance script works like `push-drain-acceptance.mjs`. |
| 7 | **The adapter action isn't deployed** (the edge-function deploy gap) | The nudge would get a `BG400 Unknown action`, and the status turns unhealthy on `last_ok_read_age`. The PR 2 release checklist includes `functions list` against the last commit. The migration that schedules the job applies **after** the function deploy. |
| 8 | pg_net or the Vault secret is missing | The same `unconfigured` branch as the import nudge, but it raises (6). |
| 9 | TMDB outage or 429 | Per-subject backoff. A failed read never transitions anything. |
| 10 | **Old clients** (iOS store binary, Android beta) | The inbox hides unknown kinds (safe). An unknown push tap routes to the inbox, where the row is invisible (bad). Pushes are gated on a known timezone, which only the new OTA reports, and the live flip happens after OTA adoption. |
| 11 | Unknown region | No theatrical event for that person (E2). |
| 12 | A mass fan-out for a popular show at scale | Fan-out is batched (`p_limit`) per 15-minute tick. Pushes spread naturally across timezones. |
| 13 | Blocked, suspended or deleted accounts | `active` profiles only. Actorless rows skip the block predicate. The account cascade removes everything. |
| 14 | A push leak or a copy bug after launch | `release.fanout_mode = 'off'` (event-level), `proactive.push_enabled = false` (push-level, inbox continues), and #119's `push.delivery_enabled` (everything). All three are `app_config` rows, so switching them needs no deploy. |
| 15 | A `claim_push_batch` rebuild regression, which breaks **every** push | Rebuild from `20260920000200`, mechanical diff, the existing 101 push tests plus new ones, and a staging push first. |
| 16 | DST and timezone arithmetic | IANA names are validated against `pg_timezone_names`. All times are `timestamptz`, and windows are computed with `p_now at time zone tz`. The tests cover DST transition days. |
| 17 | JustWatch or TMDB terms (future C and commerce) | Not triggered in v1. Pushes name no provider and carry no link. |

---

## J. QA: deterministic, and it never waits for a real release date

### J1. Principle: every function takes the clock

`release_observe(p_obs, p_now)`, `_release_fanout(p_now, p_limit)` and
`_proactive_arbiter(p_now)` are all internal and service_role only, and each defaults to
`now()`. Tests and operator scripts pass explicit instants. The state machine can't tell a
fixture from TMDB, because it only ever sees an observation. **There's no test mode.**
This is the welcome-email principle: the mechanism *is* the test surface.

### J2. Fixtures

- **Raw TMDB captures** (committed JSON, trimmed) for normalizer tests: a returning series
  with an undated next season; one with a dated one; one mid-premiere (`next_episode_to_air`
  = S3E1); an ended series; a canceled one; a movie with US type 3; one with only type 2; a
  festival-only premiere; a canceled movie; a placeholder `12-31` date.
- **Normalized observation builders** for SQL tests: `series({ seasons, status })`,
  `movie({ regions })`, and `at('2026-10-03T07:59:00Z')`.

### J3. Transition matrix (db tests, `supabase/tests/release-events.test.mjs`)

Every (state × observation) pair → (state, log row, fanout). Most importantly:

- `scheduled D` + a read at D−1 23:59 PT → stays `scheduled`.
- A read on D, within 12 hours → `released`, fanout `pending`.
- `scheduled D` with **no read since D−1** → stays `scheduled` (rule 1).
- A read on D says D+7 → `scheduled`, `date_changes=1`, no fanout.
- A date cleared → `announced`.
- First observation, season dated 30 days ago → `released`, `skipped_stale`.
- `released` then a read says a future date → anomaly logged, still `released`, no second fanout.
- A type-2-only movie → never `released` for theatrical.
- Season 0 → no event.
- A canceled series → `withdrawn`.
- Idempotence: the same observation applied twice gives an identical state and a single log row.

### J4. Fan-out, dedupe and cap (db tests plus races)

- **Eligibility table:** a caught-up ranker; a behind watcher; `progress='watching'`; series
  on watchlist only; the season itself on watchlist; `not_for_me` on every season → excluded;
  already watched season N → excluded; suspended → excluded; the preference off → a
  `preference_off` ledger row and **no** notification; movie region match / mismatch /
  unknown.
- **Dedupe:** fan-out run twice → one ledger row and one notification per person. Arbiter
  run twice → one `push_outbox` row.
- **Races** (`concurrency/races/release-fanout.mjs`, in the existing real-Postgres harness):
  two concurrent fan-outs of the same event, and a fan-out against a concurrent unwatchlist.
  Mutation-check it: remove the `on conflict` guard and the race must fail.
- **Cap:** 3 candidates in one week → 2 `pushed` at least 36 hours apart, and the third ends
  `inbox_only/global_cap`. Class A notifications in the same week don't count. Priority
  order per F3.
- **Window:** timezones `America/Los_Angeles`, `Asia/Kolkata`, `Pacific/Auckland`, unknown,
  and a DST-change Sunday. `not_before` holds at 09:59 and releases at 10:00. 20:01 → held
  until the next day. Expiry → `stale`.
- **`already_seen`:** mark the inbox row read before the window → no push.

### J5. Scheduled-job and pipeline tests

- The nudge: `idle` / `unconfigured` (raises when work is due) / `posted` / `failed` (never
  rolls back the tick). The same shape as the import nudge tests.
- `release_status()`: each `problems[]` string is produced by the state that should produce it.
- Normalizer (Deno, `normalize.test.ts`): each raw fixture → the expected observation;
  `release_dates` type selection; min date per type; region filtering.
- **Shadow period (production, 1 to 2 weeks, before anything is live):** refresh plus fan-out
  in `shadow` mode write the log and the ledger (`outcome='shadow'`) and no notification.
  Then read: every would-be notification, its date against reality for a sample, the anomaly
  count (released then moved), placeholder frequency, and how often the cap would bind. This
  is the **only** step that uses real dates, and it runs in the background while other work
  continues.

### J6. Push harness

- `push-sender/push.test.ts`: the copy for both types × both variants (today / later), null
  titles, a season with no series title.
- `claim_push_batch` db test: a release job carries `release_kind`/`release_on`, and every
  existing type's fields are unchanged (the 101 existing tests are the regression net).
- Client jest: `hrefForPush` for both kinds (valid / missing id → inbox), `sentenceFor` /
  `verbFor`, the settings sections coverage test (`SECTION_COVERAGE`), and `report_device_context`
  called once per session with the device values.

### J7. One-account manual QA (one session, staging preview app)

Operator script `release-qa.mjs`. **It refuses the production ref**, checking three ways:
the typed ref, the JWT `ref` claim, and `environment_name()`, like the welcome canary
scripts.

1. The founder, on the plum preview build, ranks Season 1 of a real series that has a
   Season 2, and watchlists one real movie.
2. The script confirms `account_context` has the phone's timezone and region, then injects:
   "Season 2 released today" and "movie in theaters today in <region>", both through
   `release_observe` with a synthetic observation (the same entry point the adapter uses).
3. It runs `_release_fanout(now())` then `_proactive_arbiter(now())`. Within about a minute:
   **one** push lands (the season, by priority), and **two** inbox rows appear.
4. Tap the push → the Season 2 page. Tap the movie inbox row → the movie page.
5. Re-run steps 2 and 3 → nothing new (dedupe on a device).
6. Toggle **Watching → New seasons** off. Inject another series → no row, and the ledger
   records `preference_off`.
7. Check the Settings regroup visually. Check the "Premieres …" line on an upcoming season.

Everything else (cap spacing, windows, DST, races) is covered by J3 to J6 and doesn't need a
phone. **Total manual rounds: one.**

---

## K. PR sequence

| PR | Contents | Surfaces | Visible effect |
|---|---|---|---|
| **0** (exists) | #119, the push kill switch. Founder confirms the initial state, then it lands. | migration | none |
| **1**: device context | `account_context` + `report_device_context` RPC; client calls it on session ready (timezone + region from `expo-localization`) | migration + **OTA** | none. **Ship early** so timezone and region data build up before the flip. |
| **2**: release data layer | Adapter `release-refresh` action + normalizer (fixtures, Deno tests); `release_subjects` / `release_events` / `release_event_log`; `release_interest` + `release_poll_due`; `release_observe`; nudge + pg_cron job; `release_status()` | **edge deploy first**, then migration | none. Observe-only in production from day one. |
| **3**: fan-out + ledger + arbiter | `proactive_ledger`; `_release_fanout`; `_proactive_arbiter` + cron; categories `new_seasons` / `watchlist_releases` in `_apply_notification_preference`; `claim_push_batch` rebuild (+2 fields); `push-sender` copy; `app_config` `release.fanout_mode` (per kind: `off`/`shadow`/`live`, seeded **`shadow`**), `proactive.push_enabled` | migration + **push-sender deploy** | none. Shadow ledger only. |
| **4**: client | New kinds in `NotificationKind` / `KINDS` / `ACTORLESS_KINDS` / `ROUTED_KINDS`; `sentenceFor` / `verbFor` / inbox row with a date line and reason; `targetChainFor`; Settings regroup + 2 toggles; title page release line + unreleased Rank/Log guard | **OTA** | Settings regroup, title-page status |
| **Flip** | `release.fanout_mode.season_premiere = 'live'`, after shadow review + J7 + OTA adoption. `theatrical_release` a week later. | `app_config` row, no deploy | Notifications begin |
| **5** (v1.1) | "Out now for you" shelf (one read RPC + For You component) | migration + OTA | new shelf |
| **6** (v2) | Streaming availability: `provider_snapshots (media_item_id, region, flatrate_ids, first_seen_at)`, diffed daily for watchlisted released movies, stable across 2 reads, `streaming_available` event kind | migration + edge + OTA | new type |

Dependencies: 1 ∥ 2. 3 needs 2 (it reads events), and 1 (timezone for the window). 4 is
independent of 3 at build time, but must be **adopted** before the flip.

---

## L. What can ride along vs what needs its own backend validation

| Piece | Bundle with another release? | Why |
|---|---|---|
| PR 1 client half (report timezone/region) | **Yes**, any routine OTA | It's additive, calls one RPC, and fails soft. The migration is additive (a new table and one RPC) and can go with any `db push`. |
| PR 4 client | **Yes**, any OTA | Inert until the flip. Unknown kinds only render once rows exist. The Settings regroup is the one visible change, so give it a line in that OTA's QA notes. |
| PR 2 | **No. Validate on its own.** | It's the first scheduled job that spends provider quota. It needs an edge deploy (not in any release path), and **days of real data** to show the refresh keeps dates current. It can't be judged in one QA session. |
| PR 3 | **No. Validate on its own.** | It rebuilds `claim_push_batch`, which **every push in the product** goes through. Apply it to staging first, with the push suites and a real staging push of an existing type, before production. Don't bundle it with any other `claim_push_batch` change. It needs a `push-sender` deploy ordered **after** the migration (the sender ignores fields it doesn't know, and no release job exists while it's in `shadow`). |
| The flip | An operator action, no deploy | Needs the shadow review (J5), a J7 pass, and OTA adoption confirmed. |
| PR 0 (#119) | Its own decision | A pending founder choice about the initial value of `push.delivery_enabled`. |

**No native build is needed for any of v1.** `expo-localization` and `expo-notifications` are
already in every binary, so the fingerprint doesn't move.

---

## Future commerce compatibility (§7 of the brief)

Nothing here builds monetisation. The architecture keeps it possible without rework:

- **Notifications never carry URLs.** A push or inbox row carries `media_item_id` + `event_kind`
  + `released_on`, and the **destination page** decides the call to action at render time.
  A ticketing or affiliate link added in 2027 works for notifications sent in 2026, and the
  notification pipeline never has to know about it.
- **Actions follow from event kind and region**, which `release_events` already keys:
  `theatrical_release` + region → a future "Get tickets" slot; `streaming_available` + region
  → "Open in <service>". The only legitimate link today is TMDB's watch-options page
  (`normalize.ts` `watchOptionsLink`). A per-service deep link or an affiliate link needs a
  partner agreement (JustWatch, or a ticketing partner), and the product must work with the
  slot empty.
- **Terms to check before any monetised call to action:** whether TMDB's API terms for
  commercial use change bingd's footing, and the JustWatch attribution rule for availability
  data. Neither applies to v1.
- **Attribution is ready:** `surface: 'notification'` on `watchlist_added` / `title_logged` /
  `ranking_completed`, plus the ledger's `notification_id`. That measures conversion now and
  would measure a click-through later with no schema change.

---

## Decisions for the founder: RESOLVED 2026-09-19

All five are answered in the [founder decisions](#founder-decisions-2026-09-19-authoritative)
table at the top. #119 (the global push kill switch) is independent of this tranche: release
awareness can't send whatever its state.

---

## S. The shadow tranche as built

### S1. What exists

| Piece | Where |
|---|---|
| Release state | `release_subjects` (what's polled), `release_events` (the state machine, unique per object/kind/region), `release_event_log` (append-only changes). Migration `20260930000100`. |
| Device context | `account_context` (timezone, region; no read policy) + `report_device_context(text, text)` (the only client-callable function in the tranche). |
| Observation | `release_observe(jsonb, timestamptz)`: every transition. `release_observe_failure`: backoff 1h/3h/12h/24h. |
| Refresh | `_release_reconcile` (explicit interest → subjects), `_release_refresh_tick` (posts due ids to `tmdb-adapter` `release-refresh` through pg_net, 2h lease, **raises** if it can't reach the adapter). |
| Shadow | `release_shadow_ledger` (one row per account per event, ever), `_release_fanout_event`, `_release_arbitrate`, `_release_evaluate`. Migration `20260930000200`. |
| Operator | `release_status()`, `release_shadow_summary`, `release_event_summary`, `schedule_release_awareness()`, `unschedule_release_awareness()`. |
| Adapter | `release-refresh` action (service_role, named ids only); `detail` offers its movie/series reads to `release_observe` (best-effort, tracked subjects only). `normalize.ts`: `regionalReleases`, `movieReleaseObservation`, `seriesReleaseObservation`. |

### S2. The transition rules, as implemented

- **Reached**: the date has begun somewhere, `p_now ≥ date 00:00 UTC − 14h`.
- **Released** only on a reached date **and** a TMDB read at most `release.freshness_hours`
  (12) old. A stale read updates dates but never releases.
- **Terminal**: a later move or clearing is logged as `moved_after_release` /
  `cleared_after_release`. It never re-opens evaluation.
- **Stale**: released more than `release.stale_after_days` (7) before it was first
  recorded → `skipped_stale`, never evaluated.
- **TBD** clears `scheduled_date` (→ `announced`). A later date is a `date_set`.
- **Canceled** series or film withdraws what hasn't aired. A revival restores it.
- The log is written only on a change, so an idempotent refresh writes nothing.

### S3. Schedule

`schedule_release_awareness()` installs `bingd-release-refresh` (`7 * * * *`) and
`bingd-release-evaluate` (`*/15 * * * *`). Cadence per subject (`_release_next_check`): 6h
within a day of a date (or past a date without a fresh read); 1 day if within 30 days
(series) or 60 days (film); 7 days beyond; 3 days for an undated returning series; 30 days
for an ended or canceled one.

### S4. Switches (`app_config`, operator-side)

| Key | Seeded | Effect |
|---|---|---|
| `release.refresh_enabled` | `true` | `false` stops the tick |
| `release.shadow_enabled` | `true` | `false` stops evaluation |
| `release.push_enabled` | **`false`** | recorded on each decision as `real_send_enabled`; **no code sends** |
| `release.freshness_hours` / `stale_after_days` | 12 / 7 | transition rules |
| `release.push_cap_per_week` / `push_min_gap_hours` | 2 / 36 | hypothetical cap |
| `release.window_start_hour` / `window_end_hour` | 10 / 20 | local send window |
| `release.push_expiry_hours` | 48 | how long a push candidate waits |
| `release.refresh_batch` | 40 | subjects per tick |

### S5. What to read after 7–14 days

```sql
select * from release_status();                 -- healthy, problems[], zero release notifications
select * from release_event_summary;            -- events by kind/state/evaluation, date changes
select * from release_shadow_summary order by event_kind, tier, outcome, reason;
select change, count(*) from release_event_log group by change;          -- incl. anomalies
select count(*) filter (where failures > 0), max(failures) from release_subjects;
```

The questions it answers: how many real releases were detected (by kind); how many
**would_push** vs **inbox_only** vs **skipped**, and why; the caught-up to behind ratio; how
often the **cap** binds; how many candidates lacked a **timezone** or **region** (a client
reporting gap); **anomalies**, meaning a date that moved after its release was recorded
(TMDB reliability); **date changes** before release (postponements); and read **failures**.
Spot-check a sample of `released` events against the real-world premiere or opening date
before real sending is proposed.

### S6. What is NOT built

Inbox rows, pushes, `_push_eligible` entries, preference categories in Settings, routing
and copy, streaming availability, ticket or affiliate links, auto-Watchlist, episodes,
calendar and countdown UI. All of it arrives after the shadow review and a founder
approval.
