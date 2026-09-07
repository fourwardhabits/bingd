# Bingd — Screen Specification

**Version:** v2
**Status:** Draft for review
**Date:** 2026-08-15 (v1 was 2026-08-13)
**Specification:** [`../product/PRD.md`](../product/PRD.md) v0.6 · [`design-system.md`](./design-system.md) v2

What each screen is for, what is on it, and which states it must handle. Components and values come from [`design-system.md`](./design-system.md); this document does not restate them.

Where a screen has an unresolved choice, it is marked **Open** and repeated in §17.

> **What changed in v2.** The 0–10 score replaces the ordinal everywhere ([`design-system.md`](./design-system.md) §8), and the base surface is now Paper with Parchment as its warm accent (§1 there). Six screens were reworked against reference material on 2026-08-15: Collection §5, Title detail §6, Feed §7, Recommendations §8, Profile §9, Search §11. Reference archives are git-ignored under `design-references/`; screens cited by filename below are committed, resized, in [`references/`](./references/).

---

## 1. Inventory

| # | Screen | Section |
|---|---|---|
| 1 | Welcome and sign-in | §3 |
| 2 | Onboarding: name, username, photo | §3 |
| 3 | Onboarding: seed your taste | §3 |
| 4 | Onboarding: find and invite friends | §3 |
| 5 | Log sheet — bucket prompt | §4 |
| 6 | Comparison | §4 |
| 7 | Reveal | §4 |
| 8 | Collection | §5 |
| 9 | Title detail | §6 |
| 10 | Feed | §7 |
| 11 | Recommendations | §8 |
| 12 | Profile and match | §9 |
| 13 | Leaderboard | §9 |
| 14 | Lists | §10 |
| 15 | Search | §11 |
| 16 | Letterboxd import | §12 |
| 17 | Notification inbox and settings | §13 |
| 18 | Share sheet and cards | §14 |
| 19 | Settings, privacy, blocking | §15 |

---

## 2. Navigation — Decided 2026-08-13, superseding Provisional INF-4

[`client.md`](../architecture/client.md) §2 proposed **Feed · Search · + · Recommendations · Profile**, with rankings and lists inside Profile, and flagged it as expected to change during design. It changed, for two reasons.

**The collection is buried.** Both reference apps give the user's own collection a top-level tab and neither hides it behind a profile. Letterboxd's first tab is the user's own films; Beli's second is "Your Lists." A ranking is the thing a Bingd user returns to daily and the artifact the whole product produces, and reaching it through Profile puts the user's private working surface behind their public identity page.

**Search does not need a tab of its own.** In Beli the center button *is* search, because searching for a place is how you log one. The same is true here: you search for a film in order to log it, so the center **+** and the search field are the same action. Keeping both spends a tab slot on a duplicate entry point.

**Decided:**

| Tab | Contents |
|---|---|
| **Feed** | Followed users' activity |
| **Collection** | Watched, Watchlist, Unranked, Lists — §5, reworked 2026-08-15 |
| **+** | Log and rank — opens directly into title search |
| **Recommendations** | The generated slate |
| **Profile** | Public identity, stats, match, leaderboard, settings |

Search for **people** lives in Profile and in the invite flow; search for **titles** lives behind **+** and as a header affordance on Feed and Collection. Leaderboard sits inside Profile because it is a statement about standing among friends, which is identity rather than a daily surface.

Confirmed by the founder on 2026-08-13. Recorded in [`../product/decision-log.md`](../product/decision-log.md) §12.

---

## 3. Onboarding

Four steps. Each is skippable except account creation, and each states why it is asking.

**Welcome and sign-in.** Wordmark on Parchment, one line of positioning, three buttons: Continue with Apple, Continue with Google, Continue with email. Apple is required on iOS (PRD §7). The email path is a one-time code, never a password — no user ever creates or manages one, which removes a whole category of screen and a whole category of support request. One exception, and it is deliberately quiet: a *More sign-in options → Sign in with password* line below the three buttons, leading to a separate screen for the App Store / Play review account, which cannot receive an emailed code. It is `tertiary`, `sm`, secondary-toned, and offers no way to create an account — see [`../release/store-review-access.md`](../release/store-review-access.md).

**Name, username, photo.** One field per screen. Username availability resolves live with the taken state written plainly rather than as a red error. Photo is genuinely optional and the skip is a visible button, not a small link.

**Seed your taste.** The cold-start problem: recommendations and match need ranked titles, and a new user has none. Two entry points, presented together.

- **Import from Letterboxd** — the fastest path, and the reason import is in v1 (§12).
- **"Which of these have you seen?"** — a grid of widely-seen titles. Tapping one logs it. This is Beli's "How many of these spots have you tried?" ([`references/beli-30-collection-progress.jpg`](./references/beli-30-collection-progress.jpg)) and it works because recognition is far easier than recall.

Beli also asks what you dislike during onboarding ([`references/beli-20-onboarding-dislikes.jpg`](./references/beli-20-onboarding-dislikes.jpg)). Bingd should not. Genre exclusions collected before a user has logged anything are guesses about themselves, they conflict with the guardrails in [`recommendations.md`](../architecture/recommendations.md), and the same signal arrives more honestly from the *I didn’t like it* bucket.

**Find and invite friends.** Contact matching is opt-in with an explicit explanation of what leaves the device. Below it, the personal invite link with a native share action. Skippable.

The user lands on an empty Collection with one clear next action, never on an empty Feed.

**As built — 2026-09-07, the pre-GTM convergence.** Two things the shipped flow says that the specification above did not, both from the product audit of what a stranger meets in the first minute.

- **What a score is, before the first one appears.** The intro of Build your taste reads *"Rank five films you have seen. bingd. learns from how they compare to each other, not from stars. Each one gets a score from where it lands, and that score can move as you rank more."* A first liked film reveals `10.0` and `#1 in Movies`, and the second ranking moves it; without that sentence the reveal read as a star rating the app had assigned and then changed its mind about. The reveal repeats it once, quietly — see §4.
- **The summary offers Explore For You and Find people.** *See my collection* is gone from the second slot: the Collection is one tap away on the bar for the rest of this person's life, and the moment five films are placed is the one moment the app can say "now find the people whose rankings you will see". Find people lands on For You opened on People (`PEOPLE_DISCOVERY` in `lib/routes.ts`, the tab with `show=people`), which is the existing discovery surface and not a screen of its own. The empty Feed offers the same action to the same place (§7).

---

## 4. The log and rank loop

The core of the product. Three surfaces in sequence, and the sequence must feel like one continuous motion.

### Log sheet — bucket prompt

Opened from **+**, from a title page, or from a search result. A sheet, not a screen, so the context underneath stays visible — this is what makes Beli's version feel light ([`references/beli-224-bucket-prompt.jpg`](./references/beli-224-bucket-prompt.jpg)).

Anatomy: title header with poster and a close control; a category indicator (Movies or TV seasons); **"How was it?"** with the three bucket chips; then optional rows for who you watched it with, a note — one **Note** row since 2026-08-27, private until its *Share as a review* chip publishes it (PRD §22) — and the date.

**Built 2026-08-14 without two of those rows.** The tagging picker needs the social graph, which does not exist yet. The date row is not built either, and the consequence is worth stating plainly: the watch date is written only alongside a note, so a user cannot record "I watched this last night" without also typing something. Recorded in [`open-questions.md`](../product/open-questions.md). *Both were built later; the date row's own behaviour is below.*

**The watch date, and forgetting it (2026-08-24).** The row offers Today, Yesterday, a month grid, and **"Don't remember"**. Choosing a bucket stamps today the first time, and it must — the row displays "Today" as a pending default, and a default the sheet never saved is a claim it cannot keep. What was missing was the way back: `log_watched` coalesces its date, so nothing in the app could say "I watched this, I just don't know when", and the founder had to leave the flow and edit the title afterwards, which does not work either for the same reason.

**Clearing the date does not un-log the title.** The bucket is an independent watch signal, so the title stays Logged with `watched_on = null`; the server enforces that rather than merely allowing it, refusing the one case where the date is the only record of the watch (api.md §1). The label is **"Don't remember"** and not "Clear date": clear is what the control does to the field, not what the person means, and it reads as undoing the log. The row then reads **"Not recorded"** rather than "Today", and the bucket stamp is suppressed so the next rating tap cannot silently write the date back.

Two rules the architecture depends on:

- Choosing a bucket **saves immediately** and is queueable offline. The title is now Logged.
- Comparisons start only when the user taps **"Find where it lands."** Bucketing and ranking are separate actions ([`api.md`](../architecture/api.md) §1), and this is the surface where that separation becomes visible to the user.

Offline, the bucket saves with a pending marker and the ranking action is disabled with its reason shown.

**Tagging** sits here: "Who did you watch it with?" opens a picker of people you follow or who follow you, up to ten. A non-user can be invited from the same picker, which is the hand-off in PRD §17.

### Comparison

![Beli's comparison screen](./references/beli-252-comparison.jpg)

Beli's version is a stacked card inside the same sheet, with Undo, "Too tough," and Skip along the bottom. The structure is right and Bingd should follow it: staying in the sheet preserves the sense that bucketing and comparing are one flow.

Bingd's version is barer. Two `poster.xl` cards, **"Which did you like more?"** above them in `title2`, the film's title beneath each card, and the controls below. No year, no runtime, no genre. Everything else is something the user reads instead of deciding.

**Two controls, not three (built 2026-08-14).** This section previously specified three, mapping to `rank_back`, `rank_skip` and `rank_skip`. Beli's "Too tough" and Skip call the same thing, so Bingd ships one control for both: two buttons that do the same work is a choice the user has to think about for no reason.

**Undo and Skip (renamed 2026-08-24).** The two were **Back** and **Too tough to call**, and both words were checked against what the server does rather than kept.

`rank_back` restores `lo`, `hi` and `pivot` from the history entry it pops, and decrements the skip count (20260813001600). It genuinely reverses the previous answer, so **Undo** is the accurate word and **Back** was the weaker one — and on a screen with no navigation stack, "Back" also invited the reading "leave this sheet", which is the close control in the corner. At the first comparison there is nothing to reverse and the server ends the session instead; the title keeps its bucket and stays Logged, which is the same promise kept.

**Skip** replaced **Too tough to call** on 2026-08-24 because that wording named only half of what `rank_skip` is for. The founder's case is the other half: the poster is familiar and the memory is not, and "too tough to call" is the wrong sentence for "I do not remember this one well enough to say". Both want a different opponent and both always got one — the mechanism is unchanged and the word was the fix.

**Renamed again 2026-08-30, and this one is final: the control is `Too tough` on every surface.** Onboarding took the words back on 2026-08-28 while every other surface said Skip, and the founder met the result on the device — one control under two posters with two names. A control the app cannot name consistently is one whose meaning the reader re-derives each time; "Too tough" is the half that survives alone, because it says *why* you are pressing it. The two-word label costs nothing: the control row divides into equal halves rather than hugging its labels, so Undo and Too tough are the same physical size either way.

The accessibility label stays "Too tough to call. Skip this comparison" — the two words on the button are a reason, and a screen-reader user needs the effect as well: this compares something else, it does not leave the ranking. Leaving is the close control in the corner. The RPC keeps the name `rank_skip`; this is a copy contract, not a rename.

Both are `sm` and secondary-toned since the same date. At `md` they were 48pt tall, `headline` weight and full ink — physically the control the app uses for the primary act of a screen, sitting directly under the two posters that *are* the act, so they read as the question rather than as the way out of it.

**No progress line at all (2026-08-24).** This section previously specified a quiet line rather than a bar, on the grounds that the remaining count is an estimate from a range only the server knows. That reasoning was right and it argued one step further than the section took it: an estimate this screen cannot make is not information, and "A few comparisons to go" followed by "Getting closer" is encouragement. Founder feedback called it distracting and non-actionable, and it was also a line that changed on every comparison beside two posters somebody is trying to compare.

What survives is the one message that is not encouragement: after a skip the pair changes, and **"Try this one instead"** says why. Without it a poster silently becoming a different poster reads as a fault. The slot keeps its height when the sentence is absent, so the controls below do not move between comparisons.

**Long press to remember a title (2026-08-24).** Founder request: a poster and a name are enough to recognise a film and not always enough to *remember* it, and the only way out of that was to abandon the ranking and look the title up — which loses the session and every answer already given.

Pressing and holding either poster opens a compact sheet inside the comparison: the full name, the year, certification, length, genres, who directed or created it, the top cast and the overview, scrollable if it runs long. Nothing to act on — no score, no watchlist control, no reviews — because an action here would be a second decision competing with the one the reader is in the middle of. Dismissing returns to the same pair, because the reminder renders *inside* the comparison and nothing about the pair was ever unmounted.

React Native suppresses `onPress` after a long press, so holding a poster to read about it cannot also register as choosing it — the correctness property this gesture needed. A long press is invisible and unreachable to a screen reader, so each card also carries a small **"What is this?"** control with its own label, per design-system.md §8's rule that a hidden gesture may be the fast path and never the only one.

It adds no new data path: the row comes from `media_items`, which the comparison card already reads, and the credits from the `credits` facet of `media_cache`, which the title page has read since the integration landed. Nothing is fetched until somebody actually asks.

**No prefetch, and none is possible (corrected 2026-08-14).** This section previously claimed the next pivot's poster prefetches while the user decides. It cannot: the next pivot's identity is chosen by `rank_answer` from the answer being given, so it does not exist until the round trip returns. What is built instead is that neither card can be tapped until the opponent is on screen — answering against a card showing an ellipsis records a preference over something the user was never shown. A stall here still damages the mechanic, and the honest fix is the server round trip, not a prefetch.

**The comparison card never shows the opponent's score.** Beli shows it (`7.8` in the reference) and Bingd deliberately does not. "This is my 9.2" is an anchor that invites agreement rather than a real judgment, and the mechanic's whole value is unanchored preference. The score is visible everywhere else in the app, which makes this the one screen where keeping it off has to be deliberate. Decided by the founder on 2026-08-13; unchanged by the move to scores on 2026-08-15, and more important now that the badge appears on every other surface.

### Reveal

The composition in [`design-system.md`](./design-system.md) §9: an Amber panel, the **score** in Ink at display size, title and bucket below. The score counts up from the low end of its own band rather than from zero, so the animation reads as placing the title inside the bucket the user just chose.

**Nothing on the reveal mentions Too tough (2026-08-30).** The panel used to be followed by "You skipped a few, so this is an estimate. You can move it from Rankings." whenever the server reported an `adjustable` placement. It appeared only for the people who used the affordance, which turned the one control that keeps a ranking honest into something the reward screen apologised for — and it landed on somebody who had just finished their first ranking. Removed and not replaced: the reveal states the score and the placement, exactly as it does for a ranking that met no Too tough at all. The placement itself is unchanged, and the title is as movable from Rankings as any other.

**The reveal never names a placement worse than #10 (founder, 2026-09-05, from a physical Android pass).** It drew every placement it could compute, led by the overall ordinal:

```
8.7                                     7.1
The Matrix                              Vincenzo, S1
#19 in Movies              becomes      #9 Comedy · #9 Drama
Below Spirited Away                     Below Fullmetal Alchemist: Brotherhood, S1
Above Harold & Kumar…                   Above The Office, S1
#6 Science Fiction · #7 Action
```

Four lines of ordinal under a score, and the largest number on the screen was the one saying least — `#19 in Movies` is a fact about how much the reader has ranked, not about the film. The rule is now the one [`hero-rank.ts`](../../src/features/collection/hero-rank.ts) has applied to the title page since 2026-08-28, with the reveal's own allowance of two lines: **top ten overall and the genres are suppressed; otherwise the top-ten genres, at most two; otherwise nothing**, with no gap reserved.

**The order settled on 2026-09-06, after the founder saw both on a device.** The placement went below the anchors on 2026-09-05 and came back under the title once it was top-ten-only — because the reason for moving it was that it was often the wrong thing to lead with, and a conditional line is not. It is drawn **muted**: the hierarchy is score, title, placement, then the names either side, and an ordinal at the title's weight is two headlines.

**A season is named the way everything else names one.** It printed `media_items.title`, which TMDB writes as "Season 1" — so a reader who had just ranked Vincenzo saw a score, the words *Season 1*, and two anchors underneath that identified themselves while the subject did not. The subject's own row now goes through [`compactName`](../../src/lib/titles.ts), which is what the anchors have always used, so the three lines agree by construction. A film's title is returned untouched.

Nothing about the arithmetic moved — same `rankings.position`, same genre ordering off the same cached list, same neighbours. `TOP_RANK_SHOWN` lives in `genre-rank.ts` so the hero and the reveal read one number.

Below the panel, three actions: **Share**, **Rank another**, and **Done**. **Share is absent as built (2026-08-14)** — share cards do not exist, and an action that does nothing is worse than one that has not arrived. Beli celebrates the first rank specifically ([`references/beli-229-first-rank-celebration.jpg`](./references/beli-229-first-rank-celebration.jpg)) and Bingd should too — the first reveal is the moment the product explains itself, and it is worth a distinct line of copy.

**That line exists as built (2026-09-07), and it is the explanation rather than a celebration.** Under the anchors, in `footnote`/`tertiary`, onboarding's reveals carry *"Your score comes from where this lands in your rankings. It can move as you rank more."* The condition is the `surface` the sheet already carries for analytics — `onboarding` is exactly "the first five rankings this account will ever see" — so no first-reveal flag is persisted, reset on a second device, or got wrong. An ordinary reveal, the one a reader with two hundred rankings meets from Search or a title page, does not carry it; the intro of Build your taste says the same thing once before the first comparison (§3). Nothing about the score, the placement or the arithmetic moved.

**Undo at the first comparison says what it left behind (2026-09-07).** `rank_back` with nothing to reverse ends the session, and the sheet used to say *"Still in your collection — stays logged. You can rank it whenever you like."*, which a stranger read as finished. It now reads **Logged, not ranked yet** over *"{title} is saved in your Collection without a bingd. score. Rank it from your Collection or its title page whenever you like."* Copy only: the unranked contract, the bucket and the session are untouched.

---

## 5. Collection — reworked 2026-08-15

The user's own working surface.

### Ranked and Watched were the same list

v1 had four segments: **Ranked · Logged · Watchlist · Lists**. As built, Ranked and Watched showed largely the same titles in a different order, because almost everything a user logs they also rank. Two tabs that mostly agree force a choice with no meaning behind it, and the user has to learn which one is the "real" list.

**Decided: one list.** The segments are **Watched · Watchlist · Unranked**, and Unranked appears only when the count is non-zero — a tab that is always empty for most users is a permanent reminder of a chore.

Watched is sorted by score descending, which *is* position order, so it reproduces v1's Ranked tab exactly while also containing the unranked titles. A ranked title shows its score; an unranked one shows the dashed `Rank` badge, which is a button into the ranking sheet. The list is therefore complete and honest at the same time, and the fastest path to ranking something is now sitting in the list the user already looks at.

Unranked survives as a tab because it is a useful *filter* of that list, not a different list.

### Header

Beli's stacked header ([`references/beli-60-list-header.jpg`](./references/beli-60-list-header.jpg)): a category dropdown, then tabs, then utilities. Bingd's version, top to bottom:

```
bingd.                                    ⚙
Movies ˅                                        ← title1, DM Serif, opens a sheet
Watched      Watchlist      Unranked            ← active: Ink + Maroon underline
⇅ Score                                         ← sort
```

**Movies / TV becomes a dropdown**, replacing v1's tap-to-cycle toggle. A control that changes value on tap without saying what it will change to cannot be read before it is used, and with only two options it happened to work — it would have broken the moment a third category existed. A dropdown states the current value and shows the alternatives on demand.

### Rows

The compact row from [`design-system.md`](./design-system.md) §8, which is Letterboxd's diary row ([`references/letterboxd-55-diary.jpg`](./references/letterboxd-55-diary.jpg)): 38 × 57 poster, title and year, `148m · Action · Adventure`, score badge right.

**The band headers are gone.** *LOVED IT* / *IT WAS FINE* / *NOT FOR ME* section headers made the bucket partition legible when the only number on the row was an ordinal that said nothing about how much the user liked something. The score says it — the ranges do not overlap, and the badge is tinted by bucket — so the headers now caption information already present twice on every row.

**The bucket label is gone from the subtitle** for the same reason. `I liked it · 148m · Action` next to a badge reading `8.7` spends the most valuable line on the row restating the badge.

No progress bar toward 100% and no "380 remaining" (PRD §5). Someone importing 800 films must not open this tab and feel behind.

### Filter options are in a fixed, readable order — 2026-08-30

| Section | Order |
| --- | --- |
| Genre | Alphabetical, by the label drawn |
| Language | Alphabetical, by the **English word** — Greek under G, not `el` under E |
| Decade | Chronological, **oldest first**: Earlier · 1990s · 2000s · 2010s · 2020s |

Genres and languages were ordered by count, descending. That is a defensible order for a
list somebody is *browsing* and the wrong one for a list somebody is *looking something up
in*: the position of Horror moved every time another horror film was logged, so a reader
had to re-scan the section on every visit to find an option they already knew was there.
The count is still printed beside each entry for whoever wanted the popularity signal — it
just no longer decides where the entry sits, and it stays attached to its own option.

Anime takes part in the alphabet like any other genre, which puts it after Animation
(the two agree for four letters and then `a` precedes `e`).

Decades were newest-first. Ascending because a decade list is a timeline and a timeline
starts at the beginning; it was already in calendar order rather than by count, for the
reason that still holds — a decade list that reorders itself as the collection grows is
unreadable.

**The comparison is code-point on a lower-cased label, not `localeCompare`.** This app has
three collators — Hermes on the phone, Node's full ICU under Jest, a browser's on the web
— and `lib/language.ts` exists because a rule that passed on Node and behaved differently
on the device shipped once already. Every label in both facets is ASCII English, so the
two orders agree; what this buys is that they cannot stop agreeing on somebody's phone.

**Lists is still absent**, deliberately: there is no list UI yet, and an empty tab that cannot be filled is worse than one that has not arrived.

Beli puts a milestone tracker at the top of this surface — progress toward unlocking scores and recommendations ([`references/beli-30-collection-progress.jpg`](./references/beli-30-collection-progress.jpg)). Bingd should use this pattern **only** for the recommendation threshold, where the target is finite and reaching it unlocks something real. It must never appear over the ranked list itself, where there is no finish line.

---

## 6. Title detail — redesigned 2026-08-15

### What was wrong

v1 specified a poster at `poster.lg` with the title beside it and explicitly no backdrop, because §1 of the design system forbade full-bleed artwork on Parchment. As built it was the weakest screen in the app, and the reason is structural rather than cosmetic: a title page whose largest element is a 132pt poster on a tan field has no focal point, so it reads as a form rather than as a page about a film. Every app in the reference set — Letterboxd, Apple TV, Max — opens a title page with a wide image, and they do it because artwork is the only thing on the screen the user recognises instantly.

**Decided: this screen gets the app's one full-bleed hero** ([`design-system.md`](./design-system.md) §1, §7).

### Composition

The top half is Luma's event page, which solves a closely related problem — a hero image, an identity object overlapping it, then a dense block of state and metadata — and does it on a light background, which Letterboxd and Apple TV do not.

```
┌────────────────────────────────────────────┐
│                                            │
│   backdrop, 16:9, scrim to surface.base    │   ← the app's only full-bleed artwork
│                                            │
│                          ┌──────────────┐  │
└──────────────────────────│ Sci-fi │ Action│──┘  ← genre pills straddle the hero edge
   ┌──────────┐            └──────────────┘
   │          │   Inception
   │  poster  │   2010
   │  poster.lg│
   └──────────┘
   A thief who steals corporate secrets through dream-sharing
   technology is given the inverse task…              more
   148m · Christopher Nolan · Leonardo DiCaprio, Elliot Page

   ┌───────────────┐    ⬤        ↗
   │    Ranked     │   8.7     Share
   └───────────────┘
   Watched 12 Aug 2026

   ─────────────────────────────────────────────
   Cast    Details    Reviews    Seasons
```

**Genre pills straddle the hero's bottom edge.** This is the position Luma gives its "Highlight" chip, and it earns its place for a reason beyond decoration: genre is the single most useful fact about a film the user has not seen, and it is the thing they are scanning for when deciding whether to add it. Putting it half onto the artwork makes the hero and the content one object rather than a banner with a page beneath it. Pills use `surface.raised` with a hairline, not a bucket color — they are metadata, and §1 allows exactly one chromatic UI element on a content surface, which is spent on the score.

**Personal state sits above the fold, to the right of the primary action.** Rank/Ranked button, the watch date directly beneath it, then the score badge, then Share. Luma puts a map icon in that slot; the score is what belongs there in a collection app, because it is the answer to the question the user is asking when they open a film they have already seen.

The badge shows the dashed unranked state when the title is logged but not compared, which makes the two adjacent controls read as one sentence: *Rank* → *no score yet*. Nothing about that state is presented as a failure (PRD §26.4 AC 2).

**Order of the whole page:** the user's own state, then the primary action, then catalog metadata, then friend signal, then attribution. State comes first because this screen is most often opened by someone deciding whether they have already seen something.

### Tabs

Luma renders its secondary content as a scrolling row of pills. Bingd makes them real tabs — **Cast · Details · Reviews · Seasons** — because the content behind them is long and a user who wants the runtime should not scroll past the cast to find it. Apple TV's information layout ([`references/apple-tv-95-information.jpg`](./references/apple-tv-95-information.jpg)) is the model for Details: label above value, stacked, no table rules.

- **Cast** — the cast strip, plus director and writer.
- **Details** — released, runtime, genres, original language, and **the ordinal in full**: `#2 of 6 in Movies`, with the denominator, because a bare ordinal is unreadable without it (PRD §10).
- **Reviews** — the user's own note. Friends' notes when the feed carries them. Absent entirely until there is something in it; a tab that is always empty is worse than a missing tab.
- **Seasons** — series only. Per-season state, since the season is the rankable unit and the series is not (AD-1). This distinction is invisible in the data model and has to be made obvious here.
- **Episodes** — season only, and **first in the row**, which also makes it what a season page opens on. Episode number and title, then air date and runtime, then a 16:9 still, then a synopsis clamped to three lines. Nothing on a row is pressable: this is metadata a reader scans, not a unit they act on (PRD §10). Added 2026-09-03.

**Why Episodes leads a season page.** People remember watching a show and forget which seasons — which lands directly in front of the one action a season page exists for. Episode names, dates and stills are what settle it. Cast does not: a show's cast barely changes between seasons, so it was the least distinguishing thing on the page it used to lead.

Tabs whose content does not exist for a given title are not rendered. A film has no Seasons tab and no Episodes tab; a series grouping has no Episodes tab either, because episodes belong to the season a reader selects rather than to a browser spanning all of them.

**The tab row scrolls sideways when it does not fit.** A season carries five tabs, which is past what a 320pt phone holds, and any row can outgrow its width once a reader raises their system text size. The row is a flex row with a fixed gap and no wrap, so before this it simply ran off the right edge and took its last tab with it. A row that already fits is unchanged: no scroll indicator, no bounce, same left alignment.

### States

**No backdrop.** Common — the seed catalogue ships without artwork of any kind (PRD §7.14). The hero collapses to a short `surface.sunken` band at the height of the pill row, so the poster still overlaps something and the layout does not shift into a different design. Never a grey box where an image failed, and never a stretched poster standing in for a backdrop.

**No overview.** Omit the paragraph. Do not render a placeholder line.

**Provider attribution** appears here. TMDB's requirements are published and specific — an approved logo, kept less prominent than Bingd's own mark, plus the exact notice "This product uses the TMDB API but is not endorsed or certified by TMDB" in an About or Credits section. The notice itself lives in Settings; this screen carries the source line. Details in [`../reference/tmdb-integration.md`](../reference/tmdb-integration.md).

### As built — 2026-08-27: the hero is the backdrop's own shape, and Rank is the page's biggest thing

Two founder passes on a device, recorded together because both move the top of this screen.

**The hero frame is `status-bar inset + width ÷ (16:9)`.** The visible image box below the transparent header is exactly the backdrop's own 16:9 on every device, so the full artwork — top edge included — shows with no crop on either axis. The fixed frame ratios that preceded it (1.4, then 1.62, then 1.5) were each a different wrong crop on some device, because any frame that is not the image's own shape forces `cover` to choose an edge to lose. `POSTER_LIFT` went 96 → 120 and the heading gap halved (16 → 8), so the title starts sooner and the score cluster sits higher despite the deeper hero; the collapsed no-backdrop band tracks `POSTER_LIFT` at 120, so the two states keep one geometry.

**The personal cluster is the primary action of this page.** The reader's own score circle is the page's largest (`xl`, 64 — a badge size that exists for this cluster alone), the "Your score" caption is gone — a filled Maroon circle with a number in it, above a button named Rank, does not need a caption to say whose score it is — and Rank/Ranked is full 44pt control height with a `headline` label. **Recommend in the action row is outlined**: filled Maroon marks the primary action of the current context ([`design-system.md`](./design-system.md) §8), and on a title page that is this cluster. Recommend is filled again inside its own sheet, where sending is the point; Watchlist is unchanged; never two equally dominant Maroon CTAs in one view.

### As built — 2026-09-05: where to watch, under the scores and over the tabs

One compact row, and its size is the decision. Label on the left with `via JustWatch` beneath
it, the first three service logos on the right at 28pt, a `+N` when there are more, and a
chevron. Tapping opens a sheet grouping every service under **STREAM · RENT · BUY**, a service
offered two ways appearing under both from one entry.

```
   ─────────────────────────────────────────────
   ⬤ 8.7  bingd.        ⬤ 9.1  Following
     12 ratings           2 people you follow
   ─────────────────────────────────────────────
   WHERE TO WATCH          [N] [tv] [a]  +2   ›
   via JustWatch                                  ← small, tertiary, italic
   ─────────────────────────────────────────────
   Cast    Details    Reviews    Videos
```

**Not a tab, and that is the whole placement argument.** A film opens on Cast and a season
opens on Episodes, both of which are those pages' point; a season's row is already five tabs
and scrolls sideways on a 320pt phone. Availability is worth finding without a tab hunt and is
not worth a hero band, so it is a row on the page — under the score block, over the tabs, on
every kind of title including a series, which has no score block of its own.

**It disappears rather than explaining itself.** Loading, failed and genuinely empty all draw
nothing: this is the one block on the page allowed to be absent, and a card apologising for a
licensor's missing data would be a permanent apology on every obscure film in the catalogue.
Nothing about a provider failure reaches the page around it.

**A logo is not a button, and since 2026-09-05 nothing on this block leaves the app.** TMDB
publishes no per-service deep link, so nothing here opens Netflix. `View watch options` —
TMDB's own page for the title in that market — was the sheet's one action and was removed on
the founder's ruling: a real link to the wrong place is still the wrong place. It sent
somebody out of bingd. to a web page that sent them somewhere else, and it did not do the
thing its position implied. Nothing replaces it; manufacturing a provider URL would be a
guess presented as a destination.

**The heading is the app's section treatment, over the app's own hairline.** `WHERE TO WATCH`
in small maroon caps, with the JustWatch credit beneath it in italic tertiary. It was a
`callout` label in full ink until 2026-09-05, which is a row's weight rather than a
section's — so sitting directly under the two score units it read as a third thing inside
Scores. The heading alone was tried first and the founder rejected it on a device: with the
score units directly above and nothing between them the block still read as a continuation.
The rule added on 2026-09-06 is `ScoresSection`'s own — gutter-inset, doubled hairline —
borrowed rather than invented, and it costs a pixel of height. The block is a row and stays
a row.

The JustWatch credit is on both surfaces because their terms require the source to be named
wherever the data is shown — demoted, never hidden. See
[`../reference/tmdb-integration.md`](../reference/tmdb-integration.md).

### As built — 2026-09-07: the identity redesign

> **Partly superseded by the note below it** — the founder reviewed this composition and
> corrected four things: the poster moved to the right, the identity block came off the
> artwork, the floating `YOU` pill became the words "Your score", and Rank/Ranked kept its
> label and its menu instead of becoming an Adjust glyph. Everything else here is what
> shipped. This note stays because the reasoning that produced the rejected version is what
> makes the correction legible.

The founder's redesign of the top half of this page, taken as a whole. Nothing about ranking,
scoring, recommendation or the catalogue moves; this is composition, hierarchy and one crash.

```
   ╔════════════════════════════════════════════╗
   ║ ‹                                       ⋯  ║  ← overlays the artwork, no bar
   ║        backdrop, 16:9, behind the          ║
   ║        status bar, scrim under chrome      ║
   ╚════════════════════════════════════════════╝
   ┌────────┐  The Last of Us
   │        │  Season 1, 2023
   │ poster │  TV-MA · 9 episodes · Craig Mazin
   │  md    │  #1 in TV · Watched 12 Feb 2026
   └──────⬤─┘
         YOU        ← 10.0 in the circle, YOU on its lower edge

      ⇅          ▢          ➤
    Adjust      Save    Recommend

   A thief who steals corporate secrets through dream-sharing technology
   is given the inverse task of planting an idea into the mind of a chief
   executive, but his tragic past may doom the project and his team to
   disaster before they can even begin. … more      ← always on line four

   [Drama] [Action & Adventure] [+2]

   SCORES
   ⬤ 9.1  Following        ⬤ 8.7  bingd.        →   ← scrolls sideways
     2 people you follow      12 ratings

   WHERE TO WATCH             [N] [tv] [a]  +2   ›
   via JustWatch
   ─────────────────────────────────────────────  ← the page's one hairline
   Episodes    Cast    Reviews    Details
```

**Identity moved to poster-and-title side by side.** The poster used to sit alone under the
hero with a detached score column opposite it, and the title, year and metadata began on a
full-width band below both — three bands for one fact. They are one row now: the poster still
straddles the hero's fade on its Paper mat, and everything that names the title sets beside it
in a column, in the order a reader scans. For a season the heading is **the show** and the
subtitle is `Season 1, 2023`; the show's name is also the link to the series page, which
replaces the small Maroon line that used to sit above the heading. `POSTER_LIFT` is 88 with
the poster at `md`, and the no-artwork band is the bar's height plus that lift, since the
navigation now overlays the hero rather than sitting above it.

The metadata line reads certification, then length, then a credit — `TV-MA · 9 episodes ·
Craig Mazin`, `PG-13 · 145 min · Destin Daniel Cretton`. Two facts became available to it
without a new request: a season now inherits its series' certification, because TMDB publishes
a rating on the series and never on a season, and a season's length is its **episode count**
rather than a runtime (`20260820000400`) — the line used to print a runtime column TMDB does
not fill for seasons, so the segment was simply missing on every season page. Television's
credit falls back from director to an explicit Creator and then an Executive Producer, read
off the `credits` facet the screen was already fetching. Any part that is absent is dropped
without leaving a separator, and a line with nothing in it is not rendered at all. The feed
keeps `148m` in its own subheading: that is a two-line row with a poster, and this is a line
with a column to itself.

**The personal score now carries explicit `YOU` context, over the poster.** `10.0` in a
detached upper-right column was not self-evidently the reader's own — a bare number beside
artwork is where every other product puts a critics' aggregate. The circle moved onto the
poster's lower outside corner with a `YOU` pill on its edge: Paper ground, Maroon hairline,
Maroon capitals, not a second filled shape. The number, the scale and where it comes from are
unchanged (PRD §10, `score.ts`), it is still not a star rating, and the logged-but-unranked
state is still the honest dashed ring rather than a greyed zero. A ranked title whose band
sizes have not landed draws the neutral empty circle, because the dashed ring reads "rank
this" and would contradict the Adjust control beside it. The ordinal survives as a segment of
the context line — `#1 in TV · Watched 12 Feb 2026` — rather than as a row of its own, and the
watch date is on this page for the first time.

**Rank/Save/Recommend became one compact action group.** They were three controls of three
kinds in two places: a full-height `Ranked` chip with a tick, two unlabelled glyphs under it,
and before that a row of Maroon chips further down. Now one row of three, equal shares, one
baseline, one weight, each 44pt or more, never wrapping. **The `Ranked` button is gone**: a
button whose job is to *report* is a button standing in for a fact, and the fact is on the
poster. The first action is the rank intent at whichever stage the title is in — **Adjust**
(same watch, `mode: 'rerank'`) for a ranked title, **Rank** for an unranked one. Each glyph
keeps a one-word caption, because a paper plane is Recommend here and Send everywhere else. A
series gets Save alone (PRD §10). The rest of the ranking menu — the note, who I watched with,
*Log another watch*, *Change your rating*, Remove — moved from the Ranked chip to the
overflow `⋯` in the top bar, with the same reachability it had: present for a ranked title,
absent otherwise.

**The overview precedes the genres and collapses to four lines with `more` inline.** `more`
was a second `Text` under the prose, so a synopsis that filled its clamp spent a whole line on
one word and pushed the genres away from the paragraph they belong beside. It is now a span
*inside* the clamped `Text`, which is what makes the guarantee structural — React Native
cannot put it on a fifth line, because `numberOfLines={4}` has not given the block one. Where
to cut is **measured**, not counted: an invisible pass reports every line of the full synopsis
with its own width, a second reports the width of ` … more`, and the fourth line is trimmed to
a word boundary that leaves room for it. A character count would be right at one width and one
text size and wrong at every other. A synopsis that already fits four lines shows no marker at
all. Before the measurement lands, and if it never does, the block is the full text under a
plain four-line clamp — honest, and still tappable.

**Scores regained a heading and became horizontally extensible.** `SCORES`, in the app's
section treatment. It was removed on 2026-09-06 because the units name themselves, which is
true of each unit and not of the pair — two circles arriving under a synopsis with no heading
read as a continuation of the synopsis, and no arrangement of two units gives a screen reader
a landmark. **Following leads bingd.**, because a mean over accounts the reader chose is a
signal about their own taste and the app-wide mean is a fact about the app. The row is a
horizontal scroller sized to its content rather than a flex pair with a responsive stacked
fallback: a third unit has been asked for twice, and content sizing means `Not enough ratings`
can never break mid-word at any text size. No card, no wash, no rule. The reader's own score
is still not in here (founder, 2026-08-18).

**The hero navigation is transparent and gains opacity on scroll.** The route no longer draws
a navigator header at all. Back and an overflow control overlay the artwork on `TitleHero`'s
own top scrim — the app's existing contrast language — and one `Animated.Value` carries three
things at once as the hero leaves: the Paper ground and its hairline arriving, the compact
title fading up, and a crossfade between two copies of each glyph, light on artwork and Ink on
Paper. The old arrangement mounted or unmounted a `headerBackground` on a boolean, which has
no middle; and `headerTintColor` is a navigation option rather than an animatable value, so
there was no way to make the icons change with the ground. **Navigation semantics are
unchanged**: Back is `router.back()` and returns to whatever pushed the route, and the
hardware back and edge-swipe gestures are the navigator's and untouched. The compact title is
hidden from assistive technology until it is readable, crossed with hysteresis, so a screen
reader does not meet the title twice on every page.

**Section separation was reduced to one hairline.** Rules above the scores, above Where to
watch, and between every pair of episodes are gone. Whitespace is the default separator and a
Maroon section heading is what announces a block; the single rule left is above the tab row,
which is the one place the page changes mode — above it the page is about the title, below it
it is a set of lists you choose between.

### As built — 2026-09-07, final: identity left, poster right

The founder's review of the composition above, and the direction that supersedes it. Everything
in the note before this one still describes what changed and why *except* the four points
corrected here — they are kept rather than rewritten, because the reasoning that produced the
rejected version is what makes this one legible.

```
   ╔════════════════════════════════════════════╗
   ║ ‹                                       ⋯  ║  ← discs on artwork, no bar,
   ║        backdrop, 16:9, behind the          ║    old compact height
   ║        status bar and the controls         ║
   ╚════════════════════════════════════════════╝
   The Last of Us                    ┌────────┐
   Season 1, 2023                    │        │
   TV-MA · 9 episodes · Craig Mazin  │ poster │
   #1 in TV · Watched Feb 12, 2026   │  md    │
                                     └────────┘
                                     Your score
                                        10.0

                       [ ✓ Ranked ]   🔖   ➤

   Twenty years after a fungal outbreak ravages the planet, a hardened
   smuggler is hired to escort a teenage girl out of a brutal quarantine
   zone, and what begins as a small job becomes a journey across a
   broken country. … more                    ← always on line four

   [Drama] [Action & Adventure] [+2]

   SCORES
   ⬤ 9.1  Following        ⬤ 8.7  bingd.        →

   WHERE TO WATCH             [N] [tv] [a]  +2   ›
   via JustWatch
   ─────────────────────────────────────────────  ← the page's one hairline
   Episodes    Cast    Reviews    Details
```

**The poster is right of the identity block, and the identity block is on Paper.** The pass
above put the poster left and pulled the whole row up into the artwork. Two corrections, and
they are one: **primary title text must not depend on being readable over a backdrop nobody
chose.** A hero is a night scene, a white sky, a face — a serif title set on it is legible on
the artwork the designer happened to be looking at and nowhere else. So the identity row now
begins at the hero's lower edge and every word of it sets on the page's own surface. The poster
keeps its overlap, at a shallower `POSTER_LIFT` of 56, because artwork over artwork is fine and
it is the one object on this page allowed to cross the fade. The row aligns on its top rather
than its bottom, so a one-line film title and a wrapped three-line one both start level with
the artwork instead of the block sliding up and down with the length of a name.

**The primary title remains on the normal content surface** in every state, including a title
with no backdrop at all, where the hero is the bar's height plus a short warm band.

**The personal score is associated with the poster and says whose it is in words.** It sits
under the frame, centred on it: `Your score` in `caption`/tertiary, then the filled Maroon
circle. The floating `YOU` pill from the pass above is gone — a bubble on a badge reads as a
sticker or a notification rather than as a label, which was the founder's objection. Ownership
is now stated, nothing floats, and the number is still the dominant element in the block by an
order of magnitude of weight. The scale, the derivation (`score.ts`) and the honest dashed
unranked state are untouched; it is still not a star rating.

**Rank/Ranked keeps its word, its treatment and its menu.** The intermediate pass replaced it
with an `Adjust` glyph that went straight to a same-watch rerank. That is rejected: choosing
between adjusting a placement and declaring a rewatch is the reader's decision, and putting two
intents behind one press is the founder's Terrace House bug rebuilt in a different shape. So:

- **unranked** — filled Maroon `Rank`, opens the log sheet, where a band is chosen and a first
  ranking begins;
- **ranked** — outlined `✓ Ranked`, opens the ranking-options menu, which is where *Rank it
  again*, *Log another watch* and *Change your rating* are each named and each chosen.

There is deliberately **no responsive switch** between a labelled button and an icon: a control
that is a word on one phone and a symbol on another is two controls. The same menu is also
reachable from the overflow in the top bar.

**Rank/Ranked, Save and Recommend are one compact cluster**, right-aligned under the poster and
the score rather than three equal shares of the content width — stretched across the page they
read as a toolbar, which is the dashboard feeling this whole pass removes. Only the rank
control is labelled, because only it is the primary act; the two glyphs keep their full spoken
names and each clears 44pt through its own box rather than through slop, so neighbouring targets
cannot overlap.

**The top bar keeps the compact height it had before the redesign** — `insets.top` plus 44 on
iOS and 56 on Android, exactly the navigator header's own metrics — and reserves nothing,
because it is absolutely positioned over the artwork. What changed is only how it behaves. It
begins fully transparent, and each control sits on a small Ink disc while it is over artwork:
`TitleHero`'s top scrim is a gradient across the whole width, which is right for a bar and
weakest exactly where a single glyph is smallest, so a local disc carries the contrast a pale
backdrop needs. The disc fades out on the same value the Paper ground fades in on, so it exists
only while there is artwork behind the glyph.

**The synopsis is four lines with `more` inline on the fourth, the genres follow it, and the
Scores treatment is unchanged from the note above.** Those three were accepted as built.

### As built — 2026-09-07, polish from the device: the score on the corner, one action row

Three corrections after the first physical pass of the composition above, none of them a
change of architecture.

**The score is back on the poster.** It sat *under* the frame for one revision, which produced
a tall empty column on the right of the page and a number that read as a separate block. It is
anchored to the poster's **lower-left corner** now — about a third of the circle overhanging
onto Paper, which keeps the number legible whatever the artwork behind the rest of it is — with
`Your score` in `caption` beneath it. No floating pill. The unranked state is the dashed ring
**with nothing in it**: the word `Rank` inside the circle duplicated the button beside it, and
the honest statement of "no score yet" is the empty ring, not a second invitation.

**The action row spans the content width.** `[ ✓ Ranked ] [🔖] [➤]` as one row directly after
the identity block, the labelled control taking the width the two glyphs leave. Hung from the
right under the poster it read as detached on the device — a cluster floating in a corner with
a blank column above it. Control set, treatment and behaviour unchanged; the glyphs are still
icon-only and each still clears 44pt through its own box.

**The ranking menu says it in the app's own words.** *Adjust placement* is now **Rank it
again**, and *I watched it again* is now **Log another watch**. Only the labels moved: `rerank`
still passes `p_new_watch: false` and writes no activity, `again` still passes `true` and
writes exactly one, *Change your rating* is untouched. The pair the founder rejected named the
mechanism and a confession; these name the act, in the verbs the rest of the app uses.

**Twelve points between the synopsis and the genres.** The chips sat directly on the
paragraph's last line. A `space[3]` gap keeps them associated with it without becoming a
section break.

**For You's controls are one row, and scroll.** *Sent to you · N*, *Group Picks* and *Filters ·
N* wrapped to two rows on a 360pt phone, and the arithmetic does not allow a fit at footnote
size with counts. The row is a horizontal scroller with `nowrap` now — the same arrangement as
the tab row — so on every ordinary phone nothing changes and on a narrow one it scrolls rather
than reflows.

### The title-page crash — 2026-09-07

The founder's report was two symptoms: a title page renders briefly and then the app's error
boundary appears, and sometimes the reader ends up back on Feed rather than on the title page.

**The second symptom is fully explained and fixed.** `RouteErrorBoundary` wraps `<Stack>` in
`app/_layout.tsx`, so catching *anything* unmounts the navigator and the pushed route goes
with it, along with everything behind it. Clearing the error mounts a fresh `<Stack>` at the
root index; `nextRoute` reads the root index as `group === undefined` and returns
`/(tabs)/feed` (`session.tsx`). No code decided to go to the feed — the back stack stopped
existing. Expo Router lets a route module export `ErrorBoundary` and wraps only the route
component in it, so `app/title/[id].tsx` now does: caught there, the route stays on the stack,
Back still returns to whatever pushed it, and `retry` re-renders in place. The root boundary
remains for everything a route boundary cannot catch — a throw in a layout, in the navigator
itself, or on a screen that has not declared one.

**The exception was not nameable from the repository, so the boundary was made to name it —
and it did.** A caught render error had gone only to Sentry, which this project has been unable
to read for weeks. It now also goes to the flight recorder as a `render` event carrying the
error's class and the route, and a beta build prints the class and message under the apology.
The first physical pass on that build read back:

> `TypeError: Cannot read property 'layout' of null` — `title/[id]`

**The root cause is `GenreRow`'s measuring pass reading a released synthetic event.** React
Native's renderer pools synthetic events: once an event's handlers have run,
`e.isPersistent() || e.constructor.release(e)` returns it to the pool and
`SyntheticEvent.destructor()` sets `nativeEvent` to null (`ReactFabric-prod.js`). The
measuring layer read `event.nativeEvent.layout.width` inside a functional `setWidths`
updater, and React runs an updater *later*, during render, whenever it cannot compute it
eagerly — which is the moment another update is already queued on the same component. So the
first chip's width was read while the event was alive and every later chip's was read off a
destroyed one: a title with one genre never crashed, and a title with two or more crashed
whenever their layouts landed in one batch. Thrown during render rather than in the handler,
it reached the error boundary instead of the red box — "loads for a moment, then the apology",
on the titles that had genres. It shipped in #114 and was in the beta from the #122 update on.

The fix is one line moved: the width is read synchronously in the handler and the updater
closes over a number rather than an event. `GenreRow.test.tsx` reproduces the failure's own
shape — three chips reporting in one batch, each event destroyed the way the renderer destroys
it before the updaters run — and the route-local boundary and the diagnostic line stay,
because the next unnamed exception deserves the same treatment.

One suspect was removed on the way past rather than left standing: `GenreRow` mounted its
"all genres" `Sheet` unconditionally, so every title page in the app carried a React Native
`<Modal>` — and its keyboard listeners — inside the page's `ScrollView`, permanently, for a
list nobody had asked to see. Every other sheet on this page mounts on demand; this one does
now too.

---

## 7. Feed — reworked 2026-08-15

Strictly chronological, no algorithmic ordering (PRD §14).

### Cards were the wrong container

As built, each activity was a bordered card on `surface.raised`. Three items produced three rounded rectangles stacked with gaps, and the chrome outweighed the content — a feed of cards reads as a list of notifications, not as a stream of things people did.

Beli's feed is flat: white ground, hairline between items, no card ([`references/beli-374-activity-item-full.jpg`](./references/beli-374-activity-item-full.jpg)). Letterboxd's is the same. **Decided: divider-separated rows, no card.** Removing the border also removes the double-surface problem, where a `surface.raised` card holds a poster that needs its own hairline to separate from it.

### What a movie feed has instead of photos

Beli's items are carried visually by food photography — a horizontal strip of square images per activity. That does not transfer, and the honest reason is that a movie app has no user photos to show. Every activity would carry the same official poster, and a wall of identical posters is not content.

**The poster does the work at a smaller size, and the score does the rest.** A compact title card inside the item is enough to identify the film; the score badge gives each row a distinct thing to look at, which is what the photo strip was actually providing. User photos — a shot of the group on movie night — are a plausible later addition and are out of scope for this pass.

### Anatomy

```
┌─────────────────────────────────────────────────┐
  (S)  Suraj ranked Inception with Anna
       ┌──┐
       │▓▓│  Inception (2010)                 ⬤ 8.7
       └──┘  148m · Sci-fi
       "Third time and it still holds up."
       ♡ 3    ↗    + Watchlist            13h ago
─────────────────────────────────────────────────
```

- **Avatar** `sm`, then the sentence. Actor name and title are Inter 600 inside a `body` sentence, which is Beli's bolded-entity treatment and makes the row scannable without a separate header line.
- **Tagged people render inline in the sentence** — "Suraj ranked *Inception* **with** Anna and Beth". This is Beli's pattern and it is the right home for Bingd's watch tagging: tagging reads as part of the story rather than as a metadata field.
- **The compact title card** — `poster.xs`, title and year, `148m · Sci-fi` — is a button to the title page.
- **The score badge** at `sm`, right-aligned against the title card. It replaces v1's rank badge.
- **The note**, if any, in `body`. Two lines then "more". The row renders one when given one; the feed does not yet pass one, because a note lives in `user_media` behind its author's RLS and nothing copies it into `feed_events.payload`. Publishing a user's own words to their followers' feeds is a moderation decision (`20260813000600` kept reactions text-free for exactly that reason), not something to slip in with a layout change.
- **The reaction row**: reactions, share, and **add to watchlist**. Beli surfaces "19 bookmarks" as social proof, and the Bingd equivalent — how many people added a title to their watchlist from this activity — is also the product's core virality metric (PRD §28), so it earns its place. Timestamp right-aligned on the same line.

**No comment affordance.** Comments are deferred (PRD §14) and a disabled comment icon would be worse than none.

### The actor must be named

An activity item whose subject is "Someone" is not an activity item. The interface must not absorb a missing actor behind a plausible-looking fallback, which is exactly what happened: every item read "Someone ranked a title." and looked enough like a deliberate anonymity feature to survive to a screenshot.

The cause was not the `profiles_read` policy, which admits your own row and every row you follow. `use-feed.ts` read the embedded profile as `row.profiles[0]`. PostgREST returns a to-one embed as an object and a to-many as an array, and its generated types claim array for both, so the index silently produced `undefined` and every fallback in the mapper fired at once — including on the user's own activity, where an unnamed actor is impossible by construction. `use-collection.ts` had already hit this and normalised with a small `media()` helper; the feed had not.

Where an actor genuinely cannot be resolved, the item is **omitted**. A feed with three items is honest; a feed with five items, two of them about nobody, is not.

Empty feed for a user following nobody: an invitation to find friends, not a spinner and not a blank page.

**As built — 2026-09-07.** The quiet feed — *"Your feed is quiet right now. Rank a title, or follow someone, and activity will appear here."* — carries one action, **Find people**, into For You opened on People (`PEOPLE_DISCOVERY`). The copy had said "follow someone" for weeks while nothing on the screen led to anybody: People lives behind For You's category selector, which a stranger on an empty Feed had no reason to open. It is the same destination onboarding's summary offers, by the same parameter. It is not an Everyone feed, not a contacts import, and not a banner — the branch is gone the moment there is activity to show.

### The row as it stands — 2026-08-20

The anatomy above is the 2026-08-15 decision and is kept for its reasoning. Three device passes have moved the composition since, and this is where it landed:

```
┌─────────────────────────────────────────────────┐
  ┌──┐
  │▓▓│  Suraj ranked Inception (2010) with Anna   ⬤ 8.7
  │ (S)  148m · Sci-fi
  └──┘
        "Third time and it still holds up."
        ♡ 3   💬 2   🔖   ✈                  13h ago
─────────────────────────────────────────────────
```

- **One band, not three.** The avatar header line and the separate title card are gone; the sentence, the artwork and the score share a row, with the note and the actions hanging off it. That is what closed the density gap against Beli — three items filled a phone, and the difference was never type size.
- **One sentence.** Actor, verb, title, year, companions and any tail are a single wrapping text node. Actor and title are semibold and both are pressable; the year is muted and joined to the title by a non-breaking space, so a wrap cannot strand it.
- **One leading object.** The poster is the anchor and the actor's face is a small ringed chip in its bottom-right corner, contained inside the artwork rather than overhanging it. Two separate leading visuals is Bingd's problem and not Beli's — Beli has one photograph per item where Bingd has a poster *and* a face — and setting them side by side made the row read as busy.
- **One left text edge.** The sentence, the metadata, the note, the reaction cluster and the action icons all start at the poster's right edge. The metadata used to start 32pt left of the sentence it describes, because the avatar was standing in front of that sentence; nothing is offset by hand now.
- **Actions are icons**, labelled for screen readers and named after the title they act on. Comments shipped since — the icon appears only where a surface has wired the sheet up, and it carries a count and never a preview, since a preview is the mask that gets forgotten.

---

## 8. Recommendations — reworked 2026-08-15

Opens directly to a slate, never to a "generate" button — the slate is built on a schedule ([`recommendations.md`](../architecture/recommendations.md)).

### Shelves, not a single list

Max's home screen and Apple TV's ([`references/apple-tv-5-shelves.jpg`](./references/apple-tv-5-shelves.jpg)) are both stacks of titled horizontal shelves, and that structure fits recommendations better than a vertical list of cards for one reason: **the shelf title is where the explanation goes.** PRD §13 requires every recommendation to carry a reason derived from stored signals, and a reason that covers six titles at once — "Because you loved Inception" — costs one line instead of six.

Each shelf: a section header carrying the reason, then `poster.md` artwork with the last card clipped ([`design-system.md`](./design-system.md) §8). Tapping a poster opens the title page; the actions — add to watchlist, log it, dismiss with a reason — live there rather than on the tile, because a poster wall with three buttons per tile is not a poster wall.

Shelf titles are rendered from stored evidence and never composed on the client (AD-8). A shelf that cannot state its reason does not ship.

**One shelf gets the detailed treatment**: the top slate keeps v1's card form — `poster.lg`, title, and the full sentence, "Because you ranked *Sinners* #2 and Jordan ranked this #1" — because the first recommendation should show its work. The shelves beneath it are for browsing.

Before the threshold is reached, the tab shows what is missing and the fastest way to get there, which is the one place the milestone tracker from §5 belongs.

**As built — 2026-09-07: what a long press says, and what a thin wall admits.**

- **A long press on a poster gives the reason and nothing else.** `headlineFor` derives one sentence from whichever term carried the score — *"Because you loved Heat"*, *"More drama, which you rank highly"*, *"Popular right now"* — and that sentence is the whole of what a store build shows. It used to append `score 0.412`, the anchor contributions, the genre and language affinities and the popularity prior: the engine's working, in `rank.ts` vocabulary, on a production long press. The working survives under `__DEV__` only — a dev client attached to Metro — and on no built binary, the community beta included (founder decision, 2026-09-07). It is deliberately narrower than the Diagnostics sheet's own gate.
- **A thin-taste wall says so, and only a genuinely popular one says "popular".** When the slate resolved no anchor (`lowData`) — a reader who has ranked two films, or ranked nothing they loved — one line in the footnote register sits above the artwork. Which line depends on what is actually on the wall (Codex review of #122, same day): the pool also takes `social_candidates`, the titles people the reader follows put in their top band, so "no anchor" is not "popularity-only". `popularityOnly` is derived in the hook's `select` from the drawn items — no anchor *and* no social id on the wall — and only then does the line read *"Popular right now while bingd. learns your taste."* A thin taste with a followed reader's title on the wall reads *"bingd. is still learning your taste."*, which claims nothing about where the titles came from. Both are gone the moment an anchor resolves. Nothing about the slate, its weights, its sources or its exposure window moved; this is a label on a wall that was already being drawn.

---

## 9. Profile, match, leaderboard

**Profile** is the public artifact: avatar, name, username, one stats block (PRD §5 permits exactly one), the top of the ranking, and lists. Viewing someone else's profile shows the match score with its evidence count — `88% match · 126 shared` — and the shared-titles view is the interesting screen, because agreement is more legible as a list of specific films than as a number.

**Top ranked is a poster wall, not rows** (2026-08-15). Three across, artwork only, each with its score chipped onto the corner ([`design-system.md`](./design-system.md) §8). Rows were the wrong form here: this is the one block on the profile that exists to be looked at rather than worked through, and three compact rows carrying runtime and genre give a visitor metadata they did not ask for while making the films themselves small. The wall is low-detail on purpose and every tile is a button.

**The avatar is uploadable.** It was not, and a profile with a permanent set of initials where a photo belongs undercuts the whole surface — this is the screen the product asks people to share. `profiles.avatar_url` had existed since the first identity migration and no code path could write it.

The control lives in **Settings**, not on the profile, because the profile is what other people see and changing your picture is an edit. Settings is also the only place it can live: `set_avatar` refuses a caller with no profile row, which keeps an avatar from existing during onboarding — where a storage object referencing `auth.users` would block the age gate's account deletion ([`20260813002200`](../../supabase/migrations/20260813002200_signup.sql) warned about exactly this).

The picker crops square at the source, since every surface renders the avatar in a circle, and the client downscales to 512px before upload. Each upload writes a **new filename** and deletes the previous one — overwriting at a stable path leaves the CDN and every already-rendered image serving the old face, which reads as the upload having silently failed.

**The stats block counts what it says.** `Watchlist` read `top.length`, the length of the top-six ranked slice, so an account with six rankings and an empty watchlist reported six.

**Recent activity uses the feed item from §7**, including its rule that an item with no resolvable actor is omitted rather than rendered as "Someone". On one's own profile every actor is oneself, so an unnamed item here is unambiguously a bug — and it was one, on every row, until 2026-08-15.

It is also **filtered to the profile's owner**. The underlying query spans everyone the user follows, and a friend's ranking under a heading on your own profile is a different claim from the one the heading makes.

Low-confidence matches are visually downweighted per PRD §13. A `94% match · 8 shared` must not look more impressive than `88% match · 126 shared`, which is exactly what a bare percentage would do.

**Leaderboard** ([`references/beli-405-leaderboard.jpg`](./references/beli-405-leaderboard.jpg)) ranks friends by activity within a scope. It is a social surface and it needs a deliberate tone: the Curious Collector voice, not a competitive one. Blocked users never appear, which follows automatically from `can_view_profile` (AD-5).

---

## 10. Lists

Create, title, describe, set visibility, add titles, reorder. A list detail page is a poster grid with a header.

Two behaviors carry product weight:

**Imported lists never count toward the limit** ([`api.md`](../architecture/api.md) §4). A user importing twelve Letterboxd lists keeps all twelve and can still create three of their own. The interface should not present the imported ones as an overage.

**Over the limit, nothing is lost.** Existing lists stay fully readable and editable; only creation is refused, with an explanation. This is the universal over-limit rule (PRD §20) and this is the screen where a user would first meet it.

---

## 11. Search — reworked 2026-08-15

One field, results as compact rows (§5), each with a log action. Fast enough that it feels like filtering rather than querying.

The **+** tab opens here with the field focused. A separate people-search lives in Profile and in the invite flow.

### The idle state is not empty

An autofocused field over a blank screen is the most common state of this tab and v1 gave it a single line of prompt copy. **Recent searches** fill it instead: a section header, the last several queries as tappable rows, and a way to clear them. This is Spotify's library pattern and it is worth having because film search is genuinely repetitive — people look for the same title across several sessions before they watch it.

**The prompt for somebody with no history, as built (2026-09-07):** *"What did you watch?"* over *"Search for a film or show you have watched, then tap + to rank it. Shows are ranked by season."* It read *"Search for a title, open it, then log it with +."* until the pre-GTM audit — two taps the row no longer asks for, since + acts from the result: a film goes straight to its bucket, a show asks which season first (`SeasonPicker`).

### Filters

A row of filter pills beneath the field: **All · Movies · TV**. The underlying RPC already restricts results to films and series, so this is a client-side narrowing of what came back and costs nothing.

Deeper filters — year, decade, genre — are **Open** (§17). They need a server change and there is no evidence yet that a catalogue this size needs them.

### Matching must survive punctuation

"Spiderman" returning nothing while "Spider-Man" exists in the catalogue is the kind of failure that makes a user conclude the app has a small library. Titles are full of punctuation the user will not type: hyphens, colons, ampersands, apostrophes. Search must match across it in both directions — typing the punctuation when the title has none, and omitting it when the title has some.

This is a server concern and the fix is in [`../architecture/api.md`](../architecture/api.md); the design requirement is only that **no result set is empty because of a character the user cannot be expected to guess.**

### An empty screen has several meanings

Search answers from two places — the local catalogue, then TMDB when the local answer was thin — and a blank list can mean five different things. Each gets its own copy, because the action they call for differs:

| State | What it says | Action |
| --- | --- | --- |
| Still asking TMDB | Looking further afield… | none, it is in progress |
| Both searched, nothing found | Nothing matches that | check the spelling |
| Rate limited | Too many searches | wait |
| TMDB errored | Could not search wider | Try again |
| Filter hid every row | Nothing in this filter | switch to All |

The fourth is the one worth naming. A failed wider lookup used to render as "nothing matches" — the app stating confidently that a film does not exist when what actually happened is that it never managed to ask. A missing provider key looked identical to an empty catalogue, which is how that failure stayed invisible.

Beli's "Import your lists" entry point sits inside its list surface ([`references/beli-66-import-lists.jpg`](./references/beli-66-import-lists.jpg)); Bingd's equivalent belongs in Collection and in onboarding, not in search.

---

## 12. Letterboxd import

Four steps, each of which can be left and resumed.

**Upload.** Plain instructions for exporting from Letterboxd, then a file picker.

**Review.** The counts, stated plainly: how many titles matched, how many did not, how many lists came across. Unmatched titles are listed and resolvable by hand, and skipping them is fine.

**Mapping.** Star ratings map to buckets automatically with no user interface, per the founder's confirmation of INF-1. The mapping is stated once, plainly, and every bucket stays editable afterward. Ratings never produce positions — imported titles arrive **Logged, not Ranked**, which is the safety property the two-table split exists to guarantee ([`data-model.md`](../architecture/data-model.md)).

**Anchors.** A short guided session — roughly ten to fifteen comparisons over titles the user rated most highly — that produces a real ranking spine without asking anyone to rank 800 films. This is the step that turns an import into a usable collection, and it is where an import either succeeds or quietly ends.

Afterward, unranked titles surface as the occasional nudge described in PRD §15, never as a backlog.

---

## 13. Notifications

Beli's settings screen is the best available baseline for scope ([`references/beli-446-notification-settings.jpg`](./references/beli-446-notification-settings.jpg)) — twelve toggles covering follows, saves from your list, likes, comments, contacts joining, featured lists, news, weekly rank reminders, and streaks.

Bingd's v1 set is deliberately smaller, matching PRD §15: someone followed you, someone reacted to your activity, someone tagged you in a watch, someone you invited joined, someone added a title to their watchlist from your activity, and the twice-weekly ranking nudge.

Beli's streak reminders are **not** adopted. Streaks manufacture obligation, and the product's position is a collection you keep, not a habit you maintain.

**Inbox** is a chronological list, grouped by day, with unread state. **Settings** is one toggle per category, matching the per-category preferences in [`data-model.md`](../architecture/data-model.md). Push delivery is flagged off server-side in v1 (AD-10), so the settings screen exists and works from day one against the inbox alone.

---

## 14. Sharing

The **Top 10 share card** is the polished artifact (PRD §16): ten posters, scores, and titles on Parchment, set in DM Serif Display, with the wordmark. Parchment stays the share-card ground even though the app moved to Paper — a shared image has no surrounding interface to sit inside, so the warmth has to come from the card itself, and Parchment is what makes it recognisably Bingd in someone else's feed. Poster-forward, because artwork is what makes a shared image stop someone mid-scroll, and typographic enough that the card is recognizably Bingd rather than a generic grid.

**Two canvases**, designed separately rather than one scaled:

| Format | Layout |
|---|---|
| **Feed card**, 4:5 | Two columns of five. Score and title beside each poster |
| **Story card**, 9:16 | Content confined to the middle 80% vertically, clear of platform chrome. Wordmark at the top of the safe area, ten items below |

The story card matters most, because Stories is where this kind of image actually gets posted. Its trap is vertical safe area: every platform overlays a reply bar and a header, and a tenth title hidden underneath makes the card look broken.

Each must render with ten titles, with fewer than ten, and with **artwork partly or wholly missing** — common after a Letterboxd import reaching obscure titles. Missing posters use the designed placeholder, and an all-text layout covers a top 10 that is mostly unillustrated.

Sharing uses the OS share sheet, so the user picks Instagram Stories or TikTok themselves. Direct-to-Stories buttons are a later addition, and the native declarations that make that addition cheap ship in the first build (PRD §16).

Secondary cards: a single ranking reveal, and a profile match card.

Every share routes through the native share sheet. Link previews are server-rendered, which is the one place artwork appears outside the app and therefore the first place a licensing restriction would bite.

---

## 15. Settings, privacy, blocking

Conventional grouped list. Three parts carry product weight.

**Privacy** is where a profile becomes private. Changing it takes effect immediately, including on already-shared links, because a share token is never authorization (AD-8) — and the screen should say so in one plain line rather than leaving the user to guess whether old links still work.

**Blocked accounts** lists blocks with an unblock action, and states plainly that unblocking does not restore a previous follow ([`api.md`](../architecture/api.md) §3).

**Account deletion** is reachable, not buried, and states what is deleted and what is retained.

---

## 16. Not designed here

Deliberately out of scope for v1, listed so their absence is not read as an oversight: any billing, paywall, price, or "Pro" surface (PRD §20); comment threads (PRD §14); a Midnight dark theme (PRD §5); **episode tracking or ranking** (PRD §10); web app screens beyond the share and invite landing pages.

That last one said "episode-level anything" until the Episodes tab was built, and it was
broader than the decision it pointed at. What PRD §10 rules out is an episode becoming a
*unit*: no episode logging, ranking, rating, watched state, progress or feed activity. It
has never ruled out showing a reader what is inside a season. The Episodes tab is
informational metadata and nothing else, and nothing about it commits the product to
episode tracking arriving later.

---

## 17. Open

Nothing here is blocking. The questions that were — the tab structure in §2 and the comparison card in §4 — were resolved by the founder on 2026-08-13; the score display and base surface were resolved on 2026-08-15.

| # | Question | Working answer |
|---|---|---|
| 1 | Illustration style for empty states and onboarding | Choose a source before the first build |
| 2 | Ranking nudge copy and timing — PRD §15 | Draft alongside notification implementation |
| 3 | Deeper search filters: year, decade, genre — §11 | Not built. Needs a server change, and no evidence yet that a catalogue this size needs them |
| 4 | Sort options on Collection beyond score — §5 | Score descending is the only sort. Recently watched and A–Z are cheap to add once asked for |
| 5 | User photos on feed items — §7 | Out of scope. Revisit if watch tagging shows people want to post movie-night pictures |
