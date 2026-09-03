# Series watchlist invariant — production preflight and release plan

**Migration:** `supabase/migrations/20260906000100_a_series_you_have_finished_leaves.sql`
**Written:** 2026-09-03 · **Applied to PRODUCTION (`abheeqyjzekiowkztfxv`) 2026-09-03** from
`main` @ `a558088` via the step-5 path (`migration list` showed exactly the one pending
migration; `db push` applied it alone). Founder preflight and the post-apply re-run of the
same query both returned `watchlist_rows_deleted = 0, users_affected = 0,
series_affected = 0`; the backfill therefore removed nothing. `_leave_series_watchlist()`
and its three triggers are live, EXECUTE is revoked from `anon`/`authenticated`, no RLS
policy changed, no edge function deployed, staging untouched (still not a gate).

This is the one migration in PR #87. It adds `_leave_series_watchlist()`, three
triggers, and a backfill that **deletes** watchlist rows for series whose released
normal seasons are all already met. Because the backfill deletes user data, production
gets a read-only preflight first, and the founder approves the numbers before anything
is applied.

## Staging is not a gate for this migration

STAGING (`fjxhcbowoxuzulwirzyr`) stands at 53 of 103+ migrations with the known
lock-table / backlog problem ([release-lanes.md](./release-lanes.md) records it as the
first post-launch project). A `supabase db push` against staging would attempt the
entire outstanding backlog, turning this feature into the staging repair. So, for this
migration, **do not push to staging**, and do not edit staging's migration-history
table to fake the state. The staging repair stays a separate, explicitly scheduled
project.

Validation happens where it already happens for every migration: the test harness
replays the **complete** migration tree into an isolated local PostgreSQL for
`test:db`, and the concurrency suite runs the same tree on a real cluster with
independent connections. That is a full-schema environment at exactly the state
production will be in after the push.

## Release sequence

1. CI green on PR #87 (typecheck, lint, `test:db`, `test:race` — the same suites as
   local).
2. Merge PR #87 to `main`. **Merging deploys nothing.**
3. Run the read-only preflight below against PRODUCTION (`abheeqyjzekiowkztfxv`) and
   record the three counts in the PR or the decision log.
4. Founder reads the counts and explicitly approves the apply.
5. Apply the single migration through the normal path:

   ```
   supabase link --project-ref abheeqyjzekiowkztfxv
   supabase migration list        # exactly one pending: 20260906000100
   supabase db push               # applies only that one, in order
   ```

   `db push` applies only unapplied migrations; production is current through
   `20260905000100`, so exactly one file applies. If `migration list` shows anything
   other than the single pending `20260906000100`, stop.
6. Re-run the preflight afterwards: it must return zero rows — the same predicates
   drive the trigger, so any row that appears later is a new completion the trigger
   handles on its own.

No client change, no OTA, no build: the rule lives entirely in the database.

## The read-only preflight

Computes **exactly** the set the backfill's `delete ... using judged` would remove:
the `judged` CTE below is copied verbatim from the migration, and the
`released_seasons > 0 and unmet_seasons = 0` filter is the delete's own `where`
clause. If the migration's predicates ever change, this file must change in the same
commit — the two are the same query or the preflight is worthless.

Run it in the Supabase dashboard SQL editor on `abheeqyjzekiowkztfxv` (or `psql` on
the production connection string). It is a single `select`; it writes nothing.

```sql
with judged as (
  select w.user_id,
         w.media_item_id as series_id,
         count(s.id) as released_seasons,
         count(s.id) filter (
           where not exists (
                   select 1 from rankings r
                    where r.user_id = w.user_id
                      and r.media_item_id = s.id
                 )
             and not exists (
                   select 1 from user_media um
                    where um.user_id = w.user_id
                      and um.media_item_id = s.id
                      and (
                        um.bucket is not null
                        or um.watched_on is not null
                        or um.progress = 'completed'
                      )
                 )
         ) as unmet_seasons
    from watchlist w
    join media_items series
      on series.id = w.media_item_id
     and series.kind = 'series'
    join media_items s
      on s.parent_id = series.id
     and s.kind = 'season'
     and s.season_number > 0
     and s.release_date is not null
     and s.release_date <= current_date
   group by w.user_id, w.media_item_id
),
would_delete as (
  select * from judged
   where released_seasons > 0
     and unmet_seasons = 0
)
select (select count(*)                  from would_delete) as watchlist_rows_deleted,
       (select count(distinct user_id)   from would_delete) as users_affected,
       (select count(distinct series_id) from would_delete) as series_affected;
```

### Sample of affected series — catalogue data only

No user id, name, handle, note or watch date leaves the query; a series title plus
season counts identifies a show, not a person.

```sql
with judged as (
  -- identical CTE to the totals query above
  select w.user_id,
         w.media_item_id as series_id,
         count(s.id) as released_seasons,
         count(s.id) filter (
           where not exists (
                   select 1 from rankings r
                    where r.user_id = w.user_id
                      and r.media_item_id = s.id
                 )
             and not exists (
                   select 1 from user_media um
                    where um.user_id = w.user_id
                      and um.media_item_id = s.id
                      and (
                        um.bucket is not null
                        or um.watched_on is not null
                        or um.progress = 'completed'
                      )
                 )
         ) as unmet_seasons
    from watchlist w
    join media_items series
      on series.id = w.media_item_id
     and series.kind = 'series'
    join media_items s
      on s.parent_id = series.id
     and s.kind = 'season'
     and s.season_number > 0
     and s.release_date is not null
     and s.release_date <= current_date
   group by w.user_id, w.media_item_id
),
would_delete as (
  select * from judged
   where released_seasons > 0
     and unmet_seasons = 0
)
select wd.series_id                as media_item_id,
       mi.title,
       wd.released_seasons         as released_normal_seasons,
       wd.released_seasons - wd.unmet_seasons as met_seasons,   -- always equal here
       count(*)                    as watchlist_rows
  from would_delete wd
  join media_items mi on mi.id = wd.series_id
 group by wd.series_id, mi.title, wd.released_seasons, wd.unmet_seasons
 order by watchlist_rows desc, mi.title
 limit 25;
```

### One honest caveat

Both the preflight and the backfill evaluate `current_date` at their own run time. A
season whose `release_date` falls between the preflight and the apply moves a series
from "deleted" to "kept" (or completes one more show). The drift is only ever in that
direction-of-the-calendar sense, the predicates themselves cannot diverge, and step 6
closes the loop.
