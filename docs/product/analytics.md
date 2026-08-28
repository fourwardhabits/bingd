# Analytics — what Bingd measures before the friend beta, and what it deliberately does not

**Status:** current as of 2026-08-19. Implemented in [`src/lib/analytics.ts`](../../src/lib/analytics.ts),
[`src/lib/release.ts`](../../src/lib/release.ts) and [`src/lib/monitoring.ts`](../../src/lib/monitoring.ts).

**Companion documents:** [`growth-instrumentation.md`](./growth-instrumentation.md) ·
[`deferred-roadmap.md`](./deferred-roadmap.md) · [`PRD.md`](./PRD.md) §28

---

## 1. The one question this is sized to answer

> **Do people activate, run the core loop, use the social side — and which build were
> they on when they did it?**

That is the whole brief. Thirteen events. Everything a mature analytics practice would add
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

Thirteen events, eleven of them since 2026-08-18 and two added on 2026-08-19 when the
invitation resolver gave them writers. The union in `src/lib/analytics.ts` is the
enforcement — there is no
`track(name: string, props: object)` to reach for, so inventing an event is a compile
error rather than a decision somebody makes at 2am before a demo.

### Activation

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `sign_in_completed` | a Supabase session exists | the person signing in | `method` |
| `signup_completed` | `create_profile` answered `created` | the new account | — |
| `onboarding_completed` | the first-run taste flow ended, by either exit | the account | `skipped`, `titles_ranked` |

### Core loop

| Event | Fires exactly when | Owner | Properties |
|---|---|---|---|
| `title_logged` | `set_bucket` answered `ok` | the collector | `media_kind`, `surface`, `bucket` |
| `ranking_completed` | the ranking session answered `placed` | the ranker | `media_kind`, `surface`, `comparisons`, `rebucket` |
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

**The other experiment — recommendation rotation — has no events at all**, deliberately.
Its question is whether repeated visits produce a fresher slate, and that is answerable
from data the feature already stores: `recommendation_impressions` records what was shown
and `recommendation_feedback` records what was dismissed. Emitting a client event per
slate would be a second, worse copy of a server-side fact — and would put a stream of
writes on a screen the founder asked to keep quiet (PRD §13).

---

## 3. What each event does **not** mean

This section is the point of the document. Every line here is a number somebody could
otherwise report in good faith and be wrong about.

**`sign_in_completed`** is not an account. `profiles.id` references `auth.users(id)` and
the profile is created afterwards, so there is a real, persistent state in between
(`auth.md` §4). The **gap between this and `signup_completed` is the metric** — people who
authenticated and then abandoned the profile form. It is also not an install: an install
with no sign-in produces PostHog's own `Application Installed` and nothing of ours.

**`signup_completed`** is `created` and nothing else. `create_profile` also answers
`already_exists`, which means the profile was already there — a replay, not a signup, and
it emits nothing.

**`onboarding_completed`** covers both exits and `skipped` separates them. One event
rather than two, so the denominator cannot drift: everybody who reaches the end of the
flow is in it. It is emitted from `useCompleteTasteOnboarding`, which all three exits go
through, rather than from the three buttons.

**`title_logged`** is a bucket, not a position. A bucket is a band (PRD §11); the exact
ordering is `ranking_completed`. It is not the log sheet opening.

**`ranking_completed`** is the server answering `placed`. It is **not** the ranking sheet
opening, not a comparison answered, and not an abandoned session. `rebucket: true` is a
ranked title moving band, which discards its position and re-runs comparisons — a
different act with the same completion.

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

**`member_search_result_opened`** carries `position` and nothing else. **The query text is
never sent.** Neither is the handle or the display name.

**`invite_link_created`** is a link *created*, never a link *sent*.

> **The rule `growth-instrumentation.md` exists to enforce: opening an OS share sheet is
> not an invitation sent.** The sheet can be dismissed and the message deleted unsent, and
> nothing in this app will ever know either way. Any metric named `invite_sent` that
> counts share-sheet opens is a number that will be believed and is wrong.

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
| `skipped`, `rebucket`, `has_title` | booleans |
| `titles_ranked`, `comparisons`, `position` | counts |

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
| TestFlight / store | production | ios/android | embedded → ota | production |

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
| `ranking_completed` | approximately once | `failed && changed` is the lost-reply case and emits nothing |
| `recommendation_sent` | approximately once | a refusal inside a 200 is not a send; an unknown outcome holds its id for the retry and emits nothing |
| `recommendation_opened` | once per row per process | the server answered; a per-process set covers a stale `opened_at` and two quick presses |
| `onboarding_completed` | once per flow | guarded on the flow having already *ended*, so two buttons on one summary report one completion |
| `follow_created` | approximately once | `already_applied` carries no state and emits nothing; a known existing edge, and a relationship not yet read, both emit nothing |
| `watchlist_added` | approximately once | additions only, `ok` only |

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
   decision plus one environment variable.

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
