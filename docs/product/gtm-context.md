# GTM context — the input document for the go-to-market research thread

**Last updated:** 2026-08-25
**Product baseline:** PR #48, reviewed head `7179d0d` (merged as `2df988c`) · **Release/native push delta:** PR #49, reviewed head `3e90661` (merged as `266b38d`)

**Companion documents:** [`PRD.md`](./PRD.md) · [`brand.md`](./brand.md) ·
[`analytics.md`](./analytics.md) · [`deferred-roadmap.md`](./deferred-roadmap.md) ·
[`../release/beta-distribution-readiness.md`](../release/beta-distribution-readiness.md)

**What this document is.** The input for a future GTM research and strategy thread — not
the strategy itself. It states what bingd. is, what actually differentiates it today,
who the candidate early users are, what we want from testers, and what the honest
distribution state is at the time of writing. Section F deliberately stops short of
community research (subreddit rules, specific communities, specific creators): that is
the next thread's job.

**One distinction governs every claim here.** *Product contract* = what the reviewed beta
tranche (PR #48) does. *Distribution state* = what is actually installable today
(section H). GTM claims must not conflate them — in particular, push notifications are
built but not yet delivered to any phone.

---

## A. What bingd. is

bingd. is a social movie and TV-season logging, ranking, recommendation and discovery
app. Instead of assigning star ratings, people sort what they watch into three buckets
(*I liked it / It was fine / I didn’t like it*) and then answer head-to-head comparisons
(*Which did you like more?*) that place each title at an exact position, displayed as a
personal 0–10 score. That ordered taste profile powers the social layer: a chronological
feed of friends' activity, comments and reactions, a Taste Match percentage between two
people once they share enough ranked titles (and never a fake number before that),
one-tap recommendations to people you follow, and people discovery through
mutual connections and taste. Movies and TV seasons are both first-class — ranking a
season *is* logging it — which no film-only competitor offers in one profile.

## B. The core loop

```
discover a title (search · For You · a friend's feed · a recommendation)
   → log it: How was it? — one of three buckets
   → compare: a few head-to-head choices inside that bucket
   → score reveal: a 0–10 position in your own list
   → Finish your log: review or private note, who you watched with, watch date
   → the ranking feeds your taste profile, Match, and friends' feeds
   → friends react, comment, and recommend back
   → their recommendations land in Sent to you / Recommendation requests
   → which is the next thing you discover
```

Secondary loops: the Watchlist (intent → watched → auto-cleared), bingd. Awards
(20 tracks, 30 badges, derived from real collection facts), and the invite link
(`bingd.app/i/<token>` — one personal reusable link; acceptance creates a one-way follow).

## C. Current differentiators

These are grounded in shipped behaviour. As *market* claims they are hypotheses to test
(none has been validated against real users' stated preferences), but each mechanism is
real today:

1. **Pairwise ranking instead of star calibration.** Nobody is asked "how many stars";
   they are asked which of two things they liked more, which people can actually answer.
   The 0–10 score is derived from position, never entered.
2. **Movies + TV seasons in one ranked taste profile.** Seasons are ranked objects, not
   an afterthought; series are grouping pages.
3. **Friend recommendations are a first-class system**, not a share sheet: one-way
   sending to anyone you follow, delivered instantly to mutuals, held as
   requests for people who don't follow you back — kept until the recipient acts on
   them (Add, Dismiss, or follow the sender), never silently dropped.
4. **Taste Match between people** — a computed, honest percentage from genuinely shared
   ranked titles, with explicit states instead of fake numbers when data is thin.
5. **People discovery from the graph and from taste** (For You → People: Mutuals, Taste
   matches) — in a dedicated surface, never injected into the Feed.
6. **Logging never requires writing.** A ranking with no text is complete. Reviews exist
   for those who want them; a private note exists for those who don't want an audience.
7. **A social-first feed that stays a feed** — chronological, from people you follow, no
   algorithmic insertion, no stranger cards.
8. **Recommendations with structure and provenance** rather than a black-box "because you
   watched" carousel.

Competitive framing (working hypotheses, per PRD §4): Letterboxd has the logging culture
but star self-calibration and film-only scope; Beli proved the log→rank→match→recommend
flywheel in restaurants and is the product-mechanics reference (never the visual one);
IMDb and streaming watchlists are solitary and unranked. Do not state competitor
weaknesses as fact in outbound copy — position on what bingd. does.

## D. Social mechanics — the exact rules

- **Follows** are one-way; private accounts require approval (Follow / Following /
  Requested). Followers/Following counts open searchable list sheets, subject to
  privacy. Public accounts default; private gates content but never findability.
- **Feed**: chronological activity from approved follows — rankings, watchlist adds,
  season completions — with six reactions and threaded comments (one visual nesting
  level; comment notifications open a dedicated conversation page). Historical activity
  follows the *current* follow graph at read time: follow someone and their past
  activity appears; unfollow and it all disappears.
- **Recommendations**: send to anyone you follow (approved). Mutual → delivered to Sent
  to you; not mutual → a Recommendation request the recipient controls (Add / Dismiss /
  Dismiss all / follow-to-release). Pending requests are never ordinary notification
  rows. Blocks void everything.
- **Match** sits under the handle on every other profile: a percentage when computable,
  *Rank more to see Match* or *Not enough shared taste yet* when not. Minimum five
  titles ranked by **both** people.
- **Rank again vs Change your rating**: another watch produces exactly one new feed
  activity; a correction produces none. Abandoning either changes nothing visible.

## E. Why network density matters more than downloads

**Five connected friends are worth more than twenty isolated installs**, because almost
every mechanic above needs a relationship to exist before it produces value:

- The **Feed** is empty without follows.
- **Recommendations** need a follow edge to send along, and a mutual one to deliver.
- **Match** needs five titles ranked by *both* sides — two strangers with small
  collections show nothing.
- **People → Mutuals** needs friends-of-friends; **Taste matches** needs overlapping
  catalogues.
- **Comments and reactions** need an audience who can see the activity.

An isolated tester sees a logging app; a cluster sees the product. Recruiting should
therefore target *groups* (a group chat, a film club, a household) or seed each new
tester with follows into an existing cluster. This is also why the friend beta
deliberately precedes any public push.

## F. Early GTM hypotheses — channels to research, not recommendations

Candidate cohorts, all labelled **GTM hypotheses to validate** — none is a proven
segment:

| Cohort | Hypothesis |
|---|---|
| **Movie social users** (Letterboxd, movie group chats) | Already log socially; pairwise ranking + TV seasons + real friend recs is the upgrade pitch |
| **AMC / theater loyalists** (A-List/Stubs-style frequent moviegoers) | High volume of fresh watches; every showing is a log-and-compare moment |
| **Taste / ranking nerds** (lists, brackets, tier-makers, pairwise-comparison enjoyers) | The mechanic itself is the draw |
| **Beli-adjacent users** | Already fluent in the log→rank→match model; the movie analog needs no explanation |
| **Small critics / creators** (movie TikTok/IG/YouTube/Letterboxd) | An early ranked profile + a following is an asset; small enough to plausibly engage |
| **Existing friend groups** | The density argument in E — clusters light up every social surface at once |

Channels to research in the next thread: Reddit and movie communities, AMC/theater
communities, Letterboxd-adjacent spaces, Beli-adjacent communities *where rules permit*,
micro-critics, film clubs and friend groups. **This document deliberately contains no
subreddit-rule research and no channel recommendations.**

## G. What we want from the next testers

Not downloads. The behaviours that make a tester count, in rough funnel order — with
whether we can currently measure each ([`analytics.md`](./analytics.md)):

| Behaviour | Measured by |
|---|---|
| Complete signup | `signup_completed` (vs `sign_in_completed` for drop-off) |
| Rank enough titles for Match (≥5 shared; activation = 10 ranked) | `ranking_completed` count; `invite_activated` for invitees; exact counts need the database |
| Follow people / join a cluster | `follow_created` (approved vs pending) |
| Send and receive recommendations | `recommendation_sent`, `recommendation_opened`; **request Add/Dismiss is unmeasured** (analytics.md §12) |
| Comment / react | **unmeasured** — product works, no events |
| Use People discovery | **unmeasured** — no `people` surface value |
| Return after the first session | PostHog `Application Opened` timestamps only |

The unmeasured rows are recorded gaps, deliberately not instrumented mid-beta —
cohort evaluation that needs them should plan around database queries or accept the gap.

## H. Current distribution reality — as of 2026-08-25

The honest state, verified against `web/distribution.config.json`, the release docs and
the merged PR #49:

- **iOS friend beta: live on TestFlight** — a public join link exists
  (`testflight.apple.com/join/kkgaYsqx`, behind `bingd.app` invite routing). The
  installed binary predates push.
- **Android: closed test live** — a Play opt-in URL exists
  (`play.google.com/apps/testing/app.bingd`); tester eligibility is administered in the
  Play Console. Known gap: the Play app-signing SHA-256 is not yet in the App Links
  config, so Android deep links can fail for Play-installed testers.
- **Public stores: not live.** Both store URLs are null and the web build refuses
  `mode: "public"` until they exist. No production release candidate has been built or
  submitted.
- **Backend: nonprod only.** The beta runs on the `bingd-nonprod` Supabase project;
  **there is no production Supabase project yet** — the production lane exists and fails
  closed ([`../release/production-bootstrap.md`](../release/production-bootstrap.md)).
- **Web: `bingd.app` is deployed** (Cloudflare Pages from `main`); invite links,
  privacy/terms/support pages and the deep-link files are served. The Terms of Use is a
  founder-unreviewed draft.
- **Push: built, not delivering.** PR #49 made the beta lane push-capable (APNs
  production entitlement, FCM file required), but **zero device tokens exist** — no
  binary in anyone's hands can register. Remaining: founder credential steps (APNs key,
  FCM service account), a **new beta binary on both platforms**, and redistribution to
  testers. Until then, in-app notifications are the only channel. **Do not claim push in
  any outbound copy.**
- **In flight:** a release shepherd is working the RC/build track concurrently with this
  document. Re-verify this section before quoting it — the next state change (a
  push-capable beta binary) may land at any time.

## I. Open GTM questions for the next thread

1. Which subreddits and communities permit beta recruitment / self-promotion, and on
   what terms?
2. Where do AMC A-List / Stubs power users actually congregate?
3. How receptive are Letterboxd- and Beli-adjacent communities to another app, and what
   framing doesn't read as a clone pitch?
4. Should founder posts lead with pairwise ranking, friend recommendations, Match, or
   movies+TV-in-one? (Different cohorts likely answer differently.)
5. How do we recruit *clusters* rather than individuals — invite mechanics, group
   onboarding, seeding follows?
6. Which micro-influencers/critics are small enough to plausibly engage with a friend
   beta, and what would they get from it?
7. CTA mechanics: TestFlight link vs waitlist vs (later) public store — and how the
   `bingd.app/i/<token>` invite link should carry each.
8. How should Android closed-test recruitment overlap with real GTM, given Play testing
   requirements?
9. When public-store GTM starts, which of the unmeasured funnel steps in G must be
   instrumented first?
