# Release awareness: the production shadow, and how to read it

**Live on production (`abheeqyjzekiowkztfxv`) since 2026-09-19T23:34:47Z.** Observation
window: **7 to 14 days**, so the review is due between **2026-09-26** and **2026-10-03**.

Nothing it decides is delivered. `release.push_enabled` is `false`, neither release type is
in `_push_eligible`, and no function writes `notifications` or `push_outbox`. Real sending
needs a new migration and a separate founder approval.

Product decisions and design: [`../product/release-awareness.md`](../product/release-awareness.md).
Doctrine and the proposed hierarchy: [`../product/notifications.md`](../product/notifications.md) §11.

---

## 1. What is running

| | |
|---|---|
| Migrations | `20260930000100`, `20260930000200`, `20260930000300` (production was 153/153 at install; it reached 154 on 2026-09-20 when another tranche's `20261001000100` landed, which touches nothing here) |
| Edge function | `tmdb-adapter` **v15**, byte-identical to merge `f15c72b` |
| Jobs | `bingd-release-refresh` (`7 * * * *`), `bingd-release-evaluate` (`*/15 * * * *`) |
| Policy | film awareness **T-7**, season awareness **release morning**, **no cap applied** (the former rules are recorded as a counterfactual), send window 10:00 to 20:00 local, unknown timezone means no push |

**One rule for reading it: aggregates only.** Every query below groups. Nobody looks at an
individual account's rows without a separate, explicit approval.

---

## 2. The readouts

```sql
-- Health first. `healthy` must be true and `problems` empty; the last two must stay 0.
select release_status();

-- Release events: how many were detected, in what state, and how they were evaluated.
select * from release_event_summary order by event_kind, state, evaluation;

-- The decision aggregate: would-push, in-app-only, skipped, by kind, timing, tier, reason,
-- with the former cap's counterfactual counted beside it.
select * from release_shadow_summary order by event_kind, timing, tier, outcome, reason;

-- Season timing: the policy in force against the measured alternative, in hours.
select * from release_timing_comparison;

-- Film notice length: how many days of warning each film awareness actually gave.
select days_to_release, count(*) as decisions, count(distinct release_event_id) as films
  from release_shadow_ledger
 where event_kind = 'theatrical_release'
 group by days_to_release order by days_to_release desc;

-- Caught up against behind, and what each outcome was.
select tier, outcome, reason, count(*) as decisions, count(distinct user_id) as accounts
  from release_shadow_ledger
 where event_kind = 'season_premiere'
 group by tier, outcome, reason order by tier, outcome;

-- The former cap, purely as a counterfactual: how often would it have bitten, and how.
select cap_reason, count(*) as would_have_been_suppressed, count(distinct user_id) as accounts
  from release_shadow_ledger
 where cap_would_suppress group by cap_reason;

-- Client reporting gaps: no timezone means no push, an unknown region means no film push.
select count(*) filter (where not timezone_known) as timezone_missing,
       count(*) filter (where region_status = 'unknown')  as region_unknown,
       count(*) filter (where region_status = 'mismatch') as region_mismatch,
       count(*) as decisions
  from release_shadow_ledger;

-- Dates that moved, and reads that arrived too late to be usable.
select change, count(*) from release_event_log group by change order by 2 desc;

-- Refresh health: failures, and anything the provider is not answering for.
select count(*) as subjects,
       count(*) filter (where failures > 0)  as failing,
       count(*) filter (where last_read_at < now() - interval '2 days') as stale_reads,
       max(failures) as worst
  from release_subjects;

-- The scheduler itself.
select j.jobname, d.status, count(*)
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname like 'bingd-release-%' and d.start_time > now() - interval '7 days'
 group by 1, 2 order by 1, 2;
```

---

## 3. Baseline at install (2026-09-19T23:34Z)

| | |
|---|---|
| Subjects | 127 (110 series, 17 films), all read, 0 failing |
| Events | 436: 386 season premieres `skipped_stale`, 21 films `skipped_late`, 21 `announced`, 7 `scheduled`, 1 season evaluated |
| Ledger | 1 decision: `skipped / no_history` (a Season 1, so nobody has prior history) |
| Would-push | 0 |
| Release notifications, outbox rows | **0 / 0** |

The `skipped_stale` and `skipped_late` counts are the catalogue's back history being seen
for the first time. They are recorded and can never be evaluated, which is the freshness
rule working; they should not grow much after the first day.

**The first real events to watch:**

| When | What |
|---|---|
| 2026-09-23 | *Survivor* Season 51 premieres: the first real season awareness |
| 2026-10-02 | First real film T-7 (*Your Mother Your Mother Your Mother*, opens 10-09) |
| 2026-10-30 | *Godzilla Minus Zero* T-7 (opens 11-06) |
| 2026-12-11 | *Dune: Part Three* and *Avengers: Doomsday* T-7 (both open 12-18) |

---

## 4. What the review decides

| Question | Reading | What it would change |
|---|---|---|
| Is the film notice the right length? | `days_to_release` spread | `release.movie_lead_days` |
| Is release morning right for seasons? | `release_timing_comparison`, plus how many plans land late in the local evening | the season timing, with the alternative already measured |
| Does a cap need to exist at all? | `cap_would_suppress` by reason and by account | keep uncapped, or add a soft cap or a digest for the lower band only (notifications.md §11) |
| Are we reaching anybody? | `timezone_missing`, `region_unknown` | the device-context hook rides in the first Android production binary (#179); these should fall as it reaches devices |
| Is TMDB reliable enough to announce a date? | `moved_after_release`, `date_changed` | the freshness rule, or the lead time |
| Is the refresh keeping up? | `failing`, `stale_reads`, cron `status` | cadence or batch size |

**Real sending stays off** until that review is written up and separately approved. Turning
it on is a new migration (inbox rows, push eligibility, copy, routing, preferences), not a
config flip.

---

## 5. Stopping it

```sql
select unschedule_release_awareness();   -- stops both jobs; nothing is lost
update app_config set value = 'false' where key = 'release.shadow_enabled';  -- stops evaluation
update app_config set value = 'false' where key = 'release.refresh_enabled'; -- stops the TMDB reads
```

Redeploying `tmdb-adapter` from a commit before `f15c72b` removes the `release-refresh`
action, which makes the tick raise and go red in `cron.job_run_details` rather than fail
quietly. The SQL is additive and inert with the jobs unscheduled.
