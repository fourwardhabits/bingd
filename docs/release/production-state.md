# Production state

**What is live right now.** One page, updated at every production release. Last updated
**2026-11-09** (production OTA of 2026-11-09 from merge `19362af` recorded; store table from
public listings 2026-11-08).

This exists because the release documentation was all *runbooks* — how a cutover was done
on a particular day — and none of it answered "what is production, today". The 2026-09-25
audit found the newest record was `stopping-point-cutover.md`, two days and four migrations
behind. A runbook ages into history the moment it runs; this does not.

`production-acceptance.md` is how production is proved. `safe-update-runbook.md` is how it
is changed. This is what came out the other side. **Old `release/*`, `integration/*` and
`preview/*` branches are history, not production truth.** This page and `main` are.

What is left to do is one list: [`../product/founder-todo.md`](../product/founder-todo.md),
which also holds the freeze rule.

> **Coordination note (2026-11-09):** PR #224 (`docs/release-record-219`, still open) also
> edits this file, recording the 2026-11-03 security OTA. This page already records every
> production OTA through 2026-11-09, so #224 is superseded; closing it is the founder's call.

---

## The release

| | |
|---|---|
| **Live application source** | `main` `19362af9c4f94bda68f870b39e39c56e4f243def` (merge of #239, 2026-11-09T16:21:13Z). Adds automatic trailer stills on Cinematic title pages to everything in `3757656` (merge of #238, 2026-11-07: PR #237 compact TV episode rail, episode detail sheet, season metadata order, personal scores in For You → Top Rated; PR #238 trailer-privacy inventory language). |
| **DB migrations** | **177 applied**, head `20261024000500`; staging identical |
| **Production OTA, 1.1.0 (live)** | Android update `01a1c1cb-991e-781a-b32e-dd26b3a3f368`, group `84b59979-aa7a-467e-8ca0-d1e2a780824c`, runtime `ec79e1818e57bb6ea8f21e1296286bca881f8aef`; iOS update `01a1c1cb-991e-7577-bd7f-daf6d90f6b7c`, group `5b0883b1-8070-4741-9fae-1ecb0d5fc87a`, runtime `8ea562b7f252462cc2b3f44d0c45d817a18eeddb`. Branch `production`, commit `19362af`, created 2026-11-09T19:31:48.126Z. Published by `ota-production.yml`; evidence below. |
| **Production OTA, 1.1.0 (previous, rollback target)** | Android update `01a1b812-7bdb-7cc6-a4eb-a4dbe8f29a01`, group `d5e7f3f3-368d-41a1-8db1-24ed60bf211f`, runtime `ec79e181`; iOS update `01a1b812-7bdb-7a29-98f0-351ad279ef8b`, group `5a561da1-6ea1-477d-b741-17f2643fd8a8`, runtime `8ea562b7`. Published 2026-11-07 from source commit `f0f6d26`, EAS workflow run. Trailer stills only after Show previews. |
| **Production OTA, 1.0.1** | from `9d9683a`, published 2026-09-26: Android group `ef499cac` on runtime `da3c7f47`, iOS group `b79070c2` on runtime `61efbf17`. Both updates' ids start `01a0db04`, the name used below |
| **Preview OTA** | Android group `2c4aca0c` on runtime `2503ffaa`, staging backend. No iOS binary on the current preview runtime. |

### The 2026-11-09 release (PR #239)

Founder-authorized for this release only. Published from the release operator's machine with
the project's Expo token, not by the agent that wrote this record.

| Check | Result |
|---|---|
| Release gate (GitHub) | run `42669504320`, `workflow_dispatch` on `19362af`, success |
| CI on `main` (GitHub) | run `42653895360`, `push` on `19362af`, success |
| `ota-production-check.yml` (EAS) | run `01a1c1c4-2d5c-79ea-a3a9-71d27f46c9c7`, success; fingerprints Android `ec79e1818e57bb6ea8f21e1296286bca881f8aef`, iOS `8ea562b7f252462cc2b3f44d0c45d817a18eeddb`, equal to `config/live-runtimes.json` |
| `ota-production.yml` (EAS) | run `01a1c1c6-fb68-7a51-a69e-041b38dbab2e`, started 2026-11-09T19:26:45Z; preflight, fingerprint, runtimes and publish all success |
| `eas update:view` | both groups above on branch `production`, commit `19362af9c4f94bda68f870b39e39c56e4f243def`, the runtimes above |

The GitHub runs were re-read when this record was written. The EAS rows are as reported by the
release operator from `eas update:view`; no EAS session was available to re-read them. The
release changed JavaScript and comments only: no migration, no native or config change, and
`config/live-runtimes.json` is unchanged because no binary moved.

**What it changed for readers.** On a Cinematic title page, trailer stills now load from
YouTube's image host (`i.ytimg.com`) with the page; before, production waited for Show
previews. The Original layout never mounts the trailer rail and sends no YouTube request.

### Open privacy follow-up (F-6)

**Not a compliance determination.** Whether the device IP address carried by third-party image
requests (`i.ytimg.com` for trailer stills, and in parallel `image.tmdb.org` for posters, which
were already automatic) means declaring **Location → Approximate location** as Collected and
Shared on Google Play Data safety is **unresolved**. On 2026-11-09 at 9:17 AM MST the founder
decided to ship automatic stills under the **existing** Play declaration, with that question
kept open as a privacy follow-up. No Apple or Google declaration and no privacy policy text
changed with this release; the live policy already describes the YouTube image requests.
Evidence and the exact question to put to Google Play developer support:
[`pr239-thumbnail-privacy-review.md`](./pr239-thumbnail-privacy-review.md) and
[`privacy-decision-matrix.md`](./privacy-decision-matrix.md) F-6.

### Rolling back this release

A rollback is a production change and needs its own founder authorization.
[`safe-update-runbook.md`](./safe-update-runbook.md) §4 governs.

- **Back to the 2026-11-07 update** (stills behind Show previews again). Republish each
  platform's previous group:

  ```
  npx eas update:republish --group d5e7f3f3-368d-41a1-8db1-24ed60bf211f --message "rollback to 2026-11-07 (f0f6d26)"
  npx eas update:republish --group 5a561da1-6ea1-477d-b741-17f2643fd8a8 --message "rollback to 2026-11-07 (f0f6d26)"
  ```

- **Back to the bundle embedded in the 1.1.0 binaries** (`9d9683a`), when no published update
  is trusted:

  ```
  npx eas update:roll-back-to-embedded --branch production --message "back to the shipped bundle"
  ```

- **Code route.** Restore `trailerPreviewsByDefault` in `src/features/title/trailer-previews.ts`
  to `(): boolean => lane !== 'production'`, merge, and publish that commit with
  `ota-production.yml`.

Each lands on the next foreground check or cold start, as below. Record whichever runs here.

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
  1.1.0 OTA above (source `19362af`, published 2026-11-09), which delivers the cinematic episode
  rail (PR #237), trailer-privacy inventory language (PR #238) and automatic trailer stills
  (PR #239).
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
- **Trailers.** Cinematic title pages load trailer stills from YouTube's image host with the
  page (since 2026-11-09). The Original layout shows trailers as text rows and requests no
  stills.
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
