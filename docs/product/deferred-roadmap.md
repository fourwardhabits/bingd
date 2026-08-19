# Deferred roadmap — product capability that is specified, wanted, and not being built yet

**Status:** current as of 2026-08-19, at the product re-freeze.

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
being one. Those live in `.agent-workflow/continuation.md` and
`.agent-workflow/feature-completion-status.md`, and they stay there.

**One entry breaks that rule on purpose and says so out loud.** §7, the invite and
referral resolver, is genuinely both: a product capability *and* a friend-beta growth
blocker. It is cross-referenced rather than quietly filed under "later".

Each entry states: **what it is · why it is wanted · why it is not being built now · what
should bring it back · what it depends on.**

---

## 1. People and actor search

**What it is.** A grouped **People** section in Search, alongside Titles and Members, so
that typing "Tilda Swinton" finds the person and opens the person page the app already
has (`app/person/[id].tsx`, reached today only by tapping a face in a cast strip).

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

---

## 5. Award notifications, and `award_earned` analytics

**What it is.** Telling somebody they have earned an award tier — an inbox row, and later a
push — plus the matching analytics event.

**Why it is wanted.** Awards shipped on 2026-08-18 with twenty tracks and thirty badges.
An award nobody is told about is a page people have to remember to visit.

**Why it is deferred.** **There is no durable record of which tier an account has reached.**
Tiers are computed entirely on the device, in `src/features/awards/progress.ts` over
`tracks.ts`, from raw table reads. Notifying only on a *crossing* — 49→50 yes, 50→51 no —
therefore requires knowing the previous tier, and Codex confirmed independently that
existing persisted state can derive the *current* tier but cannot prove a transition was
previously notified.

A client-held "last seen tier" is exactly the observed-state assumption Review 21 spent
seven rounds proving unsafe: a reinstall, a second device or a lost reply turns it into
either a missed award or a repeated one. An award notification that fires twice is worse
than one that never fires.

**Everything downstream already exists**: the `award_earned` notification type, the
`awards` category defaulting off, the preference row, and the route to the Awards sheet.
The day a ledger lands, the writer is the only new part.

**Revisit when.** A durable unlock or tier ledger is built — which is a migration and a
review, not an afternoon.

**Depends on.** An `award_unlocks` table or equivalent, written transactionally with the
facts that move a tier · exactly-once semantics on that write.

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

## 7. Invite and referral activation resolver

> ### ⚠ This is also a friend-beta growth blocker, not only a roadmap item.
>
> It is carried in `.agent-workflow/continuation.md` and
> `.agent-workflow/feature-completion-status.md` as a release-hardening item, and it stays
> there. It appears here because it is genuinely a product capability too — **not** so that
> it can be read as optional.

**What it is.** The half of direct invitations below the link: a resolver at
`https://bingd.app/i/<token>`, an open record, redemption, and activation.

**Why it is wanted.** It is the friend beta's growth mechanic. Without it, "invite a
friend" is a link somebody can send and nobody can count.

**What exists today.** `create_invite_link` mints the caller's one reusable personal link
and records one `invite_link_creations` row per share — a real intent signal, and the
strongest one available without a web property. `invite_attributions` has had
`accepted_at` and `activated_at` since `20260813001300` **with nothing writing them**.
`app/i/[token].tsx` is a stub that says invitations are not active in this build, which is
true. Bingd Awards' Invite Instigator track counts `activated_at is not null`, so it reads
zero for every account and will until this lands — deliberately, because the alternative
was a badge for pressing a button.

**What has to be built** (each item is a named missing piece, not a guess):

1. **A link resolver** at `https://bingd.app/i/<token>`. There is no web property at all.
2. **`record_invite_open(token)`** — callable by `anon`, must **not** confirm whether a
   token is valid or it becomes a token oracle, writing to a new `invite_link_opens` table
   so that one link opened by five people is five rows.
3. **Deferred deep linking, or an honest limitation.** App Links and Universal Links carry
   a token only if the app is *already installed*. A fresh install needs Play Install
   Referrer or a deferred deep-link provider. **Do not approximate this with
   fingerprinting** — IP-and-timestamp matching is both a privacy problem and wrong often
   enough to poison the metric. If it is not built, redemption is limited to people who
   already had the app, and that limit must be stated wherever the number is shown.
4. **`redeem_invite(operation_id, token)`** — after profile creation, never before. Primary
   key `invitee_id`, so a person is invited once and a second call is a no-op. Must refuse
   a token whose `env` does not match the running environment (PRD §17), refuse
   self-invitation, and refuse where a block exists in either direction.
5. **Activation**, already defined: PRD §28 says ten ranked titles.

**What it unlocks the moment it lands.** `invite_redeemed` and `invite_activated` become
emittable; `acquisition_source: 'invite'` gets its first honest writer
([`analytics.md`](./analytics.md) §4–5); Invite Instigator starts counting with no client
change, no migration and no threshold rewrite.

**Revisit when.** Immediately — it is the next growth-side item, and it is on the hardening
list rather than waiting for a roadmap slot.

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
  no CSV parser and no matching pipeline exists in the app today. It is a v1 "must have"
  in the PRD's own staging and is not a friend-beta blocker: the cohort's collections are
  being built by hand, which is also the behaviour the beta is trying to observe.
