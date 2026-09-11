# Analytics — what Bingd measures before the friend beta, and what it deliberately does not

**Status:** current as of 2026-08-19. Implemented in [`src/lib/analytics.ts`](../../src/lib/analytics.ts),
[`src/lib/release.ts`](../../src/lib/release.ts) and [`src/lib/monitoring.ts`](../../src/lib/monitoring.ts).

**Companion documents:** [`growth-instrumentation.md`](./growth-instrumentation.md) ·
[`deferred-roadmap.md`](./deferred-roadmap.md) · [`PRD.md`](./PRD.md) §28

---

## 1. The one question this is sized to answer

> **Do people activate, run the core loop, use the social side — and which build were
> they on when they did it?**

That is the whole brief. Nineteen events. Everything a mature analytics practice would add
— retention cohorts, an activation funnel with D1/D7/D28, paid attribution, sponsorship
reporting, an experimentation platform — is in [`deferred-roadmap.md`](./deferred-roadmap.md)
§9–§12 with the reason it is not here.

Sizing it this way is a decision rather than an omission. With thirty to sixty friends on
four different builds, the failure mode is not *too little data*: it is a hundred event
types nobody has agreed the meaning of, half of them counting taps instead of outcomes,
and a funnel that silently pools an Android dev client with a TestFlight build.

**Two vendors, both already installed. No third one is being added.**

| | Vendor | What it answers | Configured by |
|---|---|---|---|
| Product analytics | **PostHog** | the app worked and nobody used it | `EXPO_PUBLIC_POSTHOG_KEY` |
| Crash and error | **Sentry** | the app broke | `EXPO_PUBLIC_SENTRY_DSN` |

Both are **optional by absence**. With no key configured every function is a no-op, which
is how the project runs for somebody with no account at either service. Neither key is a
secret: a PostHog project token is write-only and a Sentry DSN only accepts events.

---

## 2. The canonical event set

Twenty-one events: eleven since 2026-08-18, two added on 2026-08-19 when the invitation
resolver gave them writers, one added on 2026-09-03 with Help & Support, three added
on 2026-09-03 with Group Picks, two added on 2026-09-06 with For You rotation and
the weekly streak, and two added on 2026-09-07 with the pre-GTM convergence — the two
funnel denominators, `onboarding_started` and `ranking_started`, without which "did
onboarding begin" and "did they abandon ranking" had no number. The union in
`src/lib/analytics.ts` is the enforcement — there is no
`track(name: string, props: object)` to reach for, so inventing an event is a compile
error rather than a decision somebody makes at 2am before a demo.

### Activation

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `sign_in_completed` | a Supabase session exists | the person signing in | `method` |
| `sign_in_redirect_rejected` | Google sign-in was refused **before** the provider was contacted, or the callback came back on a URL the app did not send (2026-09-10) | the person signing in | `problem` |
| `signup_completed` | `create_profile` answered `created` | the new account | — |
| `onboarding_started` | the first-run taste flow **became active** for this account on this device — the one write of the `active` phase, never a resume, a rerender or a relaunch | the account | — |
| `onboarding_completed` | the first-run flow ended, at the notification step which is now its last | the account | `skipped`, `titles_ranked` — either may be **absent**, see below |
| `onboarding_step_completed` | one step of the first-run flow was left, in either direction (2026-09-09) | the account | `step`, `variant`, `outcome` |

### Core loop

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `title_logged` | `set_bucket` answered `ok` | the collector | `media_kind`, `surface`, `bucket` |
| `ranking_started` | the opening call answered with a comparison, or with a placement outright (an empty band) — once per session, on whichever attempt first opened | the ranker | `media_kind`, `surface`, `mode` |
| `ranking_completed` | the ranking session answered `placed` | the ranker | `media_kind`, `surface`, `comparisons`, `mode`, `rebucket`, `skips` |
| `comparison_info_opened` | Details under one side of a comparison opened the recall sheet (2026-09-11) | the ranker | `media_kind`, `surface` |
| `watchlist_added` | `set_watchlist(present: true)` answered `ok` | the saver | `surface` |

### Social and discovery

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `follow_created` | `follow` committed **and** the screen knew there was no edge before it | the follower | `surface`, `state` |
| `recommendation_sent` | `recommend_title` stored the row | the **sender** | `media_kind`, `surface` |
| `recommendation_opened` | `mark_recommendation_opened` answered without error, for a row this device had not already reported | the **recipient** | `media_kind`, `surface` |
| `member_search_result_opened` | a member row in Search was opened | the searcher | `surface`, `position` |

### Growth

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `invite_link_created` | `create_invite_link` wrote an `invite_link_creations` row | the inviter | `surface`, `has_title` |
| `invite_redeemed` | `redeem_invite` answered `ok` — an `invite_attributions` row was inserted **by this call** | the **invitee** | none |
| `invite_activated` | `_rank_finalize` answered `activated: true` — this transaction flipped `activated_at` | the **invitee** | none |

### Experiments — added 2026-08-28

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `leaderboard_viewed` | the reader **entered** Leaderboard from the Feed toggle | the reader | `metric` |
| `leaderboard_metric_selected` | a **different** metric chip was chosen | the reader | `metric` |

Two events, for one of this tranche's two experiments. The board sits behind a control
nothing else leads to, so *did anybody find it* has no other answer; and *which of the
four metrics people care about* is what decides whether the set stays at four.

Both are narrow on purpose. `leaderboard_viewed` fires on the **transition into** the
mode, not on render — so leaving and returning is a second view, which it is, being a
second decision to look, while a re-render on the busiest screen in the app is not.
`leaderboard_metric_selected` fires only on a genuine change; re-tapping the chip you are
already on emits nothing, or the count would measure fidgeting.

`metric` is the server's own name for the board (`titles` | `movies` | `tv` | `reviews`),
so the event, the chip and the RPC argument are one string rather than a fourth spelling
of the same four things.

**The other experiment — recommendation rotation — had no events at all** when this
section was written, deliberately: its question is whether repeated visits produce a
fresher slate, `recommendation_impressions` records what was shown and
`recommendation_feedback` what was dismissed, and a client event per slate would be a
second, worse copy of a server-side fact. That held until 2026-09-06, when the founder's
"Jobs and Creed III again" turned out to be unanswerable from the impressions table
alone — it records that a title was shown, not how much of a wall the reader had
already seen. `for_you_slate_shown` (the For You section below) is the one event that
answers it, gated on the same guard the impression writer uses so it cannot become the
stream of writes this paragraph was refusing.

### Social connection activation — added 2026-09-08

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `people_suggestions_viewed` | the reader **entered** the People mode of the Feed tab | the reader | `source`, `mode` |
| `people_suggestions_mode_changed` | a **different** People list was chosen | the reader | `mode` |
| `follow_activity_opened` | an aggregated follow story was opened into its list of people | the reader | — |
| `invite_auto_follow_succeeded` | `redeem_invite` answered `connected: true` — a personal invite left both accounts mutually connected | the **invitee** | none |

The founder's §A17, and the question behind all four is the one this release exists to
answer: **does somebody who joins connect with people they actually know?**

`people_suggestions_viewed` is shaped like `leaderboard_viewed` and for the same reason —
it fires on the **transition into** the mode, not on render. What it adds is `source`
(`people` | `onboarding` | `sparse_feed` | `invite`), which is the part worth measuring:
the permanent mode behind the Feed's toggle and a contextual prompt at the end of
onboarding are two different mechanisms, and only one of them can be improved by moving a
control. `invite` is declared and has no emitter — a redeemed invitation ends in a mutual
connection rather than in a prompt to go and find people, so there is nothing honest to
attribute to it today.

`mode` is `mutuals` | `match`, the server's own two lists.
`people_suggestions_mode_changed` fires only on a genuine change, exactly as
`leaderboard_metric_selected` does.

**There is deliberately no `people_suggestion_followed`.** §A17 names one, and it already
exists: `follow_created` carries `surface` and `state`, so a follow started from People is
`{ surface: 'people', state: 'approved' }` and a request is the same event with
`state: 'pending'`. A second name would make "how many follows happened" a sum over two
events, which is how a funnel comes to disagree with itself. `surface` gained `people` in
the same change, kept distinct from `for_you` — People used to live there, and one number
spanning the move would hide whether the move worked.

`invite_auto_follow_succeeded` follows the **row**, like `invite_redeemed`: the server
answers `connected` only when both follow edges came out approved, so a private inviter —
whose side stays a request until they answer it — emits nothing here. It sits beside
`invite_redeemed` rather than replacing it, and the ratio between the two is the whole
measurement of §A7. **`invite_auto_follow_failed` is deferred and has no emitter**: the
reverse edge is written inside `redeem_invite`'s own transaction with the attribution row
it depends on, so it cannot half-succeed, and calling a private inviter's pending request a
failure would mislabel a privacy decision that was kept on purpose.

### Help & Support — added 2026-09-03

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `settings_support_email_opened` | a Help & Support row in Settings was tapped and a mail draft was asked for | the sender | `type` (`feedback` \| `problem`) |

One event for two rows, separated by `type`, because the question is *does anybody reach
for the support channel* and the follow-up is *which of the two ways*. A second event name
would split the denominator for nothing.

`type` is the only property. The subject is a constant and the body is a template, so the
only part of the mail that is a person's own words is what they type after the draft
opens — which this app never sees. No address, no account, no free text.

### Group Picks — added 2026-09-03

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `group_picks_opened` | the Group Picks chip was tapped and the sheet opened | the reader | — |
| `group_picks_generated` | a group asked for picks and the list was built — once per generation, never per filter change | the reader | `group_size`, `result_count`, `source_mix`, `filter_count` |
| `group_picks_result_opened` | a pick row was opened into its title page | the reader | `position` |

Three events for the funnel the feature actually has: opened, asked, acted. `group_size`
is the **effective** count the server scored over, which is the honest denominator when a
member fell out of visibility between the picker and the call. `source_mix` is one short
tally string — `saved:4|group:9|rewatch:2|trending:0` — that says what kind of list this
was (shared saves, inferred taste, or trending fill) without naming one title on it.

What deliberately does not travel: member ids, member names, title ids, title names, the
filter *values*, and the internal group score. Saves made from a pick reuse
`watchlist_added` with `surface: 'group_picks'` rather than growing a fourth event.

### For You — added 2026-09-06

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `for_you_slate_shown` | a genuinely new wall was put in front of the reader — once per distinct slate, from the same guard `noteImpressions` uses, never per render or per page already recorded | the reader | `medium`, `size`, `repeat_count` |

One event, and it exists to make repetition a number. Opens and saves cannot answer
whether the wall is getting fresher: a reader shown the same nine films every week and
saving one looks identical in those numbers to a reader shown a fresh wall.
`repeat_count` is how many titles on this wall the reader had already been shown inside
the impression window (`foryou.impression_window_hours`); `size` beside it makes the
ratio meaningful, and `medium` separates the two walls, which have different pool
depths and will not improve at the same rate. No title id travels.

**`size: 0` is a real value** (2026-09-07). The slate query settled successfully and the
**unfiltered** wall drew nothing — no candidate survived scoring and the reader's own
dismissals — so the reader met an empty For You. It is emitted once per wall key from the
hook's own guard, because the impression writer has nothing to record for an empty wall.
It is never emitted while the query is pending, never for a failed request (that is the
error state, with its retry), and never for a wall the reader emptied with their own
filters, where Clear all is on screen. `repeat_count` is `0` by construction. "Are
recommendation walls sometimes empty" is `size = 0` over all `for_you_slate_shown`, per
`medium`.

**This corrects §2's earlier claim** that the rotation experiment had "no events at
all". It has one, added with #112 on 2026-09-06, and it was emitted for a day before
being written here — which is exactly the drift the pinned list in `analytics.test.ts`
exists to make visible.

### Weekly streak — added 2026-09-06

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `streak_state_viewed` | the streak section was drawn on the reader's **own** profile, once per settled read rather than per render | the reader | `weeks`, `ranked_this_week`, `days_left` |

The distribution, not the engagement: how many people are looking at a live streak
versus a zero, which is what says whether the mechanic is working before any reminder
push exists. §10b carries the measurement plan it belongs to. Deliberately no
`streak_reminder_*` events — those describe a push that does not exist.

---

## 3. What each event does **not** mean

This section is the point of the document. Every line here is a number somebody could
otherwise report in good faith and be wrong about.

**`sign_in_redirect_rejected`** counts a failure that is otherwise invisible, which is the
only reason it exists. GoTrue answers a `redirect_to` it cannot use by substituting
`site_url` rather than by erroring, so before 2026-09-10 a bad callback meant the person
authenticated with Google **successfully** and was then left on `https://bingd.app` with no
session and nothing raised anywhere. Nobody reports "it worked and then nothing happened",
so the count has to come from the client. `problem` is three words — `no_scheme`,
`not_the_app`, `wrong_landing` — and deliberately never the URL: an authorization code
lives in a query string and a token in a fragment, so a property that could hold the URL
could hold a credential. The sanitized scheme/host/path goes to the flight recorder and to
Sentry instead. **A non-zero count here is a release blocker**, not a trend line.

**`sign_in_completed`** is not an account. `profiles.id` references `auth.users(id)` and
the profile is created afterwards, so there is a real, persistent state in between
(`auth.md` §4). The **gap between this and `signup_completed` is the metric** — people who
authenticated and then abandoned the profile form. It is also not an install: an install
with no sign-in produces PostHog's own `Application Installed` and nothing of ours.

**`signup_completed`** is `created` and nothing else. `create_profile` also answers
`already_exists`, which means the profile was already there — a replay, not a signup, and
it emits nothing.

**`onboarding_started`** (2026-09-07) is the flow becoming active, not the screen being
seen. It is emitted from the one line in `useBeginTasteOnboarding` that writes the
`active` phase, after both guards have found nothing decided in memory or on disk — so an
account that closed the app on film three and reopened emits nothing (the start happened
on the launch that wrote `active`), a second mount of the screen emits nothing, and an
account that already finished or declined emits nothing. It is **not** `signup_completed`:
an account created on this device but routed to the Feed by a timed-out first-run check
has no start, which is the gap the seed in `create-profile.tsx` exists to close. **The
denominator for `onboarding_completed`** is this event, and `onboarding_started` without a
matching completion is the abandonment the beta could not previously count.

**`onboarding_step_completed`** (2026-09-09) exists because the flow is ten steps long and
"it converts" stopped being a useful sentence about it. It follows the **step** rather than
the tap, so a lost reply under-counts rather than double-counts, and its `variant` is the
branch the People step drew **on entry** — a `could_not_load` retried into a real list still
reports what the reader first met. It carries no ids, no handles and no count of who was
suggested: step 9 is a private read of one person's social neighbourhood, and the analytics
must not be able to reconstruct that graph.

**`onboarding_completed`** covers both exits and `skipped` separates them. One event
rather than two, so the denominator cannot drift: everybody who reaches the end of the
flow is in it. It is emitted from `useCompleteTasteOnboarding`, which all three exits go
through, rather than from the three buttons.

**Both of its properties can be absent, and an absence means "not known"** (2026-09-09).
Read `skipped` as three groups, not two: `false` is a recorded completion, `true` a
recorded skip, and *missing* an account whose outcome nothing wrote down — one that was
already mid-flow when this shipped, or a device whose preference write lost. `titles_ranked`
is missing on the same terms, when the last step was reached before the taste count had
been read at all.

This is worth the awkwardness in a query because both properties have already been wrong
in the flattering direction. `skipped` was first derived from the taste count at the moment
the last button was pressed, and that count is a query the step can mount before: an
unanswered read was zero, zero was below five, and **an account that ranked all five
reported itself as a skip.** The repair recorded the outcome at the two exits that watch it
happen — which is right — but resolved an unreadable one to `completed`, on the reasoning
that finishing is the likelier explanation. That swaps an under-count for a *manufactured*
success, and it is the worse trade: a gap in a chart is visible and can be excluded, while
an invented completion is indistinguishable from a real one and can never be subtracted
back out. So the flow still ends normally on an unknown outcome — that is a product
decision the app is entitled to make on incomplete information — and the event simply does
not say. `sanitize` drops the undefined, so nothing reaches PostHog.

**`title_logged`** is a bucket, not a position. A bucket is a band (PRD §11); the exact
ordering is `ranking_completed`. It is not the log sheet opening.

**`ranking_completed`** is the server answering `placed`. It is **not** the ranking sheet
opening, not a comparison answered, and not an abandoned session. `mode` says which of
four acts completed, in the words the Ranked menu uses (2026-09-07):

| `mode` | The act | Writes a `title_ranked` activity |
|---|---|---|
| `start` | a first placement; the title had no position | yes |
| `rebucket` | *Update your rating* into a different band | no |
| `rerank` | *Update your rating* re-choosing the same band. Reached from the *Rank it again* row too, until that row was consolidated away on 2026-09-08 | no |
| `again` | *Log another watch* — a second viewing | yes, exactly one |

It is there because the three completions of an already-ranked title reach the same
`placed` answer as a first placement and, until 2026-09-07, were counted as one. A
reader who adjusted a placement showed up as a new ranking in every funnel that reads
this event as "watched and placed a new title" — which is the wrong number in the
direction that flatters, and it is also the one query that cannot be repaired
afterwards, because the event carried nothing to split it on. **A count of first
watches is `mode in ('start', 'again')`**; a count of new titles ranked is `mode =
'start'`; corrections are the other two.

`rebucket` is kept beside it and is exactly `mode = 'rebucket'`. A second spelling of
one fact is tolerable where deleting the first would cut every saved query and chart
written against it in two.

`skips` (2026-09-07) is how many *Too tough* presses the server accepted during the
session. It is counted on the client from the answered `rank_skip` calls, because
`_rank_finalize` returns no skip count; an Undo after a skip does not subtract, so it is
the number of times the control was **used** rather than the net. It is not a measure of
how uncertain the placement is — `adjustable` is the server's word for that and it is
deliberately not on this event.

**`ranking_started`** (2026-09-07) is a session, not a tap. It fires when the opening
call — `rank_start`, `rank_again` or `rank_rebucket` — is answered with a comparison to
show, or with the placement outright where the band was empty and there was nothing to
compare against. A refused opening (a suspended account, a title already ranked) emits
nothing. Once per session, on whichever attempt first opens: a lost reply retried under
the same operation id that then opens is one start, and a pivot, a skip and an undo inside
the session are none. It carries the same `mode` vocabulary as the completion so the two
join on it, and `media_kind` comes from the title being ranked rather than from the
server's answer, because a comparison carries no category. **`ranking_started` minus
`ranking_completed`, per `mode`, is the abandonment rate.**

**`comparison_info_opened`** is the recognition question, counted. A comparison the reader
cannot answer from two posters is the one that loses them, and Details is the escape hatch
built for it; nothing said how often it is reached for, or whether the two kinds reach for
it at anything like the same rate. The memory-aid pass of 2026-09-11 is built on the claim
that a season needs it far more than a film does, because a poster with a number on it is
the same poster in every season of a show, and this is the only number that can test that.

It fires on the press that opens the sheet, so a Details pressed while the opponent is
still loading emits nothing. Twice in one comparison is a reader who checked both sides,
which is a real act rather than a duplicate.

**There is deliberately no `comparison_info_outcome`.** The obvious companion event says
what the reader did next — picked, gave up, or left — and it is not specified, because a
comparison has four ways out and one of them is Undo, which rolls the pair back
*underneath* the answer: an outcome event would then attribute one comparison's Details to
the next comparison's pick. Joining `comparison_info_opened` against `ranking_started` and
`ranking_completed` at the session level answers the coarse version of the question with
no such hazard, and that is what to read first.

**`watchlist_added`** is an addition. Removals are not measured; nothing in the beta asks.
It carries **no `media_kind`**, deliberately: the watchlist accepts a whole series as well
as a film or a season, so the kind would need a third value no other event has, and two of
the four bookmark surfaces hold only a media id anyway.

**`follow_created`** with `state: 'pending'` is a **request**, not a follow. Following a
private account creates one, and reporting the two together describes a network that does
not exist yet. It is not a profile view.

It is also **not a proof of insertion**, and that limit is stated rather than buried.
`follow` answers `ok` with the *existing* state when a row was already there — so that
re-following somebody is not an error — which means the response body alone cannot separate
a new edge from a repeat. The client's own relationship read is the second witness, and it
has three states: no edge, an edge, and **not yet known**. The last one emits nothing,
because the Follow button renders from `noRelationship()` while `follow_state_with` is
still in flight and reporting that as "there was no edge" is how a re-follow becomes a new
one. The complete fix is a server that reports whether it inserted, which is a migration.

**`recommendation_sent`** is a stored row. It is **not** the share sheet opening, and a
200 is not enough on its own: `recommend_title` returns `not_mutual`, `yourself` and
`not_recommendable` *inside* a successful response, on purpose, so that a refused attempt
still costs the sender a rate-limit slot.

**`recommendation_opened`** belongs to the **recipient**, not the sender. It is not a
delivery and not an impression.

The screen's `opened_at is null` check is necessary and **not sufficient**: it reads a
cached list, so two quick presses both see a null timestamp. The event is therefore emitted
inside `useMarkRecommendationOpened`, after `mark_recommendation_opened` answers without
error and at most once per row per process. The write stays fire-and-forget for the
*person* — a failure must not stand between somebody and the title they were told to watch
— but a failure is not an open, so it emits nothing. The residual is a reinstall or a
second device reporting one more open for a row already opened elsewhere.

**`settings_support_email_opened`** is a **tap, not a message received**. Everything
after it happens in the mail client: the draft may be abandoned, rewritten or never sent,
and this app is not told which. It is an upper bound on support mail, never a count of it —
and it is emitted even when the mail client fails to launch, because somebody who tried and
could not is the most important reading it has.

**`member_search_result_opened`** carries `position` and nothing else. **The query text is
never sent.** Neither is the handle or the display name.

**`invite_link_created`** is a link *created*, never a link *sent*.

> **The rule `growth-instrumentation.md` exists to enforce: opening an OS share sheet is
> not an invitation sent.** The sheet can be dismissed and the message deleted unsent, and
> nothing in this app will ever know either way. Any metric named `invite_sent` that
> counts share-sheet opens is a number that will be believed and is wrong.

> **Its two properties both went constant on 2026-09-02, and the reason is a product
> decision rather than a bug.** Sharing a title off Bingd used to mint an invitation link
> and append it to the message; it no longer does (PRD §6F As-built), so `create_invite_link`
> is now reached from exactly one place — **Invite friends** on the own profile. Every
> event from that day forward therefore carries `surface: 'profile'` and
> `has_title: false`.
>
> The properties are kept rather than dropped. They are what makes the series before and
> after the change readable as one series: a query that groups by `surface` shows the
> title-share source ending on a date, which is the fact, instead of showing a schema that
> changed underneath it. **Expect the raw count to fall**, and do not read the fall as a
> growth regression — it is the removal of link creations nobody deliberately asked for.

**`invite_redeemed`** is an attribution row, not a link opened and not an install. It is
emitted only on `redeem_invite`'s `ok`, which is the one answer meaning *this call wrote
the row*. `already_applied` is a replay of a redemption already counted; every refusal
wrote nothing. It carries **no properties at all** — the inviter is another person, and
who is attributed to whom is a join on `invite_attributions` rather than a property on a
vendor's timeline.

**`invite_activated`** is ten ranked titles by an attributed invitee (§28), and it is
**owned by the invitee** because they are the one who ranked. The server decides, not the
client: `_maybe_activate_invite` flips `activated_at` under a row lock and reports whether
*this* transaction was the one that flipped it, so two devices finishing the tenth ranking
together produce one event and a retry produces none. An app that counted rankings locally
would emit this for accounts with no attribution and again after every reinstall.

> **What the invite funnel systematically under-counts, and it is not small.** A token does
> not survive a trip through the App Store, TestFlight or Play. Universal Links and App
> Links carry one only when the app is **already installed**, and Bingd has no install
> referrer and no attribution SDK — deliberately, because the alternatives are
> fingerprinting and clipboard reading (PRD §17).
>
> So somebody who taps an invitation, installs Bingd, and then launches it **from their
> home screen instead of returning to the invitation page** arrives with no token. No
> `invite_redeemed`, no attribution, no `invite_activated`, and no row in Invite
> Instigator — for a person who genuinely was invited. Nothing detects this and nothing
> corrects for it.
>
> Every invite number is therefore a **floor**, and the gap is largest exactly where it
> matters most: new installs, which is the population the whole mechanic exists to reach.
> Say so whenever one of these numbers is reported. Do not scale them up by a guessed
> factor — the honest response to an unmeasured population is to name it, not to model it.

---

## 4. Events that are named but cannot be emitted

One name is declared in `DEFERRED_EVENTS` and is **deliberately absent from the emittable
union**, so sending it is a compile error until the state behind it exists.

| Name | What it would mean | What is missing |
|---|---|---|
| `award_earned` | an award tier was crossed | an honest client emission point. The ledger exists now (`award_unlocks`, `20260828000100`) — the reason changed on 2026-08-28, see the note below |

Declaring the name now settles the taxonomy without faking the data. Roadmap item §5 is
where it comes from.

> **The reason changed on 2026-08-28, and the disposition did not.** Until then the
> missing piece was a durable unlock ledger — tiers were computed on the device from raw
> reads, so a *crossing* could not be distinguished from a *state*. `20260828000100`
> built that ledger and the whole social loop on top of it, but the crossing is decided
> **server-side**, inside triggers: the client learns of it by reading a feed event or a
> notification, and emitting an analytics event from an observation of one is exactly the
> observed-state pattern this file refuses everywhere else. The event stays in
> `DEFERRED_EVENTS` until there is an emission point that witnesses the crossing rather
> than its announcement.

> **`invite_redeemed` and `invite_activated` left this list on 2026-08-19**, and that is
> the mechanism working rather than the list eroding. `20260819000500` gave both of them a
> writer, so both moved into the emittable union in the same change that made them true —
> which is the only way a name should ever leave this table.

---

## 5. Common properties

| Property | Values |
|---|---|
| `media_kind` | `movie`, `tv_season` |
| `surface` | `search`, `collection`, `feed`, `for_you`, `sent_to_you`, `profile`, `title`, `onboarding`, `awards`, `notifications` |
| `bucket` | `loved`, `fine`, `not_for_me` |
| `method` | `email_code`, `apple`, `google` |
| `state` | `approved`, `pending` |
| `mode` | `start`, `rebucket`, `rerank`, `again` — on `ranking_started` and `ranking_completed` alike |
| `skipped`, `rebucket`, `has_title` | booleans |
| `titles_ranked`, `comparisons`, `skips`, `position` | counts |

`surface` is named for what a person would recognise rather than for the component or the
route, because a component gets renamed in a redesign and the historical data then refers
to something that no longer exists. It is passed into the sheets as a prop rather than
read from the router: three screens mount the ranking sheet, and the route underneath is
not the same question as where somebody decided to rank something.

### Prepared, nullable, and one of them now written

| Property | Future values |
|---|---|
| `acquisition_source` | `friend_direct`, `launch_party`, `beli`, `letterboxd`, `amc_alist`, `reddit`, `instagram`, `organic_store`, `invite`, `other` |
| `beta_cohort` | a free string the founder assigns, e.g. `amc_alist_01`, `beli_01` |

`setAcquisition()` has **exactly one caller**: a successful `redeem_invite`, which sets
`acquisition_source: 'invite'`. That is the one mechanism that establishes how somebody
arrived without inferring it. Every other value, and `beta_cohort`, are still set by
nobody.

**It is registered rather than back-filled, so it is not retroactive.** PostHog
super-properties attach to events from that moment on; the `signup_completed` two screens
earlier does not gain a source. That is the honest shape — the app did not know then — and
it is why the invite funnel is joined in the database on `invite_attributions`, with this
as a cheap cross-check rather than as the record.

**Nothing may infer a source from behaviour.** "They followed three people in the first
minute, so it must be a friend referral" is exactly the reasoning this section forbids.

### Filter context — deferred, and why

`genre_filter`, `language_filter`, `decade_filter` and `anime_filter` are **not** emitted.
The filters narrow what is drawn on For You and the Collection, and no canonical event has
a natural place to hang them: adding a `filter_applied` event would be instrumenting a
control rather than an outcome, which is the direction this set is sized against. "Do
people use the filters" is a real question and it is a post-beta one.

---

## 6. Release identity — which of the four builds is this

Every canonical event and every Sentry report resolves to a build.
[`src/lib/release.ts`](../../src/lib/release.ts) is the single helper; nothing
reconstructs these fields at a call site.

| Field | Source |
|---|---|
| `environment` | `APP_VARIANT` → `development` / `preview` / `production` |
| `platform` | `Platform.OS` |
| `app_version` | `Application.nativeApplicationVersion` |
| `build_number` | `Application.nativeBuildVersion` |
| `runtime_version` | `Updates.runtimeVersion` — the fingerprint hash an update must match |
| `eas_channel` | `Updates.channel` — **null on a development build**, by EAS's design |
| `eas_update_id` | `Updates.updateId` — null when running the bundle the build shipped with |
| `build_kind` | `dev_client` / `embedded` / `ota` |

**`build_kind` is the field that does the work**, and its rule is counter-intuitive
enough to be worth stating: a dev client attached to Metro reports
`isEmbeddedLaunch: true` — there is no update, so the launch really is embedded — which
would file every founder dev-client session under the same label as a fresh TestFlight
install. So `__DEV__` is answered **first** and wins.

Which is what makes these four distinguishable at a glance:

| Build | environment | platform | build_kind | eas_channel |
|---|---|---|---|---|
| Android dev client | development | android | dev_client | *(null)* |
| iOS dev client | development | ios | dev_client | *(null)* |
| Preview | preview | ios/android | embedded → ota | preview |
| Community beta (TestFlight / closed test) | **production** | ios/android | embedded → ota | beta |
| Public release (App Store / Play) | production | ios/android | embedded → ota | production |

### Which builds are strangers on — read `eas_channel`, not `environment`

**`environment` is not the production-versus-beta discriminator, and a dashboard that
filters on it is counting the community beta as the public launch.** `environment` is
`APP_VARIANT`, and the beta lane builds the *production* variant on purpose (`lib/env.ts`,
`isRelease`): a TestFlight build and the App Store build that replaces it share a bundle
identifier and a scheme, so they share a variant. The beta row and the release row above
are identical in that column.

**`eas_channel` is the canonical release-lane filter.** It is `Updates.channel`, set by
the EAS profile that built the binary (`eas.json`: `development`, `preview`, `beta`,
`production`), and it is on every canonical event and every lifecycle event as a super
property. The rules, stated once (2026-09-07):

- **Stranger and public-launch dashboards filter `eas_channel = 'production'`.** That is
  the only lane a person the founder has never met can be on.
- **The community beta stays separately filterable as `eas_channel = 'beta'`**, and its
  numbers are never added to the launch's: friends ranking their fifth film in August are
  not evidence about activation in October.
- **`eas_channel` is null on a development build**, by EAS's design; `build_kind =
  'dev_client'` is the field that names those, and they belong in no product dashboard.
- **A `lane` property is deliberately not added.** `lib/env.ts` already has a `lane`
  value, but it is a build-time input rather than a runtime fact about the binary that is
  actually running, and two properties answering "which lane" that can disagree is worse
  than one. `eas_channel` is what the update server enforced; it is the one to trust.

Nothing here is a secret. A version, a build number, a channel name and an update id are
printed on every build's own About screen; there is no DSN, project token or Supabase key
in this object, and a test asserts as much.

**In PostHog** the context is both `register`ed as super properties — so the library's own
`Application Opened` and `Application Installed` carry it — and merged into each canonical
event explicitly, because `register` is asynchronous and a first launch can capture a
lifecycle event before it persists.

**In Sentry** it is set as tags, deliberately **not** as `release` and `dist`. Those are
set by the Sentry Expo plugin at build time from the native project and are what the
uploaded source maps are keyed to; overriding them from a runtime read turns a
symbolicated stack back into minified output, which is most of what a crash reporter is
for.

---

## 7. Identity, and the three transitions

The internal Bingd UUID and nothing else. No email, no username, no display name. A person
profile carrying a username turns an analytics vendor into a second copy of the social
graph, which is not what was agreed to when somebody signed up.

`src/features/auth/session.tsx` drives both vendors from one effect on the session's user
id, so there is no second place to forget.

| Transition | What happens | Why |
|---|---|---|
| none → somebody | `identify(userId)` | the anonymous events from before signup join the account — this is the whole signup funnel |
| somebody → none | `reset()` | a second account on the same device is a separate person to the vendor |
| somebody → somebody else | `reset()` **then** `identify()` | without the reset PostHog aliases the second account onto the first one's anonymous id, and the two people are one person for ever |
| none → none | **nothing** | see below |

**That last row is a fix rather than a formality.** `session.tsx` issues `identify(null)`
on every cold start, before the stored session has resolved. Calling `reset()` there
throws away the anonymous distinct id and the registered super properties on *every single
launch*, which destroys the one thing an anonymous id is for.

**Account deletion resets both.** `delete_account` is always followed by `signOut()` —
including on the branch where the outcome was never established — so the session goes null
and the ordinary sign-out transition applies.

**Sentry is identified too**, which it previously was not: `identifyForMonitoring` existed
and had no caller, so every crash report was anonymous. A crash that cannot be tied to an
account is a crash nobody can ask about, and the beta's entire support loop is "you said
the app broke, let me find your session".

---

## 8. Privacy — what never leaves the device

**Autocapture is off and stays off.** In a mobile app it records the text of whatever was
tapped, which here means film titles out of somebody's private collection. PRD §22 does
not permit that, and "we only look at aggregates" is not a control.

Three layers, in order of strength:

1. **The typed union.** No declared event accepts a title, a username, a note, a bio, a
   date of birth or a search query, so one cannot be sent by accident.
2. **A property allowlist.** `track` filters every key against `ALLOWED_PROPERTY_KEYS`. It
   is belt and braces over the type, and the braces are the part that survives somebody
   widening the union in a hurry.
3. **Scalars only.** A property whose value is an object or an array is dropped, not
   walked and pruned. That is the shape of the accident worth guarding: somebody spreads
   `...profile` into a property bag and the bio travels inside the value.

Never sent, asserted by test against the allowlist:

> email · username · display name · any person's name · title text · **search query text**
> · note or Bingd Review body · comment text · bio · date of birth · avatar path · invite
> token · any auth token, service key or password · phone

Media item ids, recipient ids and actor ids are also excluded. They are not free text, but
an analytics vendor holding a graph of who recommended what to whom is a second copy of
the social graph by another route.

**Sentry is scrubbed on the same reasoning** (`src/lib/monitoring.ts`): `sendDefaultPii`
is off, the user object is reduced to its id, request bodies and cookies are deleted,
`extra` is filtered to scalars, console breadcrumbs are dropped entirely, and **query
strings are stripped from every URL** — a route path like `/title/<uuid>` names an
identifier, but a query string is where the search screen puts what the user typed.
**Performance transactions are scrubbed too**, through `beforeSendTransaction`: they never
pass through `beforeSend`, which is how they went out unfiltered until review 24.

**What Sentry deliberately keeps, and the residual.** Exception messages and stack frames
are not redacted — they are the entire product, and a crash reporter that strips the error
reports nothing. The known exposure is that **PostgreSQL echoes rejected input in
constraint and cast errors**; `lib/diagnose.ts` refuses to put those messages on screen for
that reason, and the same would apply to one that reached Sentry as an exception.

Plenty of query functions *do* throw such an error — every `if (error) throw error` inside
a `queryFn`. What keeps them out of Sentry today is that **React Query catches them** and
turns them into an error state a screen renders: no call site forwards one on, and
`reportHandled` has no callers at all. That is a property of the current call sites rather
than of the scrubber, so it is written down rather than assumed — the first
`reportHandled(supabaseError)` anybody adds inherits this exposure.

---

## 9. Duplication — what these numbers are worth

Review 21 spent seven rounds on one sentence: **a client's observation is not proof of a
server outcome.** Analytics does not need ledger semantics — nobody is paid out of this
data — but an event must not be *obviously* wrong in the direction that flatters.

So every emission sits behind an outcome the server confirmed, and **none sits on a
reconciliation path**. A write that commits and loses its reply is therefore
**under-counted**: the client that could not hear the answer does not claim one.
Undercounting a lost reply is a small bias in a known direction; double-counting a retry is
a number that looks like growth and is not.

| Event | Guarantee | The case it is guarded against |
|---|---|---|
| `signup_completed` | **structurally unique** | `already_exists` is a replay, not a signup |
| `invite_link_created` | **structurally unique** | a replayed operation id answers `already_applied` with the same token — the share works, no row is written, nothing is emitted |
| `invite_redeemed` | **structurally unique** | the primary key on `invitee_id` means only one call can insert; a replay is `already_applied`, a second token is `already_attributed`, and both emit nothing |
| `invite_activated` | **structurally unique** | the server reports the transition, not the state: only the transaction whose guarded UPDATE flipped `activated_at` is told `activated: true` |
| `title_logged` | approximately once | `already_applied` is one intent replayed; only `ok` counts |
| `ranking_completed` | approximately once **per completion** | `failed && changed` is the lost-reply case and emits nothing. A rerank or rewatch of an already-ranked title is a second completion and a second event, and `mode` is what says it was not a second *title* |
| `recommendation_sent` | approximately once | a refusal inside a 200 is not a send; an unknown outcome holds its id for the retry and emits nothing |
| `recommendation_opened` | once per row per process | the server answered; a per-process set covers a stale `opened_at` and two quick presses |
| `onboarding_completed` | once per flow | guarded on the flow having already *ended*, so two buttons on one summary report one completion |
| `follow_created` | approximately once | `already_applied` carries no state and emits nothing; a known existing edge, and a relationship not yet read, both emit nothing |
| `watchlist_added` | approximately once | additions only, `ok` only |
| `comparison_info_opened` | once per open | the press that opens nothing — Details while the opponent is still loading — emits nothing; two opens in one comparison are two events on purpose |
| `for_you_slate_shown` | once per distinct slate per process | guarded by `noteImpressions`' own returned set, so a re-render, a bookmark or a page already recorded emits nothing; the server's hour-truncated impression key is the second guard |
| `streak_state_viewed` | once per profile mount | a component-lifetime ref, so scrolling the profile tab is not a second view; a relaunch is |

Three soft edges, stated rather than buried:

- **`follow_created` cannot prove insertion from the response.** See §3. The client's
  relationship read is the second witness; an unread relationship emits nothing.
- **`recommendation_opened` is per process.** A reinstall or a second device can report one
  more open for a row already opened elsewhere.
- **Analytics identity is process-local.** `identify` tracks who this process has
  identified, while PostHog's distinct id is persisted. The two agree in every sequence a
  person can produce — a sign-out resets both, and a relaunch restores the same account it
  was killed with — and `session.tsx` only reports "signed out" once the session is *known*
  to be absent rather than while it is loading, so a launch that resolves to signed out
  clears anything a previous process left. The sliver that remains is a process killed
  between a session changing and the effect that reports it.

**No durable analytics outbox has been built** and none should be before the beta.

---

## 10. Verification status

**PostHog and Sentry are wired, and both ingest endpoints accepted a controlled event on
2026-08-19 from the development configuration.** Neither has been confirmed *visible in
its project*, because neither credential can read anything back — a PostHog project token
is write-only and a Sentry DSN only accepts events. That last step is a human opening a
dashboard.

```
npm run telemetry:smoke -- <a label for this run>
```

`scripts/telemetry-smoke.mjs` sends one `telemetry_smoke_test` event to PostHog and one
handled, non-fatal message to Sentry, using the keys in `.env`. It is operator tooling
rather than a screen in the app — a test button on a settings screen ships, gets forgotten,
and is found by a tester.

**It refuses to run when production is named at all.** Values are unquoted first, so
`APP_VARIANT="production"` is not read as a different string; the variant is validated
against the same three values the app accepts, and an unrecognised one refuses rather than
defaulting; and **both the process environment and the file's own label are checked**, so
`APP_VARIANT=development` on the command line cannot relabel a `.env` that holds production
keys. The keys and the label come from the same file, and that is the pairing that matters.

Results of the run on 2026-08-19, from `APP_VARIANT=development`:

| Service | Response |
|---|---|
| PostHog | `HTTP 200 {"status":"Ok"}` |
| Sentry | `HTTP 200 {"id":"b71d898031ca464a8bab83b0f0ca2842"}` |

### What the founder still has to do

1. **Open PostHog → Activity** and confirm `telemetry_smoke_test` is there with
   `environment: development`. If it is not, the token is live but pointed at a project
   nobody is watching.
2. **Open Sentry → Issues, environment `development`** and confirm *Bingd telemetry smoke
   test*.
3. **Run the app itself once** on a dev client, sign in, and confirm a
   `sign_in_completed` arrives carrying `build_kind: dev_client`. The script proves the
   endpoint; only the app proves the app.
4. **Check the source-map upload on the first Preview build.** `eas.json` sets
   `SENTRY_DISABLE_AUTO_UPLOAD=true` for both `development` and `preview`, so **a Preview
   build's stack traces will be minified**. That is right for a dev client and a decision
   worth revisiting for Preview — it needs `SENTRY_AUTH_TOKEN` as an EAS secret.
5. **Decide the PostHog project separation.** One project with `environment` as a property
   is what is implemented and is adequate for a friend beta. Two projects — nonprod and
   production — is the cleaner arrangement before a public launch, and is a founder
   decision plus one environment variable. **Until then, and whatever is decided, the
   beta-versus-launch split is `eas_channel`, not `environment`** — see §6. The beta lane
   reports `environment: production`.

---

## 10b. Notification measurement

The types, triggers and conversion definitions live in
[`notifications.md`](./notifications.md) §8 and are deliberately **not** duplicated here.
What belongs in this document is the shape the measurement has to take, and one decision
that has to be made before any of it is collected.

**One event exists today.** `streak_state_viewed` — the current run, whether the week is
already safe, and how many days remain — emitted once per settled read on the owner's own
profile. It answers the only question a streak has before any push exists: how many
people are looking at a live streak versus a zero. That distribution is the difference
between a mechanic that works and decoration.

**Nothing else is declared, on purpose.** `streak_reminder_sent`, `..._opened` and their
siblings describe pushes that do not exist. Declaring them early puts permanently empty
series in the dashboard, which reads as a broken feature rather than an absent one.

**The one decision that cannot be deferred past the first proactive push.** Organic and
notification-assisted behaviour have to be separable, or the retention question the
whole exercise exists to answer cannot be asked: *did the reminder cause the return, or
did the person who was coming back anyway happen to get one?* `ranking_completed`
already carries `surface`, so the shape is available — a notification-opened ranking
attributed to the push that produced it, either through a surface value or through an
attribution window opened by the tap. It has to be settled **before** the first
proactive type ships, because data gathered without it cannot be repaired afterwards.

Per type, once there is one: **eligible → sent → suppressed (by reason) → opened →
converted.** The suppression reason is the load-bearing half — without it there is no
way to tell "this type never works" from "this type is never selected", and those two
have opposite fixes. Open rate is never the success metric on its own.

---

## 11. Deliberately not built

Named here so that nobody has to guess whether it was forgotten. Each has an entry in
[`deferred-roadmap.md`](./deferred-roadmap.md).

- Retention infrastructure — D1/D7/D14/D28, cohort tables, a dashboard (§9)
- A formal activation funnel with a 24-hour bound (§9)
- Paid and mobile attribution — campaign links, Meta, Google, Apple, AppsFlyer, Branch,
  Adjust (§10)
- Sponsorship analytics — impressions, viewability, trailer and watchlist conversion (§11)
- An experimentation or A/B platform (§12)
- Revenue analytics — nothing is purchasable in v1 (PRD §21)
- A durable client-side analytics outbox (§9)
- Session replay — off, and it is the single largest privacy exposure PostHog offers
- Autocapture and screen tracking (§8 above)
