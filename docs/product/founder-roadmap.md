# bingd. — founder roadmap: beta to the first 100 real users

**Status:** operating plan, written 2026-08-27 against the live friend-beta state
(iOS TestFlight build 5 · Play closed test versionCode 7 · OTA chain compatible · push
delivering).

> **Committed 2026-09-26, at the product freeze.** The plan is from 2026-08-27; the live state
> is [`../release/production-state.md`](../release/production-state.md) and what is left is
> [`founder-todo.md`](./founder-todo.md). `gtm-context.md` and `brand.md` exist only on the
> unmerged PR #50 branch (`docs/product-gtm-refresh`).

**Companion documents:** [`PRD.md`](./PRD.md) ·
[`gtm-context.md`](https://github.com/fourwardhabits/bingd/blob/docs/product-gtm-refresh/docs/product/gtm-context.md) ·
[`brand.md`](https://github.com/fourwardhabits/bingd/blob/docs/product-gtm-refresh/docs/product/brand.md) · [`analytics.md`](./analytics.md) ·
[`deferred-roadmap.md`](./deferred-roadmap.md) ·
[`../release/public-launch-risk-register.md`](../release/public-launch-risk-register.md)

**What this document is.** The founder's execution plan for the next ~30 days and the
first ~100 real users, with a high-level path beyond. It is an *operating* document:
phases with entry and exit conditions, a weekly calendar, exact research questions, and
decision gates. It deliberately does not re-derive product strategy — the PRD and
gtm-context.md own that. Where this document states a threshold, **the threshold is a
heuristic chosen to force a decision, not a scientifically established number.** Change
it deliberately, not by forgetting it.

**Task markers.** `[F]` = founder must do it personally (judgment, relationships,
credentials). `[AI]` = an agent can execute it end-to-end. `[F+AI]` = agent drafts,
founder decides or sends.

---

## 1. One-page strategy

**Where bingd. is.** The product works. Both beta lanes are live, the stability fires
(push registration storm, auth stalls, onboarding hangs) are out, push reaches phones,
and the thirteen-event analytics set is wired. The bottleneck has moved from *building*
to *learning*: almost nobody outside the founder's immediate circle has used the app, so
every product belief — that pairwise ranking is fun, that friend recommendations
re-engage, that Match creates connection — is still a hypothesis with zero external
evidence.

**Current objective.** Get ~100 real users onto the published betas **in connected
clusters**, and use them to answer one question:

> **Do people who join with friends get recurring value from bingd. —** do they
> activate (10 ranked titles), connect, act socially without prompting, and come back
> after they watch something?

**Key hypothesis.** A connected cluster (4+ people who know each other, mutually
following, with overlapping taste) will activate and retain meaningfully better than
isolated installs, because the Feed, recommendations, Match, and reactions only produce
value across a relationship (gtm-context §E). If clusters *don't* behave differently,
the social layer isn't yet earning its weight and that changes what gets built next.

**Why the first 100 matter.** Not as a number — 100 installs is a vanity milestone. They
matter because ~100 users across 5–8 clusters is the smallest population that can show a
retention curve, distinguish a cluster from a loner, produce enough taste overlap for
Match and recommendations to be tested honestly, and generate the dataset Recommendation
Engine V2 is explicitly waiting for (deferred-roadmap §18). Everything downstream —
public launch, channel spend, monetization — is gated on what this cohort shows.

**The operating stance.** Distribution and learning are now the founder's job;
engineering is the *support* function. Product changes ship only when they are P0/P1
(cannot install, sign in, activate, or run the social loop) or when three independent
users hit the same confusion. Everything else waits, on purpose.

---

## 2. Stage roadmap

| Stage | Goal | Primary activities | In parallel | Success gate (exit) | Don't do yet |
|---|---|---|---|---|---|
| **0 — Instrument & ready** (days 0–4) | Trust the dials before turning up traffic | Verify funnel end-to-end on both platforms; PostHog dashboard; Sentry readable; feedback log; support loop | Inner-circle invites begin | Dashboard shows real events for a fresh signup on each platform; every P0 path verified | Any feature work; any public posting |
| **1 — Seed clusters** (days 1–14) | 20–35 users in ≥3 connected clusters | Personally recruit 3–4 movie group chats + inner circle; seed follows; 24–48h research messages | P0/P1 fixes only; daily 10-min dashboard glance | ≥15 activated; ≥3 clusters where members follow each other and ≥1 unprompted social act happened | Reddit/strangers; invite-loop asks; any deferred feature |
| **2 — Validate the loop** (days ~10–30) | 35–60 users; prove activation + social loop | One hop out (friends-of-friends); first semi-stranger group (coworkers, film club); weekly cohort review; 5 user calls | Batch P2 fixes weekly; [AI] community-rules research for Phase 3 | Activation ≥~50% of signups; W2 return ≥~40% of activated; unprompted social acts weekly in ≥2 clusters | Public store launch; rec-engine tuning; growth features |
| **3 — First repeatable acquisition** (days ~30–60) | 60–100+; test channels on strangers | 1–2 community experiments (Reddit/Discord/local film club), run one at a time; "invite two people you watch movies with" ask to activated users; measure isolated vs clustered | Fix stranger-onboarding friction found; keep research cadence | One channel produces ≥15 signups at acceptable effort AND ≥30% of them activate; invite ask produces measurable redemptions | Paid anything; attribution SDKs; scaling founder content |
| **4 — Retention proof & channel pick** (100+, months 2–3) | Prove recurring value; pick the public-launch channel | Hold acquisition mostly flat; watch W2/W4 curves by cohort; deep-dive churned users; decide public-launch scope | Close pre-public majors (L-1, HG-3, production bootstrap) as they become the critical path | Scorecard §6 mostly green two weeks running; a named channel + message that repeatably converts | Monetization; feature expansion beyond gate-triggered fixes |
| **Future — public stores** | Hundreds → thousands | See §12 | | | |

Each stage in the required detail:

### Stage 0 — Instrumentation and readiness (days 0–4)

1. **Objective.** Make the dials trustworthy and the support loop real before traffic
   arrives.
2. **Why it exists.** Every later decision in this document reads a metric or a user
   report. If `signup_completed` doesn't visibly land in PostHog, or Sentry can't be
   read, or feedback arrives across six text threads, the next 30 days produce anecdotes
   instead of answers. analytics.md §10 already lists founder verification steps that
   have never been done (confirm events visible in the PostHog project; confirm Sentry
   issues readable).
3. **Entry condition.** Now. Nothing blocks it.
4. **Specific activities.**
   - `[F]` Walk the funnel as a stranger once per platform: open your own
     `bingd.app/i/<token>` link on a phone, install via TestFlight / Play opt-in, create
     a throwaway account, complete onboarding, rank 3 titles, follow one person, send one
     recommendation. Note every moment of confusion; confirm each canonical event
     appears in PostHog with the right build identity.
   - `[F+AI]` Build the one founder dashboard in PostHog (§6 lists the exact tiles). AI
     drafts the insight definitions; founder confirms they render and bookmarks it.
   - `[F]` Fix Sentry access so Issues is readable in under a minute on the phone.
   - `[F+AI]` Create the feedback log — one place (a single spreadsheet or GitHub
     issues, founder's pick), columns: date · reporter · platform · build/update (from
     the About screen or Diagnostics sheet) · what happened · severity P0–P3 · status ·
     closed-loop-with-reporter? All six text threads funnel into it, by the founder,
     same day.
   - `[F]` Confirm the support address on bingd.app's support page is a mailbox that is
     actually checked.
   - `[F]` Check Google Play developer verification status (HG-2 — **deadline
     2026-09-30**, ~4 weeks away).
5. **In parallel.** Inner-circle invitations can start immediately — these people
   tolerate rough edges and their reports test the support loop itself.
6. **Metrics/signals.** A fresh signup on each platform produces the expected event
   chain; a deliberate test crash appears in Sentry.
7. **Exit criteria.** Dashboard live and checked two days running; both platform funnels
   walked clean or with logged P-rated findings; feedback log has ≥1 real entry that was
   closed back to the reporter.
8. **Failure signals.** Events missing or misattributed to the wrong build → stop
   recruiting, fix instrumentation first. An install path that fails (TestFlight link
   dead, Play opt-in rejected) is a P0.
9. **What we learn.** Whether the measurement story in analytics.md §10 is actually
   finished, and where the install path leaks before any stranger touches it.
10. **Not yet.** No feature work of any kind. No public visibility.

### Stage 1 — Seed connected clusters (days 1–14, overlaps Stage 0)

1. **Objective.** 20–35 users, of whom ≥15 activated, arranged in at least 3 genuine
   clusters — people who already watch and talk about movies together.
2. **Why it exists.** gtm-context §E: an isolated tester sees a logging app; a cluster
   sees the product. Recruiting clusters first means the *first* impression most testers
   get includes a live Feed, real Match numbers, and recommendations from people they
   know — which is the product being tested. It also front-loads the highest-tolerance,
   highest-honesty users.
3. **Entry condition.** Stage 0's dashboard is live (a day or two of overlap is fine).
4. **Specific activities.**
   - `[F]` Write **individual** messages (never a group blast) to 10–15 close friends
     who watch things. The ask names a concrete first act: "install, rank 10 titles
     you've seen — takes about 10 minutes — and follow me back; I need 5 people whose
     taste I trust before I let strangers in."
   - `[F]` Recruit 3–4 existing movie group chats of 4–8 people. The ask to the chat:
     "I built the thing we do in this chat. If at least 3 of you install this week and
     rank 10 titles, Match scores between all of us light up." Getting **≥3 members of
     the same chat inside a 48-hour window** is the point — a cluster that trickles in
     never sees each other.
   - `[F]` Seed every new user socially within 24h from the founder account: follow
     them, and send one *personal* recommendation through the product (a title chosen
     for them, not a broadcast). This exercises the exact loop being tested and gives
     every tester one item in Sent to you.
   - `[F]` Run the 24–48h research message on every signup (§7, verbatim questions).
   - `[AI]` Nightly: pull exact activation/connection counts from the nonprod database
     (event counts approximate; SQL is truth for "who has 10 ranked titles" and mutual
     follows).
5. **In parallel.** P0/P1 fixes ship by OTA as found. Nothing else does.
6. **Metrics/signals.** Signups; onboarding completion; activation within 7 days;
   mutual-follow counts; recommendations sent by non-founder accounts; reactions and
   comments (unmeasured in PostHog — read from the database `[AI]`).
7. **Exit criteria.** ≥15 activated users; ≥3 clusters in which members follow each
   other without being individually walked through it; **at least one unprompted social
   act** (a reaction, comment, or recommendation the founder neither performed nor
   requested) in at least 2 clusters.
8. **Failure signals.** Friends install but stall before 10 ranked → activation problem;
   run the §7 questions, watch one session in person, fix the top friction before
   recruiting further. Installs but no follows despite seeding → the connection
   mechanics are too hidden; that's a P1. Polite silence from people who said yes →
   the ask is wrong, not the app; rewrite the ask first.
9. **What we learn.** Whether people who *like* the founder — the friendliest possible
   audience — will do 10 rankings and one social act. If they won't, strangers won't,
   and Phase 3 would be spending a nonrenewable first impression on an unvalidated
   funnel.
10. **Not yet.** No Reddit, no public posting, no invite-loop prompts (personal
    recruiting is still cheaper and higher-signal), no feature requests honored unless
    P1 by the §8 framework.

### Stage 2 — Validate activation and the social loop (days ~10–30)

1. **Objective.** 35–60 users; establish with numbers that activation, connection, and
   week-2 return actually happen in clusters.
2. **Why it exists.** This is the gate between "my friends humored me" and "this works
   on people one hop away." It also produces the first honest retention read, which
   every later decision cites.
3. **Entry condition.** Stage 1 exit met.
4. **Specific activities.**
   - `[F]` One hop out: ask each activated tester — individually, not in-app — "who are
     the two people you'd most want on this?" and let them make the introduction or
     send their own invite link. Target 10–15 friends-of-friends who land *inside* an
     existing cluster.
   - `[F]` First semi-stranger group: coworkers who talk movies, a film club, a regular
     movie-night crew. One group, recruited with the same 48-hour-window ask.
   - `[F]` Five 15-minute calls with a mix of activated and stalled users (§7 script).
   - `[F]` Weekly cohort review (Sunday, 60–90 min): scorecard §6, decide the one
     product change and one acquisition move for the week.
   - `[AI]` Research pass for Stage 3: which subreddits/Discords/communities permit
     beta recruitment and on what terms (the open questions in gtm-context §I) —
     research only, no posting.
   - `[F+AI]` Batch P2 fixes into one weekly OTA.
5. **In parallel.** Continue 24–48h messages on every signup; continue founder seeding
   of follows/recs for users who arrive outside a cluster.
6. **Metrics/signals.** Activation rate by cohort; W2 return; second-ranking-session
   rate; unprompted social acts per cluster per week; invite redemptions (floor —
   analytics.md §3).
7. **Exit criteria.** Activation ≥~50% of signups; W2 return ≥~40% of activated;
   unprompted social activity weekly in ≥2 clusters; the semi-stranger group activated
   without founder hand-holding beyond the ask.
8. **Failure signals.** Activation fine, W2 return red → people rank once and leave:
   the collection has no pull yet; investigate with calls before building anything.
   Friends-of-friends activate much worse than friends → onboarding depends on founder
   proximity; find and fix the gap before Stage 3. Social acts only happen when the
   founder acts first → the loop isn't self-sustaining; that finding outranks
   recruiting more users.
9. **What we learn.** The first real retention curve; whether the social loop runs
   without the founder as its motor; what stalls people at each funnel step.
10. **Not yet.** Public-store launch, Letterboxd import, rec-engine work, referral
    mechanics beyond the existing invite link, monetization signals.

### Stage 3 — First repeatable acquisition experiments (days ~30–60)

1. **Objective.** 60–100+ users; find one channel beyond personal reach that produces
   activating users at a founder-sustainable effort.
2. **Why it exists.** Personal recruiting caps at the founder's social graph.
   The first 100 must include people with no path to the founder, both to reach the
   number and because **strangers are the only honest test of cold onboarding** —
   which is what a public store launch serves.
3. **Entry condition.** Stage 2 exit met. Posting to strangers before then burns a
   first impression that does not come back.
4. **Specific activities.**
   - `[F+AI]` One community experiment at a time, one week each: AI drafts the post per
     the community's rules and brand.md voice; founder edits and posts personally,
     engages every reply for 48h. Candidates (validate rules first, per the Stage 2
     research): a Letterboxd-adjacent subreddit, a ranking/tier-list community, a
     Chicago film-community Discord or club, an AMC A-List community.
   - `[F]` The invite ask, to activated users only, personally: "invite the two people
     you actually watch movies with." Measure `invite_redeemed` (a floor) and ask
     directly who joined.
   - `[F]` A movie-night/launch-night test if a local group makes it cheap: one
     evening, everyone installs and ranks together, Match reveals at the end. This is
     the cluster-onboarding mechanic in its purest form; note what it converts.
   - `[F+AI]` Fix the stranger-onboarding frictions the new cohort exposes (these are
     P1 by definition — they block activation).
5. **In parallel.** Keep the research cadence on all new users; keep weekly reviews;
   watch isolated-stranger retention as its own cohort.
6. **Metrics/signals.** Per-channel: signups, activation rate, W2 return, founder hours
   spent. Isolated vs clustered activation/retention split (the network-density
   question, finally answered with data).
7. **Exit criteria.** One channel yields ≥15 signups with ≥~30% activation at an effort
   the founder could repeat monthly; the invite ask produces measurable redemptions;
   100 total users crossed or clearly in reach.
8. **Failure signals.** Strangers install and vanish before onboarding completes →
   cold-start gap (they arrive to an empty feed; consider whether founder-seeding can
   be productized later — but log it, don't build it yet). A channel produces installs
   but near-zero activation → wrong audience or wrong promise; kill it after one good
   post, don't iterate endlessly.
9. **What we learn.** Which acquisition unit (cluster vs individual) and which channel
   the public launch should lead with; how much worse isolated users perform (the
   number that justifies — or kills — invite-first growth mechanics).
10. **Not yet.** Paid acquisition, attribution SDKs, creator partnerships at scale,
    building viral loops beyond the existing invite link.

### Stage 4 — Retention proof and channel selection (100+, months 2–3)

1. **Objective.** Prove recurring value on the full cohort and pick the public-launch
   channel and message.
2. **Why it exists.** Public launch is a one-time event with real fixed costs
   (production Supabase bootstrap, legal, store review, HG-3 trademark clearance).
   It should be spent on a product with proven retention and a known channel, not to
   find out.
3. **Entry condition.** ~100 users; Stage 3 exit met.
4. **Specific activities.** Hold acquisition roughly flat; watch W2/W4 by cohort;
   `[F]` call 5 churned users ("what happened after the first week?"); `[F+AI]` close
   the pre-public majors in §10 as the critical path; decide public-launch scope
   against PRD §27.
5. **In parallel.** Only gate-blocking product work.
6. **Metrics/signals.** The §6 scorecard, now with enough volume to trust; churn
   reasons from calls.
7. **Exit criteria.** Scorecard mostly green two consecutive weeks; a named
   channel + message with a repeatable conversion story; pre-public checklist §10
   green.
8. **Failure signals.** W4 retention collapses across cohorts → the product has an
   engagement problem no launch will fix; return to product work with the churn-call
   evidence. Only founder-adjacent clusters retain → the product currently *requires*
   a dense import mechanism (this is when Letterboxd import and contacts come off the
   deferred list, per their own revisit triggers).
9. **What we learn.** Whether to launch, what to say, and to whom.
10. **Not yet.** Monetization (measure gate hits first — PRD §28), fundraising
    narratives, feature expansion.

---

## 3. First-100 acquisition plan

**The unit is the cluster until Stage 3; individuals are recruited only where they can
be seeded into an existing cluster or where testing cold onboarding is the point.**

A numerical path. Conversion figures are stated to force planning arithmetic, **not
because they are precise** — expect ±half on every one:

| # | Tranche | Source | Target users | Assumed conversion | Founder activity | Timing | Learning goal |
|---|---|---|---|---|---|---|---|
| 1 | Inner circle | Close friends + family who watch | **12–15** | ~70–80% of individual asks | 10–15 personal messages, hand-held onboarding | Week 1 | Activation friction with maximum goodwill; support loop shakeout |
| 2 | Movie group chats | 3–4 existing chats, 4–8 people each | **15–20** | ~50% of chat members | One tailored ask per chat; 48-hour-window push; seed follows | Weeks 1–3 | Does a cluster light up socially without prompting? |
| 3 | Friends-of-friends | Introductions from activated testers | **10–15** | ~30–40% of asks | "Who are the two people you'd want on this?" to every activated user | Weeks 2–4 | Does it spread one hop without the founder? Does onboarding survive weaker ties? |
| 4 | Local / semi-strangers | Coworkers, a film club, movie-night crew, Chicago film community | **10–15** | ~30% of a group | 1–2 group asks; optionally one movie-night onboarding evening | Weeks 3–5 | Semi-stranger activation; the movie-night mechanic |
| 5 | Online community | One subreddit/Discord experiment at a time (rules permitting) | **15–25** | Unknown — that's the experiment | 1 post/week, personally engaged for 48h | Weeks 4–6 (gated on Stage 2 exit) | Cold-install onboarding; isolated-user retention; channel viability |
| 6 | Referrals | Invite links from activated users, prompted personally | **10–15** | ~1 redemption per 2–3 activated users asked | The invite ask at week 2–3 of each user's life | Ongoing from week 3 | Do users invite when asked? Ever unprompted? |

**Total: ~75–105.** If tranches 1–4 underdeliver, that is itself the finding — do not
paper over it by going louder in tranche 5; a product that can't convert warm ties has
no business recruiting cold ones.

**Measurement honesty.** Invite-link numbers are floors — a token does not survive a
store install, and someone who installs then launches from the home screen is invited
but unattributed (analytics.md §3). Track tranche membership manually in the feedback
log (who came from where), and use `beta_cohort` / `acquisition_source` super-properties
only if wired deliberately; today nothing sets them except invite redemption.

---

## 4. The next 7 days — founder checklist

Aggressively prioritized; roughly 5–7 hours of founder time total across the week.

```
[ ] 1. Walk the funnel as a stranger, both platforms
      Time: 60–90 min   Dependency: none
      Output: verified install→signup→rank→follow→recommend path; P-rated list of hitches;
              events confirmed in PostHog with correct build identity
      Why: every later number depends on this path working and being measured

[ ] 2. Stand up the founder dashboard + fix Sentry access          [F+AI]
      Time: 45 min founder (AI drafts insights)   Dependency: PostHog login
      Output: one bookmarked dashboard (§6 tiles); Sentry Issues readable on the phone
      Why: 10-minute daily check becomes possible; reliability regressions surface same-day

[ ] 3. Create the feedback log and route all existing threads into it   [F+AI]
      Time: 30 min   Dependency: none
      Output: one sheet/board with severity columns; existing known issues entered
      Why: feedback across six text threads is how P1s get lost

[ ] 4. Check Google Play developer verification (HG-2)
      Time: 15 min   Dependency: Play Console access
      Output: confirmed compliant, or a dated task — deadline 2026-09-30
      Why: missing it can take the Android app offline regardless of everything else

[ ] 5. Send 10–15 individual inner-circle invites
      Time: 60 min (personal messages, not a blast)   Dependency: task 1 done
      Output: ~8–12 installs beginning; each told the concrete ask (10 rankings + follow back)
      Why: first activation data from the most honest available audience

[ ] 6. Recruit 2 movie group chats with the 48-hour-window ask
      Time: 30 min   Dependency: task 1 done
      Output: ≥3 members of each chat installing in the same window
      Why: first connected-cluster behavior — the core hypothesis gets its first test

[ ] 7. Seed every new user from the founder account (daily)
      Time: 10–15 min/day   Dependency: signups arriving
      Output: follow + one personal in-app recommendation per new user within 24h
      Why: guarantees every tester's first session includes a live social surface

[ ] 8. Send the 24–48h research message to every signup (daily)
      Time: 10 min/day   Dependency: signups arriving
      Output: answers logged in the feedback log
      Why: the why behind every funnel number; cheapest research that exists
```

Explicitly **not** this week: any coding task that isn't a P0/P1 from task 1 or a
tester report; any public post; any new feature.

---

## 5. The next 30 days — weekly view

| | Week 1 | Week 2 | Week 3 | Week 4 |
|---|---|---|---|---|
| **Primary objective** | Instruments trusted; inner circle in | 3 clusters live; first activation read | One hop out; loop validation | 35–60 users; Stage 3 go/no-go |
| **Acquisition** | 10–15 inner circle; 2 group chats | 1–2 more group chats; 48h-window pushes | Friends-of-friends asks to every activated user | First semi-stranger group; prep (not post) community experiment |
| **Research** | 24–48h messages start | 24–48h messages on all; log everything | 5 × 15-min calls (mixed activated/stalled) | Week-2 follow-up message to week-1/2 cohort |
| **Product/build** | P0/P1 only, from funnel walk | P0/P1 only | First batched P2 OTA if warranted | Second P2 batch; stranger-friction fixes |
| **Analytics** | Dashboard live; daily glance habit | First weekly cohort review (Sun) | Weekly review; isolated-vs-cluster first look | Weekly review; W2 retention of week-1/2 cohort — the number of the month |
| **Admin** | HG-2 check; support mailbox confirmed | — | [AI] community-rules research | Review pre-public list §10; no action unless critical-path |
| **Decision gate** | Funnel clean? If not, fix before recruiting further | ≥3 clusters formed? If not, more chats before more individuals | Unprompted social acts happening? If not, that's the week's product question | Stage 2 exit met? → green-light community experiment for week 5 |

Parallelism rule: acquisition messages, research messages, and AI-executed fixes always
run concurrently; the founder's scarce hours go to conversations, and agents carry the
build and analysis load between them.

---

## 6. Metrics and scorecard

### The founder dashboard (build once in PostHog, Stage 0)

Daily glance (~10 min): new `signup_completed` · `ranking_completed` count ·
crash-free rate / new Sentry issues · anything new in the feedback log.

Weekly review adds: onboarding completion rate · activation rate by weekly cohort ·
`follow_created` (approved) per new user · `recommendation_sent` / `recommendation_opened`
· invite funnel (created → redeemed → activated, labelled *floor*) · returning users via
`Application Opened` (W2 proxy).

Two things PostHog cannot answer, pulled by SQL from nonprod `[AI]`, weekly: exact
activated-user list (≥10 rows in `rankings`), and the mutual-follow graph (who is
connected, cluster shapes). Comments/reactions are also unmeasured events — count them
in SQL, don't add events mid-beta (gtm-context §G).

### Definitions (fixed now so numbers mean the same thing all month)

- **Activated** = 10 ranked titles (PRD §28, canonical). Track *within 7 days of
  signup* as the working rate; the PRD's 24-hour bound is a public-alpha metric and too
  strict for friends with jobs.
- **Connected** = ≥2 mutual follows.
- **Cluster** = ≥4 users who mutually follow within their group.
- **W2 return** = any `Application Opened` on days 8–14 after signup.
- **Second ranking session** = a `ranking_completed` on a later calendar day than the
  user's first.
- **Unprompted social act** = a reaction, comment, or recommendation not performed by
  the founder and not individually requested by the founder.

### First-100 scorecard — all thresholds are heuristics

| Area | Metric | Why it matters | GREEN | YELLOW | RED |
|---|---|---|---|---|---|
| **Users** | Total signups; % arriving inside a cluster | Volume is only meaningful if connected | 75–100+, ≥70% clustered | 40–75 | <40, or mostly isolated |
| **Activation** | % of signups activated within 7 days | The product's first promise: a ranked list worth having | ≥50% | 30–50% | <30% |
| **Connectedness** | % of actives connected (≥2 mutuals); # clusters | The social layer needs edges to exist at all | ≥70%, ≥5 clusters | 50–70% | <50% |
| **Engagement** | Second ranking session ≤14d; unprompted social acts/cluster/week | Ranking again = the collection has pull; social acts = the loop runs itself | ≥60%; weekly acts in most clusters | 40–60%; sporadic | <40%; social only when founder prompts |
| **Retention** | W2 return of activated; W4 for older cohorts | A movie app is weekly-cadence, not daily — W2 is the honest early bar | ≥40% W2 | 25–40% | <25% |
| **Reliability** | Crash-free sessions; open P0s; median P1 fix time | Beta trust is spent once | ≥99%, zero P0, P1 <3d | 97–99% | <97%, or any P0 open >24h |
| **Qualitative pull** | Unprompted invites; "disappointed without it" answers; feature asks from retained users | The signal numbers can't fake | Any unprompted invite; ≥3 users clearly pulled | Polite positivity only | Users can't say what they'd use it for |

**Retention interpretation, stated once.** Do not benchmark against daily-use consumer
apps. The natural loop is: watch something (1–3×/week) → log it → see friends' activity.
The failure signature to watch for is not "didn't open daily" but **"watched something
and didn't log it"** — that exact question is in the §7 script because no event can
answer it.

---

## 7. User research plan

Behavioral data says *what*; conversations say *why*. Use messages for breadth (every
user, async, 2 questions) and calls for depth (5 at a time, 15 min, scripted). Trust
behavior over stated intent everywhere they conflict — what people say they'll use is
worthless next to what they did yesterday.

**At signup + 24–48h — every user, by text, exactly two questions:**
1. "What did you think you'd use bingd. for when you first opened it — and what did you
   actually end up doing in it?"
2. "Was there any point where you weren't sure what to do next? Where?"

**At day 7–10 — every user still reachable, two questions:**
3. "Have you watched anything since installing? Did you log it in bingd.? If not — no
   judgment — what happened instead?"
4. "What would make you open bingd. tomorrow without me messaging you?"

**Week 3 — five 15-minute calls** (mix: 2 activated-and-returning, 2 activated-then-quiet,
1 stalled before activation):
- "Walk me through the last time you opened it. What did you do first?"
- "In your own words, what does the 8.4 next to [their title] mean?" *(comprehension
  check on the score — PRD §10 assumes this reads correctly; verify it.)*
- "You ranked X and then stopped for a week — what was that week like?"
- "Who in your life should be on this? What's stopped you from sending them your link?"
- Stalled user only: "You got to [step] and stopped — take me back to that moment."

**Cadence and sample:** messages are 100% coverage (10 min/day); calls are 5 per
research cycle, roughly weeks 3 and 6. Log every answer in the feedback log the same
day, tagged to the user's cohort. When an interview claim and the funnel disagree —
"the ranking was fun!" but 40% stall at comparison 3 — **the funnel is telling the
truth and the interview is being polite.**

---

## 8. Product prioritization — bugs and backlog governance

### Severity framework

| Level | Definition | Response |
|---|---|---|
| **P0** | Cannot install, sign in, or use the app; crash loop; data loss; privacy leak | Drop everything. Fix + OTA (or rollback per the safe-update runbook) same day. Distribution pauses only for open P0s |
| **P1** | Blocks activation or the social loop for more than one user (onboarding stall, ranking failure, follow/recommend broken, invite link dead) | Fix within ~3 days via `[AI]` agents; OTA when verified |
| **P2** | Repeated confusion — ≥3 independent users hit the same misunderstanding | Batch; one weekly OTA at most |
| **P3** | Polish, single-user preference, cosmetics | Backlog. Revisit monthly. Most die there, correctly |

### Feedback → NOW / NEXT / LATER / IGNORE

The trap this framework exists to prevent: *one tester asks → founder launches Claude →
app changes that night.* Every piece of feedback passes four questions, in order:

1. **Does it block activation or the social loop right now?** → NOW (it's a P0/P1).
2. **Have ≥3 independent users hit it, or does the funnel corroborate one report?** →
   NEXT (P2 batch). One person's opinion is a data point, not a work item.
3. **Does it require a native change?** → LATER automatically. The native surface is
   frozen; a new binary is a deliberate, scheduled event (§9), never a reaction to one
   report.
4. **Is it already in deferred-roadmap.md with a revisit trigger?** → LATER, and the
   *trigger* decides when — the register already contains the reasoning; don't
   re-litigate it because a tester independently reinvented the feature.

Everything else → IGNORE, politely, with a thank-you to the reporter (the close-the-loop
habit is what keeps testers reporting). Founder-observed polish itches follow the same
rules as tester reports — **random founder observations do not get to block
distribution either.**

---

## 9. Release and engineering cadence

Operational rules for the current lane (mechanics live in
[`release-lanes.md`](../release/release-lanes.md) and the
[`safe-update-runbook.md`](../release/safe-update-runbook.md)):

- **OTA to beta** is the default vehicle: P0 same-day, P1 within days, P2 in one weekly
  batch. Every OTA goes to preview first, gets a device smoke-check, then beta — except
  a P0, where the runbook's fast path applies.
- **New binary** only when something native must change, batched deliberately, never
  inside the same tranche as other risk (the push-binary lesson). There is currently no
  reason to cut one; treat the next binary as an *event* with its own checklist.
- **Hold a release** when it isn't a P0 and the week already shipped an OTA — testers on
  a small beta notice churn more than they notice absence of polish.
- **Roll back** per the runbook whenever a shipped OTA produces any P0 signal; roll
  back first, diagnose second.
- **Verify what a device is running** before treating any report as evidence: resolve
  the About-screen / Diagnostics prefix to an EAS update ID first — a "bug" on a stale
  update is not a bug in HEAD.
- **AI executes, founder decides.** Agents carry implementation, review, SQL analysis,
  and research drafts. The founder's engineering role this month is: choose what ships
  (by §8), smoke-test on a physical device, and press publish. Independent review stays
  mandatory on sensitive surfaces (PRD §29's agent-risk row).

---

## 10. Admin, legal, and security checklist

### NOW (this week, mostly minutes not days)

- **Google Play developer verification (HG-2)** — confirm status; hard deadline
  **2026-09-30**.
- **Support mailbox** monitored; bingd.app support page points at it.
- **Feedback log** exists (§4).
- **Sentry + PostHog dashboards readable** by the founder (§4).
- **Credential hygiene:** any untracked credential files sitting inside the repo
  folder (e.g. the Android signing/FCM files in `02 JSO/`) move to a password
  manager / secure storage outside the working tree. `[F]` 30 min.
- Nothing else. Privacy policy, terms (labelled draft), data-deletion (in-app account
  deletion), and the moderation runbook already exist and are beta-adequate.

### BEFORE PUBLIC STORE LAUNCH (start when Stage 4 entry is in sight)

- **L-1 legal facts:** operating entity decision, governing law/venue, legal-notice
  address, a lawyer's read of the Terms draft. (Entity formation is decided *here*,
  when a real contract needs a party — not now.)
- **HG-3:** App Store / Play name availability + knockout trademark search.
- **Production Supabase bootstrap** (the entire production lane currently fails
  closed, by design) + the OTP-template/console-state replication and
  ref-in-three-places discipline.
- **Store privacy labels** re-verified against the store-privacy inventory; two-project
  PostHog split decision (analytics.md §10 item 5); Sentry source-map upload for
  production builds.
- **Moderation reality check:** the report queue is only read when somebody looks —
  fine at 60 friends, needs at least a notification-on-report before strangers arrive.
- **Security re-verification pass** of the beta-security-review against HEAD.

### AFTER INITIAL VALIDATION

- Entity formation + banking/bookkeeping (there is no money to keep books on yet).
- Trademark *registration* (clearance search is the launch gate; registration follows).

### MUCH LATER

- Attribution SDKs, ad accounts, anything with a data-sharing relationship
  (deferred-roadmap §10's reasoning stands until there is a campaign and a budget).

**Security/privacy pre-growth minimum, stated as a rule rather than a program:** the
posture (RLS reviewed, analytics allowlisted, no free text in events, autocapture off,
Sentry scrubbed) is already stronger than the cohort requires. The risk is *regression*,
not absence: no new SDK, no new event property, and no relaxation of the scrubbing
rules ships during the beta without its own review. Verify account deletion end-to-end
once on a throwaway account; confirm blocking works between two test accounts; done.

---

## 11. Decision gates

| Decision | Evidence threshold |
|---|---|
| **Keep polishing vs recruit more** | Recruit unless an open P0/P1 or activation <30% on the last 10 signups. Polish never blocks distribution by itself |
| **Post to Reddit / strangers** | Stage 2 exit: activation ≥~50%, W2 ≥~40% of activated, unprompted social acts in ≥2 clusters — plus rules research done for that community |
| **Expand to broader communities** | The first community experiment activated ≥~30% of its signups |
| **Ask users to invite friends** | User is activated + returned in week 2. Product-side invite *prompts* (beyond the existing link) are built only if manual asks show ≥1 redemption per 2–3 asks |
| **Launch publicly in app stores** | Scorecard mostly green 2 weeks running · a repeatable channel identified · §10 pre-public list closed · PRD §27 gates met. All four; the first three are the ones nobody can backfill later |
| **Invest in new features** | Only via §8 (P1/P2 evidence) or a deferred-roadmap revisit trigger firing on real usage — e.g. Letterboxd import returns when hand-building a collection is *the* measured stopping point for a public cohort; rec-engine V2 when 30–60 users have overlapping catalogues and stable Match pairs |
| **Start thinking about monetization** | After retention proof (Stage 4 green) — and even then the first step is instrumenting capability-gate hits (PRD §28), not pricing |
| **Reconsider the core product** | If, with ≥50 users in ≥5 genuine clusters and no open P1s, activation stays <30% **or** W2 return of activated stays <20% for 3+ weeks — the friendliest audience the product will ever have is saying no. Reconsider means: churn calls first, then re-scope, not quiet abandonment |

---

## 12. After 100 users — deliberately high-level

Every arrow below is a hypothesis, not a plan of record.

- **100 → 250: prove the loop repeats without the founder's graph.** Double down on the
  one validated channel; productize the invite moment only if manual asks proved
  demand. Retention infrastructure (D7/D28 cohort views) becomes PostHog configuration
  on real volume — deferred-roadmap §9 comes due here.
- **250 → 500–1,000: public-store launch.** Production bootstrap, legal pack, HG-3,
  store review. Cold-start work comes off the shelf as *its* triggers fire: Letterboxd
  import (public cohort, real export files to tune against), possibly contacts
  matching (with its recorded privacy requirements). Recommendation Engine V2 gets its
  dataset.
- **1,000+: compounding distribution.** Referral loops with product support, Quarterly
  Recap as the shareable artifact (blocked on the rewatch/cross-year debt, per
  deferred-roadmap §13), micro-creator partnerships if and only if early creator
  experiments showed pull.
- **Later, and only if justified by retention economics:** monetization (Pro bundle per
  PRD §20–21, growth loops stay free permanently), partnerships, capital. None of these
  is a goal; each is a tool that becomes relevant only after recurring value is proven.

---

## 13. If I only do five things

1. **Personally recruit clusters, not installs** — individual messages to friends and
   whole group chats with the 48-hour-window ask, until ≥5 clusters exist.
2. **Message every new user at 24–48h and day 7** with the four §7 questions, and log
   the answers the same day.
3. **Look at the dashboard for 10 minutes every day** — signups, rankings, crashes —
   and the full scorecard every Sunday.
4. **Fix only P0/P1, batch P2 weekly, ignore the rest** — and let AI agents do the
   fixing while founder hours go to conversations.
5. **Hold the Stage 2 gate honestly** — no strangers, no Reddit, no launch until the
   friendliest possible cohort has proven activation and the social loop.

## 14. Do not work on yet — the anti-roadmap

Each of these is recorded with reasoning in deferred-roadmap.md or the PRD; the list
exists so a quiet evening doesn't turn one into a project:

- Letterboxd import (§20 — returns at public traction, not before)
- Recommendation Engine V2 or any rec tuning (§18 — waits for this cohort's data)
- Push scheduler / receipt reconciliation (§4 remainder — inbox + current push suffice)
- Award artwork completion (§14 — reversible, blocks nothing)
- Monetization, paywalls, pricing, RevenueCat (PRD §21 — paid-beta phase)
- Paid acquisition or any attribution SDK (§10)
- Contacts import (§21 — privacy design first, and only at public scale)
- Experimentation/A-B platform (§12 — the cohort cannot power an experiment)
- New analytics events mid-beta (the thirteen are the set; SQL answers the rest)
- Dark mode, collection swipe-paging (§16), followers score (§3), historical
  reviews-per-watch (§19)
- New native binaries without a forcing native change
- LLC paperwork, trademark registration, bookkeeping (until §10's gates say so)
- A founder content-creator program — seeding follows and one personal rec per new
  user is the whole "community program" until evidence demands more

---

## Tomorrow morning: the three hours

> *"If I wake up tomorrow with a stable iOS/Android beta and no coding task already
> queued, what exactly should I spend the next three hours doing?"*

**0:00–0:30 — Look at the instruments.** Open PostHog: did yesterday's events arrive,
from which builds? Open Sentry: anything new? Open the feedback log (create it now if it
doesn't exist — 15 of these minutes). If the dashboard from §4 isn't built, spend this
half hour having an agent build it while you do the next block.

**0:30–1:45 — Recruit, personally.** Write 10 individual messages to the closest people
who watch things — each one names the ask: *"install from this link, rank 10 titles
you've seen (about 10 minutes), follow me back."* Then write to your two most active
movie group chats: *"I built the thing we do in this chat — if 3+ of you get on this
week, Match scores between all of us light up."* Use your own `bingd.app/i/<token>`
link everywhere. Do not send a group blast to individuals; the personal sentence at the
top of each message is the conversion mechanism.

**1:45–2:15 — Seed the network.** From your account: follow every tester who has joined,
and send each one a personal recommendation through the app — one title picked for that
person. You are exercising the exact loop the beta exists to test, and making sure
nobody's first session opens onto an empty feed.

**2:15–2:45 — Run the research loop.** Message everyone who signed up in the last 48
hours: *"What did you think you'd use bingd. for when you first opened it — and what did
you actually do? Was there any point you weren't sure what to do next?"* Log every
answer.

**2:45–3:00 — Triage, don't build.** Sort anything new in the feedback log with the §8
framework. If a P0/P1 exists, hand it to an agent with a clear brief and check the fix
tonight. If not — and this is the discipline — **close the laptop with nothing queued.**
The next three hours of product improvement are hiding in the replies to the messages
you just sent, not in the codebase.
