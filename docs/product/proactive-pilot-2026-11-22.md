# Proactive notifications: audit and `watchlist_social` pilot (2026-11-22)

**Founder request, 2026-11-22:** finish the watchlist-related proactive notifications so that
`watchlist_social` can be piloted safely. `theatrical_release` and `watchlist_resurface` are
audited here and **not** activated. `season_premiere` and streaming availability stay
deferred.

**What this change is:** migration `20261130001100_a_friend_you_actually_talk_to` (applied to
**staging only**), its rollback (`docs/release/proactive-pilot/rollback-20261130001100.sql`), PGlite
tests (`supabase/tests/proactive-pilot.test.mjs`, `proactive-pilot-rollback.test.mjs`), and this
document. **No client change** (the shipped bundle already renders and routes every proactive
kind, §2) and **no edge-function deploy** (production's `push-sender` already carries the
proactive copy and the Expo `expiration`, §2).

**Nothing was written to production.** Every production number below comes from read-only
queries run as `supabase_read_only_user`, and only aggregates are recorded.

Companions: [`proactive-notifications.md`](./proactive-notifications.md) (the design),
[`notifications.md`](./notifications.md) (doctrine),
[`release-awareness.md`](./release-awareness.md),
[`../architecture/push.md`](../architecture/push.md),
[`../release/push-operations.md`](../release/push-operations.md) §12 (kill switch),
[`decision-log.md`](./decision-log.md) §6.

---

## 1. Audit, per type

Production state read on 2026-11-22: schema head `20261130001000` (214 migrations, the same as
`main` before this change), and every proactive function body identical to `main`'s (compared
by `md5`, ignoring carriage returns). All four proactive switches `false`; `proactive_candidates`
empty; no proactive notification rows. **`bingd-proactive-tick` is not scheduled** in production
(nor on staging): the active jobs are push-drain, release-evaluate, release-refresh, import,
ops-health and welcome-dispatch.

✅ implemented · ⚠️ implemented with a gap · ❌ missing · ➖ not applicable

| | `watchlist_social` | `theatrical_release` | `watchlist_resurface` | `season_premiere` |
|---|---|---|---|---|
| **Trigger** | ✅ after-insert trigger on `feed_events` (`title_ranked`/`title_logged`; nothing writes `title_logged` today), written now, not during an import, not more than a day old | ✅ release-awareness T-7 arming (`evaluation = done`), collected by the tick for 48 h after arming | ✅ the tick, per reader inside their evening window with budget to spare | ✅ a `released` season event confirmed in the last 48 h, collected by the tick |
| **Qualification** | ⚠️→✅ before this change: **mutual follow alone** (affinity only ordered clusters). Now: mutual follow, viewable, active, not watched, **and affinity strictly above `proactive.friend_min_affinity` (1.5)**, see §3 | ✅ watchlisted, active, not watched, US or unknown region | ✅ deterministic pick (friends, trending, recent, age saved); push-only | ✅ saved series or season, or caught up on the previous normal season; **plus an operator-written US availability verification, which nothing writes** |
| **Aggregation** | ✅ one cluster and one inbox row per (reader, title, fixed 7-day window); push-eligible at the 2nd distinct qualifying friend | ➖ one per (reader, release) | ➖ one title per reader per evening | ➖ one per (reader, season release) |
| **Scheduling** | ⚠️ arbitration needs `bingd-proactive-tick`, **not scheduled in production** (runbook step P4) | ⚠️ same; also its collector only runs inside the tick | ⚠️ same | ⚠️ same |
| **Caps** | ✅ shared: 1 per local day, 2 per rolling 7 days, type cooldown 72 h, title cooldown 7 days; one-per-day enforced by a partial unique index | ✅ shared | ✅ shared, plus 7-day resurfacing cooldown and 72 h quiet | ✅ shared; a season and its series share the title cooldown |
| **Window / quiet hours** | ✅ 17:00–20:00 reader-local; unknown timezone means no push; claimed late means dropped ("tonight or not at all"); Expo `expiration` from `deliver_by` | ✅ same; never on or after the opening day | ✅ same; expires at tonight's window close | ✅ same |
| **Dedup** | ✅ ledger unique `(recipient, type, dedupe_key)`; one push per cluster ever (`sent` stays `sent`); at-most-once claim | ✅ once ever per (reader, release) | ✅ once per local date | ✅ once per (reader, release) |
| **Preference gate** | ✅ `watchlist_discovery` (default on) at creation (muted means untouched), selection and claim; muting closes open windows | ✅ same category | ✅ same category | ✅ same category |
| **Type switch** | ⚠️→✅ before: none of its own (`generation_enabled` started social **and** theatrical). Now `proactive.social_enabled` (seeded false), re-checked at selection and claim | ⚠️→✅ before: none of its own. Now `proactive.theatrical_enabled` (seeded false), re-checked at selection and claim | ✅ `proactive.resurface_enabled` (false) | ✅ `proactive.season_enabled` (false) |
| **Per-recipient pilot scope** | ❌→✅ now `proactive.pilot_recipients` (seeded `[]`), §4 | ✅ same allowlist applies | ✅ same | ✅ same |
| **Client-version gate** | ✅ per token: `proactive_version >= proactive.min_client_version` (2) at selection and claim; reactive unaffected | ✅ | ✅ | ✅ |
| **Push eligibility** | ✅ not in `_push_eligible`; only the arbiter writes its `push_outbox` row; kill switch `proactive.push_enabled` | ✅ | ✅ (hidden carrier row at selection) | ✅ |
| **Deep link** | ✅ title page (`/title/<id>`), push and inbox | ✅ title page | ✅ title page (push only) | ✅ the season's page |
| **Blast risk if switched on today** | low (§5), and now allowlisted | first tick collects everything armed in the last 48 h (today: 0) | **synchronised**: every reachable reader the first evening (today: 3) | 0 without verification rows |

### What was missing for `watchlist_social`, and what this change does about it

| Gap | Before | Now |
|---|---|---|
| Meaningful affinity | mutual follow qualified a friend | a friend counts only above 1.5 (§3) |
| Type isolation | `generation_enabled` also started theatrical | `social_enabled` and `theatrical_enabled`, both seeded false |
| Pilot scoping | none | `pilot_recipients` allowlist, enforced in the trigger, at the ledger's door and at selection/claim |
| No backfill | already true by construction | verified and pinned by tests (§6) |
| Kill switch / rollback | `push_enabled`; forward-only rollback described | unchanged, plus `social_enabled` stops social at the claim; a rehearsed rollback script (§9) |
| Write-path fan-out (B2) | the trigger walks every mutual watchlister inside the ranking transaction | **pilot-bounded only**: the trigger considers listed readers only. Moving it off the write path is still required before a general rollout (§8) |

## 2. Can the production client render and route each kind?

The production bundle is the OTA from `main` at `0aa2677e` (the coordinator's read). The code on
that commit:

| | `watchlist_social` | `theatrical_release` | `watchlist_resurface` | `season_premiere` |
|---|---|---|---|---|
| Inbox kind known (`KINDS`) | ✅ | ✅ | ➖ never returned (`my_notifications` excludes it) | ✅ |
| Inbox copy (`use-notifications.ts`, pinned by `proactive-copy.test.ts`) | ✅ `clusterPhrase`: "Ravi and Eric", "Ravi, Eric and 1 other"; row drawn only when `cluster_count > 0` | ✅ `opensPhrase`: "Opens Fri, May 16" / "Opened May 16" | ➖ | ✅ `availablePhrase`, `premiereName` |
| Inbox tap (`targetFor`) | ✅ title | ✅ title | ➖ | ✅ season |
| Push tap (`pushDestination`, `routing.test.ts`) | ✅ `/title/<id>` (`kind` + `mediaItemId`); no `mediaItemId` falls back to the inbox | ✅ | ✅ | ✅ |
| Version reported | `PROACTIVE_CLIENT_VERSION = 2`, sent with `register_device_token` once per process | | | |

Production `push-sender` is **version 6, deployed 2026-11-12**. Its deployed bundle (read through
the Management API, read-only) contains the proactive copy (`watchersPhrase`, "watched it. It’s
on your Watchlist", the resurfacing lines) and `expirationFor` / `deliver_by`. **No deploy is
needed for the pilot.**

**Devices in production (live tokens, aggregates):** iOS: 1 token at version 2, 8 at null
(8 accounts); Android: 2 at version 2 (2 accounts), 12 at null (3 accounts). **3 accounts hold a
capable token**, all with a known timezone and region US. A null token is a build that predates
proactive kinds, or one not relaunched since its OTA: it gets no proactive push, and reactive
push is unchanged.

**OS permission.** The client registers a token only when the OS reports `granted`
(`use-push.ts`), so a reader who never granted permission has no token and the arbiter holds the
candidate `no_device`: **inbox row only**. A reader who granted and later turned notifications off
in OS Settings keeps a live token (the server cannot see that); the push is handed to Expo and
the OS does not show it. The inbox row is there either way. This is the same for reactive push
and is not changed here.

## 3. "Meaningful social affinity": what it was, what it is now

**Before:** `watchlist_social` qualified a friend on **mutual follow alone**.
`_proactive_affinity` (20261031000100; 0 for blocked or inactive pairs since 20261112000100) only
ordered competing clusters and chose which two names to show. That is what
`proactive-notifications.md` §K warned about ("keep this off in production until B2"), and it
**did not match** the approved doctrine.

**Now:** a friend counts toward a reader's cluster only while
`_proactive_affinity(reader, friend, now) > proactive.friend_min_affinity`, seeded **1.5**:

- **Why 1.5.** The score's structure makes it the floor that means something (§R.1): a mutual
  follow is 0.5, the reactions family caps at 1, and reactions earn no reciprocity bonus, so
  mutual follow plus any amount of reacting is **at most 1.5**. Strictly above it there is always
  a comment on their activity, a reply, an active mention, a delivered recommendation or a
  co-watch inside the 90-day, 30-day-half-life window. A block or an inactive account is 0.
  One comment by the reader on the friend's activity today scores 2.5 and qualifies for about
  20 days on its own.
- **Where it is applied.** In the trigger (a non-qualifying friend writes nothing: no cluster,
  no inbox row, no member) and in `_proactive_social_actors`, the one authority for cluster
  membership. So the threshold count, the arbiter's and the claim's revalidation, the names and
  count in the push, and the inbox row all agree; a friend whose affinity decays below it drops
  out the way an unfollow does.
- **Fail closed.** A value that is not a JSON number qualifies nobody.
- **Doctrine check:** mutual follow required ✅; mutual follow alone never enough ✅; reactions
  alone never enough ✅; two distinct qualifying friends inside the fixed 7-day window ✅;
  aggregated, one inbox row per (reader, title, window) ✅; privacy, blocks, preference, client
  version, caps, quiet hours, 17–20 h window ✅; never generic "someone you follow ranked
  something" (only titles on the reader's own Watchlist) ✅.

**Distribution** (computed inline with the function's own SQL, because the read-only role cannot
execute definer functions; aggregates only):

| | directed mutual pairs | mean | p50 | p75 | p90 | > 0.5 | > 1.5 | ≥ 2 | ≥ 3 |
|---|---|---|---|---|---|---|---|---|---|
| Production | 82 | 1.82 | 0.59 | 1.88 | 3.55 | 53.7% | **30.5%** | 22.0% | 18.3% |
| Staging | 24 | 2.38 | 1.10 | 2.32 | 5.79 | 79.2% | 25.0% | 25.0% | 25.0% |

## 4. The pilot allowlist

`proactive.pilot_recipients`, a JSON array of account ids, seeded `[]`.

- **Empty (or absent):** no restriction, the behaviour before this change. **Emptying it is a
  general rollout**, which is not approved.
- **Non-empty:** only listed readers can get a proactive candidate, inbox row or push, of any
  type. Enforced three times: the social trigger's reader query (so a ranking's fan-out during the
  pilot is the allowlist, not every watchlister of the title); a `BEFORE INSERT` trigger on
  `proactive_candidates` that drops any other recipient whoever writes (each collector reads a
  dropped row as "already decided" and writes no inbox row); and `_proactive_invalid`
  (`outside_pilot`), so anybody taken off the list is suppressed at selection and dropped at the
  claim.
- **Fail closed:** a string, an object, JSON null, or any element that is not a uuid string
  allows nobody.
- `proactive_status()` reports `pilot: {restricted, recipients}` as a count, never an id.

## 5. Production volume estimate (read-only, 2026-11-22, aggregates only)

Scale: 53 active profiles, 41 mutual pairs, 810 Watchlist rows.

**`watchlist_social`**, replaying the last 30 and 7 days of ranking activity against today's
Watchlists, follows, blocks and preferences (readers who have since watched a title are
excluded, so these are slight underestimates):

| | 30 days | 7 days |
|---|---|---|
| ranking events by active accounts | 482 | 85 |
| (friend ranking × reader's saved title) hits, mutual follow only (the old rule) | 36 | 11 |
| inbox rows the old rule would write | 31 | 8 |
| push-eligible clusters, old rule (≥ 2 friends in the window) | 4 | 2 |
| hits with a qualifying friend (affinity > 1.5, scored today) | 16 | 7 |
| **inbox rows, new rule** | **14** | **5** |
| **push-eligible clusters, new rule** | **1** | **1** |
| distinct readers, new rule | 3 | — |
| most inbox rows for one reader in 7 days, new rule | — | 3 |

Of those readers, 3 hold a capable token. **The first tick after enablement sends nothing**
(§6), so there is no backlog to blast. With an allowlist of one account the ceiling is that
account's share of the numbers above, under 1 push a day and 2 a week.

**`theatrical_release`** (not activated): armed in the last 48 hours: **0 events, so 0 inbox rows
and 0 candidates on its first tick.** Armed in the last 30 days: 2 events, 4 (reader, release)
pairs. 3 US theatrical releases are scheduled in the next 30 days.

**`watchlist_resurface`** (not activated): **3 readers** are reachable today (capable token,
timezone, a Watchlist, preference on), so up to 3 pushes the first evening it is turned on with
push, and one more each time a device reports version 2 (8 accounts have a timezone and a
Watchlist). This is the synchronised wave §K warns about.

**`season_premiere`** (deferred): **0** operator verification rows, so 0, although 5 season
releases were confirmed in the last 48 hours.

## 6. No backfill, and the first tick

- The social trigger sees a `feed_events` row only at the moment it is inserted, and only while
  `generation_enabled`, `social_enabled` **and** (during the pilot) the allowlist let it. A
  ranking made before the switch is never re-read: there is no job that scans past activity.
- A row dated more than a day back (a repair, a backfill, a consolidation) is ignored; the split
  and consolidation tools insert only `ranking_batch` / `watchlist_added` rows, which never
  qualify; imports post nothing.
- So a cluster counts from the first qualifying ranking **after** enablement, inside the
  existing fixed 7-day window evaluated forward. The first tick finds no social candidate.
- The theatrical collector would look back 48 hours on its first tick, which is why it now has
  its own switch and stays off.

Pinned by `proactive-pilot.test.mjs` ("activity from before the switch never joins, and the
first tick after it sends nothing").

## 7. Staging end-to-end (2026-11-22)

**Applied:** `20261130001100` to staging (`fjxhcbowoxuzulwirzyr`) in one transaction with its
`supabase_migrations.schema_migrations` row (`statements` is the whole file, as for the previous
staging applies; md5 of the stored statement equals the file's). A rolled-back dry run first.
Staging already had `20261201000100` (#322) applied, so this version sits below its head there.
Staging switches afterwards: all off, `pilot_recipients` `[]`, threshold 1.5.

**Validated** with `docs/release/proactive-pilot/staging-e2e-20261122.sql`, which runs entirely
inside **one transaction that rolls back**: 15 disposable accounts (`@example.invalid`), four
disposable titles, the switches turned on inside the transaction only, the real triggers, the
arbiter at a computed evening instant and `claim_push_batch`. The live drain never saw any of it.
Each app ranking is its own transaction, so the script clears the per-transaction marker before
each ranking insert.

| Check | Result |
|---|---|
| Affinity | commented-on friend qualifies; mutual-only no; reactions only no (score exactly 1.5); blocked pair no |
| 1st qualifying friend ranks a saved title | 1 candidate `pending / below_threshold`, 1 actorless inbox row |
| 2nd qualifying friend | candidate eligible; still 1 inbox row per title; `my_notifications` returns it unread with `cluster_count` 2 and 2 named actors |
| Non-qualifying actors (mutual-only, reactions-only, a friend who blocked the reader, a private account the reader is not approved to follow) | 0 cluster members recorded for any of them |
| Watchlist & discovery off | 0 candidates, 0 inbox rows |
| Not on the allowlist | 0 candidates, 0 inbox rows |
| 20:30 UTC (quiet hours) | every eligible candidate held `quiet_window` (old client `client_unsupported`, no device `no_device`) |
| 17:30 UTC | one selected per capable reader; outbox row = the selected notification |
| Daily cap | the reader's second eligible cluster held `higher_priority_selected`, then `daily_cap` after the push |
| Claim (payload) | 1 job, `type` / `proactive.type` `watchlist_social`, `media_item_id` = the saved title, `actor_count` 2, 2 names, `deliver_by` = 20:00 local that evening, **1 token: the capable phone, never the old build** |
| After the claim | candidate `sent`, `actor_count_at_send` 2 |
| Dedup | a third friend after the push: no new job, cluster shows 3, inbox rows unchanged |
| Old client only | held `client_unsupported`; no outbox row |
| No device (permission never granted) | held `no_device`; inbox row present; no outbox row |
| Kill switch with a selected candidate | claim returns nothing; candidate `suppressed / kill_switch` |
| Cleanup | after rollback: 0 candidates, 0 outbox rows, 0 test profiles, users or titles, 0 social rows; switches as before |

**Navigation** is the client's and is pinned by `routing.test.ts`: a push with
`kind: watchlist_social` and `mediaItemId` opens `/title/<id>`; the inbox row opens the title.
The push body comes from production's `push-sender` (`watchersPhrase`), Deno-tested in CI.

## 8. Not done, and what must not be skipped

- **General rollout is not ready.** The social trigger still runs inside the ranking
  transaction; outside a pilot it walks every mutual watchlister and computes one affinity each.
  B2's "off the write path" remains. The allowlist bounds it for the pilot.
- **Affinity cost at scale is unmeasured.** Production is tiny (41 mutual pairs). `my_notifications`
  now computes affinity per cluster member it draws.
- **A ranking that joins a pilot reader's cluster stays standalone in the Feed.** A cluster member
  is a reference to the ranking post, and referenced posts are never hidden behind a group
  (`_unpresent_on_reference`, 20261128000100). Cosmetic, bounded by the allowlist.
- **OS permission turned off after registration** still yields a token (§2).
- **Theatrical, resurfacing and seasons stay off.** Nothing in the runbook touches them.

## 9. Pilot runbook (for the coordinator; do NOT run without the founder's approval)

`<FOUNDER_UUID>` is a placeholder for the id the coordinator holds privately. Every statement
below is for the production SQL editor (role `postgres`). **Nothing here has been run in
production.**

### P0. Ship the migration

1. Merge this PR (founder approval).
2. Production `npx supabase db push --linked --dry-run`: it must list exactly
   `20261130001100_a_friend_you_actually_talk_to.sql`. If `20261201000100` (#322) reached
   production first, the CLI asks for `--include-all`; the dry run must still list only this
   file. Then push without `--dry-run`.
   Until it is applied and recorded (`node scripts/production-migrations.mjs`), the production
   OTA gate (`scripts/ota-gate.mjs`) refuses to publish from any commit that contains it, as for
   every migration.
3. Verify it is inert:

```sql
select version from supabase_migrations.schema_migrations where version = '20261130001100';
select proactive_status() - 'tick' - 'job';
-- expect: generation/push/social/theatrical/resurface/season all false,
--         friend_min_affinity 1.5, pilot {restricted: false, recipients: 0}, candidates {}
```

### P1. Preflight the pilot account (read-only)

```sql
select (select status from profiles where id = '<FOUNDER_UUID>')                          as status,
       (select timezone is not null from account_context where user_id = '<FOUNDER_UUID>') as has_timezone,
       (select count(*) from device_tokens
         where user_id = '<FOUNDER_UUID>' and revoked_at is null
           and coalesce(proactive_version, 0) >= 2)                                         as capable_tokens,
       _notifies('<FOUNDER_UUID>', 'watchlist_discovery')                                  as preference_on,
       (select count(*) from watchlist where user_id = '<FOUNDER_UUID>')                    as watchlist_titles,
       (select count(*) from follows f
         where f.follower_id = '<FOUNDER_UUID>' and f.state = 'approved'
           and exists (select 1 from follows b where b.follower_id = f.followee_id
                        and b.followee_id = f.follower_id and b.state = 'approved')
           and _proactive_friend_qualifies('<FOUNDER_UUID>', f.followee_id, now()))         as qualifying_friends;
```

`capable_tokens` 0 means relaunch the app on a current build first (the token reports version 2
on its next launch). `qualifying_friends` below 2 means no push can ever form.

### P2. Enable generation for the allowlist only (one transaction, allowlist first)

```sql
begin;
update app_config set value = '["<FOUNDER_UUID>"]'::jsonb where key = 'proactive.pilot_recipients';
update app_config set value = 'true'::jsonb where key = 'proactive.social_enabled';
update app_config set value = 'true'::jsonb where key = 'proactive.generation_enabled';
do $check$
declare s jsonb := proactive_status();
begin
  if not (s -> 'pilot' ->> 'restricted')::boolean or (s -> 'pilot' ->> 'recipients')::int <> 1
     or (s ->> 'theatrical_enabled')::boolean or (s ->> 'resurface_enabled')::boolean
     or (s ->> 'season_enabled')::boolean or (s ->> 'friend_min_affinity')::numeric < 1.5 then
    raise exception 'pilot preconditions not met: %', s - 'tick' - 'job' - 'candidates';
  end if;
end;
$check$;
commit;
```

From here a qualifying friend's ranking of a title on the pilot account's Watchlist writes the
inbox row; nothing is pushed yet (`push_enabled` is still false), and nothing is arbitrated until
the tick is scheduled.

### P3. Observe inbox-only (a few days)

Use the monitoring queries (P6). Expect only the pilot account, only `watchlist_social`.

### P4. Schedule the tick, then enable push

```sql
select schedule_proactive_notifications();       -- installs bingd-proactive-tick, every 15 min
select jobname, schedule, active from cron.job where jobname = 'bingd-proactive-tick';
update app_config set value = 'true'::jsonb where key = 'proactive.push_enabled';
select proactive_status() - 'tick' - 'candidates';
```

`push_enabled` is global, but only allowlisted readers can have a candidate, and theatrical,
resurfacing and seasons create nothing while their switches are off. Reactive push reads none of
this.

### P5. Leave alone

`proactive.theatrical_enabled`, `proactive.resurface_enabled`, `proactive.season_enabled`: false.
`proactive.friend_min_affinity`: 1.5 (never below). `proactive.pilot_recipients`: never `[]`
while generation is on.

### P6. Monitoring (aggregates only)

```sql
-- Health and switches.
select proactive_status() - 'candidates';
select push_drain_status();

-- Volume by type, state and reason.
select type, state, reason, candidates, recipients, sent from proactive_summary order by type, state;

-- Per day.
select date_trunc('day', created_at) as day, type, state, count(*) as n, count(distinct recipient_id) as readers
  from proactive_candidates group by 1, 2, 3 order by 1 desc, 2, 3;

-- Must be 0: anybody outside the allowlist, or any type but social.
select count(*) filter (where not _proactive_pilot_allows(recipient_id)) as outside_pilot,
       count(*) filter (where type <> 'watchlist_social')                as other_types
  from proactive_candidates;

-- Must be 0: duplicates (more than one push a local day; more than one push per title in 7 days;
-- more than one inbox row per candidate).
select count(*) from (select recipient_id, selected_local_date from proactive_candidates
                       where state in ('selected', 'sent') group by 1, 2 having count(*) > 1) d;
select count(*) from (select a.id from proactive_candidates a join proactive_candidates b
                        on b.recipient_id = a.recipient_id and b.media_item_id = a.media_item_id
                       and b.id <> a.id and b.sent_at between a.sent_at and a.sent_at + interval '7 days'
                     where a.sent_at is not null) d;
select count(*) from (select (payload ->> 'candidate_id') from notifications
                       where type = 'watchlist_social' group by 1 having count(*) > 1) d;

-- Delivery failures (push_outbox rows of proactive notifications; a delivered row is deleted).
select o.state, o.attempts, o.failures, left(o.last_error, 120) as last_error, count(*)
  from push_outbox o join proactive_candidates c on c.notification_id = o.notification_id
 group by 1, 2, 3, 4;

-- Handed over, opened, acted on (observational).
select * from proactive_attribution;

-- Tick duration (keep well under the app role's statement timeout).
select status, count(*), max(end_time - start_time) as longest
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname = 'bingd-proactive-tick' and d.start_time > now() - interval '1 day'
 group by 1;
```

`sent` means handed to `push-sender`, not delivered (`proactive-notifications.md` §M).

### P7. Kill switch

```sql
-- Stop proactive pushes now (queued jobs dropped at the next drain, within a minute):
update app_config set value = 'false'::jsonb where key = 'proactive.push_enabled';
-- Also stop social entirely (selected clusters dropped at the claim as social_disabled):
update app_config set value = 'false'::jsonb where key = 'proactive.social_enabled';
-- Verify:
select proactive_status() -> 'push_enabled', proactive_status() -> 'social_enabled';
select count(*) from push_outbox o join proactive_candidates c on c.notification_id = o.notification_id;  -- 0 within a minute
select push_drain_status() -> 'healthy';   -- reactive unaffected
```

### P8. Rollback

**Configuration** (back to today's state), in this order, one transaction:

```sql
begin;
update app_config set value = 'false'::jsonb where key in
  ('proactive.push_enabled', 'proactive.social_enabled', 'proactive.generation_enabled');
update app_config set value = '[]'::jsonb where key = 'proactive.pilot_recipients';
commit;
select unschedule_proactive_notifications();   -- optional: pending candidates expire on their own clocks
```

Never clear the allowlist before generation is off: an empty list with generation on is a
general rollout.

**Schema**, only if the founder decides the migration itself must go: with
`proactive.generation_enabled` and `proactive.push_enabled` both false (the script refuses
otherwise: the restored functions drop the gates that hold existing candidates), run
`docs/release/proactive-pilot/rollback-20261130001100.sql`, and in the same transaction delete
the `supabase_migrations.schema_migrations` row for `20261130001100`. It restores the five
rebuilt functions verbatim, drops the helpers, the ledger trigger and the four settings, keeps the
reasons vocabulary (rows carry its new words) and deletes no data. Rehearsed by
`supabase/tests/proactive-pilot-rollback.test.mjs`.
