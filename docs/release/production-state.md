# Production state

**What is live right now.** One page, updated at every production release. Last updated
**2026-11-20, 06:20Z**: production client is the OTA from `main` `1c24b5cd`; the database is at
208 migrations, head `20261130000300` (#331); `main` is `ecd03517`. The store table is
unchanged since the public listings of 2026-11-08.

This exists because the release documentation was all *runbooks* — how a cutover was done
on a particular day — and none of it answered "what is production, today". The 2026-09-25
audit found the newest record was `stopping-point-cutover.md`, two days and four migrations
behind. A runbook ages into history the moment it runs; this does not.

`production-acceptance.md` is how production is proved. `safe-update-runbook.md` is how it
is changed. This is what came out the other side. **Old `release/*`, `integration/*` and
`preview/*` branches are history, not production truth.** This page and `main` are.

What is left to do is one list: [`../product/founder-todo.md`](../product/founder-todo.md).

**Labels used on this page and in the living docs that point here.** **Live in production**:
on `main`, published to the production OTA channel and, where it has a switch, switched on.
**Shipped dark**: on `main` and in production, switch off, so no reader sees it. **Staging or
unreleased**: on staging or a Preview build, or merged without a production release. **Proposed**:
a design or a draft PR. A PR's open/draft state on GitHub is not the test: #305 and #301 are
still open drafts, but their heads were integrated into release 1115 (#307) and are on `main`.

> **Where the 2026-11-15 to 2026-11-20 records live.** Each release below was recorded by its
> operator in a manifest, an execution record or a handoff. They were written on the branch
> `ops/preview-1115-records` and imported to `main` on 2026-11-20 (#332), at their original
> paths: [`release-records-index.md`](./release-records-index.md). The branch is kept as
> history. One-off operator scripts and three Preview manifests stayed on it; the index says
> why.

> **Coordination note (2026-11-09, still open):** PR #224 (`docs/release-record-219`) also
> edits this file, recording the 2026-11-03 security OTA. This page supersedes it. If #224 is
> merged first, this file will conflict; resolve in favour of this page and close #224.

---

## The release

| | |
|---|---|
| **Live application source** | `main` `1c24b5cd` (merge of #319, 2026-11-20): #321 *Who I watched with* picker and #319 Collection drag-to-rerank, on top of everything below. `main` is now `ecd03517`. #328, #329 and #331 changed no app code: #328 only the server's grouping rule (its client diff is a rename), #329 the email template, #331 a database job. So the installed client is `1c24b5cd`, and production behaviour is `ecd03517`'s. |
| **Production OTA, 1.1.0** | Published 2026-11-20 from `1c24b5cd` (workflow run `01a1f6ba-87cd-78ec-8fe0-1dafcbddddfc`). Android update `01a1f6bf-421a-7843-b074-8a0ec05cd692`, group `0a3f0fcb-7f8d-438d-901b-a164e53f95bc`, runtime `ec79e181`; iOS update `01a1f6bf-421a-76fa-b92a-19bfb6d8118a`, group `16309eb2-6034-41c2-9ecc-df88f2dc957b`, runtime `8ea562b7`. Rollback: republish the `a3300bf0` pair, Android `e9ea7c27-d921-42b3-8acc-4e11c8a75d8b`, iOS `78bc77db-b45f-42a8-b96c-90ef70bfba2b`, and leave the database as is (the `a3300bf0` client works against it). Source: [`production-2026-11-20-319-321.md`](./production-2026-11-20-319-321.md). |
| **DB migrations** | **208 applied**, head `20261130000300` (#331), equal to `main`'s 208 files. Read 2026-11-20 06:20Z. Earlier the same day: 206 at 02:43Z, 207 (#328) at 03:08Z. #319's three (`20261129000100`, `000200`, `000300`) were applied one at a time on 2026-11-20, every invariant re-checked after each. |
| **pg_cron** | Six jobs, all active, the same on staging: `bingd-import-drain` (10 s), `bingd-import-maintenance` (1 min), `bingd-push-drain` (1 min), `bingd-release-refresh` (:07 hourly), `bingd-release-evaluate` (every 15 min), `bingd-welcome-dispatch` (:41 hourly, #331). Read 2026-11-20. `bingd-proactive-tick` is not scheduled. Diagram: [`../architecture/diagrams.md`](../architecture/diagrams.md) §7 |
| **Edge Functions** | `letterboxd-import` v4 (2026-11-15, `verify_jwt` on), `tmdb-adapter` v16, `push-sender` v6 (both 2026-11-12). Read 2026-11-15 (#307 release comment). |
| **Production OTA, 1.0.1** | Unchanged: from `9d9683a`, published 2026-09-26: Android group `ef499cac` on runtime `da3c7f47`, iOS group `b79070c2` on runtime `61efbf17`. Both updates' ids start `01a0db04`, the name used below |
| **Preview OTA (staging backend)** | Last recorded: `integration/preview-1121` `5e5f55df` (`main` `68095e99` + #322 at `b2dba1a8`), on the `preview` channel: Android group `15c2a381`, runtime `2503ffaa`; iOS group `a8ceecc7`, runtime `ef07f4b8` ([`preview-2026-11-21-wsc.md`](./preview-2026-11-21-wsc.md)). The Preview before it, `219e2953` (#319 + #321), was released. Staging migrations: **209**, head `20261201000100` (#322's, staging only; read 2026-11-20). **Staging only.** |

### Production releases since the last update of this page

Each one is a paired OTA to the 1.1.0 runtimes (`ec79e181` / `8ea562b7`), except #328 and #331,
which were database migrations only. None needed a new binary.

| Date | `main` | What it shipped | Migrations after | OTA groups (Android / iOS) |
|---|---|---|---|---|
| 2026-11-12 | `a228c6a5` (#267, OTA from `ace7c3fa`) | Founder RC #266: TV show and season rankings, IMDb + Letterboxd import entry, Watch History cards, Discover People, My Lists, proactive-notification plumbing (switches off) | 189, head `20261115000100` | `f97b8534` / `4eded7f4` |
| 2026-11-15 | `b92a3764` (#307, OTA from `357bb126`) | Release 1115: Collection one poster per show, Keep/Update Show, Sent to You read state and paging, review cards and Helpful, import UX and IMDb matching, Onboarding 2.0 (the #305 head), community-score eligibility, the H-2 fix; Rec V2 **dark** | 199, head `20261124000100` | `4de6fcdc` / `f247fd5e` |
| 2026-11-15 | `44f25f9c` (#309, OTA from `979e3c21`) | Polish A: copy, labels and dates | 199 | `46fd8420` / `4c6412a8` |
| 2026-11-16 | `fb44d469` (#308) | Post-QA refinements: Edit watch → Note with *Share as a review*, 85% sheets | 199 | `30bf8eef` / `cacbef1e` |
| 2026-11-16 | `9d11a797` (#310 + #311) | Feed grouping: a watchlist session and a backlog half hour are one post. Flags on 08:26Z | 201, head `20261126000100` | `b82a0376` / `0c141d10` |
| 2026-11-17 | `0170506e` (#312 + #313) | Poster rails on grouped posts; title-page backfill grouping, cross-ladder groups; historical consolidation run (115 groups, 587 fewer visible cards) | 203, head `20261128000100` | `80f10846` / `7d2f3828` |
| 2026-11-19 | `a3300bf0` (#320 + #323) | Feed card spacing; labelled Like · Comment on every post, visible "and others" links | 203 | `e9ea7c27` / `78bc77db` |
| 2026-11-20 | `1c24b5cd` (#321 + #319) | *Who I watched with*: searchable picker, a follow-back taggable at once. Collection drag-to-rerank across rating categories; the TV wall dragged directly (dragging a show scored by its seasons' average ranks it as a show); silent ranking updates in the Feed; the TV Reorder control removed | 206, head `20261129000300` | `0a3f0fcb` / `16309eb2` |
| 2026-11-20 | `68095e99` (#328), database only | Feed: two or more first rankings by one person inside one fixed 30-minute window are one post, whatever the watch date. `_ranking_is_historical` and `feed.ranking_backfill_days` removed. No consolidation run under the new rule | 207, head `20261130000200` | no OTA (client stays `1c24b5cd`) |
| 2026-11-20 | `333c1a79` (#329) | Welcome email: the bingd. logo (served from bingd.app) and no photo; the workflow's schedule raised to six attempts an hour. Released by merging, because every Welcome run renders `main` | 207 | no OTA |
| 2026-11-20 | `ecd03517` (#331), database only | Welcome dispatch: the `pg_cron` job `bingd-welcome-dispatch` asks GitHub to run the Welcome workflow hourly at :41. **Inert until the founder stores the production Vault token** `welcome_dispatch_github_token`: until then it returns `unconfigured` and makes no request, and the workflow's own GitHub schedule (six offsets an hour, `welcome-email.yml`) remains the trigger. Stop: `welcome.delivery_enabled` false, or `cron.unschedule('bingd-welcome-dispatch')` | 208, head `20261130000300` | no OTA |

Merged to `main` with no app release needed: #314 (Welcome canary workflow), #315
(security register), #316 (recommendation benchmark, `eval/` only), #324 (Welcome email v2,
merged 2026-11-19) and #329 (logo-only Welcome email, 2026-11-20). The Welcome workflow renders
whatever `emails/welcome/dist/` is on `main`, so merging a template is its release. Whether a
scheduled send has run on the current template is the reliability workstream's check: see
`docs/ops/reliability-2026-11-20.md`.

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

**Store refresh 1.2.0 (#326, #330): built, not public.** iOS build 16 is uploaded to App Store
Connect and the Android `.aab` is built. Submission and the store listing steps are the
founder's. Until a 1.2.0 binary is public, the table above stands, and so do the OTA runtimes.
The Play listing shows the current version, not rollout percentage. `config/live-runtimes.json`
holds the same two runtimes for the OTA gate, and changes with this table. A store refresh is
being prepared separately; until a new binary is public, this table stands.

### OTA and binary roles

- **1.0.1 binaries** (runtimes `61efbf17` / `da3c7f47`) reach the frozen app through OTA
  `01a0db04`. A fresh install of one launches its old embedded bundle, downloads `01a0db04` in
  the background, and runs it after the next reload. That older embedded bundle predates #198,
  so its first foreground return can reload mid-sign-in. **Nothing since 2026-09-26 reaches
  them**, including TV show rankings, Feed grouping and drag-to-rerank. The `presented_in`
  read policy hides a group's members from every client, and an old bundle reads a group as
  one single-title post.
- **1.1.0 binaries** (runtimes `8ea562b7` / `ec79e181`) embed `9d9683a` and receive the
  production OTA above (`1c24b5cd`, 2026-11-20).
- **Launch behaviour, both platforms:** `fallbackToCacheTimeout: 0` and the default
  `checkAutomatically` (on load). The embedded or cached bundle shows immediately, any newer
  update downloads in the background, and it applies at the next safe foreground return
  (outside sign-in and onboarding, #198) or the next cold start. It never applies on the same
  launch. iOS and Android behave the same.
- **A future OTA from `main` targets the 1.1.0 runtimes only.** Reaching 1.0.1 installs as well
  means publishing a second time from a 1.0.1 tree (`release/2026-09-25-prod` is `9d9683a` at
  1.0.1). None is planned.

---

## Feature flags (production)

**Every row was re-read on 2026-11-20** (06:20Z, read-only, production and staging). Earlier
reads are kept in brackets where the value matters to a past decision.

| Flag | Production | Staging |
|---|---|---|
| `ranking.backlog_enabled` | **true** | true |
| `ranking.refine_enabled` | **false**: Refine is shipped dark (unchanged since the 2026-09-26 read) | true |
| `goals.count_watch_events` | true | true |
| `leaderboard.monthly_from_events` | true | true |
| `welcome.delivery_enabled` | **true**. `welcome_emails`: 13 sent, 0 in any other state; the same count as 2026-11-17 ([`welcome-email-diagnosis-2026-11-17.md`](./welcome-email-diagnosis-2026-11-17.md)) | false |
| `release.refresh_enabled` / `release.shadow_enabled` / `release.push_enabled` | true / true / **false**: release awareness runs in shadow, with no push | true / true / false |
| `push.delivery_enabled` | `false`, **but inert**: nothing reads this row, and push delivery runs. #119 would make it a real switch; that is a founder decision | false |
| `proactive.generation_enabled` / `push_enabled` / `resurface_enabled` / `season_enabled` | false / false / false / false: shipped dark, and `bingd-proactive-tick` is not scheduled | the same |
| `recommendations.v2_engine` / `v2_rollout_percent` / `v2_allowlist` | **`"v1"`** / 0 / `[]`: Rec V2 is shipped dark | `"v1"` / 0 / `[]` |
| `score.contributor_min_rankings` | 10 | 10 |
| `feed.watchlist_grouping_enabled` / `feed.ranking_grouping_enabled` | **true** / **true** (30-minute windows) | true / true |
| `feed.ranking_backfill_grouping_enabled` | **true**: the kill switch for grouping first rankings, which kept its name. `feed.ranking_backfill_days` no longer exists (`20261130000200`) | true |

**Security (2026-11-19; unchanged 2026-11-20).** H-2 is fixed in production (`20261124000100`, trigger
`retire_unproven_password`). H-1 is **closed** (2026-11-18): the privileged Actions secrets
live only in the `production` and `nonprod` Environments, restricted to `main`; evidence in
[#317](https://github.com/fourwardhabits/bingd/pull/317) on
[`../security/security-closeout-2026-11-17.md`](../security/security-closeout-2026-11-17.md).
Still open and founder-only: M-5's Sentry dashboard rule (unverified) and m-3's nine historical
log deletions.

Username-or-email sign-in (#300) is **not in production**: its migration slot
`20261123000100` is unused and none of its functions exist (read 2026-11-15).

---

## What is live

- **Ranking.** Ordinal ranking is canonical: position within its pool is the truth, and the
  score is derived. **Three independent pools: Movies, TV shows and TV seasons** (since
  2026-11-12, `20261114000100`–`000400`). A whole show is ranked in its own pool; ranking a
  season offers *Update Show* / *Keep Show* for the parent (`20261120000100`). Unranked
  (backlog) sittings deal seen-but-unranked titles one at a time; a placement left
  mid-comparison resumes. Header **Done** shows a summary of only what the sitting completed;
  *Keep ranking* continues it. Ranking an already-seen title never creates a watch.
  **Ranking updates are silent** (since 2026-11-20, `20261129000300`): an update, a manual
  move, a change of category, a correction or Refine posts nothing new in the Feed; the latest
  watch's existing post takes the new score. Only a first ranking and a rewatch post.
  Mechanics: [`../architecture/ranking.md`](../architecture/ranking.md) §14.
- **Collection.** Movies / TV / Lists. The TV Collection shows **one poster per show**,
  carrying the explicit show score or else the season average (`SN AVG`).
  **Drag-to-rerank** (since 2026-11-20, #319): on Watched, sorted by rating with no filters, a
  long-press lifts a ranked title and a drop moves it anywhere in the same ranking, across
  rating categories too; it takes that place's category and score, with Undo. The TV wall is
  dragged directly: an explicitly ranked show moves among the ranked shows, and dragging a show
  scored by its seasons' average gives it an explicit show ranking at that place. The TV
  Reorder control is gone. A move writes a `manual` placement and never a comparison, watch,
  post or notification ([`../architecture/collection-rerank.md`](../architecture/collection-rerank.md)).
- **Watch history.** Multiple watches per title, undated watches as first-class, Watch History,
  companions (*Who I watched with*: a searchable picker with removable chips, up to ten mutual
  follows, and a follow-back is taggable at once; since 2026-11-20, #321), per-watch notes
  (Edit watch → Note, private unless *Share as a review* is on), and *Recently watched* sorted
  by the latest real watch date.
- **Notes and reviews.** One title-level review (`user_media.note`), shared or private, with a
  spoiler flag; review cards, review sort and **Helpful**.
- **Feed and social.** Follows, ordinary activity, **grouped posts** (a watchlist session, a
  backlog half hour, and first-time rankings made within one half hour whatever the watch date,
  each one post with a poster rail; see the semantics below), labelled Like · Comment on every
  post, comments with author follow-up notifications, reactions, recommendations and **Sent to You** (read state,
  unread first, Movies/TV filter), invites, the leaderboard, goals and Awards.
- **Lists v1.** Native lists of movies, seasons and series, public/private/link, custom order,
  Add to List, share links, public web page.
- **Import.** **Letterboxd** (ZIP/CSV, films and diary dates) and **IMDb** (CSV; movies are
  added; whole TV shows are matched and reported but not added) into the collection, from
  Settings → *Import from* and from onboarding. An imported rating is never a ranking.
- **Onboarding 2.0.** Profile, picks, head-to-head, *Your First Five*, People search and invite,
  notification step, with the OB-1 analytics events
  ([`../product/onboarding-observability.md`](../product/onboarding-observability.md)).
- **Discovery.** Search (the Search tab), title pages, For You (engine V1), Top Rated,
  Trending, Similar, Cast, person pages, Discover People, Taste Match (computed live per pair).
- **Email.** The Welcome email, 48–168 hours after sign-up, for accounts created after
  2026-09-18, with a logo-only header (#329). It is started by the GitHub schedule in
  `welcome-email.yml`. #331's hourly `pg_cron` dispatch joins it once the founder stores its
  Vault token.
- **Web.** bingd.app: install page, public title, profile and list previews, invite links.

### Shipped dark (in production, switched off)

Recommendation Engine V2 (`v2_engine "v1"`, 0%;
[`../architecture/recommendations-v2.md`](../architecture/recommendations-v2.md)), Refine
(flag off), proactive notifications (every switch off, and the tick not scheduled), proactive
release pushes (shadow only). The Welcome dispatch job (#331) is live but inert until its token
is stored.

**Not a switch:** `push.delivery_enabled` is an inert row that no delivery code reads, so push
cannot be turned off through configuration. The switch that would read it is #119, an open,
unapplied PR; whether to apply it is a founder decision.

### Staging or unreleased (not in production)

| What | Where |
|---|---|
| Reactions and comments on follow stories, Workstream C (#322) | Draft PR. **On staging** (migration `20261201000100`, staging at 209) and in Preview `5e5f55df`, awaiting founder device QA. Not in production ([`preview-2026-11-21-wsc.md`](./preview-2026-11-21-wsc.md)) |
| Store refresh 1.2.0 (#326, #330) | iOS build 16 uploaded to App Store Connect; Android `.aab` built. Not submitted for release; the listing steps are the founder's |
| Username-or-email sign-in (#300) | Draft PR; migration not applied anywhere |
| Design System v3 (#295) | Draft PR |
| A push kill switch that stops delivery (#119) | Open PR, unapplied in production. Until it is, `push.delivery_enabled` is inert |

### Intentionally not live

Letterboxd **Lists** import, IMDb whole-show import, TV Time import, predicted score,
unmatched-import repair, Stats/Wrapped, Watch Next (#183/#184, parked), further share cards
and Awards, a share link for grouped posts and Awards, and episode-level tracking (episode
**metadata** is shown; nothing about an episode is logged or ranked).

---

## The semantics the current release fixes in place

### Grouped Unranked ranking (`20261020000100`, `20261023000100`)

A sitting in the Unranked flow posts **one** `ranking_batch` event, not one per title.

- It is written as `ranking_batch_draft` while the sitting runs and **flipped to
  `ranking_batch` only when the sitting ends**: the summary's Done, the queue running out, or
  Close. A post that grew while you ranked would re-sort the feed under the reader.
- The representative title is the **last one placed** (`do update set media_item_id =
  excluded.media_item_id`). A sitting that placed nothing deletes its draft.
- It renders as `<Name> ranked <Title> and N more`, where *N more* opens the sitting's list.
  Since 2026-11-17 a post of two or more titles is drawn as a poster rail (below).
- **A sitting of exactly one title is an ordinary ranking post**, badge included. It
  borrows the live score, because a batch payload carries none. Above one title there is no
  badge: the representative stands in for a set.
- A force-quit leaves an unfinalised draft, which every reader is blind to. So does leaving
  by iOS swipe-back or Android hardware back: that exit is in the TODO register.
- Refine creates no grouped activity.

**Since 2026-11-16/17 a sitting can share its post** (`20261126000100`, `20261128000100`;
design in [`../feed/expanded-grouping.md`](../feed/expanded-grouping.md)):

- Backlog sittings that begin within **30 minutes** of an open group join it, and the group
  keeps its id, place and conversation (`feed.ranking_grouping_enabled`).
- Movies, shows and seasons share one social group (cross-ladder); each title keeps its own
  ladder and score.
- **First-time rankings in one half hour are one post** (#328, `20261130000200`, founder rule
  of 2026-11-20, live since that day). Two or more eligible first rankings by one person inside
  one fixed 30-minute window are one grouped post, whatever watch date was chosen. That covers
  every surface but Unranked, and an Unranked sitting in the same half hour joins it. A
  rewatch, a review, an update and anything already reacted to, commented on or notified stay
  standalone. Until 2026-11-20 a title-page ranking grouped only when its watch was
  historical, so one logged with the default *Today* stayed standalone. Earlier posts were not
  consolidated under the new rule.
- A grouped post draws its members as a poster rail with the author's scores, and keeps one
  Like and one Comment; Save and Share are not drawn on it.
- Members are hidden by `feed_events.presented_in` under the read policy, never deleted.
  The one-time historical consolidation of 2026-11-17 grouped 702 earlier posts into 115
  groups and is reversible per batch (`revert_feed_consolidation`).
- A watchlist session (saves within 30 minutes) is likewise one `watchlist_added` post
  (`20261125000100`).

**It creates no watch.** No `watch_event`, no watch date set to today, no imported
Letterboxd date replaced, no change to the latest-watch date, and nothing counted for the
monthly leaderboard.

### Collection moves and silent updates (`20261129000100`–`000300`, 2026-11-20)

- `rank_reorder` is granted back to `authenticated`, because every move now writes one `manual`
  placement. It refuses a move computed from a stale list (`55000`) and a position that is
  not a place in the named category (`22023`).
- A move across a category line changes `rankings.bucket` and `user_media.bucket` together,
  and takes the score of its new place. `rankings.created_at` is kept, so a move is not heard
  as a ranking.
- On the TV wall, `rank_promote_show` turns a season-average show into an explicit show
  ranking at the dropped place; `rank_unpromote_show` is its Undo. Its seasons' rankings are
  not read or written, and a show still on the watchlist stays there.
- A TV correction that moved its title used to post a `title_ranked` marked `update: true`.
  It now posts nothing, like a film's. Earlier `update: true` posts are left as they are.

### Review visibility and the remembered default

The review is always `user_media.note` with `note_visibility` and `note_has_spoilers`,
written by Log/Rank, Another watch and Title → Write a review. `watch_events.note` is the
**per-watch** note, owner-only by schema (`20261014000100`).

- **Watch History → Edit watch → Note** (since 2026-11-16, #308) writes the watch's own note
  (`set_watch_details`). *Contains spoilers* and *Share as a review* sit in that editor, both
  off when it opens. With Share on, Save then publishes a copy as the title's review
  (`save_note`), asking first before replacing a different stored review. The two notes are
  never linked afterwards.
- A reader's **first-ever** new review opens **private** (founder, 2026-11-04; live since the
  2026-11-07 OTA). An earlier version of this page said it opened shared.
- Only an explicit tap on *Share as a review* is remembered as the default for the next
  **new** note (`note-visibility-pref`: per account, **stored on the device**, not synced).
  Saving or ranking never changes it.
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

Preview never accumulates its own history that later has to be reconciled. Its last recorded
candidate (2026-11-21, `5e5f55df`) is `main` `68095e99` plus #322 only. The one before it
(2026-11-20b, `219e2953`, #319 and #321) was released to production on 2026-11-20. Staging QA accounts and the states they cover are
in [`staging-qa-inventory.md`](./staging-qa-inventory.md).

---

## Updating this page

At every production release, change: the release table and store table, any semantics the
release moved, and the flag table. If a release changes none of those, it does not need an
entry. This is a statement of the current state, not a changelog.
