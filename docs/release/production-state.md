# Production state

**What is live right now.** One page, updated at every production release. Last updated
**2026-11-09** (OTA from 2026-11-07 recorded; store table from public listings 2026-11-08).

This exists because the release documentation was all *runbooks* — how a cutover was done
on a particular day — and none of it answered "what is production, today". The 2026-09-25
audit found the newest record was `stopping-point-cutover.md`, two days and four migrations
behind. A runbook ages into history the moment it runs; this does not.

`production-acceptance.md` is how production is proved. `safe-update-runbook.md` is how it
is changed. This is what came out the other side. **Old `release/*`, `integration/*` and
`preview/*` branches are history, not production truth.** This page and `main` are.

What is left to do is one list: [`../product/founder-todo.md`](../product/founder-todo.md),
which also holds the freeze rule.

> **Coordination note (2026-11-09):** PR #224 (`docs/release-record-219`) also edits this
> file, recording the 2026-11-03 security OTA. This update supersedes it by going further:
> it records all OTAs through 2026-11-07. If #224 is merged first, this file will conflict;
> rebase this branch on the merged result or let this branch merge first and close #224.

---

## The release

| | |
|---|---|
| **Live application source** | `main` `3757656` (merge of #238, 2026-11-07). Includes PR #237 (compact TV episode rail, episode detail sheet, season metadata order, personal scores in For You → Top Rated) and PR #238 (trailer-privacy inventory language). |
| **DB migrations** | **177 applied**, head `20261024000500`; staging identical |
| **Production OTA, 1.1.0** | Android update `01a1b812-7bdb-7cc6-a4eb-a4dbe8f29a01`, group `d5e7f3f3-368d-41a1-8db1-24ed60bf211f`, runtime `ec79e181`; iOS update `01a1b812-7bdb-7a29-98f0-351ad279ef8b`, group `5a561da1-6ea1-477d-b741-17f2643fd8a8`, runtime `8ea562b7`. Published 2026-11-07 from source commit `f0f6d26`, EAS workflow run. |
| **Production OTA, 1.0.1** | from `9d9683a`, published 2026-09-26: Android group `ef499cac` on runtime `da3c7f47`, iOS group `b79070c2` on runtime `61efbf17`. Both updates' ids start `01a0db04`, the name used below |
| **Preview OTA** | Android group `2c4aca0c` on runtime `2503ffaa`, staging backend. No iOS binary on the current preview runtime. |

### Store distribution

| | Public today | Previous, still installed on some phones |
|---|---|---|
| **iOS** (App Store, `app.bingd`) | **1.1.0 (15)**, released 2026-09-26, EAS build `e38d94d9`, runtime `8ea562b7` | **1.0.1 (12)**, built from `89a1d8c`, runtime `61efbf17`, receives OTA `01a0db04` |
| **Android** (Google Play, `app.bingd`) | **1.1.0 (vc15)**, EAS build `4d71b121`, runtime `ec79e181`; uploaded by hand (no Play service account exists) | **1.0.1 (vc12)**, built from `6d2f845`, runtime `da3c7f47`, receives OTA `01a0db04` |

Both 1.1.0 binaries are built from release commit `63694c3` = `9d9683a` + the marketing version
(#212). The resolved config differs from `9d9683a` in `version` alone, measured on both lanes.
They **embed** the frozen app, including the fresh-install reload guard (#198), which no OTA can
deliver to a first launch.

Read from the public App Store lookup and Play listing on 2026-11-08. Both show 1.1.0 (15).
The Play listing shows the current version, not rollout percentage. `config/live-runtimes.json`
holds the same two runtimes for the OTA gate, and changes with this table.

### OTA and binary roles

- **1.0.1 binaries** (runtimes `61efbf17` / `da3c7f47`) reach the frozen app through OTA
  `01a0db04`. A fresh install of one launches its old embedded bundle, downloads `01a0db04` in
  the background, and runs it after the next reload. That older embedded bundle predates #198,
  so its first foreground return can reload mid-sign-in.
- **1.1.0 binaries** (runtimes `8ea562b7` / `ec79e181`) embed `9d9683a` and now receive the
  1.1.0 OTA above (source `f0f6d26`, published 2026-11-07), which delivers the cinematic episode
  rail (PR #237) and trailer-privacy inventory language (PR #238).
- **Launch behaviour, both platforms:** `fallbackToCacheTimeout: 0` and the default
  `checkAutomatically` (on load). The embedded or cached bundle shows immediately, any newer
  update downloads in the background, and it applies at the next safe foreground return
  (outside sign-in and onboarding, #198) or the next cold start. It never applies on the same
  launch. iOS and Android behave the same.
- **A future OTA from `main` targets the 1.1.0 runtimes only.** Reaching 1.0.1 installs as well
  means publishing a second time from a 1.0.1 tree (`release/2026-09-25-prod` is `9d9683a` at
  1.0.1). While the freeze holds, no OTA is planned.

---

## Feature flags (production, read 2026-09-26)

| Flag | Production | Staging |
|---|---|---|
| `ranking.backlog_enabled` | **true** | true |
| `ranking.refine_enabled` | **false**, a founder decision still open | true |
| `goals.count_watch_events` | true | true |
| `leaderboard.monthly_from_events` | true | true |
| `welcome.delivery_enabled` | true | false |
| `release.shadow_enabled` / `release.push_enabled` | true / **false** | true / false |
| `push.delivery_enabled` | `false`, **but inert**: nothing reads this row, and push delivery runs. #119 would make it a real switch; that is a founder decision | false |

---

## What is live

- **Ranking.** Ordinal ranking is canonical: position within Movies or TV is the truth, and
  the score is derived. Unranked (backlog) sittings deal seen-but-unranked titles one at a
  time; a placement left mid-comparison resumes. Header **Done** shows a summary of only what
  the sitting completed; *Keep ranking* continues it. Ranking an already-seen title never
  creates a watch.
- **Watch history.** Multiple watches per title, undated watches as first-class, Watch History,
  companions, and *Recently watched* sorted by the latest real watch date.
- **Notes and reviews.** One title-level note (`user_media.note`), shared or private, with a
  spoiler flag.
- **Feed and social.** Follows, ordinary activity, one grouped post per Unranked sitting,
  comments with author follow-up notifications, reactions, recommendations, invites, the
  leaderboard, goals and Awards.
- **Lists v1.** Native lists of movies, seasons and series, public/private, custom order,
  Add to List, share links.
- **Import.** Letterboxd CSV import into the collection.
- **Discovery.** Search, title pages, For You, Top Rated, Trending, Similar, Cast.
- **Web.** bingd.app: install page, public title and profile previews, invite links.

### Intentionally not live

Refine (built, flag off), Letterboxd **Lists** import, predicted score, unmatched-import
repair, Stats/Wrapped, Watch Next (#183/#184, parked), further share cards and Awards,
episode-level tracking, whole-series ranking, and proactive release pushes (shadow only).

---

## The semantics the current release fixes in place

### Grouped Unranked ranking (`20261020000100`, `20261023000100`)

A sitting in the Unranked flow posts **one** `ranking_batch` event, not one per title.

- It is written as `ranking_batch_draft` while the sitting runs and **flipped to
  `ranking_batch` only when the sitting ends**: the summary's Done, the queue running out, or
  Close. A post that grew while you ranked would re-sort the feed under the reader.
- The representative title is the **last one placed** (`do update set media_item_id =
  excluded.media_item_id`). A sitting that placed nothing deletes its draft.
- It renders through the ordinary `ActivityRow`: poster, actor avatar over it, and
  `<Name> ranked <Title> and N more`, where *N more* opens the sitting's list.
- **A sitting of exactly one title is an ordinary ranking post**, badge included. It
  borrows the live score, because a batch payload carries none. Above one title there is no
  badge: the representative stands in for a set.
- A force-quit leaves an unfinalised draft, which every reader is blind to. So does leaving
  by iOS swipe-back or Android hardware back: that exit is in the TODO register.
- Refine creates no grouped activity. There is no historical backfill: sittings before
  `20261020000100` stay as the individual posts they were.

**It creates no watch.** No `watch_event`, no watch date set to today, no imported
Letterboxd date replaced, no change to the latest-watch date, and nothing counted for the
monthly leaderboard.

### Review visibility and the remembered default

One model on all three surfaces: Log/Rank, Another watch, and Watch History → edit. The
object is always `user_media.note` with `note_visibility` and `note_has_spoilers`.
`watch_events.note` is a private diary line, owner-only by schema (`20261014000100`), and
the composer does not write it.

- A reader's **first-ever** new note opens with *Share as a review* **on**.
- After they save a new note with an explicit choice, that choice is the default for the next
  **new** note (`note-visibility-pref`: per account, **stored on the device**, not synced).
- **A note that already exists always opens on its stored visibility and spoiler flag.** No
  default and no habit may move it.
- Title → **Write a review** opens shared whatever the habit is. That is an act, not a
  default.

### Review count

`title_review_count` and `title_reviews_v2` share one predicate (`note is not null and
note_visibility = 'public'` under `can_view_profile`), so the tab's number and its rows answer
the same question. Both are invalidated together in `invalidateAfterCollectionChange`:
public → private decrements immediately, and private → public increments.

### Recently watched

The Collection's `watched` sort axis orders by the **latest real watch date**, with unknown
dates sunk in both directions. It applies on Watched and Unranked; the Watchlist keeps
*Recently added*. Ranking never moves a title in it.

### Watch metadata on a title page (§J.2, founder-locked)

| | |
|---|---|
| 1 watch, dated | `#2 in Movies · Watched Aug 17, 2026 ›` |
| 1 watch, **undated** | `#2 in Movies ›`, **no watch line by design** |
| 2+ watches | `#2 in Movies · Watched 2 times ›` |

Never `Watched 1 time`. A title ranked without a dated watch shows no date, and none is
inferred: a ranking is not a viewing. A title with a single watch offers *Remove from
collection*, which unranks and unlogs it.

---

## The two lanes

**Production** is `main` against the production Supabase project (`abheeqyjzekiowkztfxv`).

**Preview** is the *same* application against the **staging** backend (`fjxhcbowoxuzulwirzyr`),
installed beside the shipped app. `config/backends.cjs` refuses any other backend for the
preview lane. **Preview never points at production data.**

**Preview is not a long-lived product branch.** A preview candidate is always:

1. current `origin/main`, the production application,
2. the preview/staging environment,
3. the staging backend and data,
4. only the explicitly unreleased fix being tested.

Preview never accumulates its own history that later has to be reconciled. Today it carries
nothing unreleased: `01a0db08` is `9d9683a`. Staging QA accounts and the states they cover are
in [`staging-qa-inventory.md`](./staging-qa-inventory.md).

---

## Updating this page

At every production release, change: the release table and store table, any semantics the
release moved, and the flag table. If a release changes none of those, it does not need an
entry. This is a statement of the current state, not a changelog.
