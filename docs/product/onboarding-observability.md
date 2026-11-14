# Onboarding observability — what the funnel can and cannot say today

Written 2026-09-17, to answer one founder question:

> Can I distinguish users who genuinely abandon onboarding from users who pause and come
> back 2–3 days later, and approximately where they stop?

**Yes, with the events that already exist, and no new instrumentation** — provided you read
two of them the way this page says rather than the way their names suggest. §2 is the part
that will otherwise cost you a wrong number.

Nothing in this document changes the app. It is a reading guide and a dashboard recipe.

> **Updated 2026-11-14 for Onboarding 2.0 (OB-1).** That build adds
> `onboarding_step_viewed`, sends the missing `profile` completion, adds
> `first_five_index` and `coach_shown` to onboarding's `ranking_completed`, and adds
> `notification_permission_result` and `onboarding_people_search_used`. §1, §2 and §4 say
> what changes and from which build. `onboarding_step_completed` is **not** renamed or
> reshaped, so its series since September continues unbroken.

---

## 1. What is already emitted

These events matter here. All of them are in `src/lib/analytics.ts`, defined as a closed
union, so an event not listed there cannot be emitted at all. The last four rows arrive
with Onboarding 2.0 (OB-1) and are absent from every earlier build.

| Event | Fired where | Means exactly |
|---|---|---|
| `sign_in_completed` | a Supabase session exists | authenticated. **Not** an account |
| `signup_completed` | `app/(auth)/create-profile.tsx` | `create_profile` answered `created`. The account now exists. Not a replay: `already_exists` emits nothing |
| `onboarding_started` | `use-taste-onboarding.ts`, once, as the phase is written `active` | the first-run flow genuinely became active for this account on this device. **Not** on a remount, **not** on a resume of a flow that was already active |
| `onboarding_step_completed` | five call sites in `app/onboarding/` | one step was *left*, with `step` and `outcome` |
| `onboarding_completed` | `use-taste-onboarding.ts`, from the one function all three exits go through | the flow ended, by either exit. `skipped` separates them |
| `onboarding_step_viewed` | six call sites: `create-profile.tsx` (`profile`), `taste.tsx` picker (`pick`) and Your First Five (`payoff`), `letterboxd.tsx`, `people.tsx` (once its branch is decided), `NotificationStep` | one step was *shown*, with `step` only. Once per step per run in one app session (`features/onboarding/step-viewed.ts`): not on a re-render, a remount or a sheet opening. **A relaunch that resumes a step may send it again**, which is acceptable: read it per person, not per event |
| `ranking_completed` with `surface: 'onboarding'` | `RankingSheet`, passed the run's context by `taste.tsx` | as everywhere, a placement landed. On onboarding only it also carries `first_five_index` (1–5: which of the five) and `coach_shown` (the first-comparison coach line was on screen). Both are **absent** on every other surface. An empty-band placement with no comparison still emits it and still takes its index |
| `notification_permission_result` | `NotificationStep`, once, when it settles | `result` is `granted`, `pending`, `undelivered` or `declined` — **Not now and an OS refusal are both `declined`**. `had_follow` is the step's own Feed-or-For-You answer, `false` if it had not arrived yet |
| `onboarding_people_search_used` | `people.tsx`, once, on Continue, only if a search settled | `searches` (distinct trimmed queries that came back) and `had_results` (any found somebody other than the viewer). Never the query |

Two properties of `onboarding_completed` can be **absent**, and absent means *not known* —
not zero, not false. `titles_ranked` is missing when the last step was reached before the
taste count had been read; `skipped` is missing when nothing recorded the outcome. This is
deliberate and documented in `analytics.md`: an earlier version resolved both to confident
values and reported accounts that ranked all five as skips. **Exclude the missing ones from
a chart; never coalesce them to zero.**

Every event also carries release identity as PostHog super-properties, so all of these are
available as breakdowns without any new work: `platform`, `environment`, `app_version`,
`build_number`, `runtime_version`, `eas_channel`, `eas_update_id`, `build_kind`.

PostHog is identified by the account id (`identify(userId)`), which is the same id as
`profiles.id` — so any PostHog cohort can be joined to the database by hand, and that is
what §5 does.

---

## 2. The two traps in the step event, and they are the whole reason this page exists

`onboarding_step_completed` declares six steps: `profile`, `pick`, `payoff`, `letterboxd`,
`people`, `notifications`. **Before Onboarding 2.0 only five of them were ever emitted, and
one of those is emitted in only one direction.** Verified against every call site on `main`
(`abbb45e`), and updated for OB-1:

| `step` | emitted? | with which `outcome` |
|---|---|---|
| `profile` | **from the Onboarding 2.0 build on** (`create-profile.tsx`, beside `signup_completed`, on `created` only); **never** by any older build | `continued` only |
| `pick` | yes | **`skipped` only** |
| `payoff` | yes | `continued` only |
| `letterboxd` | yes | `continued` and `skipped` |
| `people` | yes | `continued` only — "following is optional, so leaving without one is not a skip" |
| `notifications` | yes | `continued` only |

**Trap one: a funnel step on `step = 'pick'` counts only the people who gave up on it.**
Finishing the five-title run does not emit `pick`; it emits `payoff` with
`outcome: 'continued'`, because the payoff screen is what the run advances into. So:

- people who **completed** the five-title run = `onboarding_step_completed` where
  `step = 'payoff'`
- people who **bailed out** of it = `step = 'pick'` (always `skipped`)
- people who **stopped dead inside it** = `onboarding_started` with *neither* of the above

Read `pick` as a skip counter and `payoff` as the completion counter, and the flow reads
correctly. Read `pick` as "the pick step", and it will look like a step with a 100% skip
rate, which is an artefact of where the event fires.

**Trap two: `step = 'profile'` is sent only from the Onboarding 2.0 build on.** It fires at
the same moment as `signup_completed` and under the same rule (`created` only, never
`already_exists`), so for builds that send both the two counts agree. **Older builds never
sent it**, so a funnel over a date range that includes them will show `profile` far below
`signup_completed`; that gap is the builds, not drop-off. For any range that crosses the
release, use `signup_completed` as the profile step, or filter by `app_version`/
`runtime_version`.

**And the view half now exists (OB-1).** `onboarding_step_viewed` is the per-step
denominator: drop-off on a step is **viewed − completed, per person**, which finally makes
`people` and `notifications` measurable as more than absence. Count persons, not events —
a relaunch that resumes a step can send its view twice for one person, and that person still
either completed it or did not. `pick`'s view is the run's first picker frame, so for the run
read `pick` viewed against `payoff` completed (with `pick` completed still the bail-outs).

Because `people` and `notifications` only ever report `continued`, on builds before
Onboarding 2.0 drop-off on those two steps is visible **only as absence** — somebody who
leaves at People emits `letterboxd` and then nothing. That is enough to locate them, which
is what the question asks; it is not enough to distinguish "closed the app" from "is still
on the screen". From OB-1 on, `onboarding_step_viewed` says they reached it.

**Invited versus organic needs no new property.** The `acquisition_source` super-property
is on every event, and the People step's `onboarding_step_completed.variant` (`connected`,
`connected_alone` versus `starter_shared`, `starter_active`) already separates an account
that arrived on an invitation from one that did not.

---

## 3. Can you tell a pause from an abandon? Yes — it is the gap between two windows

This is the whole answer, and it needs no new event.

`onboarding_started` and `onboarding_completed` are a pair, and PostHog funnels take a
**conversion window**. The same funnel measured at two windows gives you the three
populations directly:

- **converted within 1 hour** — finished in one sitting
- **converted within 7 days** — finished ever
- **(7-day count − 1-hour count)** — *came back later*. This is the pause population, and it
  is a number you can watch rather than guess at
- **never converted within 7 days** — genuine abandonment

The flow is explicitly built to survive this. `onboarding.stage` is a durable device
preference consulted by routing *before* the taste query, precisely so somebody who closed
the app on the People step is returned to the People step days later instead of being
dropped into the Feed with two steps silently skipped. So a resume is a real, supported
path, and `onboarding_started` does **not** fire again on it — which is what makes the pair
safe to measure across days without double counting.

**Where they stopped** is the last `onboarding_step_completed` for that person, read through
§2's table. PostHog's user timeline shows this per person without any query at all.

### The one thing this cannot tell you

**It is device-local.** The stage and the ranking outcome are preferences on the phone, not
columns. Somebody who signs up on a phone and resumes on a tablet is read as established and
is not offered the rest of the flow — a trade `use-onboarding-stage.ts` documents and takes
deliberately, to avoid a migration and an RLS write path for a pointer whose only job is to
stop finished screens reappearing. It is rare, it is recoverable, and it means the resume
numbers above are a slight **under**-count of returners rather than an over-count. That is
the safe direction.

---

## 4. The PostHog setup, click by click

Nothing here invents an event name. Every name below is emitted by the current build.

### A. The funnel

1. PostHog → left sidebar → **Product analytics** → **New insight** → **Funnel**.
2. **Step 1**: click *Add step*, choose event **`signup_completed`**.
3. **Step 2**: *Add step* → **`onboarding_started`**.
4. **Step 3**: *Add step* → **`onboarding_completed`**.
5. Top right → **Save** → name it `Onboarding — signup to completion`.

### B. The two conversion windows

The window control sits under the funnel steps, reading *"Conversion window limit"*.

1. Set it to **1** and the unit dropdown to **hours**. Save the insight as
   `Onboarding — one sitting (1h)`.
2. Change it to **7** and the unit to **days**. Save as a *new* insight (top right →
   **Save as** → *New insight*) named `Onboarding — eventual (7d)`.

Put both on one dashboard: **Dashboards** → *New dashboard* → name it `Onboarding`, then
from each insight use *⋯* → **Add to dashboard** → `Onboarding`.

**The number you actually want is the difference between the two**, and PostHog will not
subtract them for you. Read the completion count off each tile; 7-day minus 1-hour is the
people who came back.

### C. The breakdowns

On the 7-day funnel: click **Breakdown** (under the steps) → *Add breakdown* → **Event
property** → choose **`platform`**. That splits iOS from Android, which matters right now
because iOS is public on the App Store and Android is still closed testing — mixing them
produces one meaningless average.

Repeat on a duplicate tile with **`eas_channel`** (and, if you want to pin a specific
build, **`runtime_version`** or **`eas_update_id`**). These are super-properties on every
event, so they are in the property list already.

### D. The three cohorts

**Cohorts** → **New cohort**, each saved by name:

1. `Signed up, never started onboarding` — *Match users who* → **completed event** →
   `signup_completed` → *in the last* 30 days; then *Add condition* → **did not complete
   event** → `onboarding_started` → in the last 30 days.
2. `Started onboarding, never completed` — **completed event** `onboarding_started` in the
   last 30 days; *and* **did not complete event** `onboarding_completed` in the last 30 days.
3. `Completed late` — **completed event** `onboarding_completed` in the last 30 days, *and*
   **completed event** `onboarding_started` in the last 30 days. PostHog cohorts cannot
   express "more than 24 hours between two events" in the UI; the honest way to get this
   group is the funnel subtraction in §B, and then, for the handful of individuals, open the
   7-day funnel's last step → **View persons** and read their timelines. Do not build a
   cohort that claims a precision the tool does not have.

### E. Where they stopped

**New insight** → **Trends** → event `onboarding_step_completed` → **Breakdown** → event
property **`step`**. Read it with §2's table beside you: `payoff` is the completed-run
count, `pick` is the bail-out count, and `profile` is non-zero only for the Onboarding 2.0
build onward.

### F. Per-step drop-off (Onboarding 2.0 builds only)

1. **New insight** → **Funnel**, *Conversion window* 7 days, filtered to the Onboarding 2.0
   `app_version` (or later).
2. Steps, each with a property filter on `step`:
   `onboarding_step_viewed` (`profile`) → `onboarding_step_completed` (`profile`) →
   `onboarding_step_viewed` (`pick`) → `onboarding_step_completed` (`payoff`) →
   `onboarding_step_viewed` (`letterboxd`) → `onboarding_step_completed` (`letterboxd`) →
   `onboarding_step_viewed` (`people`) → `onboarding_step_completed` (`people`) →
   `onboarding_step_viewed` (`notifications`) → `onboarding_step_completed`
   (`notifications`).
3. PostHog funnels count **persons**, which is exactly the reading a repeated view needs.
   Each viewed → completed pair is that step's drop-off.
4. Breakdowns worth a duplicate tile: `acquisition_source` (invited versus organic), and on
   the People pair, `variant`.

The First Five's inside is on `ranking_completed` where `surface = onboarding`: break down
by `first_five_index` to see how far into the five people get, and by `coach_shown` to
compare comparison counts with and without the coach line.

Add a second breakdown on **`outcome`** to separate `letterboxd` skips from continues —
that is the only step where both directions are emitted and the split is interesting.

---

## 5. What only the database can answer

Two things PostHog cannot say, both because the state is device-local (§3):

**How many of the five they actually ranked before pausing.** `onboarding_completed`
carries `titles_ranked`, but only for people who *reached the end*. For somebody still
paused, the count exists only in the database:

```sql
-- Accounts created since a date, and how far into Your First Five they got.
-- The onboarding target is five (PICK_TARGET); movies is the onboarding category.
select p.id,
       p.username,
       p.created_at,
       count(r.media_item_id) filter (where r.category = 'movies') as titles_ranked,
       case
         when count(r.media_item_id) filter (where r.category = 'movies') >= 5 then 'finished the five'
         when count(r.media_item_id) filter (where r.category = 'movies') > 0  then 'paused partway'
         else 'never ranked one'
       end as state
  from profiles p
  left join rankings r on r.user_id = p.id
 where p.created_at >= '2026-09-17'
   and p.status = 'active'
 group by p.id, p.username, p.created_at
 order by p.created_at desc;
```

This is the only place "stopped three titles in" is recoverable, and it needs no
telemetry — the rows are already there.

**Whether the welcome email moved anybody.** Once the note is live, `welcome_emails` holds
one row per account with `sent_at`. Take the sent ids and compare against the query above,
or against PostHog timelines, for activity after `sent_at`:

```sql
select w.user_id, w.sent_at, count(r.media_item_id) as ranked_after_the_email
  from welcome_emails w
  left join rankings r on r.user_id = w.user_id and r.created_at > w.sent_at
 where w.status = 'sent' and not w.canary
 group by w.user_id, w.sent_at
 order by w.sent_at desc;
```

**This is a before/after, not an experiment.** Everybody eligible gets the note, so there is
no holdout and the number cannot tell you the email *caused* anything. Read it as "did the
people we wrote to come back", which is a fair question, and resist the temptation to report
it as a lift.

---

## 6. Why no new event was added (2026-09-17)

> **Superseded in part on 2026-11-14.** Onboarding 2.0 (OB-1) added
> `onboarding_step_viewed` as the per-step denominator, which this section's question did not
> need and the redesign's does: drop-off per step rather than where somebody was last seen.
> `onboarding_step_completed` was still **not** renamed or reshaped, and `pick` still does not
> report `continued`, for the continuity reason given below.

The brief allowed exactly one new event, `onboarding_stage_reached`, if the existing data
could not answer the question. It can, so none was added.

`onboarding_step_completed` **already is** that event: it carries a small typed stage enum
taken from the real stage machine, it is emitted once as a step is left rather than on a
rerender, it has no per-comparison or per-tap telemetry, and it has been shipping since
2026-09-09. Adding a second event over the same six stages would have produced two series
measuring one thing, diverging the first time somebody edited only one of them — and the
existing one is the better of the two, because following the *step* rather than the *tap*
makes a lost reply under-count instead of double-count.

What the brief was reaching for was real, but it is a **reading** problem, not a missing
event: the `pick`/`payoff` asymmetry in §2. That is now written down, and it costs nothing.

**The one change worth considering later** (not made here, because the brief forbids
touching onboarding UX and this is not needed for the question): emit `pick` with
`outcome: 'continued'` when the five-title run completes, so the step reads symmetrically
and `payoff` stops doing two jobs. It would make the funnel self-explanatory and would not
change a single pixel. It would also break continuity with every `pick` number recorded
before the change, which is exactly why it belongs in its own decision rather than smuggled
into a lifecycle-email branch.

---

Related: `docs/product/analytics.md` (every event, and what each does *not* mean),
`docs/product/growth-instrumentation.md` (the invite funnel),
`emails/welcome/automation/README.md` §"Measuring this one email".
