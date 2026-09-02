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

**2. The distribution destinations themselves.** ~~`web/distribution.config.json` has a slot
for a public TestFlight URL and a Play closed-test opt-in URL, and both are `null` — so
every route currently shows *the Bingd beta is not open for this device yet*, which is
true.~~ **Superseded — both beta URLs are filled in**; the current table is in
[`../architecture/web-deployment.md`](../architecture/web-deployment.md). What is still
`null` is the pair that matters for launch: `ios.storeUrl` and `android.storeUrl`, because
neither store listing is public yet. Filling any of them in changes no invitation link
anybody has already sent, and needs no app rebuild. **A live `bingd.app` deployment is the
harder prerequisite**: until the site is hosted, Universal Links and App Links cannot
verify at all.

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

**Largely delivered 2026-08-28 (V1.5). This entry is now the remainder of the
remainder** — see the *What shipped, third pass* note below for what left it, and the
*What is still deferred* note at the end for what did not.

**What it is.** The parts of recommendation freshness that in-memory session exposure does
*not* buy. **The seed shipped** in the 2026-08-20 Preview micropass and **session exposure
shipped in the micropass after it** — see `docs/architecture/recommendations.md` §7 — so
this entry is only the remainder.

**What shipped, third pass (2026-08-28, founder §§13–18).** The durable half. This entry's
own headline complaint — that exposure "resets with the process", so the first slate after
every launch was drawn from an un-penalised pool and was therefore the same first slate —
is closed. `recommendation_impressions` gained its first writer
(`note_recommendations_shown`, hour-truncated so the primary key makes it idempotent) and
its reader (`recommendation_exposure`, windowed by `foryou.impression_window_hours` so a
penalty expires rather than accumulating for ever). The ranker merges the durable count
with the session's by `max`. Also shipped in the same pass: a small social candidate source
(`social_candidates` — followees' top-band titles, ids and a count only, no Match
weighting), diversified paging so the wall grows on scroll without reshuffling what has
been read, and the removal of the Refresh chip in favour of pull-to-refresh.

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

**What is still deferred after 2026-08-28.** Four of the five bullets above survive V1.5,
and the list they sit under is now the *only* part of this entry still open:

- **No "repeatedly ignored" signal.** V1.5 records that a title was **shown**, which is
  what the cooldown needs; it still cannot distinguish a title the reader scrolled past
  four times from one they never reached. That needs a visibility threshold, which is a
  second definition of "shown" living inside a layout — deliberately not built.
- **No novelty or recency term in the score.** Unchanged: freshness is presentational.
- **No exploration feedback.** Unchanged: nothing learns from whether an explored title
  was opened, saved or ignored, so the temperature is still a constant.
- **The candidate pool widens only a little.** `social_candidates` is a genuine third
  source and is bounded by how much the reader's followees have ranked; the anchors still
  return the same `similar` lists for weeks. A materially deeper pool still needs more
  anchors or a shorter cache life.

**Revisit when.** The beta produces evidence about whether the *durable* cooldown was
enough. The signal to watch for now is a reader who says recommendations feel familiar
**after several days**, which would mean the 72-hour window is too short to matter against
a pool this size — a pool problem rather than a memory problem, and the bullets above are
where it would be answered.

**Privacy cost, now paid rather than pending.** The dependency below asked for a decision
on impression logging as a new category of stored data. It was taken on 2026-08-28: the
table is owner-scoped with no read policy at all, the only client read is an aggregate of
the caller's own rows, rows age out of the penalty window, and the fact stored is "this
title was on your wall" and nothing about when within the hour.

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

**Reaffirmed 2026-08-28.** The founder reassessed Match and accepted it for beta: "the
next improvement is presentation, not mathematics." That tranche changed nothing in
`taste_match` — no weight, no shrinkage constant, no minimum-common threshold, no Spearman
component — and spent its budget on stating the evidence beside the number instead (PRD
§13). This entry is unchanged and still the right shape.

---

## 24. Network-relative leaderboard

**Deferred by the founder, 2026-08-28**, in the tranche that shipped the monthly board
(PRD §14).

**What it is.** A leaderboard scoped to the reader's own network — people they follow, or
mutuals — rather than to everybody they are permitted to see.

**Why it is wanted.** The board that shipped is **global**, which is right for a friend
beta where the global set and the friend set are nearly the same list. They stop being the
same list quickly. At any real scale a global board is won by whoever watches the most
television in the world, which is not a comparison anybody in this product is trying to
make, and the people a reader actually wants to be measured against are the ones whose
recommendations they take.

**Why it is deferred.** It is not needed while the beta is a few dozen accounts, and
building it now would mean choosing between "people I follow", "mutuals", and "friends of
friends" with no evidence about which one people mean — a choice better made against a
network that exists.

**What already makes it cheap.** The board is viewer-relative by construction: the
population is a `can_view_profile` filter over `profiles`, so a network scope is a
narrower `from` clause in one CTE rather than a new architecture. The metrics, the
ordering, the tie rule, the pinned "You" row and the whole client are unchanged.

**Revisit when.** The global board stops being legible — either it is long enough that a
reader cannot find themselves without the pinned row, or it is won consistently by
somebody the reader has no relationship with.

**Depends on.** Enough accounts for the two scopes to differ · a decision on which network
definition the product means.

---

## 25. External editorial and top-film-list ingestion

**Not currently planned. Recorded 2026-08-28** so that a future proposal has to argue
against a decision rather than fill a silence.

**What it is.** Importing curated third-party lists — a publication's top 100, a critics'
poll, an awards shortlist — as a recommendation candidate source.

**Why it is not planned.** The founder's reasoning, in the same breath as approving the
social candidate source: *"someone with high Match loved this and I haven't seen it"* is
more bingd.-native than importing generic critics' lists. A canon list is the same list for
every reader, so it cannot answer "what should **I** watch next", and a product whose whole
claim is a personal ranking has no use for a ranking somebody else made. It would also
re-import the labelling problem `20260817001000` removed: presenting another organisation's
judgement inside a surface people read as theirs.

**What would change the answer.** Nothing currently foreseen. If a canon ever arrives it
should be a *browsable list*, clearly attributed, and not a candidate source feeding For
You — the two are different products and only the second one is ruled out here.

---

## 26. Further leaderboard timeframes — week, year, custom

**Not built, 2026-08-29**, in the tranche that added All time (PRD §14).

**What it is.** Any leaderboard window other than the two that exist: this week, this
year, or a custom range.

**Why they are not built.** Each fails for its own reason rather than for a shared one:

- **Week.** The behaviour is low-frequency. A weekly board over films and TV seasons is
  mostly zeroes and is decided by whoever happened to have a free Saturday, which is a
  worse competition than none. This was ruled out when the board was first specified and
  the reasoning has not changed.
- **Year.** It is the all-time board with a slower reset — nearly the same list, and on a
  product this young *literally* the same list. It becomes interesting only once there is
  more than one year of history worth comparing.
- **Custom ranges.** A date picker over a leaderboard is an analytics feature. Nobody
  competes over an arbitrary fortnight.

**What it would cost if the evidence arrived.** Very little, which is the point of
recording it: `_leaderboard_counts` takes a timeframe and branches on it, so a third value
is a branch, a validator entry and an option in one table. The client's selector, its
stored preference, the metrics, the ordering and the rows are all timeframe-agnostic
already.

**Revisit when.** Beta evidence, and specifically evidence of the *shape* — readers asking
"how did I do this week", not the team deciding the dropdown looks sparse with two entries
in it.

---

## 27. "Remove me from this watch" — disputing a watched-with claim

**Not built, 2026-08-30**, in the tranche that made the watched-with notice visible
(PRD §14).

**What it is.** A control on the receiving side that says *I did not watch this with
you* — as distinct from the one that already exists, which hides the tag from the
tagged person's own surfaces.

**Why the need is now clearer, which is the only reason this is written down.** Until
this tranche a watch tag was a quiet thing: a name on somebody else's log, discoverable
if you went looking. It now arrives as an inbox row that says "Suraj watched 100 Meters
with you" and offers you a Rank button. That is a claim about your evening, delivered to
you, with an action attached — and the moment a claim is delivered rather than filed, the
question "what if it is wrong" stops being hypothetical.

**Why it is still not built.**

- The existing control may well be enough. `hide_watch_tag` already removes the tag from
  the tagged person's side without altering the tagger's log, which is PRD §14's stated
  rule and the right default: the tagger's record of their own evening is theirs.
- A dispute is a different object from a hide. It has to reach the tagger, which means it
  is a notification; it can be wrong in both directions; and two people disagreeing about
  a fact neither can prove is a moderation surface, not a button.
- The population that can do this is already an approved mutual follow. The realistic
  failure is a mistake between friends, and the realistic fix is a message — which the
  product deliberately does not have, and is not adding.

**What it would cost.** A column on `watch_tags` and a notification type is the small
version, which is exactly why it should not be built on a guess: the small version
answers "the tagger is told", and the questions that actually decide the feature are what
the tagger's log says afterwards, whether the feed event changes, and what happens when
the dispute is itself wrong.

**Revisit when.** Beta evidence, and specifically a real instance: somebody tagged in a
watch they were not at, saying so. Not the team imagining one.

## 28. Review awards — a track for publishing, split off Comment Gremlin

**Not built, 2026-08-29**, in the tranche that made Comment Gremlin comments-only
(PRD §14).

**What it is.** An award track for **publishing reviews**, the counterpart to the one
that now counts comments alone.

**Why there is a hole to fill.** Comment Gremlin counted comments *plus* published
reviews and said so on the row — "Write 100 comments or reviews". The founder's ruling
is that the two are different behaviours: a review is a considered thing you publish
about a title you ranked, a comment is talking to somebody under their activity, and one
counter that adds them together rewards neither. So the track became comments-only in
that tranche, which is the half that could be done without inventing anything — and
publishing a review currently earns nothing at all.

**Why it is not built in the same pass.** A new track is four decisions this tranche had
no evidence for, and each of them is permanent the day it ships:

- **Three names and three pieces of artwork.** Ten of the twenty existing tracks still
  draw an emoji placeholder (§14 of this document), so a twenty-first track would
  start as the eleventh placeholder rather than as a reward.
- **Three thresholds, which cannot move afterwards.** The award ledger makes a
  threshold change a migration and an un-earned tier a revocation — the Genre Gremlin
  paragraph in PRD §14 records what that costs — and there is no review-volume data to
  calibrate against. Nobody in the beta has published enough reviews to say what a
  Bronze should be.
- **What counts, exactly.** A note published, or a note *currently* public? The two
  differ under a retraction, and `note_first_published_at` exists precisely because the
  leaderboard needed the distinction (`20260828000200`); an award has to pick one and
  live with it.
- **Whether the retired combined progress transfers.** It does not, and that was
  decided: tiers the comments-only count no longer supports were revoked. Handing that
  progress to a review track instead would be re-earning an award under a third rule.

**What it would cost.** One `AWARD_TRACKS` entry, three rows in `award_tiers`, one
branch in `_award_metric`, and a trigger on `user_media` note changes — which is
almost exactly the `award_on_note` trigger this tranche deleted, and is the smallest
part of the work. The four decisions above are the feature.

**Revisit when.** There is review volume to calibrate a ladder against, and the
placeholder artwork backlog (§14) is being worked rather than grown.

---

---

## 29. A leaderboard opt-out

**Status: deferred by founder decision, 2026-08-30. Not built, and the implementation did
not argue for it.**

On 2026-08-30 a private account became visible on the leaderboard as a minimal row: rank,
display name, handle, avatar, a lock, and the count for the selected metric. Everything
that account wrote stays behind `can_view_profile` — the collection, the reviews, the
activity, the awards, Match and the shared-title count are all null or absent at the
server, not hidden at the client.

The obvious next question is whether somebody should be able to leave the board while
staying private. The founder deferred it, and this entry exists so the deferral is a
recorded decision rather than a gap.

**What it would take**, if it is ever wanted: one boolean on `profiles`, a settings
toggle, and one predicate in `_leaderboard_counts` — the population is already a single
CTE, which is what makes this cheap to add later and why nothing needed to be shaped for
it now. `my_leaderboard_standing` reads the same CTE, so the reader's own denominator
would follow without a second change. The one real design question is whether opting out
also hides *the opter's own* board position from themselves; the honest answer is
probably not, on the same reasoning that a suspended account can still load its own
profile.

**What would make it materially necessary**: a report from a real user that the count
itself is the exposure. The disclosure today is one aggregate — how many titles, films,
seasons or reviews — which names nothing and dates nothing, and is the same order as the
follower count a private profile shell has always shown. If that turns out to be wrong,
it is wrong for a reason worth reading before building the toggle.

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

---

# Added 2026-08-30 — the launch-blocking correction pass

Twelve entries, all recorded during the final pre-RC tranche. None is built and none is a
gate for the production RC. They are here so that each is a *decision* with its reasoning
attached rather than a gap somebody rediscovers.

---

## 30. Recommendation diversity and personalisation experiments

**Status: deferred, 2026-08-30, on evidence rather than on principle.**

The third freshness audit (`docs/architecture/recommendations.md` §9) measured the
founder's own wall against deployed data and found no correctness defect: 154 distinct
titles over 621 impressions in three days, a ceiling of 6 for any single title, and the
two titles in the report reachable from two of the reader's top anchors each. Nothing
changed in the code, deliberately.

**What is deferred**, and it is one question rather than a feature: is a repeat a rotation
failure or an exhausted pool? Today nothing distinguishes them. The first thing to build
is not a diversity term but a **measurement** — distinct eligible candidates per reader
against distinct titles shown per week. A ratio near 1 says the pool is the constraint and
the answer is §17's wider sources; a ratio well below 1 says rotation is the constraint.

**Explicitly not deferred-and-then-guessed**: no ML infrastructure, no uncontrolled
randomness, and no taste-weight tuning without behavioural evidence. A wall that shuffles
is not a wall that recommends, and one account's impression of two films is not a signal
to tune against. §18 holds the engine-scale version of this.

**Revisit when.** There are enough accounts with enough rankings for the pool/exposure
ratio to be read per-cohort rather than per-person.

---

## 31. The Anime / Animation counting-vocabulary boundary

**Status: deferred by founder decision, 2026-08-30. Deliberately left inconsistent, and
this entry is why.**

Two vocabularies now name the same shelf and they do not agree, on purpose:

| | Vocabulary | Anime |
|---|---|---|
| **Product genres** (`lib/media-metadata.ts`) | What a title *is called* on screen | Replaces Animation, and leads the list |
| **Award counting** (`features/awards/genres.ts`) | Eighteen canonical genres a tier is measured against | No such genre; its Animation pattern already matches `anime`, `animated`, `cartoon` |

So Toon Bloom counts an anime film as animation, while the film's own row says Anime. That
is coherent — Toon Bloom is a track about drawn things and anime is drawn — but it is a
seam, and a reader who notices it is not wrong to ask.

**What making them agree would cost, and why it is not free.** Adding Anime to the awards
vocabulary as its own genre would split the Animation population, which changes two
things a schema cannot undo quietly: Toon Bloom tiers already earned on anime-heavy
collections could fail their new metric, and Genre Gremlin — "watch N *different* genres"
— would find one more genre in the same collection and mint tiers nobody did anything to
earn. The comments-only Comment Gremlin change of 2026-08-29 is the precedent for
revocation, and it was narrow, deterministic and founder-approved by name. This one is
neither narrow nor obviously right.

**Revisit when.** There is a product reason to count anime separately — an anime award
track, or a founder decision that Genre Gremlin should see nineteen genres — at which
point the historical-unlock treatment is the *first* question rather than a consequence to
be discovered.

---

## 32. Shared-title landing pages, and an SEO evaluation after them

**Status: deferred, 2026-08-30.**

A shared title today resolves through the deep-link web build to a redirect. A **landing
page** — the title, its artwork, and whatever Bingd's own readers have publicly said about
it — is the obvious next thing, and it is deferred for two reasons that are worth keeping
separate.

The first is that it is a *product* surface and not a marketing one: it has to decide what
a stranger sees of somebody's public review, which is the same visibility question the
public profile answered and would have to answer again with different defaults.

The second is that SEO is an **evaluation that comes after**, not a reason to build. Pages
that exist for crawlers and not for people are the shape of thing this product should not
ship; the honest order is a page worth landing on, then measurement of whether anybody
lands on it.

**Revisit when.** There is enough public review volume that a landing page has something
on it, and outbound sharing is a measured behaviour rather than an assumed one.

---

## 33. Social cold-start discovery

**Status: deferred, 2026-08-30.**

A new account with no follows sees a feed that is structurally empty and a leaderboard of
strangers. Onboarding hands them the taste flow and the invite, both of which are about
*them*; nothing yet is about finding the people already here.

The pieces exist and are deliberately not wired into a flow: `can_discover_profile` and
people search (2026-08-19), the leaderboard's now-wider population (2026-08-30), and
`taste_match`. The missing thing is a **decision about what a stranger is offered first** —
the most active accounts, the closest Match, or the people an inviter already follows —
and each of those is a different product with the same components. §21 (contacts) is one
answer to it and is itself deferred.

**Revisit when.** Accounts are arriving without an inviter. In an invite-shaped beta the
inviter *is* the cold-start solution, and building a second one now would be solving a
problem the current growth model does not have.

---

## 34. Historical-entry anxiety, and fast entry

**Status: deferred, 2026-08-30. Named by the leaderboard fix rather than by a report.**

The month-attribution correction (`20260903000100`) rests on a fact worth stating: five of
twelve nonprod accounts had **no dated collection row at all**. Logging without a date is
not an edge case, it is what a large share of readers do — and the likeliest reason is
that entering a history feels like being asked to remember something.

Two experiments sit here, and neither should be run on intuition:

- **Fast entry.** A path for putting many remembered titles in at once, with no date
  prompt at all, distinct from the considered single log.
- **Anxiety.** Whether the date field itself is what stops people, or whether it is the
  ranking comparisons that follow. The two have opposite fixes and the current
  instrumentation cannot tell them apart.

**Revisit when.** Onboarding completion and first-week logging volume are measured against
each other. Until then the correct move is the one taken: make the product count what
people actually do, rather than pushing them to do the thing the product counts.

---

## 35. Capped social and watchlist digests

**Status: deferred, 2026-08-30.**

PRD §15 keeps friend-activity notifications out of v1 because a small cohort ranking
heavily would fire constantly. A **digest** is the version that survives that objection —
one message, capped, saying what happened rather than one message per thing that happened
— and the same shape serves a watchlist reminder ("three things you saved are now
streaming" is a different product; "three things you saved" is not).

Deferred because the cap is the whole design and there is nothing yet to calibrate it
against: how many items, how often, and what a quiet week produces are all questions that
need real activity distributions. A digest tuned wrong is worse than no digest, because it
is the notification people turn off first and never turn back on.

**Revisit when.** §4's push foundations carry the scheduled nudge, and there is a fortnight
of real activity to size a cap against.

---

## 36. A visibility preference for the last note or review

**Status: deferred, 2026-08-30.**

A note is private unless its author says otherwise, and `log_watched` and `save_note` both
enforce that on every write (`NR-1`). The deferred thing is a **preference**: a reader who
publishes everything re-answers the same question every time, and a reader who publishes
nothing is asked a question they have already answered.

Why it is not a one-line setting: a stored default is a claim about writing that does not
exist yet, and the failure mode is one-directional and bad — somebody who set "public" in
a confident month publishes something they meant to keep. The safer shape is probably
*remembering the last choice and showing it*, which is a different thing from a setting and
needs its own copy.

**Revisit when.** Enough reviews exist that the repetition is a real cost, and the sharing
rate says which default anybody would actually want.

---

## 37. An obvious spoiler control on comments

**Status: deferred, 2026-08-30.**

A review carries `note_has_spoilers` and the inbox enforces it server-side (2026-08-30,
mentions). A **comment** does not: comments are conversation under an activity, they were
never modelled as writing about a title, and there is no flag on them.

The gap the founder named is that the control is not *obvious* — a person about to spoil
something in a comment has nothing to reach for. Deferred rather than added because the
minimum honest version is not a checkbox: it is a decision about whether a spoiler comment
is hidden from everyone or only from people who have not logged the title, which is the
same question the review flag answered and would answer differently here (a comment is
under an activity, and the activity's own subject may not be the thing being spoiled).

**Revisit when.** Comment volume makes it a real occurrence rather than a foreseeable one,
or a reader reports it.

---

## 38. Helpful-review sorting

**Status: deferred, 2026-08-30.**

Title reviews are ordered by the sort the reader picks, and "helpful" is not one of the
options because nothing measures helpfulness. Reactions on a review exist; treating them
as a helpfulness signal is a modelling decision, not a sort order — the six reaction kinds
say different things and none of them says *this was useful*.

Deferred because the ranking is the easy half. The hard half is that a helpfulness sort
concentrates attention on early reviews and makes the first published review structurally
advantaged, which is a product decision about who gets read rather than a display option.
§28 (review awards) touches the same incentive.

**Revisit when.** There are enough reviews per title for a sort to matter, and a signal
that means helpfulness rather than agreement.

---

## 39. Global iOS header-background consistency

**Status: deferred, 2026-08-30. Cosmetic, and bounded.**

Several screens draw their own header background rather than reading one token, so on iOS
the treatment differs slightly between stacks — most visibly where a translucent
navigation bar sits over a screen that paints its own ground.

Deferred rather than fixed in this tranche for a specific reason: it touches every screen's
top edge at once, which is exactly the shape of change that reintroduces the duplicated
safe-area inset this codebase has already fixed twice. It wants its own pass, with the
whole app screenshotted before and after on a device with a notch.

**Revisit when.** The next visual pass, and not inside a correctness tranche.

---

## 40. TV retention experiments

**Status: deferred, 2026-08-30.**

Films and TV seasons are ranked in separate categories and counted separately, and the
product's assumption is that they behave the same way. They almost certainly do not: a
season is watched over weeks, a film in an evening, and the moment somebody logs a season
is a different distance from the moment they watched it.

The experiments deferred here are about **retention specifically** — whether a reader
mid-season returns more often than one between films, whether a season's own progress
state (`watching` / `completed`) predicts anything, and whether the log prompt should
arrive at a different time for television. None of them is a feature; all of them are
questions the current event set cannot answer.

**Revisit when.** §12's retention practice exists — D1/D7/D28 by cohort — so that "TV
readers retain differently" is a measurable claim rather than a plausible one.

---

## 41. Android public distribution, after the closed-testing requirement

**Status: deferred, 2026-08-30, and gated on a Google policy clock rather than on work.**

Google Play requires a personal developer account to run a closed test with a minimum
number of testers for a continuous period before a production release can be applied for.
That is elapsed time with real testers in it and no amount of engineering shortens it.

So the Android lane's shape is decided and not built: the beta channel and its build are
live, the closed test is the mechanism, and **public distribution is downstream of the
clock**. iOS is not blocked by any of this, which is why the production RC is an iOS RC.

**What this entry is protecting against**: treating the Android build's readiness as
Android's readiness. The binary is ready; the account's eligibility is not, and the two
are unrelated facts that look like one on a release checklist.

**Revisit when.** The closed test has run its required period with its required tester
count, at which point this becomes a submission task rather than a roadmap item.

---

## 42. A watch-date sort axis for your own collection

**Status: deferred, 2026-08-30, and blocked on data rather than on a comparator.**

The Collection tab had an order labelled **Recently watched**, and it never worked — the
2026-08-30 tranche found that a ranked title reached the comparator with no watch date at
all, so every comparison answered *equal* and the list kept the rating order it arrived
in under a recency label. The axis was replaced by **Recently added** on collection
membership time, which is written by the database on every row and cannot be absent.

**Ordering your own collection by when you actually watched things is a real thing to
want**, and it is not the same question as when you added them: a film logged today and
watched in 2011 is a recent addition and an old watch. What it needs first is a date on
enough rows to be worth offering, and that is a product decision about the Log sheet
rather than an engineering one — `user_media.watched_on` is nullable on purpose, and the
sheet has a deliberate "dateless on purpose" state for a title somebody genuinely cannot
date. An axis that silently sinks half the collection is the shape of the defect this
entry exists because of.

**Own collection only, and that half is settled.** [PRD §22](./PRD.md#22-privacy-safety-and-moderation)
makes watch dates private on any profile, at any visibility, to anybody, and
`logged_collection` omits the column. The See-all sheet's recency axis is **Recently
ranked** for that reason and stays that way whatever happens here.

**Revisit when.** Either the Log sheet makes a date the strong default and the founder is
willing to see undated rows sink, or a "date unknown" bucket is designed that a sort can
honestly show. Until one of those, Recently added is the honest recency axis.

---

## 43. Reversible awards beyond the collection

**Status: deferred, 2026-08-30. The boundary is deliberate and it is enforced.**

`20260904000100` makes a **collection**-derived award tier reversible — held only while
the current collection satisfies its threshold. The classification lives in
`award_tracks.metric_kind`, seeded from `AwardTrack.needs`, and is checked by
`awards-server-parity.test.ts`, so moving a track across the line is a deliberate edit in
two files rather than a slip in one.

**Mutual Mania is the interesting one.** Its count can fall — an unfollow, a block — so
by the shape of the metric it *could* be treated as current-state. It is not, and the
reason is whose act it is: revoking on it would mean **one person's unfollow silently
deletes another person's badge, their feed post and their notification**, with no act of
their own involved. Every collection revocation is a consequence of something the earner
did to their own collection, and that is what makes it legible. A social-graph revocation
is not, and it is a product decision the founder has not been asked for.

**The other four are settled, not pending.** Invite Instigator, Comment Gremlin, Hype
Courier and Heart Magnet count acts that happened: a retraction does not un-say that the
person wrote, and somebody removing a reaction does not un-react it. Nothing about the
mechanism would change if the founder later disagreed — one column value each — but the
argument would have to be made, and it is not made here.

**Revisit when.** The founder has an opinion about Mutual Mania specifically, prompted by
a real report rather than by symmetry with the collection rule.

---

## 44. Collection customisation beyond the sort contract

**Status: deferred, 2026-08-30.**

The 2026-08-30 sort work deliberately stopped at making the existing control truthful:
one label per axis, a direction toggle, and comparators that are total. Everything
adjacent that came up while doing it is recorded here rather than built, because the
tranche was a defect fix and none of these are:

- **Saved views** — a named filter-plus-sort a reader returns to. The state already
  survives tab and medium changes; what it does not do is survive a relaunch or have a
  name.
- **Persisting sort across launches.** Today only the view mode is stored. Whether a
  collection should reopen in the order you left it or in its default is a genuine
  question and the answer is not obvious — the default is *your best first*, which is a
  reasonable thing to be shown every time.
- **Multi-key sorts** — rating then title, year then rating. Cheap to implement and a
  second grammar for the reader to learn; nobody has asked.
- **Sorting the poster wall differently from the list.** They share one state on purpose:
  they are two drawings of one selection, not two screens.

**Revisit when.** A reader asks for one of them by describing a task, rather than the
control suggesting itself.

---

## 45. Rich browser previews, and the sharing loop's remaining half

**Status: partly built 2026-09-03. The rest is deferred.**

> **Superseded in part.** This item was written on 2026-09-02 saying a browser page for a
> title or a profile "needs a public reader for `media_items`, which today is reachable
> only through the app's authenticated client". **That was wrong**, and the correction is
> worth more than the item: `media_items_read` has been `using (true)` since
> `20260813000400`, and `can_view_profile` has always answered a null viewer with public,
> active accounts. Both public read paths already existed. The fallback page now uses them
> and needed no migration, no new backend and no change to any policy. See
> [`../architecture/web-deployment.md`](../architecture/web-deployment.md).

**What is built.** `/title/<id>` names the film or season, its year and its poster.
`/u/<handle>` names a public account, its handle and its avatar. Both resolve in the
browser, one request each, under the RLS the app already obeys, so a private account
returns zero rows and the page keeps its generic line. The page also carries two real app
screenshots and a 1200x630 brand social card.

**What is still deferred, and each of these is a project rather than an edit.**

- **Per-title Open Graph cards.** The poster as `og:image` and the film's name as
  `og:title`, so the *unfurled preview in the message* names the film rather than saying
  "Open on bingd." This is the one people ask for first and it is the one thing the
  2026-09-03 work could not do: these files are static, one per route, so a `<meta>` tag
  is the same bytes for every visitor. It needs a Cloudflare Worker or Pages Function, a
  TMDB or `media_items` lookup on the request path with its rate limit and its caching,
  and a fallback for the lookup failing. **The page resolving the title does not make the
  card able to**, and the difference is worth stating because it looks like an
  inconsistency and is not.
- **Dynamic social-image generation.** A rendered card with the poster, the score and the
  handle drawn on it. A step beyond the above: an image pipeline, a font, and a cache.
- **Anything about what people did with a title.** Where friends placed it, its average
  score, how many have watched it. Every one of those is a read of `rankings` or
  `user_media`, both of which are `can_i_view`-bounded and correctly return nothing to a
  signed-out reader. Showing them would mean a privileged read path, which is the line
  this page has not crossed and should not.
- **Browser accounts, ranking, feed or navigation.** Not deferred so much as declined. The
  page is an install fallback, not a web product.

**Decided against, not deferred.** Attaching a referral token to ordinary title and
profile shares so the sender could be credited for an install. It was in the code until
2026-09-02 and was removed: see PRD §6F. Sender trust is worth more than the attribution,
and the two cannot both be had on the same link.

**Revisit when.** There is a public App Store listing, and enough traffic on
`/title/<id>` fallbacks to say what a richer card would be worth. Nothing currently counts
those fallbacks; see the note on web analytics in
[`../architecture/web-deployment.md`](../architecture/web-deployment.md), which is its own
small prerequisite.

---

## 46. Deferred deep linking across an install, and what would have to be true first

**Status: deferred, 2026-09-03. Unchanged in substance from §7, restated here because the
sharing work keeps arriving at it.**

Today a link opens the right screen **only when the app is already installed**. Somebody
who taps `/title/<id>`, installs from the fallback, and opens the app from their home
screen lands on the feed. The title is not recovered. Neither is an invitation.

The honest continuation is the one the page already offers: go back to the message and tap
the same link again, which now opens the app at the right place. That works, it costs one
tap, and it is the whole of what this product supports.

**What closing it would take**, so the size is on the record: Play Install Referrer on
Android, and on iOS a deferred deep-link vendor, which today means Branch, AppsFlyer or
Adjust. Each is an SDK, a privacy review, a native rebuild, a store-listing disclosure and
a data-sharing relationship. **Never** by fingerprinting, IP-and-timestamp matching or
clipboard reading; that is a privacy position rather than a cost trade-off.

**Related and also deferred:** content-share to signup attribution, which is the same
mechanism pointed at a different question. Ordinary title and profile shares deliberately
carry no sender, so even with deferred linking there would be nothing to attribute them to
without reintroducing the referral token PRD §6F removed.

**Revisit when** the fallback page's own numbers show how many people reach it and do not
come back, which is a question the current instrumentation cannot answer.

---

## 47. Awards for sharing

**Status: deferred, 2026-09-03. Design constraint recorded now so the obvious version does
not get built later.**

There is no Award for sharing and there should not be one that counts share-button taps.

**Why the obvious version is wrong.** Opening the OS share sheet is not a share: the sheet
can be dismissed, the message deleted unsent, and the app is never told which. An Award
that rewards the tap therefore rewards *the tap*, and the rational way to earn it is to
open and dismiss the sheet repeatedly. That is a badge for spamming yourself, and it would
sit in the same sheet as Awards that are derived from a real collection.

This is the same rule `invite_link_created` already follows, for the same reason, and it is
written down in [`analytics.md`](./analytics.md): name the stage that is actually measured.

**What a real one would need**, in rough order of how much it is worth:

- **Distinct recipients or distinct titles**, not repetitions of one.
- **A cap per day and per year**, so the ceiling is reached by using the product normally
  rather than by grinding.
- **Recipient opens**, once those are measurable. `record_invite_open` already does this
  for invitations; content links have no equivalent and would need the fallback analytics
  noted in §45.
- **Recipient activation**, which is the only version that measures the thing the founder
  actually wants, and which needs the deferred attribution in §46.

So the honest sequence is §46 and the §45 analytics first, and the Award last. Until then
the invitation Awards that already exist (Invite Instigator, which counts *activated*
invitees rather than links created) are the model to copy, not the share sheet.