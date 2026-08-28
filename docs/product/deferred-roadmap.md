# Deferred roadmap — product capability that is specified, wanted, and not being built yet

**Status:** current as of 2026-08-28, when §5's notifications half shipped.

**Companion documents:** [`PRD.md`](./PRD.md) · [`analytics.md`](./analytics.md) ·
[`growth-instrumentation.md`](./growth-instrumentation.md) · [`backlog.md`](./backlog.md) ·
[`open-questions.md`](./open-questions.md)

---

## What this document is, and what it must never become

This is the register of **product capability deliberately deferred**. Every entry is
something somebody wants, that has been thought about properly, and that is not being
built before the friend beta.

**It is not the bug list.** A security defect, a privacy defect or an unresolved
release-hardening blocker does not belong here, because a roadmap is a document people
read as *"nice things, later"* — and filing a blocker among them is how a blocker stops
being one.

Those live in [`../release/public-launch-risk-register.md`](../release/public-launch-risk-register.md),
which since 2026-08-23 is the **tracked** home for pre-public majors, beta-safe minors and
accepted risks, with the release classification for both lanes. The working run logs
`.agent-workflow/continuation.md` and `.agent-workflow/feature-completion-status.md` still
hold the blow-by-blow, but they are **gitignored and founder-local** — nothing that has to
survive a fresh clone may live only there.

**§7 used to break that rule and no longer does.** The invite and referral resolver was
carried here *and* on the hardening list, because it was genuinely both. It was built on
2026-08-19; what is left under that heading is the store-distribution half, which was
always release-phase work and belongs here without qualification.

Each entry states: **what it is · why it is wanted · why it is not being built now · what
should bring it back · what it depends on.**

---

## 1. People and actor search

**What it is.** A grouped cast-and-crew section in Search, alongside titles and member
accounts, so that typing "Tilda Swinton" finds the person and opens the person page the
app already has (`app/person/[id].tsx`, reached today only by tapping a face in a cast
strip).

> **The word "People" is spent (2026-08-27).** Search's member section — previously
> titled "Members" partly to reserve People for this feature — is now titled **People**,
> matching the For You category and a People filter chip: the app had already spent the
> word on accounts everywhere else, and one surface using it differently was the
> inconsistency. When this feature ships it needs its own label ("Cast & crew" or
> similar), not People.

**Why it is wanted.** The person page is built, real and good — a portrait, a biography, a
filmography drawn from TMDB and cached, with the reader's own Saved / Ranked / Watched
state on every row. It is currently reachable by exactly one gesture. Actor-led discovery
is also how a large share of people actually decide what to watch, which is the job Search
exists to do.

**Why it is deferred.** The adapter work is not small and it is not the shape the current
adapter has. `/search/multi` results are filtered to titles and person results are
discarded; adding people means a `/search/person` path or an unfiltered multi-search, a
result type the search screen does not model, a cache table or an extension of
`person_cache`, its own claim/TTL discipline to match `tmdb_claim_person`, and a third
grouped section competing for the top of a screen the founder has already ruled must stay
title-dominant.

**Revisit when.** Members search has real usage in the beta — `member_search_result_opened`
is what will say — or when a tester asks for it unprompted more than once.

**Depends on.** `tmdb-adapter` Edge Function work · a person search cache · Search screen
grouping · no schema change to anything user-owned.

---

## 2. People by taste match

> **Built on 2026-08-26 (`20260826000500`), and this entry stays for what it got right.**
> For You gained a **`[ Titles ] [ People ]`** switch, and People is two sections —
> **Mutuals** (friend-of-a-friend, by shared-connection count) and **Taste matches**
> (scored by `taste_match` itself). PRD §13 As-built is the specification.
>
> **Every disqualification below was honoured rather than waived.** There is no
> all-users × all-ratings calculation anywhere near the client: `people_taste_matches` is a
> definer RPC that narrows candidates to accounts sharing at least `taste.min_common` exact
> titles *before* it computes anything, excludes self, blocks in either direction, anybody
> already followed and anybody already **asked**, and applies `can_view_profile` and
> `can_discover_profile` from the caller's own side. `people_mutuals` counts only edges
> `follows_read` would admit to the caller individually, and never names them.
>
> **What changed the timing** is the second section. This entry was deferred to 50–100 real
> users because taste alone would answer "here are the four people you already follow" in a
> cohort of thirty — which is true, and is exactly why Mutuals leads. A friend beta has a
> dense follow graph and a sparse ranking graph, so the graph-based section carries the
> screen at the size where the taste-based one cannot.
>
> **What is still deferred from this entry:** nothing of the design, and one thing that was
> never in it — finding people through the address book, which is now §21.

**What it is.** A **Users** surface inside For You: other members ranked by Taste Match,
each with a Follow action and a route to their profile.

**Why it is wanted.** It is the only mechanism in the product that grows somebody's
network from *taste* rather than from an address book, and the taste-match score already
exists and is already trusted (PRD §13).

**Why it is deferred.** Candidate generation is the whole problem, and the naive version
is disqualified rather than merely slow: **no all-users × all-ratings calculation on the
client, ever.** A correct version needs a bounded candidate set — public and discoverable
accounts only, excluding self, blocked in either direction, and anybody already followed —
computed server-side, plus an empty state that is honest when the cohort is thirty people
who all follow each other already.

**Revisit when.** Roughly **50–100 real users**, or earlier if network discovery is
observably the thing limiting the beta. Below that the answer would be "here are the four
people you already follow".

**Depends on.** A server-side candidate RPC · taste-match ranking over that set ·
`can_discover_profile` semantics (already correct) · a For You surface that can hold a
non-title card.

---

## 3. Followers score

**What it is.** A third score beside **Bingd** and **Following** — the average rating from
accounts that follow *the viewer* — possibly presented as a horizontal or swipeable set of
three.

**Why it is wanted.** Symmetry, and a genuinely different reading: "what do the people who
chose to follow me think of this" is not the same question as "what do the people I chose
to follow think".

**Why it is deferred.** Marginal value at beta scale against real cost. `following_score`
was audited on 2026-08-19 and is correct — it joins `f.follower_id = auth.uid()` and
`r.user_id = f.followee_id`, so it reports followees and not followers, and a test already
asserts that direction. A Followers score is a second definer function with its own
visibility reasoning, plus a UI decision about how three scores sit where two sit now. In a
cohort where almost every follow is mutual, the two numbers would be nearly identical.

**Revisit when.** The follow graph is meaningfully asymmetric — that is, when accounts
routinely have followers they do not follow back.

**Depends on.** A `followers_score` function mirroring `following_score` · a score
presentation decision · nothing else.

---

## 4. Native push notifications

> **Built on 2026-08-24 (`public/push-v1`), and this entry stays for the correction in it.**
> Registration, delivery, permission timing and deep-link routing all exist;
> [`docs/architecture/push.md`](../architecture/push.md) is the architecture and
> [`push-sender/README.md`](../../supabase/functions/push-sender/README.md) is the founder
> checklist. What remains deferred is a **scheduler** for the outbox and **receipt
> reconciliation**, both recorded there.
>
> **The "no new native binary" conclusion below was wrong**, and it is left in place with
> its correction rather than deleted, because it was reached twice from the same true
> premise and the reasoning is worth being able to find. See the block at the end of this
> section.

**What it is.** Device-token registration and real push delivery for the notification
types that already exist.

**Why it is wanted.** PRD §15 specifies it, and the whole notification layer was built
with it in mind: `expo-notifications` and its config plugin are in every build from the
first one, precisely so that enabling push is a server flag and an OTA update rather than
a new native build and a store submission.

**Why it is deferred.** It has never been built. `device_tokens` is written by nothing, no
client imports `expo-notifications` beyond the config plugin, and delivery is dark (AD-10).

**The decision push has to make when it arrives**, recorded here because it is not
obvious: **notification preferences currently gate *creation*, not delivery.** The gate is
a before-insert trigger that returns null, so "off" means the row was never written — and a
row that was never written cannot be pushed. Push must decide deliberately whether it
shares that single axis or needs its own per-channel preference, and the current contract
is *"off here means it never existed"*.

**Revisit when.** After the friend beta has run on Preview builds, and never in the same
tranche as a store submission.

**Depends on.** Apple and Google push credentials · a `device_tokens` writer and its
lifecycle · a delivery path · the preference-axis decision above · OS permission timing
(PRD §15: after a first invite or first follow, never at launch).

**Re-verified 2026-08-23**, prompted by a real follow that produced an inbox row and no
phone notification. The entry above was accurate and remains so. Two things worth adding,
because they decide how expensive this is when it is scheduled:

- ~~**No new native binary is needed.** `expo-notifications` and its config plugin are in
  every build, which is exactly what §15 bought them for. The smallest slice is
  JavaScript, one RPC and one delivery path.~~ **False, and corrected 2026-08-24 — see
  below.**
- **The credentials are not configured, and PRD §15 said they were.** `app.config.ts`
  declares no `googleServicesFile` on either platform and no `aps-environment`
  entitlement; both credential files are gitignored. This is a founder task with Apple
  and Google, not an engineering one, and it is the long pole. PRD §15 and §27 have been
  corrected.

**The smallest honest slice**, in order, none of which is started:

1. `register_device_token(p_operation_id, p_token, p_platform)` — a definer writer for
   `device_tokens`, which already exists and has no read policy by design.
2. A client that asks for permission at the moment PRD §15 names, takes a token, and
   registers it. Revoke on sign-out, or a second account inherits the first one's device.
3. A delivery path — most cheaply an Edge Function invoked from the same place the
   `notifications` insert happens, reading `device_tokens` and calling Expo Push.
4. The preference-axis decision above, which has to be made *before* 3 rather than after.

**Still not friend-beta work.** The inbox is the channel the beta was built to test, and
it works. Push is a public-launch item and belongs in the same release as the credentials.

### Corrected 2026-08-24: push **does** gate a new native binary

The premise was true and the conclusion drawn from it was not. `expo-notifications` and its
config plugin have been in every build since the first one — and the plugin's **iOS
defaults** were never examined (`expo-notifications@57.0.10`,
`plugin/build/withNotificationsIOS.js`):

```js
const withNotificationsIOS = (config, { mode = 'development', ... }) => {
  config = withEntitlementsPlist(config, (config) => {
    if (!config.modResults['aps-environment']) {
      config.modResults['aps-environment'] = mode;
```

`app.config.ts` passed only `{ color }`. So **every binary this project has ever produced is
entitled to the APNs sandbox**, including the ones bound for the App Store. A production
build with that entitlement registers against a service the production sender never talks
to, and nothing about it looks wrong — no crash, no warning, no visible difference.

Android reaches the same place by a different route: FCM needs `google-services.json`
compiled in, and `android.googleServicesFile` was declared nowhere. The second bullet above
noticed both absences and read them as *credentials*, which is a founder task; they are
also *native configuration*, which is an engineering one, and that is the half that was
missed.

Both are native inputs and neither can change over the air. The corrected statement:

> **Enabling push needs a new production binary and a store submission.** What
> `expo-notifications` being present from the first build actually bought is smaller and
> still real: no new native *dependency*, so autolinking, the native module graph and every
> other build input are unchanged — and the change is three lines of configuration rather
> than a dependency upgrade.

`public/push-v1` makes that configuration production-only, so the published friend-beta
binary's fingerprint does not move and it keeps receiving over-the-air updates.
[`docs/architecture/push.md` §2](../architecture/push.md) records the measurements.

**The preference-axis decision above has been made: one axis**, enforced structurally
rather than by a second check — a suppressed notification is never written, and the enqueue
is an `AFTER INSERT` trigger. No per-channel settings were added.

### What is still deferred

1. **A scheduler for `push_outbox`.** Nothing drains it on a timer; the app nudges the
   sender after a write and on foreground. A notification created while nobody has the app
   open waits until somebody does. One scheduled job against the same Edge Function closes
   it, and nothing else changes.
2. **Receipt reconciliation.** Expo answers a send with a *ticket*; the final outcome is a
   *receipt* fetched later. Polling them needs a second scheduled process and a table of
   ticket ids — a queue-processing platform for the one thing receipts add over tickets.
   Send-time `DeviceNotRegistered` catches the ordinary uninstall and revokes the token;
   the rest is caught on that token's next send.
3. **A way back from "Not now."** The permission question is asked once ever, and there is
   no control in Settings to change that answer afterwards.
4. **The scheduled nudge** (PRD §15), which ships with push in the PRD's plan and is not in
   this tranche. It stays deferred as §15 below.
5. **A sign-out that cannot be outrun.** `releaseDeviceOnSignOut` moves a session epoch,
   then waits up to three seconds for registrations already in flight so their compensating
   revoke happens while the session still exists. Past that ceiling it proceeds. A
   registration that lands *after* it — with a JWT still valid server-side — leaves the
   token owned by the account that just signed out, and the compensating revoke fails
   because the local session is gone. The backstop is the server's move-on-conflict: the
   **next** account to sign in on that phone takes the device in one statement. So the
   exposure is a phone signed out and left signed out, and it ends the moment anybody signs
   in. Closing it properly needs server-side ownership epochs — an `operation_id` the
   server can recognise as belonging to an ended session — which is a schema change and new
   push behaviour rather than a fix. **Raised by independent review 40 and accepted as a
   bounded residual risk**, not a defect introduced by the integration.
6. **An outbox row can outlive its attempt ceiling.** `claim_push_batch` increments
   `attempts` as it claims, and the due predicate is `attempts < 3`. A sender that dies
   between its **third** claim and its settlement therefore leaves a row that no lease
   expiry can make claimable again — it is deleted only by the cascade when its notification
   goes. One stranded row per crashed final attempt, invisible to every client, and the
   in-app notification it was for has already arrived. Left alone deliberately: every fix
   changes claim or lease semantics, and this tranche is the last one before the native
   surface freezes. **Raised by independent review 40.**

---

## 5. Award notifications, and `award_earned` analytics

> ### ✅ The notifications half is DONE — 2026-08-28, `20260828000100`.
>
> The ledger this item was waiting on was built, and the writer with it: `award_unlocks`
> — insert-wins on `(user_id, award, tier)`, written by `AFTER` triggers on the eight
> source tables — records each crossing durably, and a milestone newly earned produces
> exactly one `award_earned` feed post, exactly one congratulations notification, and a
> push when eligible. The exactly-once demand this entry insisted on ("an award
> notification that fires twice is worse than one that never fires") is met structurally,
> and the backfill announced nothing for tiers earned before the rollout. The full
> disposition is PRD §14's As-built block dated 2026-08-28.
>
> **The constraint recorded here on 2026-08-27 was honored.** The Invite Instigator
> payload carries `{award, tier, award_name, tier_label}` and nothing else — no invitee,
> no token, no timestamp anywhere in the post, the notification or the push. Hype
> Courier, whose progress is withheld from visitors, gets the private congratulations and
> **no feed post** for the same reason the count is withheld.
>
> **The analytics half stays deferred**, with a new reason recorded in
> [`analytics.md`](./analytics.md) §4: the crossing is now a server-side fact, and the
> client has no honest emission point for it.

---

## 6. Comment notifications that deep-link to the exact event

**What it is.** Tapping "somebody commented on your ranking" landing on *that comment*,
rather than on the title the ranking is about.

**Why it is wanted.** The title is the right neighbourhood and the wrong address. With a
busy title page the reader has to go looking for the thing they were told about.

**Why it is deferred.** There is no per-event route, and the feed tab is a paginated list
of *followees'* activity — **a reader's own event does not appear in it at all**. So the
two obvious targets are a route that does not exist and a screen that structurally cannot
contain the subject. Routing to a screen that cannot hold the thing is worse than routing
to its parent, so comment and reaction notifications route to the title deliberately.

**Revisit when.** A per-event route exists, which is most naturally a by-product of
building a permalink for a feed event — something sharing will want anyway.

**Depends on.** An event detail route · a read path that admits the reader's own events ·
the notification routing chain (already built and ordered, `notifications/routing.ts`).

---

## 7. Public store distribution for the invite resolver

> ### ✅ The resolver itself is DONE — 2026-08-19, `20260819000500`.
>
> This item used to be "the invite and referral activation resolver", and it was carried
> as a friend-beta growth blocker. **That blocker is closed.** What remains under this
> heading is the distribution half, which was always release-phase work.

**What was built.** `record_invite_open`, `redeem_invite` — including §17's acceptance
semantics, the one-way follow and the private-account request — `revoke_invite_link` with
its Settings control, and the activation writer, plus the `bingd.app` router at `/i/*`,
`/u/*`, `/title/*` and `/lists/*` and the two `.well-known` files that make a tapped link
open the app. `invite_attributions.accepted_at`
and `activated_at` have writers for the first time since `20260813001300`; Invite
Instigator counts real people; `invite_redeemed` and `invite_activated` are emittable and
emitted; `acquisition_source: 'invite'` has its first honest caller. The full disposition
is in [`growth-instrumentation.md`](./growth-instrumentation.md) §1 and PRD §17's As-built
block.

**What is deferred, and it is two things.**

**1. Deferred install attribution.** A token does not survive a trip through the App Store,
TestFlight or Play. The beta mechanism is honest and manual: the landing page keeps the
token in the address bar, and after installing, the visitor returns to it and taps *I
already have Bingd*. Somebody who instead launches from their home screen arrives with no
token and is **not attributed, permanently and undetectably**. Every invite number is a
floor.

Closing this needs Play Install Referrer on Android, and on iOS a deferred deep-link
vendor — Branch, AppsFlyer or Adjust. **None is being added for a beta**: each is an SDK,
a privacy review, a native build, and a data-sharing relationship, bought to recover a
population nobody has yet measured. Revisit when the landing page's own numbers show the
drop-off is large enough to justify all four costs, which is a question the current
instrumentation can now actually answer.

**Never** by fingerprinting, IP-and-timestamp matching or clipboard reading. That is a
privacy position, not a cost trade-off, and it is not open for revisiting.

**2. The distribution destinations themselves.** `web/distribution.config.json` has a slot
for a public TestFlight URL and a Play closed-test opt-in URL, and both are `null` — so
every route currently shows *the Bingd beta is not open for this device yet*, which is
true. Filling them in changes no invitation link anybody has already sent, and needs no
app rebuild. **A live `bingd.app` deployment is the harder prerequisite**: until the site
is hosted, Universal Links and App Links cannot verify at all.

**Revisit when.** The hosting and the two URLs are founder actions on the beta-release
path, not roadmap work. The vendor question is genuinely deferred.

> **Scope of the ✅ above, stated exactly.** It means the resolver's *code* is complete and
> reviewed: every stage has a writer, every clause of §17's acceptance semantics runs, and
> revocation exists. It does **not** mean invitations work on a phone today. Nothing is
> hosted at `bingd.app`, so Universal Links and App Links have never verified and have
> never been tested on a physical device — and until they do, a tapped invitation opens a
> browser that 404s. That is a founder action, and it is the first line of the next phase
> rather than a footnote to this one.

---

## 8. `recommendations_to_me` paging past 200

**What it is.** Scrolling Sent to you beyond the newest 200 recommendations.

**Why it is wanted.** Completeness, eventually.

**Why it is deferred.** The 200 is **presentation-only** and nothing canonical depends on
it: no count, no award, no badge and no score is computed from the truncated list. Paging
means server or RPC work — a cursor on `recommendations_to_me` — to reach a case that
requires somebody to have been sent two hundred recommendations.

**Revisit when.** Anybody reaches it. In a friend beta nobody will.

**Depends on.** A keyset cursor on the RPC · a paginated list on the Sent to you surface.

---

## 9. Advanced GTM analytics

**What it is.** The retention and funnel practice: a formal activation funnel with the
24-hour bound PRD §28 defines, D1 / D7 / D14 / D28 retention, behavioural retention by
cohort, and acquisition-cohort comparison.

**Why it is wanted.** It is how the decision "does this work" eventually gets made.

**Why it is deferred.** All of it is a *question asked of data*, and the eleven canonical
events in [`analytics.md`](./analytics.md) are the data. Building dashboards and cohort
infrastructure before there are thirty users produces charts of noise, and the first
version would be built against guesses about which cuts matter. A durable client-side
analytics outbox belongs in this bucket too.

**Revisit when.** After the friend beta has produced a few weeks of real events — and it
is then largely configuration in PostHog rather than app work, which is the point of
having got the event semantics right first.

**Depends on.** Real volume · the canonical event set (done) · nothing in the app.

---

## 10. Paid and mobile attribution

**What it is.** Campaign links, Meta / Google / Apple ad attribution, and a CAC →
activation → retention chain.

**Why it is wanted.** Nothing can be spent on acquisition responsibly without it.

**Why it is deferred.** Nothing is being spent on acquisition. Every SDK in this class —
Meta, AppsFlyer, Branch, Adjust — is a third-party dependency with device-graph access, a
store privacy-label consequence and its own privacy review, added for a campaign that does
not exist.

**Revisit when.** There is a budget and a campaign.

**Depends on.** `acquisition_source` and `beta_cohort` (prepared, nullable, unset today) ·
a store listing · a privacy policy that covers third-party attribution.

---

## 11. Sponsorship analytics

**What it is.** Content impressions, precise viewability, trailer and watchlist conversion,
and sponsored or campaign dimensions on the relevant events.

**Why it is wanted.** It is the reporting a sponsor would require.

**Why it is deferred.** There is no sponsored content in the product, and viewability in
particular is a specification unto itself — "was it on screen, how much of it, for how
long" is not a property that can be bolted onto an existing event honestly later.

**Revisit when.** A sponsorship is actually being discussed.

**Depends on.** Sponsored content existing · an impression event with a viewability
definition agreed *before* the first number is reported.

---

## 12. Experimentation platform

**What it is.** Feature flags, A/B assignment, exposure logging and a readout.

**Why it is wanted.** Eventually every tuning decision — ranking thresholds, slate size,
nudge timing — wants one.

**Why it is deferred.** A cohort of thirty to sixty friends cannot power an experiment.
Any result would be noise presented with a confidence interval, which is worse than an
opinion presented as an opinion. PostHog ships feature flags, so the vendor decision is
already made whenever this becomes real.

**Revisit when.** The user base can detect an effect worth acting on.

**Depends on.** Volume · PostHog flags (available, unused) · an exposure event.

---

## 13. Quarterly Recap / Wrapped

**What it is.** Three to five cards at quarter end — movies, seasons, favourite of each, a
taste line — ending in one shareable composition. High priority, post-beta. Specified in
full in [`backlog.md`](./backlog.md) §2.

**Why it is wanted.** Two jobs at once: a reason for a lapsed user to come back, and the
one artifact in Bingd somebody would post unprompted.

**Why it is deferred.** Beyond being a whole feature, it has a **hard prerequisite** that
is recorded as debt rather than as a nice-to-have. Quarter membership must use
`watched_on`, not `rankings.created_at` and not `user_media.created_at` — a recap is about
when somebody *watched* things, and both other columns record when they got round to
telling Bingd. But `watched_on` is nullable and there is **one per title**, so a watch with
no date cannot be placed in a quarter and a rewatch overwrites the first date.

Cross-year rewatch is debt item 1 in `feature-completion-status.md`, and the standing rule
there is that **no year-in-review or past-period selector ships before it is resolved**. A
recap is exactly that feature.

**One design constraint, decided and not to be rediscovered:** the final shareable card
must make it obvious that Bingd tracks **both movies and TV seasons**. That is the
differentiator against every film-only app, and a card showing five film posters says the
opposite of it.

**Revisit when.** Cross-year rewatch is resolved, and the beta is over.

**Depends on.** Rewatch history · a developer period override from the first commit (this
feature is testable four times a year otherwise) · no stored recap, which would be a second
version of the truth.

---

## 14. Remaining custom Award artwork

**What it is.** Drawn badge art for the **ten of twenty** award tracks that still render an
emoji placeholder (`src/features/awards/badges.ts`, asserted by its own test so the count
cannot drift unnoticed).

**Why it is wanted.** Awards are a collectible wall. A wall works because the art is worth
collecting, and an emoji among drawn badges reads as a placeholder — which it is.

**Why it is deferred.** It is a design workstream rather than an engineering one, it blocks
nothing, and it is the single most reversible thing in this document: replacing an asset
changes no logic, no schema and no test.

**Revisit when.** There is design capacity, and before any public launch.

**Depends on.** Design time · `assets/brand` render pipeline (already exists).

---

## 15. Marketing and reminder nudges — "Recommendations & reminders"

**What it is.** Optional prompts that bring somebody back to Bingd when nothing they did
caused them: *something good to watch tonight*, *fresh film recommendations*, *fresh TV
recommendations*. A category of its own, separate from the eight that exist, because every
one of those is somebody else doing something to you and none of these is.

**Founder brief, 2026-08-20.** Recorded in full so the shape does not have to be
re-derived:

- A **separate Marketing / Reminders section** in notification settings, not folded into
  Social or Recommendations & invites. A reminder from the app is a different kind of thing
  from a person recommending you a film, and one switch must never govern both.
- A user-facing label along the lines of **"Recommendations & reminders"** — a plain
  description of what arrives, not a euphemism for marketing.
- **Default OFF.** The opposite of every functional category, and deliberately so: the
  others are consequences of something the user did, and this one is the app asking for
  attention it was not given.
- **No dark patterns and no engagement spam.** Opting out has to be one obvious control
  that stays opted out.
- **Cadence controls if the volume ever justifies them** — a frequency choice rather than
  only on and off. Not before there is traffic to control.

**Why it is deferred, and why no toggle ships now.** *Delivery does not exist.* Native push
is §4 and is not built: nothing writes `device_tokens`, and no client imports
`expo-notifications` beyond the config plugin. The architecture was re-read during the
2026-08-20 micropass rather than assumed, and **there is no scheduled delivery of any
kind**. A notification preference gates *row creation* inside a before-insert trigger, so a
"reminder" today could only be a row the user discovers the next time they open the app of
their own accord.

That is the whole argument. A nudge whose entire purpose is to reach somebody who is *not*
in the app cannot be served by something only visible to somebody who already is. Shipping
the switch first would put a control in Settings that does nothing, and the instruction for
that pass was explicit: a dead toggle is worse than an absent one.

**Revisit when.** §4 lands. This is a section of that work rather than something to build
beside it.

**Depends on.** §4 native push · a scheduling path (an Edge Function on a cron, or the
provider's own scheduling) · a ninth notification category and its default · the
preference-axis decision recorded in §4.

---

## 16. Collection: swipe between tabs

**What it is.** Swiping left and right to move between the Collection segments — Watched,
Watchlist and Unranked — instead of only tapping the segmented control.

**Why it is wanted.** Founder suggestion, 2026-08-20. It is the gesture the segments look
like they should support, and every app with a segmented row over a list has trained people
to try it.

**Why it is deferred.** Audited against the current primitives during the Preview micropass,
and it is not the small change it looks like. Four findings, any one of which is enough:

- **Only the active segment is mounted.** `app/(tabs)/collection.tsx` renders exactly one of
  `Watched`, `Watchlist` or `Unranked`. Paging needs the neighbours mounted and laid out
  side by side, which means three collections in memory and three queries live instead of
  one.
- **The segment set is dynamic.** Unranked appears and disappears with `unrankedCount`, so a
  pager's page *indices* would change underneath the reader — and the screen already derives
  a fallback for the case where the segment somebody is standing on vanishes. Page-index
  arithmetic over a list that mutates is its own class of bug.
- **A pager is a native dependency.** `react-native-pager-view` is not installed, and
  installing it moves the native fingerprint — which this release lane cannot absorb without
  new Preview and Beta binaries.
- **The hand-rolled alternative is gesture arbitration, not layout.** Reanimated and
  `react-native-gesture-handler` are both present, so it is *possible* without a new
  dependency. But a horizontal pan over a vertically scrolling list has to be arbitrated
  against that list, against the sheet dismissals, and against the horizontal poster shelves
  elsewhere in the app. That is a gesture-architecture pass, not a screen change.

The brief for the micropass was to implement this **only if it were genuinely trivial with
existing primitives and required no native or runtime change**. It is neither.

**Intended behaviour when it is built.** A swipe moves one segment in that direction and
stops at the ends — no wrap-around, because wrapping makes the last segment feel like a
mistake. The segmented control stays, stays authoritative, and animates with the gesture.
`viewState` — the filters, the sort and the List/Wall choice — is shared across segments
today and must stay shared, so a swipe changes which list is shown and nothing about how it
is shown. Unranked appearing or disappearing must not move the reader.

**Revisit when.** There is a reason to touch the gesture layer anyway, and a tranche that
can carry new native binaries.

**Depends on.** A pager primitive (a native dependency) or a Reanimated pager written here ·
nested-gesture arbitration against `FlashList` and the poster shelves · a decision on
mounting neighbours versus rendering them lazily.

---

## 17. Recommendation freshness beyond a session's own memory

**What it is.** The parts of recommendation freshness that in-memory session exposure does
*not* buy. **The seed shipped** in the 2026-08-20 Preview micropass and **session exposure
shipped in the micropass after it** — see `docs/architecture/recommendations.md` §7 — so
this entry is only the remainder.

**What shipped, second pass (2026-08-20).** The seed alone turned out not to be enough,
and the founder's physical test is the record of it: two consecutive Refreshes kept eight of
the nine visible posters and changed their order. A seed perturbs a *ranking*, and nothing
in the pipeline knew which titles were already on screen, so turnover was a by-product of
how far a random draw happened to move a title. **The session now remembers what it has
presented** and the ranker prefers what it has not — held in module memory, reset by a fresh
process, with no schema and no write path. Measured turnover in the first visible nine is
seven of nine, with up to two score-anchors retained.

**What shipped, first pass.** Scoring and arrangement were split. The query caches the scored
candidates; the wall is drawn from them by seeded sampling over a bounded high-quality pool
(Gumbel top-k, temperature 0.12, pool of three times the wall). A visit is stable, a new
launch is a new **seed**, and an explicit Refresh control changes the seed without a
network call. A new seed is almost always a new arrangement rather than necessarily one —
a zero-spread pool returns strict order for every seed.

**What the pool bound does and does not promise.** The one guarantee is that **sampling
cannot promote a title from outside the pool**. It is *not* a promise that the wall is
drawn only from the top sixty, *not* a promise that the same titles are chosen, and *not*
a promise that the wall stays the same length — the ceilings intersect and are spent in the
order they are met. Reviews 29, 29b and 29c each found a phrasing here claiming one of
those three. The measured cost of the last (nil on the five pool shapes the suite tests), the
rejected truncate-to-pool alternative, and the tests that pin all four propositions down —
including the false ones — are in `docs/architecture/recommendations.md` §7.

**What it does not do, and is deferred:**

- **No memory of what has already been shown *across* sessions**, which is the headline
  remainder and is deliberately preserved here. Exposure lives in module memory and dies
  with the process, so two launches can draw overlapping walls and a reader who refreshed
  through the pool yesterday starts from the top today. A durable impression ledger is a
  schema and a write on every impression — the same ledger PRD §13's *Impression history*
  guardrail and the cooldown rules it specifies both need, and the same one award
  notifications wait on (§5). The micropass brief ruled out adding schema for
  recommendation history, twice, on purpose.
- **No cooldown, and no "repeatedly ignored" signal.** Within a session a title is
  preferred-against once it has been shown; nothing distinguishes a title the reader
  scrolled past four times from one they never reached, and nothing carries either fact
  into tomorrow. PRD §13 specifies both.
- **No novelty or recency term in the score.** Freshness is presentational. A title that
  entered the catalogue yesterday is not favoured over one that has been there a year.
- **No exploration feedback.** Nothing learns from whether an explored title was opened,
  saved or ignored, so the temperature is a constant rather than something that adapts.
- **The candidate pool itself does not widen.** The same anchors return the same `similar`
  lists for weeks (`media_cache`), so refreshing rearranges a fixed set. Genuinely new
  candidates need more anchors, a second candidate source, or a shorter cache life.

**Revisit when.** The beta produces evidence about whether *session* memory was enough.
The signal to watch for is a reader who says the recommendations feel familiar **on opening
the app** rather than on pressing Refresh — that is the cross-session gap and cannot be
closed without the ledger. A complaint about Refresh itself would mean something regressed,
not that this entry came due.

**Depends on.** A decision on impression logging and its privacy cost — a durable record
of what somebody was *shown* is a new category of stored data and PRD §22 has no row for it
· a candidate-source or cache-lifetime change, since a deeper pool is what a cross-session
ledger would need to draw from · PRD §13's explainability rule, which any novelty term has
to stay inside.

---

## 18. Recommendation Engine V2

**What it is.** The recommender rebuilt on evidence rather than on the one signal it has
today. What ships for the friend beta scores candidates from a single reader's ranking
history and arranges them freshly (§17); V2 is the version that also knows what a reader
has *watched*, what people with the same taste liked, and what this reader has already been
shown.

**Founder decision, 2026-08-20: current quality is accepted for the initial friend beta and
tuning stops here.** That is not a claim the recommendations are good. It is a claim that
the next honest improvement cannot be made from the desk — every lever below needs
behaviour from more than one account, and tuning weights against a single founder's
collection produces a model fitted to one person that has to be thrown away the first week
real accounts arrive.

**The three families of signal, none of them built:**

*Content.* Ranking history beyond the anchors currently used · watch history, including
what was logged and never ranked · the Watchlist as a statement of intent rather than as a
list to exclude · genre affinity learnt rather than assumed · cast and crew, which is the
signal a film person would name first and the app already stores · original language ·
era. Today's ranker reaches for `similar` off a handful of anchors and stops.

*Collaborative.* Taste Match already exists and is already computed between two accounts —
it is a **display** value with no path into the ranker. V2 turns it into a weight: the
rankings of highly matched users, what similar users watched, what they liked and
explicitly what they **disliked** — a Not-for-me from three close matches is the strongest
negative signal the product will ever have, and nothing consumes it. Following is a signal
here too, but a weaker and more careful one: people follow friends they do not share taste
with, so it informs and must not dominate.

*Novelty.* A durable exposure ledger, so freshness survives a process restart ·
cross-session turnover · a deliberate exploration term, so the wall is not only the safest
nine titles. §17 is the presentational half of this and shipped; the persistent half is
here because it is the half that needs schema.

**Why not now.** Every family above is a *ratio* problem — how much a co-viewer's dislike
should outweigh a genre match — and a ratio cannot be chosen against one account's data.
Collaborative filtering with one user is not a cold start, it is an empty one. The beta
exists to produce exactly this: 30–60 people ranking heavily against overlapping
catalogues, which is the smallest dataset any of it can be fitted to.

**Revisit when.** The friend beta has run long enough that Taste Match between real pairs
is stable rather than swinging on every new ranking, and there is enough overlap for a
"people who ranked this Loved also ranked" query to return more than noise.

**Depends on.** The impression ledger and its privacy row in PRD §22 (§17) · PRD §13's
explainability rule, which every added term still has to stay inside — a recommendation
the app cannot say a sentence about does not ship, however well it scores · analytics that
can tell an improvement from a change, which today's event set cannot.

---

## 19. Rewatch and repeated viewing history

**Status: designed, not built.** The design below is canonical as of 2026-08-23 and
replaces the sketch that stood here before. It is deliberately *not* implemented in the
friend-beta tranche — see **19.13** for why, and **19.14** for what the founder still has
to decide before it can be.

**What it is.** A title watched more than once, recorded as more than once. Today the
collection holds one `user_media` row per title and one canonical ranking, and a second
viewing has nowhere to go: re-logging a film overwrites the date it carries rather than
adding to it, and the interface has no way to say "again".

**Why it matters more than it sounds.** Rewatching is not an edge case in film culture, it
is most of what affection looks like — and Bingd is a product about what somebody loves.
An app that cannot tell a film seen once from one seen every year is missing the strongest
statement its own data could make.

---

### 19.1 What happens today, traced

Every claim here was checked against HEAD rather than inherited from an earlier document.

| Act | What actually runs | What it writes |
|---|---|---|
| First log / bucket chosen | `LogSheet.tsx` → `set_bucket`, then a conditional `log_watched` | `user_media.bucket`; then `user_media.watched_on` **only if it was null** |
| Watch date saved | `log_watched(p_watched_on)` | `user_media.watched_on`, **in place** |
| Bucketed | `set_bucket` | `user_media.bucket`. No feed event |
| Ranked | `rank_start` → `rank_answer`… → `_rank_finalize` | a `rankings` row; **a new `title_ranked` feed event** |
| Rank again, same bucket | `session.ts` `rankAgain` = `rank_unrank` **then** `rank_start` | deletes and re-inserts the `rankings` row; another `title_ranked` |
| Rank again, different bucket | `rank_rebucket` (atomic, server-side) | same, plus `user_media.bucket` |
| Watch date edited | `log_watched` again, new operation id | **overwrites** `user_media.watched_on` |
| Same title encountered again | nothing distinguishes it from the first time | — |
| Unlogged | `unlog` | deletes the `user_media` row **and** its `title_ranked` / `title_logged` / `season_completed` feed events |

**The blocking facts.**

- **`user_media` is keyed `(user_id, media_item_id)`** and carries a single nullable
  `watched_on date`. One row, one date, per title, forever. `rankings` is keyed the same
  way and carries one `position`.
- **`log_watched` coalesces on insert but overwrites on update**, so a second date replaces
  the first and the first is gone. `docs/architecture/data-model.md` already records this
  as known debt.
- **The collection RPCs are idempotent by operation id** through `_claim_operation` and the
  `processed_operations` ledger. ~~**The ranking RPCs are not**~~ — **they are, as of
  `20260825000200`.** Every ranking RPC bar `rank_cancel` now takes a trailing optional
  `p_operation_id` and claims it through `_claim_operation_result`, which also stores the
  answer so a replay returns the position and score the lost reply carried. This entry
  wanted that mechanism and no longer has to build it.
- **`title_logged` already exists and has no producer.** It is in the `feed_events` type
  CHECK, it is rendered by the client with the verb *watched* (`features/feed/activity.ts`),
  and `unlog` already cleans it up — but **no SQL anywhere inserts one**. The "watched"
  activity type is fully plumbed and entirely unused. `season_completed` is in exactly the
  same state.
- **`title_ranked` is deliberately unconstrained** and a new one is written on every
  finalize, rerank and rebucket. Repetition there is by design.
- **`_leave_watchlist` fires on any genuine `watched_on` transition** and deletes the
  watchlist row for that exact `(user, media item)`.
- **`watch_tags` is keyed `(tagger, tagged, media_item)`**, so who you watched with cannot
  vary between two viewings without a change to that table too.
- **Goals and Awards read `user_media.watched_on` directly** and filter it by date range.
  This is where the missing history actually costs the user something today: a film watched
  in 2025 and rewatched in 2026 counts once, in 2026, and silently leaves the 2025 total.

### 19.2 The product model, and why it fits this codebase

The proposed separation is **adopted**:

| Act | Watch history | Ranking |
|---|---|---|
| First watch | creates the first watch event | bucket and rank established as now |
| **Rewatch** | appends another watch event | **untouched** |
| **Rank again** | **untouched** | repositions the title |
| Rewatch *and* rank again | appends an event | repositions — but only because the user asked twice |

This is not merely compatible with the ranking architecture, it is the only model that
architecture can express. The personalized score is **not stored anywhere**: `score.ts`
derives it from the title's ordinal position inside its band and the band's size, and the
one persisted copy is a snapshot in `feed_events.payload` written at finalize. There is no
per-watch rating in the schema, so "average the ratings of separate viewings" is not a
thing the system could do without inventing a second, competing notion of a rating and
breaking invariant **I2** — that every title in a higher band outranks every title in a
lower one — which `band_bounds`, `rankInBand` and `rankings_position_unique` all depend on.

So the score keeps answering exactly one question: **where does this title rank for me
now.** A rewatch that changed the user's mind is expressed by them re-ranking it, which is
an act they take, not an inference the app makes.

### 19.3 Source of truth, after the change

| Fact | Where it lives | Stored or derived |
|---|---|---|
| That a viewing happened, and when | `watch_events` (new) | **stored**, append-only |
| `watch_count` | `count(*)` over `watch_events` | **derived** |
| `first_watched_at` | `min(watched_on)` | **derived** |
| `last_watched_at` | `max(watched_on)` | **derived**, cached (19.5) |
| Current bucket | `user_media.bucket` | stored, unchanged |
| Current rank | `rankings.position` | stored, unchanged |
| Current score | `score.ts` from position + band size | derived, unchanged |

**Ranking truth is never copied into watch history.** A watch event records that somebody
watched something on a date. It carries no bucket, no position and no score, because each
of those is a fact about the title's place in the whole list rather than about one evening.

### 19.4 The new table

```sql
create table watch_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  watched_on    date,
  created_at    timestamptz not null default now()
);

create index watch_events_owner
  on watch_events (user_id, media_item_id, watched_on desc);
```

`watched_on` is **nullable**, matching `user_media` today: "I have seen this, I do not
recall when" is a real and currently representable state, and a history table that refused
it would be unable to hold the rows being migrated into it.

**No other columns.** No bucket, no score, no note, no companions, no `source`, no
`rewatch boolean`. Each was considered and each fails the same test — it has no current
product requirement, and adding it now would fix a guess in place. In particular there is
deliberately no per-event note or per-event companion list: `watch_tags` would have to be
re-keyed for the latter and that is its own decision (19.14).

### 19.5 What happens to `user_media.watched_on`

**It stays, as a denormalized cache of the last watch.** It is not deprecated and not
dropped.

The reason is blast radius. Four read paths consume it directly — `use-log-state.ts`, the
title screen, `use-goals.ts` and `use-awards.ts` — and making it a view or dropping it
turns a contained migration into a rewrite of Goals, Awards, the title page and the log
sheet in one commit. Keeping it maintained also makes the change **reversible**: drop
`watch_events` and the app is exactly what it is today, because the column every screen
reads was never allowed to go stale.

The write rule is one line: **a watch event whose `watched_on` is later than the cached
value advances it; nothing else touches it.** An out-of-order backfill of an older viewing
therefore adds history without rewriting "last watched", which is the correct behaviour and
is not what the current in-place overwrite does.

**Goals and Awards should move to `watch_events` — but not in the same migration.** That is
where the user-visible win is (a film rewatched in a new year finally counts in both), and
it is also a change to numbers people have already seen. It wants its own pass and its own
before/after check against real beta data.

### 19.6 RPC changes

| RPC | Change |
|---|---|
| `log_watched` | also inserts the **first** `watch_events` row when it is establishing a date on a row that had none. Signature unchanged |
| `log_rewatch` **(new)** | `(p_operation_id uuid, p_media_item_id uuid, p_watched_on date)` — requires an existing `user_media` row, appends a `watch_events` row, advances the cache per 19.5. Returns `{status}` like its siblings |
| `edit_watch_event` **(new, optional for v1)** | `(p_operation_id uuid, p_watch_event_id uuid, p_watched_on date)` — corrects a date **without** claiming another viewing. This is the act the current UI silently performs, and the reason "edit" and "again" must be separate calls rather than one call with different arguments |
| `unlog` | must delete that user's `watch_events` for the title, alongside the `user_media` row it already removes |
| every ranking RPC | **unchanged.** Ranking does not learn about watches |

All of them go through `assert_can_write()` and `_claim_operation`, exactly as the existing
collection writers do.

### 19.7 Ranking interaction

None, by design. `rank_start`, `rank_answer`, `rank_rebucket`, `rank_unrank` and
`_rank_finalize` read nothing from `watch_events` and write nothing to it.

**Updated 2026-08-26.** "Rank again" no longer means only what it meant when this entry
was written: the founder's final pre-RC pass decided that **Rank again is another watch**
and **Change your rating is a correction** (PRD §10 As-built, `20260826000500`). That is a
product decision about a *feed activity* and about which control a reader reaches for — it
does not create a watch record, because there is nowhere to put one until this entry
ships, and it does not change the ranking arithmetic.

What it does do is make the eventual `watch_events` table's job smaller and clearer.
`rank_again` now carries an explicit `p_new_watch`, so the moment a reader declares a
second viewing is already named at the RPC boundary — this design's `log_rewatch` would
write the row that declaration deserves rather than having to infer one from a re-ranking.

~~The one ranking defect this design **does not** fix~~ — **fixed 2026-08-25, ahead of this
entry.** `rankAgain` was `rank_unrank` followed by `rank_start` with no transaction and no
operation id, so a failure between the two left a title logged-but-unranked. It is now a
single server-side `rank_again` transaction, and the whole ranking family carries an
operation id (`20260825000200`). That was the mechanism this entry shares with it, so the
prerequisite is already in place rather than still owed. Since `20260826000500` it does not
unrank at all until the replacement is ready to land.

~~The one ranking defect this design **does not** fix~~ — **fixed 2026-08-25, ahead of this
entry.** `rankAgain` was `rank_unrank` followed by `rank_start` with no transaction and no
operation id, so a failure between the two left a title logged-but-unranked. It is now a
single server-side `rank_again` transaction, and the whole ranking family carries an
operation id (`20260825000200`). That was the mechanism this entry shares with it, so the
prerequisite is already in place rather than still owed.

### 19.8 Watchlist interaction — and the screenshot

A Watchlist control **is** still offered on a title that is already ranked and watched, and
**this is intentional, not stale state.** It means *I want to watch this again*. The
invariant migration says so in as many words — re-adding something you have already seen is
a rewatch, and it is a deliberate act — and the trigger that clears a watchlist entry is
one-directional and fires only on a genuine transition, precisely so that a re-added entry
survives an unrelated edit to the same row.

Under this design that reading gets sharper rather than changing: the watchlist is the
*intention* to watch, `watch_events` is the *record* of having watched, and a rewatch
logged through `log_rewatch` advances `watched_on`, fires `_leave_watchlist`, and correctly
clears the intention it has just satisfied.

The only thing worth changing is the word. **"Watchlist" on a title you have already seen
could read as "Watch again"**, which says the same thing and cannot be mistaken for a stale
control. That is a copy decision for the founder (19.14) and not a semantic one.

### 19.9 Feed implications — evaluated, not built

Three acts, three different truths, and today only one of them speaks:

| Act | Today | Should it be an activity? |
|---|---|---|
| First watch | silent — `title_logged` has no producer | Probably yes, and the type already exists and already renders |
| Rewatch | impossible to express | Yes, and it needs **its own verb** rather than borrowing *watched*, or the feed reads as a duplicate |
| Rerank | **one `title_ranked` for a Rank again, none for a Change your rating** — corrected 2026-08-26 | Settled. See below. |

**The rerank row is no longer "arguably too loud"; it was measurably wrong, and it is
fixed.** The founder saw four identical *ranked War Dogs* activities produced by changing a
rating three times: `_rank_finalize` posted on every completion, and every re-ranking
completes one. `20260826000500` splits the two acts — a second viewing earns exactly one
activity at completion, a correction earns none — which also settles half of the question
this sub-section was holding open. What remains open here is the *first watch*
(`title_logged` still has no producer) and the rewatch verb, both of which need this
entry's schema.

A rewatch can be given a feed event **without** creating a second ranking identity, because
the two are unrelated tables — `title_ranked` carries the position and score, a watch event
carries neither. The dedup idiom for "one of these per title" already exists as a partial
unique index (`feed_events_watchlist_once`), and the equivalent for rewatches is the
opposite: no constraint, because repetition is the point.

**None of this ships in the same pass as the schema.** Turning on a producer for
`title_logged` changes how much every friend's feed contains, on a cohort small enough that
the change would be the dominant thing they notice. Schema first, feed vocabulary second,
with the beta's own numbers in hand.

### 19.10 Title UI — the smallest coherent version

One line, which is the whole feature for most readers:

- watched once → `Watched 23 Aug 2026` — **exactly what it says today**
- watched more than once → `Watched 3 times · Last watched 23 Aug 2026`

No history screen in v1. The count is the interesting fact; the list of dates behind it is a
detail almost nobody opens, and it can become a tap-through on the count later without any
of the above changing.

**Two actions, never one.** *Watched again* appends an event and leaves the ranking alone.
*Rank again* reopens comparisons and claims nothing about a viewing. They sit apart, they
are worded apart, and neither silently performs the other — which is precisely the failure
the current single date field forces.

### 19.11 Collection implications

Almost none, which is a good sign. The Watched list stays one row per title, because a
collection of titles is what it is; Unranked keeps working off `rankings` and is unaffected;
filters and bands are untouched. The only opportunity is a **sort by last watched**, which
becomes meaningful for the first time and is cheap given the cache in 19.5.

### 19.12 Migration and rollback

**Forward.** Create the table, then seed one event per logged row:

```sql
insert into watch_events (user_id, media_item_id, watched_on, created_at)
select user_id, media_item_id, watched_on, created_at
from user_media;
```

Every logged row gets an event, **including rows whose `watched_on` is null**, because in
Bingd logging a title *is* the claim that you watched it — the date is what is missing, not
the viewing. Seeding only the dated rows would leave undated titles reporting a watch count
of zero while sitting in the Watched list, which is a worse lie than an undated event.
`created_at` is carried across because it is the only honest evidence of when the claim was
made; it is not a watch date and must never be read as one.

**Rollback** is dropping the table. Nothing else has to be undone, because
`user_media.watched_on` was kept authoritative for every existing reader throughout — that
is what 19.5 buys. The only loss is rewatch history accumulated since the migration, which
is why the Goals and Awards repoint is deliberately a later, separately reversible step.

**Beta data is disposable** and is not intended to migrate into production, so the seed
above is exercised against real rows in beta at no risk — which is the argument for doing it
in beta rather than first attempting it on production data.

### 19.13 Is it friend-beta-safe to add now? **No.**

Not because it is dangerous, but because it is not free and it is not finished:

- It is a **schema migration**, and the friend beta is a fixed native build. Shipping a
  migration means the server changes under installed clients, so the client and the schema
  have to be compatible in both directions for the whole rollout. Doable, but it is a
  release-shaped task rather than an OTA-shaped one.
- **Material ambiguity remains** — four decisions in 19.14 that change the schema or the
  RPC surface, not just the copy.
- The behaviour it fixes is one the beta is **supposed to be observing**. The signal worth
  having is how often testers re-log something they have already logged, which the current
  write path quietly absorbs. Counting that first is cheap and makes the feature answer a
  measurement rather than a guess.

### 19.14 Unresolved founder decisions

1. **Same-day duplicates.** Two "watched again" taps on the same date: two events, or one?
   A unique index on `(user_id, media_item_id, watched_on)` collapses accidental
   double-taps and simultaneously forbids genuinely watching something twice in a day.
   Recommendation: **no constraint**, and a confirming step in the UI instead — but this is
   a product call and it decides the schema.
2. **Does a first watch produce a Feed activity?** `title_logged` is built, rendered and
   silent. Turning it on is a visible change in feed volume for a small cohort.
3. **Does a rewatch get its own verb**, or is it *watched* again? A duplicate-looking row is
   worse than no row.
4. **Do companions become per-watch?** That re-keys `watch_tags`, which is a second
   migration with its own notification and privacy surface. Recommendation: **not now.**
5. **Does the Watchlist control on a watched title get relabelled "Watch again"?** Copy
   only, no semantics (19.8).

**Depends on.** `watch_events` · the Feed's verb set (`features/feed/activity.ts`) · the
idempotency contract in `lib/write-outcome.ts`, which this must extend rather than weaken ·
and, for the part users will actually feel, the Goals and Awards repoint in 19.5.

---

## 20. Letterboxd import

**Deprioritized 2026-08-23.** It is **not** a requirement for the friend beta, for the
initial App Store release, or for the initial Google Play production release.

**Nothing here is retracted.** The design stands and stays where it was written: the full
specification is PRD §12, the screen flow is `design/screens.md` §12, the star-to-bucket
mapping is a settled founder decision in `decision-log.md` §4 (4.0+ → *I liked it*,
2.5–3.5 → *It was fine*, ≤2.0 → *I didn't like it*, one summary line, no cut-line UI), and
the argument for why an importer gets useful recommendations on day one is
`architecture/recommendations.md`. This entry moves the *stage*, not the thinking.

**Why it moved.** It was carried as a v1 must-have on the strength of cold-start: an
importer arrives with 400 films and a usable taste profile instead of an empty collection.
That argument is sound and unchanged — it is simply not an argument about *this* cohort. The
friend beta builds collections by hand, which is the behaviour the beta exists to observe,
and an importer would remove exactly the signal being collected. Meanwhile the work is not
small: a CSV parser, a title-matching pipeline with thresholds nobody has tuned against real
exports, a bucket mapping, a review step and an anchor session, none of which exists in the
app today.

**Policy that survives the deprioritization.** User-uploaded export files only. **No
scraping and no live account connection** — Letterboxd's terms prohibit automated
extraction and its API is not granted for this use case. That constraint is not a staging
decision and does not relax because the feature moved.

**Revisit when.** Public traction rather than a date: the first cohort large enough that
hand-building a collection is the thing stopping people, and real exports in hand to tune
matching against.

**Depends on.** A file picker and CSV parser · a title-matching pipeline · the bucket
mapping in `decision-log.md` §4 · the post-import anchor session.

---

## 21. Find friends from contacts

**Deferred by the founder, 2026-08-26**, in the same pass that built People discovery.

**What it is.** A third section under For You → People — *From contacts* — that finds the
people already in the reader's address book who are on Bingd, so that a new account is not
starting from an empty follow graph and a search box.

**Why it is wanted.** It is the single highest-yield discovery mechanism any social product
has, and it is the one gap People discovery does not close. Mutuals needs a follow graph
the reader does not have yet, and taste matches needs a ranking catalogue they have not
built yet — so on day one, which is exactly when discovery matters most, both sections are
empty and the screen can only say *rank more and follow people*. Contacts is the only
source that works before either exists.

**Why it is not being built now.** Requesting the address book is a decision about what
Bingd uploads concerning **people who never signed up**, and it cannot be made as a side
effect of adding a section to a screen. It needs a privacy design of its own, a line in the
privacy policy, a store-listing disclosure on both platforms, and a matching scheme that
does not amount to shipping somebody's phone book to a server. None of that is
pre-RC-sized, and the pre-RC pass that surfaced it said so explicitly.

**Requirements for any future implementation**, recorded now so they are not re-litigated:

- **Explicit opt-in.** The OS permission is requested only after a deliberate tap on a
  control that says what it is for — never at launch, never as part of onboarding, and
  never bundled into another prompt.
- **An explanation before the OS dialog**, in Bingd's own words, saying what will be read
  and what will be sent. The same two-step the notification primer uses, and for the same
  reason: our "Not now" is recoverable and the OS answer is not.
- **Privacy-preserving matching, preferred.** Hashed or otherwise blinded identifiers over
  raw numbers and emails, with the scheme written down and reviewed rather than assumed.
- **Never a silent upload.** No background sync, no re-upload on launch, and a way to
  delete whatever was matched.
- **Bingd works fully without it.** Declining costs the reader nothing but this section.

**What should bring it back.** A cohort large enough that an empty People screen on day one
is the thing stopping people — which the friend beta, where everybody already knows each
other, cannot tell us.

**Depends on.** A privacy-policy revision · store-listing disclosures for iOS and Android ·
a matching scheme · a contacts permission, which is a **native** change and therefore
downstream of the RC binary.

---

## 22. Per-title watch history — revisiting each watch

**Deferred by the founder, 2026-08-27**, in the tranche that reduced the log sheet to
one Note row.

**What it is.** A future surface on the title page — a tab or section in the row Cast /
Videos / Details / Reviews already occupies — where a reader revisits each of their own
watches of this title: the watch dates, the note or review **as it stood at that
watch**, who they watched with, and repeated watches as separate entries.

**Why it is wanted.** Rank again already records that a second watch happened (PRD §10),
and the one-note model deliberately keeps a single current text per title — so the
history of an opinion is overwritten by its latest edit. The founder's intent is that
revisiting a title should eventually read like a diary of that title, not only its
current state.

**Why it is deferred.** Today's model is **one current note per title, for good** — §19
is the schema design per-watch entries would live in (§19.4's table), and §19.13's
verdict that building it now is not friend-beta-safe stands. This surface is the
*reader* of that model, and it must not complicate the one-note model on its way in: no
second composer, no per-watch visibility matrix, no "which note is canonical" question.
The writing surface stays exactly as decided on 2026-08-27; this entry is about reading
what the future table would hold.

**Revisit when.** §19 is built — this is its natural companion surface, not a separate
schema decision.

**Depends on.** The §19 watch-history table · the title page's tab row
(`design/screens.md` §6) · a decision on how a note edit is snapshotted per watch
(§19.14 territory).

---

## 23. Match v2 — broader taste similarity

**Deferred by the founder, 2026-08-27**, in the audit that fixed Match's false precision
(`20260827001000`, PRD §13).

**What it is.** Match beyond exactly-shared titles: content-based taste profiles
(genres, people, eras) and collaborative filtering, so two people with adjacent but
non-overlapping catalogues can still read as compatible.

**Why it is wanted.** The founder's intent, recorded with the deferral rather than lost
to it: Match should eventually capture broader taste similarity, not only agreement over
the titles both accounts happen to have ranked. In a small network, exact overlap is the
scarcest input there is.

**Why it is deferred.** Both candidate mechanisms were researched in the audit and
neither survives the current constraints. The population is small and sparse — cold-start
territory for collaborative filtering — and a genre-profile similarity over
`media_items.genres` would put confident-looking numbers on pairs with **no shared
evidence at all**, which is precisely the failure the 2026-08-27 fix removed. Rebuilding
that failure a week later under a different name would be the same defect with better
branding.

**Revisit when.** Enough accounts and rankings that collaborative signal is real — and
any v2 must keep the evidence-shrinkage property the fix established: a number's
confidence must be visible in the number.

**Depends on.** A larger ranked population · a content-profile design that states its
evidence · `taste_match` remaining the single algorithm every surface calls.

---

## Carried forward from earlier decisions

Still deferred, still agreed, recorded so that nothing is lost between documents:

- **Friend-activity notifications** ("somebody you follow ranked something") — PRD §15
  excludes them from v1 deliberately. With 30–60 people all ranking heavily in the same
  fortnight it would fire constantly and read as spam. It is the obvious early-traction
  addition once the cohort is larger and more spread out.
- **The scheduled nudge** (Friday ~18:30, Sunday ~16:30, conditional on real content) —
  PRD §15 says it ships **with push**, so it is downstream of §4.
- **Paid beta payments and entitlements** — PRD §21. Nothing is purchasable in v1, and
  **capability gate hits are not measured either**: `capability_gate_hit` was declared in
  the old taxonomy and never emitted, and it is not in the current event set. PRD §28 wants
  the ceiling measured before a price is chosen, so instrumenting it is part of this item
  rather than something already done.
- **Offline outbox and durable sync** — PRD §18's capability matrix is decided; the outbox
  is not built, and `signOut` carries a note where its teardown will go.
- **Letterboxd import** — specified in full in PRD §12 and **not built**. No import screen,
  no CSV parser and no matching pipeline exists in the app today. It was a v1 "must have"
  in the PRD's own staging; as of 2026-08-23 it is **no longer a gate for the friend beta
  or for either initial store release**, and it has its own entry at **§20** above, which
  is where the reasoning and the surviving policy now live.
