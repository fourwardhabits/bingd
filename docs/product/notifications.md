# Notifications — the doctrine, the matrix, and what is deliberately not sent

**Status:** written 2026-09-06. Canonical. This is the source of truth for what bingd
sends, what it will not send, and why.

**Companion documents:** [`PRD.md`](./PRD.md) §15 (the product requirement) ·
[`analytics.md`](./analytics.md) §notifications (measurement) ·
[`deferred-roadmap.md`](./deferred-roadmap.md) ·
[`../architecture/push.md`](../architecture/push.md) (delivery)

This document is **more granular than Settings**, on purpose. A reader gets six or eight
switches; this table has twenty-odd rows. Collapsing the two would either bury a type
nobody can find or hand somebody a settings screen that reads like a database schema.

---

## 1. Doctrine

> **A notification must help somebody act on something relevant.** Not "open bingd."

Four things earn an interruption:

1. **Another person interacted with you.** You were commented on, mentioned,
   recommended something, followed.
2. **Something you explicitly saved became actionable.** A watchlist title is out.
3. **A friend created a timely conversation.** They watched something you also want to
   watch, or something you just watched.
4. **A meaningful progress state is about to expire.** A streak with two days left.

Everything else is marketing, and marketing is what costs the permission the first three
depend on. PRD §15's rule stands and is the sentence this whole document expands:
**if there is nothing true to say, send nothing.**

Every notification deep-links to the thing it promised. A push about a comment opens
that conversation; a push about a release opens that title. A proactive push whose only
destination is the feed is a push that should not have been sent.

### The two limits, and there must be both

**Per-type dedupe and cooldown.** One event, one notification. The same pair and the
same title do not produce a second one inside a meaningful window.

**A global cap across every proactive type.** Per-type limits alone are how an inbox
fills up: five types each politely sending once a week is five pushes a week. The cap is
the thing that makes adding a sixth type safe.

---

## 2. Classes

### Class A — Direct social. Highest priority, outside the cap.

Somebody did something *to you*. Without the notification you simply miss it, and the
interaction is not repeatable.

These are **exempt from the engagement cap** and should be: suppressing "Ravi replied to
you" because the app already sent a streak reminder on Tuesday is the wrong trade in
every direction. They still obey per-type dedupe, user preference, and blocks.

Everything in this class is **live today** and is not being redesigned. Nothing in this
pass found a flaw in it.

### Class B — Time-sensitive personal utility. High value, inside the cap.

A fact about something the reader explicitly saved or is explicitly working on, which
stops being useful if it arrives late. Watchlist release day; a streak about to expire.

### Class C — Friend moments. Valuable, and the easiest to turn into spam.

**"Friend" means mutual follow** — you follow them *and* they follow you back. Not a
one-way follow: a notification about somebody who has not followed back is a notification
about a stranger's evening.

### Class D — Watchlist resurfacing. Documented, not sent.

"See *Dune* on your watchlist" is better than "come back to bingd." It is still
lower-confidence than a release or a friend, because nothing happened — the app simply
decided to speak. It needs a *reason*: newly streamable, long-saved, high recommendation
confidence, reader inactive. Without one, it is a reminder that something is in a list,
which the reader put there.

### Class E — Personalised and trending. Deferred.

"A title you would love is trending." Interesting later; it needs recommendation
confidence the product does not yet measure, and it is one bad threshold away from
generic marketing push.

---

## 3. The matrix

Status vocabulary:

- **LIVE** — implemented, enabled, sending.
- **IMPLEMENTED-DISABLED** — code exists, deliberately not sending.
- **SHADOW** — candidates computed and measured; nothing delivered.
- **DEFERRED** — designed here, not built.
- **REJECTED** — considered and ruled out.

### Class A — direct social (live, outside the cap)

| Type | Trigger | Value | Deep link | Dedupe | Settings group | Status |
|---|---|---|---|---|---|---|
| `comment` | Somebody comments on your activity; somebody replies to your comment; **or the post's author adds a top-level comment to a post you had already commented on** (`payload.participant`, `20261021000100`). A third party's comment notifies the author only (and the parent's author on a reply), never every earlier participant | You are being spoken to | The conversation (`/activity/[id]`) | Per comment, at most one per person; a mention takes precedence | Social › Comments | LIVE |
| `mention` | You are `@`-named in a comment | Directed at you personally | That conversation | At most one per (comment, person), never re-sent on edit | Social › Comments | LIVE |
| `reaction` | Somebody reacts to your activity | Somebody responded | That activity | Per reaction; comment reactions write none | Social › Reactions | LIVE |
| `watch_tag` | Somebody says they watched with you | A claim about your evening | The title | Once only, one writer | Social › Watched with | LIVE |
| `follow` | Somebody follows you | A new reader | Their profile | Per follow | Social › Follows | LIVE |
| `follow_request` | A request to follow you | Only you can answer it | Their profile | Per request; **not silenceable** — see §5 | (none) | LIVE |
| `follow_approved` | Your request was approved | You can now see them | Their profile | Per approval | Social › Follow accepted | LIVE |
| `recommendation` | Somebody recommends you a title | A person picked this for you | The title | Per recommendation | Recommendations › Recommendations | LIVE |
| `recommendation_ranked` | They ranked what you sent | The loop closed | Their exact ranking post | Once per recommendation | Recommendations › Recommendations | LIVE |
| `invite_activated` | Somebody you invited started ranking | Your invitation worked | Their profile | Once per account, ever | Recommendations › Friend joined | LIVE |
| `invite_joined` | Somebody joined on your link | Same | Their profile | Once | Recommendations › Friend joined | LIVE |
| `invite_welcome` | You joined on somebody's link | Who brought you | Their profile | Once | Recommendations › Friend joined | LIVE |
| `award_earned` | You crossed an award tier | Your own achievement | **The award celebration** (2026-09-06) | Once per (award, tier), ever | Achievements › bingd Awards | LIVE |
| `goal_completed` | You finished an annual goal | Your own achievement | Your profile's goals | Once per (year, medium) | Achievements | LIVE |

### Class B — time-sensitive personal utility

| Type | Trigger | Value | Deep link | Cooldown | Cap | Status |
|---|---|---|---|---|---|---|
| `streak_expiring` | Live streak, no ranking yet, ~48h left in the week | The one thing that keeps it | Search / ranking surface, **never home** | **One per week, maximum** | Yes | **DEFERRED** — §4 |
| `theatrical_release` | A watchlisted film opens in US theaters in about a week (T-7) | You saved it, and a week is enough time to plan | Title detail | Once per (user, film release), ever | Measured, not applied | **SHADOW** (20260930000100/200/300). Superseded `watchlist_release_day`: a day-of push arrives too late to act on, so it is not sent at all |
| `season_premiere` | A new season of a series you are caught up on is out, on release morning | You ranked or watched the season before it | The season | Once per (user, season), ever | Measured, not applied | **SHADOW.** Behind-tier viewers get the in-app event only |
| `watchlist_release_week` | One week before release | Planning | Title detail | Once per (user, title) | Yes | **REJECTED for v1** — doubles volume for the same title. Release day is more actionable and assumes less. Revisit as an experiment against release-day open rates. |

### Class C — friend moments

Priority order within the class, which is also the build order if only some are built:

| # | Type | Trigger | Value | Deep link | Dedupe | Status |
|---|---|---|---|---|---|---|
| 1 | `friend_watched_your_watchlist` | A mutual friend ranks a title **currently on your watchlist** | You already said you wanted this; now somebody you trust has an opinion | **Their exact ranking post** (`/activity/[id]`) | Once per (pair, title), ever | **DEFERRED** |
| 2 | `mutual_watchlist_match` | A mutual friend adds a title you already have saved | A plan, not a fact | Title detail | Once per (pair, title), ever | **DEFERRED** |
| 3 | `friend_watched_your_recent` | A mutual friend ranks something you ranked in the last N days | Conversation | Their ranking post | Once per (pair, title) | **DEFERRED** |

**The recency window for #3 is an open question, and the honest answer is that the data
does not exist yet.** 14 days is the tighter, safer default — it keeps the notification
about a shared *moment* rather than a shared history — and 30 would roughly double the
volume for a beta cohort this size. Decide it from `ranking_completed` inter-arrival
times once there are enough public users to measure, not now.

**#1 is the strongest of the three and is the one to build first.** It is the only one
where the reader has already expressed intent about that exact title, which is what makes
it a fact they wanted rather than an observation about somebody else.

### Class D — watchlist resurfacing

| Type | Trigger | Status |
|---|---|---|
| `watchlist_now_streaming` | A watchlist title becomes available in the reader's region | **REMOVED from the roadmap** (founder, 2026-09-19). See §11.4. The mechanics are unchanged: `WhereToWatch` reads live and stores no history, so there is nothing to diff. |
| `watchlist_aging` | Long-saved title, reader inactive, high confidence | **DEFERRED / SHADOW candidate.** Generate and measure before ever sending. |

### Class E and everything else considered

| Idea | Verdict |
|---|---|
| Trending title matching your taste | **DEFERRED.** Needs recommendation confidence the product does not measure. Easiest of all these to turn into marketing push. |
| Several friends ranked the same title | **DEFERRED.** A real signal, and it needs the friend triggers first. |
| New season of a series you ranked | **IN SHADOW** since 2026-09-19, as `season_premiere` above. The release-reliability problem was the real one and is solved by a refresh that keeps dates current plus a 12-hour freshness rule, not by trusting the catalogue. (This row read "`tmdb_upsert_seasons` writes no reliable future air date"; it does write `air_date`, and the actual gap was that nothing refreshed it.) |
| Availability added to a watchlist title | **DEFERRED.** Same missing history as `watchlist_now_streaming`. |
| Award near-completion ("2 more comedies") | **REJECTED for now.** Progress is not an event; it is a state the Awards sheet already shows. A push about not-quite-finishing is the participation-trophy problem in push form. |
| Monthly / annual recap | **DEFERRED.** Worth doing when there is a year of history to recap. |
| Comeback after long inactivity | **REJECTED as a type.** "We miss you" is the exact push this doctrine exists to refuse. Inactivity is an *eligibility input* to a contextual type, never a trigger of its own. |
| Group Picks prompt | **DEFERRED.** No trigger has been identified that is not "open the app". |
| Daily streak | **REJECTED.** Weekly is the cadence the product's own loop has — people do not rank every day, and a daily streak would be broken by everybody within a week. |

---

## 4. The weekly streak reminder, specified and deferred

The streak **display** shipped 2026-09-06 and is derived from `rankings.created_at` with
no schema at all (`src/features/streaks/streak.ts`). The **reminder** is not built, and
this is the specification for when it is.

**Behaviour.** At most **one per week**. Only for a reader with a live streak to lose, or
with enough prior weekly behaviour that the reminder means something. Only near the end
of the week — about 48 hours before expiry. **Never** to somebody who has already ranked
that week. Deep-links to the ranking surface, never to home. Subject to the global cap.

**Explicitly not:** a 3-day, 2-day, 1-day, today countdown. One reminder, or none.

**What blocks it, precisely — three things, and none is a small change.**

1. **A timezone.** The week boundary is local Monday, computed on the device. A server
   deciding "48 hours before this reader's week ends" needs their zone stored, which is a
   column and a decision about how it is captured. Sending on a UTC week instead would
   fire at 4pm Sunday for some readers and 4am Monday for others.
2. **A scheduler with a candidate query.** `pg_cron` runs the push outbox drain
   (`20260826000300`) so the machinery exists, but computing "readers with a live streak
   who have not ranked this week" is a new scheduled function.
3. **The cap ledger** — §7. Without it the reminder is the first proactive type and
   therefore uncapped, which is precisely how the discipline gets lost.

**Copy and grace semantics are deliberately unsettled**, per the founder. The display's
copy ("Rank something in the next 2 days to keep it going") is *not* automatically the
push's copy: a sentence you read when you chose to look at your profile and a sentence
that interrupts your evening are different sentences.

---

## 5. Settings information architecture

**Current state: 3 sections, 8 toggles.** That is already inside the guardrail (no more
than 10 toggles, prefer 5–6; no more than 3 primary sections), so **nothing changed in
this pass.**

| Section | Toggles |
|---|---|
| Social | Follows · Follow accepted · Comments · Reactions · Watched with |
| Recommendations & invites | Recommendations · Friend joined via invite |
| Achievements | bingd Awards |

`follow_request` is deliberately **not** silenceable. A request is a question only the
recipient can answer; an account that could mute them would receive requests it can never
see and the asker would wait for ever.

**Where new types would go, when they exist.** The mapping matters more than the naming,
and the naming should change only once there is something to put in the new group:

| New type | Section | Toggle |
|---|---|---|
| Streak reminder | Achievements | *Weekly streak reminders* (new, 9th) |
| Watchlist release | **Watching** (new 4th section) | *Watchlist & releases* (new) |
| All three friend moments | Social | *Friend moments* (new, one toggle for all three) |
| Watchlist resurfacing | Watching | folds into *Watchlist & releases* |

That lands at 4 sections and 11 toggles, which is over the guardrail — so the rename the
founder sketched (Social / Watching / Progress) should happen **in the same change** that
adds the first Watching type, folding *Achievements* and the streak into *Progress*. Not
before: renaming a section today churns copy and tests for a group with nothing new in it.

**No toggle is added ahead of its writer.** `NotificationSetting.pending` exists for a
category that ships before its sender and is currently carried by nobody; a switch for
traffic the app does not produce is untruthful UI, and it was untruthful once already
(`invites` carried the flag after it had a writer).

---

## 6. Release-date safety

**Do not treat every date as a release.** `media_items.release_date` is TMDB's primary
date — for a film, usually the *theatrical* one — and three things follow:

- **"Now streaming" cannot be claimed from it.** Where-to-watch and release date are
  separate facts, and `WhereToWatch` reads availability live from a different call.
  Copy must be `"[Title] is out today."` and nothing stronger, unless bingd actually
  knows the streaming fact.
- **It has no region.** A date that is right for the US can be months off elsewhere.
- **The catalogue is a cache.** `media_items` holds what somebody already searched for,
  and a row's `release_date` was written when it was last enriched. An unreleased film's
  date is exactly the one most likely to move after it was cached.

For television, use season or episode air dates only where they are reliable;
`tmdb_upsert_seasons` does not write them today.

**Verdict: Class B release notifications stay DEFERRED** until there is a refresh path
that keeps a watchlist title's future date current. Building the sender against a stale
cached date would produce "out today" on the wrong day, which is worse than silence and
is precisely the kind of thing that costs a push permission permanently.

---

## 7. The global proactive cap

Conservative, and deliberately so. It is easier to raise a cap after watching the numbers
than to win back somebody who turned push off.

- **Maximum 2 proactive pushes per rolling 7 days**, per reader.
- **Minimum ~36 hours between them.**
- **Class A is exempt.** Direct social is not engagement marketing.

**Priority when several candidates exist on the same day:**

| | Types |
|---|---|
| **P1** Truly time-sensitive | release day; streak about to expire |
| **P2** High-context friend opportunity | friend watched your watchlist title; mutual watchlist; recent same-watch |
| **P3** Contextual watchlist resurfacing | |
| **P4** Personalised / trending | |

Within a tier: stronger explicit intent first, then the more recent trigger, then — once
there is data — that reader's own historical conversion for that type. **Deterministic
rules. No model.**

**Send only the winner. Losers are dropped, not queued.** A queue of stale nudges is how
somebody gets told on Thursday about something that mattered on Monday.

### The suppression log, and why it is not optional

Every candidate that is *not* sent should be recorded with the reason:

`preference_off` · `global_cap` · `type_cooldown` · `duplicate` · `already_completed` ·
`stale` · `higher_priority_candidate_won` · `quiet_window`

Without it there is no way to tell **"this type never works"** from **"this type is never
selected"** — and those two have opposite fixes. It is also the only way to know whether
the cap is binding at all before deciding to change it.

**This is the piece that needs a migration**: a small append-only table keyed by
(reader, type, decided_at) with the reason, plus an index for the rolling-window query.
The cap read and the log write are the same table, which is what keeps them honest.
None of it exists yet.

---

## 8. Measurement

Per type: **eligible candidates → sent → suppressed (by reason) → opened → converted.**

Conversion is type-specific, and open rate is never the success metric on its own — a
notification that is opened and then abandoned is a notification that lied about what was
behind it:

| Type | Conversion |
|---|---|
| Streak reminder | A completed ranking inside the attribution window |
| Watchlist release | Title detail opened, and separately whether it is ranked later |
| Friend watched your watchlist title | A reaction or comment on their post, or engaging with the title |
| Mutual watchlist | Title viewed, later ranked, or taken into Group Picks |

**Organic and notification-assisted must be separable, or the retention question cannot
be answered.** `ranking_completed` already carries `surface`; a notification-opened
ranking has to be attributable to the push that produced it — a surface value, or an
attribution window opened by the tap — decided *before* the first proactive type ships,
because data gathered without it cannot be repaired afterwards.

`streak_state_viewed` (live) carries the streak distribution, which is what says whether
the mechanic is doing anything before any push exists at all.

---

## 9. Old-client safety

**iOS 1.0 (7) is in the store and Android build 8 is the beta binary.** Neither knows
about routes added after it shipped.

Any new proactive type must therefore be **implemented-disabled or rollout-gated** until
compatible clients are live. Two specific hazards:

- **`hrefForPush` on an old client** cannot route a payload key it has never seen, and
  falls back to the feed. That is safe but wastes the notification.
- **A new preference category** must default in the direction the reader would expect,
  and `_notification_default` (20260828000100) is the mechanism: absence means the
  default, and an account with a row chose. No backfill — a backfill is exactly what
  breaks that.

The award celebration deep link added on 2026-09-06 follows this rule: the *in-app*
inbox routes to it because the row already carries the identity, and **push taps are
unchanged**, because the push payload does not name the award and the sender was not
touched.

---

## 10. What this pass actually changed

- **Wrote this document.** There was no canonical notification strategy before it.
- **`award_earned` now opens the award itself** in the in-app inbox, not the shelf. No
  schema change, no payload change, and a fallback to the old destination for any row
  that does not name a tier.
- **Nothing else was sent, enabled, or scheduled.** Every proactive type above is
  DEFERRED, and each names what specifically blocks it: a stored timezone, a scheduled
  candidate query, a cap ledger, or a release-date refresh path. Three of those four are
  database migrations, and this pass was not authorised to apply one.

The next honest step is **PR C**: the cap-and-suppression ledger plus the arbitration
function, with `friend_watched_your_watchlist` as the first type through it — because the
cap has to exist before the first proactive type, not after the second.

---

## 11. A hierarchy for proactive notifications

**Status: proposed, 2026-09-19, from the founder's review of the release-awareness shadow.**
Nothing here is built beyond what release awareness already runs in shadow
([`release-awareness.md`](./release-awareness.md)). This section exists so the next
proactive type is placed rather than invented, and so §7's cap question is settled with
evidence instead of a number chosen in advance.

### 11.1 The three bands

| Band | What belongs in it | Why it ranks there | Interruption |
|---|---|---|---|
| **HIGH: a person acted toward you** | A direct recommendation from somebody; a reply, comment or mention; a reaction to your activity; a follow or follow request; somebody saying they watched with you | Another person is waiting at the other end. Missing it is not a missed suggestion, it is a missed exchange, and it cannot be recovered later | Always eligible. Outside every cap, as Class A already is |
| **HIGH INTENT: something you asked about is happening** | A caught-up new season; a watchlisted film opening in theaters (T-7) | The reader recorded the interest themselves, by ranking a season or saving a title. The event is a fact about that exact thing, on a day that matters | Eligible, and not suppressed by volume alone: see 11.3 |
| **LOWER: an opportunity somebody might like** | Shared Watchlist overlap (not built); "several friends ranked this"; resurfacing a long-saved title; anything trending or taste-derived | Nobody asked, and nothing is lost if it arrives later or not at all | Eligible only under strict conditions, and the first candidate for bundling or for silence |

Two rules follow from the table rather than from taste:

- **A behind-tier release event is in-app only.** It is high intent about a series, but the
  reader is not caught up, so the day it lands is not their day.
- **A lower band never consumes the budget of a higher one.** If something has to give, it
  gives from the bottom.

### 11.2 Shared Watchlist, when it is built

Not implemented and not scheduled. It is written down because it is the archetype of the
lower band and the one most likely to be built next, so its constraints belong on paper
before anybody is tempted.

The event: two people have independently saved the same title, so there is a plan to be
made. **Every one of these has to hold.**

- **Both saved it independently.** Neither was told to by the other, and neither add came
  from a recommendation the other sent.
- **The relationship is real and visible.** A mutual follow, and the privacy rules let each
  see the other's activity. A one-way follower is a stranger's evening.
- **They have interacted recently and meaningfully**: a recommendation, a comment, a
  reaction or a watched-with, inside a bounded recent window. Two accounts that have never
  spoken have no plan to make.
- **Neither has watched it.** A plan about a film somebody already saw is noise.
- **Dedupe by pair and title, permanently**, in the ledger pattern releases already use.
- **Both still have it saved at send time**, not only when the candidate was generated.

**It must not bombard the people who use the product most.** Somebody with two hundred
mutual follows and a large watchlist can generate hundreds of these, and the person the
product works best for must not be the person it punishes. The controls, to be chosen with
evidence rather than all at once:

| Control | What it does | When it is the right answer |
|---|---|---|
| Per-type cooldown | At most one of this type per reader per period | The type is repetitive by nature |
| Per-pair cooldown | At most one about this pair per period | One friendship should not fill an inbox |
| Global soft cap | A budget that **degrades** rather than discards: over budget, the band drops to in-app only | Volume is occasionally high |
| Batching or digest | One notification about several overlaps, opening to a list | Volume is routinely high. The most likely answer for this type |
| Priority suppression | A lower band yields to a higher one inside a window | Two bands collide on the same day |

**Prefer prioritisation and bundling over arbitrary first-come dropping.** Dropping the
second thing that happened is the worst option available: invisible to the reader, random
from their point of view, and it destroys the one signal that says whether the type works.
That is the correction the founder made to release awareness on 2026-09-19, and it
generalises past releases.

### 11.3 What the shadow measures, and what it decides

Release awareness records the uncapped result and, beside it, what the former
2-per-7-days and 36-hour rules would have suppressed. When there is data:

- **If a cap would rarely have bitten**, no cap is added, and §7's number is retired rather
  than inherited.
- **If it would have bitten a few heavy users**, the answer is a soft cap or a digest for
  the lower band, never a hard drop of a high-intent event.
- **If it would have bitten everybody**, the type itself is wrong, and eligibility is what
  changes.

### 11.4 Streaming availability: removed from the roadmap

`watchlist_now_streaming`, "availability added to a watchlist title" and a "Streaming now"
Watchlist filter are **removed** (founder, 2026-09-19), not deferred. Where to Watch stays
as the downstream utility on the title page. The reasons the §3 rows give are unchanged and
still correct: availability is read live and stored nowhere, so there is nothing to diff,
and the underlying data moves around enough that "now streaming" is a promise the product
cannot keep.
