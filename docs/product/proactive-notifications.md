# Proactive notifications v1

**Status:** built on `feature/proactive-notifications`, **not applied anywhere**, 2026-10-28.
Migrations `20261028000100` (ledger, arbiter, kill switch, claim and inbox rebuilds, open
telemetry) and `20261028000200` (the three types, the tick, scheduling). Ships with **both
switches off**: `proactive.generation_enabled = false` (nothing is created) and
`proactive.push_enabled = false` (nothing is sent). Applying the migrations changes nothing
any reader can see.

**Authority:** founder decisions of 2026-10-28, recorded in
[`decision-log.md`](./decision-log.md) §6 "Proactive notifications v1". They supersede the
older rows they conflict with: the friend-activity exclusion (narrowed, not removed), the
"real release notifications" deferral (for watchlisted films only), and the scheduled nudge.

**Companions:** [`notifications.md`](./notifications.md) (doctrine and matrix) ·
[`release-awareness.md`](./release-awareness.md) (the release state machine this uses) ·
[`../architecture/push.md`](../architecture/push.md) ·
[`../release/push-operations.md`](../release/push-operations.md) §12 (the kill switch).

---

## A. What the founder decided

| | Decision | Built as |
|---|---|---|
| A | Watchlist-relevant friend activity is approved. Generic "your friend ranked something" stays excluded | `watchlist_social` |
| B | Theatrical release notifications for watchlisted films, US wide theatrical, T-7, under the existing freshness and date guards. No day-of follow-up | `theatrical_release`, driven by the release-awareness state machine |
| C | General Watchlist resurfacing, as a proactive engagement push | `watchlist_resurface`, push only |
| D | Streaming availability stays deferred | nothing built |
| E | Season-premiere delivery stays deferred | the shadow keeps running; no season row is written |
| F | No personalised or ML send time | a fixed 17:00–20:00 local window |
| G | Shared cross-type limits | one ledger, one arbiter |

## B. What does not change

Every reactive notification keeps its writer, its inbox visibility, its push eligibility
(`_push_eligible` is byte-for-byte the 20260917001500 list, pinned by a test), its
preference category and default, its deep link, its self-suppression and its import
suppression. The two functions every push and every inbox read go through were rebuilt
from their latest bodies with additions only:

- `claim_push_batch`: three additions (§K, §M); every reactive branch carried verbatim.
- `my_notifications`: two output columns and two filters (§G, §I); every join and rule
  carried verbatim.

Reactive notifications consume no proactive budget: the caps count only
`proactive_candidates` rows.

## C. Settings

Founder requirement: **5–10 visible notification controls in total.** One new section and
one new switch, default on, with no backfill, and **no section masters**.

**Before (`main`, rendered): 11 controls**

| # | Control | Writes |
|---|---|---|
| 1 | All Social notifications (master) | `follows, follow_accepted, comments, reactions, watch_tags` |
| 2 | Follows | `follows` |
| 3 | Follow accepted | `follow_accepted` |
| 4 | Comments | `comments` (also governs `mention`) |
| 5 | Reactions | `reactions` |
| 6 | Watched with | `watch_tags` |
| 7 | All Recommendations & invites notifications (master) | `recommendations, invites` |
| 8 | Recommendations | `recommendations` (also `recommendation_ranked`) |
| 9 | Friend joined via invite | `invites` (`invite_activated`, `invite_joined`) |
| 10 | All Achievement notifications (master) | `awards` |
| 11 | bingd Awards | `awards` (also `goal_completed`) |

**After (this branch, rendered): 9 switches + at most 1 button = 10 at most**

| # | Section | Control | Writes |
|---|---|---|---|
| 1 | Social | Follows | `follows` |
| 2 | Social | Follow accepted | `follow_accepted` |
| 3 | Social | Comments | `comments` |
| 4 | Social | Reactions | `reactions` |
| 5 | Social | Watched with | `watch_tags` |
| 6 | Recommendations & invites | Recommendations | `recommendations` |
| 7 | Recommendations & invites | Friend joined via invite | `invites` |
| 8 | Achievements | bingd Awards | `awards` |
| 9 | **Watching** | **Watchlist & discovery** | **`watchlist_discovery`** (new; all three proactive types) |
| (10) | top card | Turn on / Open Settings | OS permission only; shown only while push is off, one or the other, never both |

**Why removing the masters changes no behaviour.** A master was never stored. It read
"on" if any child was on and wrote its children in one call, so every preference it could
set is still set by the child switches, with the same keys and defaults. No category was
removed, merged or re-defaulted. Existing choices are untouched. `masterOn` and the bulk
writer `set_notification_preferences` stay in the code, undrawn. The rendered count is
asserted by a test (`getAllByRole('switch')` → 9).

**The global "Turn all off" is not built.** It would be the eleventh control. It needs the
settings regroup and is recorded as a follow-up (§V).

`watchlist_discovery` governs all three proactive types at creation, through the existing
before-insert gate: switched off, no inbox row is written and no push can follow (one
axis, as `push.md` §4 requires).

## D. Architecture, before and after

**Before.** Every push was a notification row whose type was in `_push_eligible`; the
after-insert trigger queued it, the drain sent it. Release awareness computed what it
*would* do in a shadow ledger and sent nothing.

**After.**

```
reactive writers ──▶ notifications ──(eligible type)──▶ push_outbox ──┐
                                                                      │
feed_events insert ─▶ _proactive_social_on_activity ─┐                │
release_events (T-7 armed) ─▶ _proactive_theatrical_collect ─┤        │
watchlist + signals ─▶ _proactive_resurface_collect ─┤                │
                                                     ▼                │
                                    proactive_candidates (ledger)     │
                                                     │                │
                              _proactive_arbitrate (every 15 min) ────┘  one per reader per tick
                                                     │
                       claim_push_batch ─ re-checks kill switch + validity, resolves copy
                                                     │
                               push-sender ─▶ Expo ─▶ APNs / FCM
tap ─▶ record_notification_open ─▶ notification_opens
```

Proactive types are **not** in `_push_eligible`, so the after-insert trigger never queues
one. The arbiter is the only writer of their outbox rows, which is what makes the budget
central rather than a convention every writer has to keep.

Push-only resurfacing still needs a notification row, because `push_outbox` is keyed on one
(that key is what makes a fabricated push unrepresentable). The arbiter writes a carrier
row of type `watchlist_resurface` **at selection time only**, and `my_notifications` never
returns that type. No reactive path changed to make room for it.

## E. The ledger

`proactive_candidates`, one row per `(recipient, type, dedupe_key)`, ever:

| Column | Meaning |
|---|---|
| `type` | `watchlist_social` · `theatrical_release` · `watchlist_resurface` |
| `dedupe_key` | release event id · `media@window-start` · local date |
| `media_item_id` | the title; also the title-cooldown key |
| `priority` | snapshot at creation (the arbiter reads the live config) |
| `state` | `pending` → `selected` → `sent`, or `suppressed` / `expired` |
| `notification_id` | the inbox row (or the hidden carrier) |
| `metadata` | ids and dates only: release event, opening date, resurfacing reason and score |
| `created_at` · `eligible_at` · `expires_at` · `window_ends_at` | lifecycle; `eligible_at` null while a social cluster is below threshold |
| `selected_at` · `selected_local_date` · `sent_at` · `decided_at` | outcome times |
| `suppression_reason` · `last_block_reason` | from one vocabulary, `_proactive_reasons()` |
| `actor_count_at_send` | social: how many people the push named |

```
            ┌──────────── invalid now ────────────┐
            │                                     ▼
 pending ───┼── held (window, cap, switch…) ──▶ pending ──(past expires_at)──▶ expired (reason = what held it)
            │
            └── best this tick ──▶ selected ──(claimed in time)──▶ sent (handed to push-sender)
                                      │
                                      ├──(claimed late: past expires_at, outside 17:00–20:00
                                      │   local, or a later local day)──▶ expired
                                      │   (expired / outside_window / no_timezone)
                                      └──(kill switch, no capable device, or invalid
                                          at claim)──▶ suppressed
```

**Tonight or not at all.** A selected candidate is re-judged when push-sender claims it
(`_proactive_claim_reason`, at the claim's clock). The claim **drops** it, ending it
`expired`, if any of these hold:

- it is past `expires_at` (reason `expired`);
- it is outside 17:00–20:00 in the reader's zone (`outside_window`);
- it is a later local day than the one it was selected for (`outside_window`), which
  covers a stalled drain recovering the next evening;
- the reader no longer has a timezone (`no_timezone`).

A stalled cron or sender that recovers the next morning therefore sends nothing late.
Reactive jobs in the same batch are untouched.

**A push dropped late consumes no budget.** The caps count only candidates that were
selected or handed over, and a dropped candidate is `expired` with no `sent_at`. The next
evening can use the day, and the week does not count it.

**At most once (founder decision, 2026-10-28).** One OS push at most per proactive
candidate. The first claim makes the candidate `sent`. Any later claim of the same outbox
row is dropped and the row deleted, whether it comes from an expired lease after a sender
crash or from a retry the sender asked for after a retryable failure. The candidate stays
`sent`. Reactive pushes keep their at-least-once retries exactly as before.

The trade, stated plainly:

- a sender that crashes before or around its Expo submission can **lose** that one
  proactive push;
- a duplicate proactive interruption **cannot** happen;
- `sent` never implies Expo accepted it or the phone showed it.

For an optional engagement push, losing one is the better failure.

**Concurrency, in three layers.** (1) The arbiter takes a per-recipient transaction
advisory lock before reading that reader's budget. (2) A partial unique index on
`(recipient_id, selected_local_date) where state in ('selected','sent')` makes a second
proactive push on one local day impossible, not merely unlikely. (3) `push_outbox`'s
primary key is the notification. The social writer has its own per-(reader, title)
advisory lock, so two friends finishing a film at once join one cluster. All three are
exercised by real-Postgres races (`concurrency/races/proactive-notifications.mjs`, PA1–3).

`proactive_cluster_actors` holds one row per qualifying activity, with that activity's
foreign key, so deleting the activity removes the membership. `notification_opens` holds
taps (§M).

## F. The budget, and who wins it

Read from `app_config`, all in one place:

| Key | Seed |
|---|---|
| `proactive.daily_cap` | 1 per recipient-local day |
| `proactive.weekly_cap` | 2 per rolling 7 days |
| `proactive.type_cooldown_hours` | 72 |
| `proactive.resurface_cooldown_days` | 7 |
| `proactive.title_cooldown_days` | 7 (across types) |
| `proactive.priority` | `{"theatrical_release":1,"watchlist_social":2,"watchlist_resurface":3}` |
| `proactive.window_start_hour` / `window_end_hour` | 17 / 20 |

Each tick, per reader, under the lock:

1. Pending candidates past `expires_at` become `expired`, with `last_block_reason` as the
   reason.
2. Due candidates (`eligible_at <= now`) are taken best first: priority, then oldest
   eligible, then id. That is a total order.
3. Each is revalidated (`_proactive_invalid`: recipient active, preference on, still on
   the Watchlist, not watched, plus the type's own checks). If it is no longer true it is
   **suppressed** with the reason.
4. Otherwise it is **held**, with the reason, by the first of: kill switch off; no
   timezone; old client; no live device; outside the window; something better already
   chosen this tick; daily cap; weekly cap; type cooldown; title cooldown.
5. The first one not held is **selected**: its notification is enqueued, and it takes the
   day.

Losers are not queued for later. They stay pending only while they are still timely and
expire when they are not, so nothing "catches up" on Thursday about Monday. Every
suppressed or expired row says why, which keeps "this type never works" distinguishable
from "this type is never chosen".

## G. Watchlist social

**Who counts: mutual friends.** That is the product's existing rule for friend moments
(`notifications.md` §2 Class C: "friend means mutual follow", and §11.2), and it is the same
relationship recommendations require. A one-way follow is a stranger's evening.

**What counts:** a `title_ranked` or `title_logged` feed event, on the exact title the
reader saved, written now. Not:

- `watchlist_added`: an intention, not a watch.
- `ranking_batch` or `ranking_batch_draft`: an Unranked sitting is one post for a back
  catalogue. No burst, no member titles.
- Anything during an import: the existing `_no_activity_while_importing` cancels the row
  first, and the trigger checks `_importing()` again rather than relying on trigger order.
- Activity more than a day old: a backfill or a repair.
- Readers who have already watched or ranked the title.
- The actor themself.

Visibility is re-derived on every read (`_proactive_social_actors`): active, mutual both
ways, `can_view_profile`. Someone who blocks, unfollows, is suspended, or deletes the
activity drops out of the count, the names and the push.

**The cluster.** One per (reader, title), with a **fixed** 7-day window from the first
friend:

| Event | Inbox | Candidate |
|---|---|---|
| 1st distinct friend | one actorless row, created | pending, `eligible_at` null, `below_threshold` |
| same friend again | unchanged | unchanged |
| 2nd distinct friend | row bumped and unread again | `eligible_at = now`: pushed at the next evening window |
| more friends before the push | row updated | the push counts them **at send time** |
| more friends after the push | row updated | `sent` stays `sent`; no second push |
| window closes with one friend | row kept | `expired / below_threshold`, no push |
| a friend on day 8 | a new row | a new cluster; the 7-day title cooldown still applies |
| a friend while Watchlist & discovery is **off** | **untouched**: not bumped, not made unread | **nothing recorded**: no member, no placeholder |
| first friend after turning it back **on** | a fresh row | a fresh cluster; a cluster the arbiter ended `preference_off` is never reused |

**Muted means untouched** (Codex review). Nothing that happens while the preference is off
is recorded, so it cannot be resurrected later, and it leaves no suppressed history that
would block the reader after re-enabling. Theatrical follows the same rule: a reader muted
when a film arms, who re-enables within its two-day collection window, still hears about
it once. Other categories are unaffected.

Copy, from the claim at send time (names are display names; at most two):
"**Dune** · Ravi and Eric watched it. It's on your Watchlist." /
"Ravi, Eric and 1 other…" / "Ravi, Eric and 4 others…". The delivered push is never
rewritten. The inbox keeps counting: "Ravi, Eric and 4 others watched Dune · On your
Watchlist".

Tap → the title page, never one friend's post: a cluster names several people.

## H. Theatrical release

The release-awareness machinery decides the date and the moment, as it did in shadow: a
film arms its awareness at T-7 on a read at most 12 hours old, once ever, never on or after
the day (`skipped_late`). `_proactive_theatrical_collect` reads events that armed in the
last 48 hours, are still `scheduled`, still in the future, and were read within
`proactive.theatrical_max_read_age_hours` (36). For each active watchlister it writes one
candidate and one inbox row, once ever per (reader, release):

| Reader's region | Outcome |
|---|---|
| US | inbox row + candidate |
| unknown | inbox row; candidate suppressed `region_unknown` (no push) |
| elsewhere | nothing |

At selection and again at claim, `_proactive_invalid` checks:

- the event is still `scheduled`;
- the date has not moved (otherwise `release_changed`);
- the read is fresh enough;
- it is not yet the day in the reader's zone (otherwise `too_late`);
- the reader's **current** region is still the release's (Codex review). A reader who now
  reports another country is `region_mismatch`, and one who reports none is
  `region_unknown`. A US date is never pushed to somebody who has moved. Candidates expire at the
earlier of 72 hours or the opening day's local midnight. **There is no day-of push.**

Copy (`release-awareness.md` §G1): "**Dune: Part Three** · Opens next Friday. You saved it to
your Watchlist." / "Opens Friday, May 16." / "Opens tomorrow." Inbox: "Dune: Part Three opens
Fri, May 16 · On your Watchlist", with the date rendered at read time ("opened May 16"
afterwards). Tap → the title page.

`release_status()` still flags any **season-premiere** notification as a leak.
Theatrical rows are expected now.

## I. Watchlist resurfacing

Push only, never in the inbox. Generated only for a reader who is inside their evening
window and has room: push switch on, timezone known, a capable client, a live device, the
preference on, no proactive push today, under the weekly cap, no resurfacing in 7 days, no
proactive push in 72 hours, nothing stronger waiting this evening, not already tried today.
A day with no room writes nothing at all.

**Selection (`_proactive_resurface_pick`), deterministic, integers only:**

- *Eligible:* on the Watchlist; released (no future `release_date`); not watched or ranked;
  not the subject of any proactive push in the last 30 days.
- *Score:*
  - +3 per mutual friend who ranked or logged it in the last 30 days (at most 3)
  - +2 if it is on the cached TMDB **week** Trending lists, under the shelf's own 168-hour
    cutoff (a season counts through its series)
  - +2 if it came out in the last 60 days
  - +1 per full 30 days saved (at most 3)
  - −2 if it was ever resurfaced before
- *Ties:* longest saved, then id. The same state always picks the same title.
- *Reason line:* the strongest signal that scored. Friends, then trending, then recent,
  else saved.

No model and no new provider. Copy: "**Dune** · Friends have been watching it. / It's
trending this week. / It came out recently. / Still meaning to watch it? It's on your
Watchlist." Expires at tonight's window close: a reminder does not roll over.

## J. Local time

The recipient's IANA timezone from `account_context` (reported by the device). It is never
inferred from logging times and never guessed. The window is 17:00–20:00 local, in one
place. A candidate eligible at noon waits until 17:00; one eligible at 21:00 waits until
tomorrow's 17:00, if it is still timely. **Unknown timezone means no proactive push**: the
candidate is held `no_timezone` and expires with that reason, and the inbox row (social,
theatrical) stays. The 10:00–20:00 release window still governs only the shadow.

**Old clients: gated per device, at send time.** Every production build now reports a
timezone, so timezone no longer gates old clients. A push is delivered to *tokens*, and one
account can hold a new phone and an old tablet at once, so the gate lives on the token:

- `device_tokens.proactive_version` records the build that last registered that token.
  The client sends `p_proactive_version` (1, `PROACTIVE_CLIENT_VERSION`) with
  `register_device_token`, which it calls once per app process. A build that predates this
  sends three arguments, reaches the new four-argument function through its default, and
  records **null**. Latest registration wins per token, so an installation that goes back
  to an old build turns that one device off again.
- **The arbiter** selects only for a recipient with at least one live token at or above
  `proactive.min_client_version`. With live devices but none capable, the candidate is
  held `client_unsupported`; with no live device, `no_device`.
- **`claim_push_batch`** gives a proactive job **only** the capable tokens
  (`_proactive_capable_token`). If none is left at send time (the capable phone signed
  out), the job is dropped and the candidate suppressed `client_unsupported`. It is never
  sent to the old device.
- **Reactive jobs are unchanged:** every live token, old builds included.

Old builds also hide the new kinds in their inbox (the existing `KINDS` filter), so an old
device never draws a row it cannot route. `report_device_context` is untouched.

## K. The three switches

All three are operator-side `app_config` rows (none is a user setting), **seeded
`false`**, and **fail-closed**: on only when the value is exactly the JSON boolean `true`,
so a malformed value (including the string `"true"`) means off. None needs a deploy, a cron
change or DDL, and clients can neither read nor write them.

| Switch | Governs | Off means |
|---|---|---|
| `proactive.generation_enabled` | all proactive creation | no candidate, no proactive inbox row |
| `proactive.resurface_enabled` | Watchlist resurfacing only | no resurfacing candidate; social and theatrical unaffected |
| `proactive.push_enabled` | proactive delivery | nothing selected; queued proactive jobs dropped at claim |

**Activation order** (staging, then production, each step a founder decision):

1. `generation_enabled = true`. Social and theatrical inbox rows and candidates begin; no
   push yet.
2. Validate social and theatrical (inbox rows, `proactive_summary`, no surprises).
3. `resurface_enabled = true`, when the founder chooses. Resurfacing is push-only, so with
   push still off **this generates nothing yet**. It only arms the type, so step 4 starts it.
4. `push_enabled = true`, only when push QA is ready. Social and theatrical pushes begin,
   and resurfacing starts generating at the next evening window.

Step 3 before step 4 is safe because resurfacing can never generate without push: there
is no wave of candidates waiting to fire. To keep resurfacing out of the first push
evenings, leave step 3 until after step 4 has been observed. Either order is safe, and
resurfacing never runs without both switches on.

### Resurfacing: `proactive.resurface_enabled`

Read only by `_proactive_resurface_collect`. It exists because resurfacing is the one type
not caused by an event: switched on, every eligible reader becomes a candidate on the same
evening, and the founder wants social and theatrical observed first.

```sql
update app_config set value = 'true'::jsonb  where key = 'proactive.resurface_enabled';  -- arm
update app_config set value = 'false'::jsonb where key = 'proactive.resurface_enabled';  -- stop
select proactive_status() -> 'resurface_enabled';
```

### Generation: `proactive.generation_enabled`

While off, **nothing proactive is created**:

- no `watchlist_social` cluster or inbox row (the `feed_events` trigger returns at once);
- no `theatrical_release` candidate or inbox row (`_proactive_tick` skips the collector);
- no resurfacing candidate;
- no proactive candidate of any kind.

Reactive notifications never read it. So **applying the migrations makes no proactive
row appear**, in staging or in production, until this is turned on. Pending candidates
made while it was on are still arbitrated, under the push switch.

```sql
-- enable (staging QA first; production only after founder approval)
update app_config set value = 'true'::jsonb  where key = 'proactive.generation_enabled';
-- disable
update app_config set value = 'false'::jsonb where key = 'proactive.generation_enabled';
-- check
select proactive_status() -> 'generation_enabled';
```

### Push (the kill switch): `proactive.push_enabled`

- **Off:** the arbiter selects nothing (candidates are held `kill_switch`, then expire);
  resurfacing is not generated; `claim_push_batch` drops any proactive job already queued
  and marks it `suppressed / kill_switch`. Reactive delivery reads neither the switch nor
  the ledger.
- No deploy, no cron change, no DDL. `app_config` has no client write policy, and no
  `proactive.*` key starts with `public.`, so clients cannot read it either.
- **Seeded `false`.** Applying the migrations sends nothing proactive.

Emergency stop and verification: [`push-operations.md`](../release/push-operations.md) §12.

`push.delivery_enabled` stays inert, as it was. Wiring it would change reactive delivery,
which is #119's founder decision and not this change's.

## L. Push-permission recovery

Notification Settings now opens with a card that states the operating system's answer, read
on open and again on every return to the foreground:

| OS state | Card | Action |
|---|---|---|
| granted | "Push notifications are on" | none |
| not yet decided | "Push notifications are off" | **Turn on**: shows the OS dialog, records the offer, registers the device |
| denied, cannot ask again | "Notifications are off for bingd" | **Open Settings** (`Linking.openSettings`) |
| no push on this device | nothing drawn | — |

It lives on this screen only and does nothing until pressed. No nagging.

**Recovering from Settings without a restart** (Codex review). `usePush` sets its
"registered" latch only once it has actually seen `granted`, and re-reads permission on
every return to the foreground. So the sequence denied → Open Settings → turn on → back to
bingd registers the device on that foreground. It goes through the same guarded,
deduplicated `registerThisDevice`: session epoch, token upsert, and the token's
`proactive_version`. It registers once and never asks.

## M. Telemetry

- **Ledger:** every candidate is recorded with its type, recipient, title, created,
  eligible, selected, sent and decided times, and the suppression reason.
- **Opens:** `notification_opens` (the first open per notification per channel, push or
  inbox, with destination and timestamp, linked to the candidate). Written by
  `record_notification_open` on every push tap and inbox tap.
- **Destination is a closed vocabulary**, never caller-supplied text: one of `profile`,
  `title`, `activity`, `awards`, `award-celebration`, `goals`, `import`, `inbox`. The
  client sends the resolver's own target kind (`pushDestination` for a push,
  `targetFor(row).kind` for an inbox row) rather than a path, so no id or username is ever
  in it. The function refuses anything else with 22023, and a column check enforces the
  same list whoever writes. Which title it was is already known from the notification.
- **Coarse event:** PostHog `notification_opened {kind, channel, proactive}`. Nothing about
  who or which title. **`kind` is closed:** the client sends it only when it is one of the
  app's `NotificationKind`s (the event's type says so), so an unknown or hostile string
  from a push payload never reaches the vendor. The server record ignores the client's
  kind entirely and reads it from the notification row.
- **Operator views (aggregates):** `proactive_summary` (type × state × reason) and
  `proactive_attribution`: handed to push-sender → opened from push → title ranked or a
  watch recorded within 7 days; and beside it, handed over and ranked within 7 days
  **without a recorded push open**. This is **observational attribution, not causal
  measurement**: a reader who opened the push might have ranked the title anyway, and an
  open that was not recorded counts as none. `proactive_status()` covers health.
- **Not pretended:** `sent` / `sent_at` means **handed to push-sender** by
  `claim_push_batch`. It is **not** Expo's acceptance and **not** delivery: after the
  claim, the sender can still drop the job (`live_push_jobs`), a submission to Expo can
  fail, and Expo's receipts are not polled (`push-operations.md` §9). `proactive_status`'s
  `sent_24h` counts handovers. "Removed from the Watchlist because consumed" is visible only
  as the log or rank that removed it.

## N. `goal_completed`

It was in `_push_eligible` and actorless, and `contentFor` had a branch for neither, so
every goal push since 20260829000200 was claimed and silently dropped. Now:

- the claim carries `goal {year, category, target}`;
- `copy.ts` has `goalContent`: "You hit your 2031 Movies goal 🎉" / "Congrats on 50
  movies", the inbox row's own words.

Deno and DB tests cover it. Nothing else about achievements changed.

**This is a reactive fix, and it is independent of every proactive switch** (founder,
2026-10-28). `goal_completed` is an ordinary reactive notification, so its push starts
working as soon as the updated `push-sender` is deployed (rollout step 3). It does **not**
wait for `generation_enabled`, `resurface_enabled` or `push_enabled`. That is intentional:
those switches govern proactive kinds only.

## O. Security and privilege

Every function below sets `search_path = public`. Every internal function is revoked from
`public, anon, authenticated` (the default-PUBLIC grant trap, `20260813001800`), and the
whole-schema sweep in `function-grants.test.mjs` pins the client-callable set. The four
tables have RLS enabled, **no policies**, and every privilege revoked from `anon` and
`authenticated`. Clients cannot read the ledger, the clusters, the opens or the views.

| Function | Caller | Definer | Grants | Why no escalation |
|---|---|---|---|---|
| `record_notification_open(uuid,text,text)` | app (inbox + push tap) | yes | authenticated | Writes only when `notifications.id = $1 and recipient_id = auth.uid()`. Answers `ok` either way (not an oracle). Channel validated; destination must be one of eight fixed words (refused otherwise, and checked by the column too), so it stores no caller text; first per channel only. No `assert_can_write`, deliberately: it is the caller's own telemetry and must not fail a suspended reader's tap (moderation exemption recorded) |
| `register_device_token(uuid,text,text,integer)` | app | yes | authenticated | Rebuilt from 20260825000300 with one defaulted argument. The owner is still `auth.uid()`, and `assert_can_write` and `_claim_operation` are unchanged. The version is bounded 1–100 and stored on that token only. Replaces the three-argument form, which old clients reach through the default (recording null). Exactly one signature exists (tested) |
| `_proactive_capable_token(device_tokens)` | arbiter, collector, claim | yes | nobody | A pure predicate over one row: live, and version ≥ the configured minimum |
| `my_notifications(integer)` | app | yes | authenticated | Unchanged shape plus two columns; cluster members pass `_proactive_social_actors` from `auth.uid()`'s side |
| `claim_push_batch(integer)` | push-sender | yes | service_role | Unchanged trust model; adds re-checks and copy fields |
| `_proactive_arbitrate`, `_proactive_tick`, `_proactive_*_collect`, `_proactive_social_add`, `_proactive_social_on_activity` (trigger), `_proactive_invalid`, `_proactive_social_actors`, `_proactive_resurface_pick`, helpers | pg_cron / trigger / each other | yes | **nobody** (tick: service_role) | No client can call any of them; pg_cron runs as the owner |
| `proactive_status`, `schedule_/unschedule_proactive_notifications` | operator | yes | service_role | Operator-only, like `release_status` |

The review questions, answered:

- **Forged actor ids.** A cluster member comes only from a `feed_events` row, and clients
  cannot insert `feed_events` at all (RLS, no insert policy; tested). The actor is the
  row's `actor_id`, written by the ranking and logging RPCs from `auth.uid()`.
- **Arbitrary-recipient injection.** Recipients come only from `watchlist` rows the
  recipient wrote, joined server-side. No function a client can call takes a recipient.
- **Cross-user Watchlist reads.** Only internal definer functions read another account's
  Watchlist. Nothing returns one to a client. The inbox row tells a reader about their own.
- **Private activity leakage.** A friend's activity reaches only mutual followers who
  `can_view_profile` them, rechecked at read and at send. The push names display names
  only, the same class of fact the reactive pushes carry.
- **Duplicate or racing sends.** §E's three layers, plus PA1–PA3.
- **Service-role exposure.** Unchanged. The drain still reads the key from Vault; nothing
  new holds it.
- **Client-triggered send bypass.** No client-callable function writes `push_outbox`,
  `proactive_candidates` or a proactive notification. The only client writes are the two
  rows above, both about the caller.

## P. Known limitations (accepted for v1)

- A device updated to a capable build reports it only on its next app launch (the client
  registers once per process). Until then it is treated as old, which is the safe direction.
- A film saved more than 48 hours after its T-7 arming is not announced.
- A season or series on the Watchlist is matched only on that exact item: a friend ranking
  Season 2 does not count toward a saved series.
- The social trigger runs inside the ranking transaction. It is per-reader subtransactioned
  and never fails the ranking, but it adds a query per ranking (`watchlist_by_title` index
  added).
- One push per local day **across** proactive types means a social cluster that arrives on
  a film's T-7 evening waits a day. That is the founder's policy, working as designed.

## S. Staging application and Preview QA (do not run without approval)

**Precondition:** the separate staging migration-parity audit is reconciled first.

1. `npx supabase link --project-ref fjxhcbowoxuzulwirzyr` then
   `npx supabase migration list --linked`. Confirm staging is at `20261023000100` with no
   drift.
2. `npx supabase db push --linked`. Applies `20261028000100` and `20261028000200` only.
   Re-run `migration list`.
3. `supabase functions deploy push-sender` (goal and proactive copy), **after** the
   migration: the old sender ignores the new fields, and with the switch off no proactive
   job exists.
4. SQL checks: `select proactive_status();` (`generation_enabled: false`,
   `push_enabled: false`, no candidates); `select release_status();` (healthy);
   `select push_drain_status();` (healthy). Confirm `_push_eligible` is unchanged, and
   that a staging social activity creates **no** proactive row while generation is off.
5. `select schedule_proactive_notifications();` then confirm the job in `cron.job`.
6. Publish a **Preview** OTA from this branch (staging backend). Relaunch the QA device and
   confirm its token reports `device_tokens.proactive_version = 1`. Keep a second QA device
   on the store build (version null) signed into the same account, for the multi-device
   check.
7. Staging only, in this order: `generation_enabled` → `true`, then `push_enabled` →
   `true` (the statements are in §K).
8. Device QA, on staging accounts from `staging-qa-inventory.md`:
   - **Social:** account B (mutual with A) ranks a film on A's Watchlist. A's inbox shows one
     row, no push. Account C ranks it too. At A's next 17:00–20:00 window, one push names B
     and C. Tap opens the title. A fourth friend updates the inbox and sends no push.
   - **Theatrical:** watchlist a film within 7 days of its US release. After the next
     evaluate and proactive tick, the inbox row appears, then the evening push ("Opens …").
   - **Resurfacing:** with `resurface_enabled` still false, confirm no resurfacing candidate
     appears. Then turn it on: an account with a Watchlist and no other proactive push this
     week gets one push in the window, with no inbox row.
   - **Late recovery:** with a candidate `selected`, stop the drain until after 20:00 local
     (`unschedule_push_drain()`), then reschedule it. Confirm no push arrives and the candidate
     ends `expired / outside_window`.
   - **Goal:** complete a goal and get the "You hit your … goal 🎉" push.
   - **Multi-device:** the social push arrives on the Preview device only, never on the
     store-build device on the same account. A reactive follow push arrives on both.
   - **Settings:** nine switches and no section masters; Watching › Watchlist & discovery
     shows. Turn the switch off and the next social activity creates nothing.
   - **Permission card:** check all three states. Deny in OS Settings, return, and see
     "Open Settings".
   - **Kill switch:** set `proactive.push_enabled` to `false` with a candidate selected and
     unclaimed, then confirm `suppressed / kill_switch` and that a reactive follow push still
     arrives.
   - **Telemetry:** taps appear in `notification_opens`; `proactive_summary` and
     `proactive_attribution` read sensibly.
9. Leave staging's switch as the founder decides.

## T. Production rollout and rollback (do not run without approval)

**Rollout:**

1. Founder approval of the reviewed PR, then merge.
2. Production `db push`: the two migrations. **All three switches are false, so nothing
   proactive is created and nothing is sent.** Verify with
   `select proactive_status();` (no candidates) and a count of zero
   `watchlist_social` / `theatrical_release` notifications.
3. `push-sender` deploy, after the migration. **This activates the `goal_completed` push
   fix immediately** (a reactive fix, §N), independent of every proactive switch.
4. `select schedule_proactive_notifications();` (the tick runs and finds nothing to do).
5. Production OTA from the merged commit, for the 1.1.0 runtimes (and a second publish from
   a 1.0.1 tree if 1.0.1 installs are to receive it, per `production-state.md`). Watch
   adoption as `count(*) filter (where proactive_version >= 1)` over live `device_tokens`.
6. After a staging pass and founder approval, in the §K order:
   `generation_enabled = true` (social and theatrical inbox rows begin) → validate →
   `resurface_enabled = true` when the founder chooses (arms resurfacing; it generates nothing
   until push is on) → `push_enabled = true` when push QA is ready (pushes begin, to capable
   devices only, tonight-or-not-at-all).
7. Watch `proactive_status()`, `proactive_summary` and push-drain health daily for the first
   week.

**Rollback, in order of reach:**

| Want to stop | Do | Effect |
|---|---|---|
| Proactive pushes, now | `update app_config set value = 'false' where key = 'proactive.push_enabled';` | Queued proactive jobs are dropped at claim. Reactive is untouched |
| Resurfacing only | `update app_config set value = 'false' where key = 'proactive.resurface_enabled';` | No new resurfacing candidates; social and theatrical continue |
| New proactive inbox rows too | also `update app_config set value = 'false' where key = 'proactive.generation_enabled';` | Social trigger and collectors write nothing |
| The scheduled tick | `select unschedule_proactive_notifications();` | Pending candidates expire on their own clocks |
| A bad `push-sender` | redeploy the previous version | The previous sender ignores `goal` / `proactive`. Goal pushes go back to being dropped, and proactive jobs (actorless, with no branch in the old copy) are dropped too. Switch proactive push off first so candidates are not marked `sent` for pushes that never go |
| The schema | a forward migration only | Existing migrations are never edited. The tables are additive; the rebuilt `claim_push_batch` / `my_notifications` / `release_status` / preference gate would be restored from their previous bodies by a new migration |

## V. Follow-ups, not in this change

- The global "Turn all off", with the settings regroup (§C).
- Season-premiere delivery (decision E), which can reuse this ledger unchanged.
- Expo receipt polling and per-token retry.
- Wiring or deleting `push.delivery_enabled` (#119).
- An "Out now for you" shelf (`release-awareness.md` §G4).

### Hardening debt from the first independent review (Fable, 2026-10-28), deferred by the founder

These are recorded, not fixed, deliberately:

- **MINOR 5: a stuck `selected` carrier.** An edge case where a candidate can remain
  `selected` (with its outbox row or carrier notification) without being claimed or
  settled. `proactive_status` surfaces it as `selected_not_sent` after 15 minutes, and the
  claim-time timeliness rule means a late claim can never send it. Its row is not yet
  settled automatically. **The at-most-once change does not resolve this**: it governs a
  candidate that *was* claimed, and this one never is. While stuck it still counts as
  `selected`, so it occupies that reader's local-day slot and one of their two weekly
  pushes without having been handed over. That costs at most a missed push, never a
  duplicate.
- **MINOR 6: tick lock duration.** The tick holds its per-reader advisory locks inside one
  transaction across collection and arbitration. A finer-grained transaction structure
  would shorten them.
- **The review's NICE items**, as listed in that review.

### Deferred by the founder from the second review round (Fable + Codex, 2026-10-28)

- Lock-duration optimisation (MINOR 6 above).
- The social inbox row's copy after the title leaves the Watchlist (cosmetic: the row
  stays, and the push is already suppressed `not_on_watchlist`).
- Guidance for future imports and backfills beyond what §G documents (the trigger ignores
  activity older than a day and anything written during an import).
- `mark_notifications_read`'s count includes hidden `watchlist_resurface` carrier rows.
- The remaining NICE findings.
