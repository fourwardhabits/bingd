# Architecture diagrams

**As of 2026-11-20.** Production client `1c24b5cd` (OTA), production database at 208
migrations (head `20261130000300`), `main` `ecd03517`. Source-controlled Mermaid; GitHub
renders each block.

**Rule for these diagrams: only components that exist are drawn.** Each one was checked
against the code on `main`, the workflow files, and a read-only `cron.job` query on
production and staging (2026-11-20). Something shipped dark is drawn dashed and labelled
*dark*. Something on staging only is labelled *staging only*. A design that was never built,
such as `recs-builder`, `import-worker`, `notify-dispatch`, the SQLite mirror and the outbox,
is not drawn. [`README.md`](./README.md) § System shape records where the v1 design differs.

What is live: [`../release/production-state.md`](../release/production-state.md).
Background job operations: see `docs/ops/background-jobs.md` (being added by the reliability
workstream) and `docs/ops/reliability-2026-11-20.md`.

| # | Diagram | Detail lives in |
|---|---|---|
| 1 | [System context](#1-system-context) | [`README.md`](./README.md), [`web-deployment.md`](./web-deployment.md) |
| 2 | [App architecture](#2-app-architecture) | [`client.md`](./client.md), [`api.md`](./api.md) |
| 3 | [Database](#3-database) | [`data-model.md`](./data-model.md) |
| 4 | [Ranking flow](#4-ranking-flow) | [`ranking.md`](./ranking.md), [`collection-rerank.md`](./collection-rerank.md) |
| 5 | [Feed and social](#5-feed-and-social) | [`../feed/expanded-grouping.md`](../feed/expanded-grouping.md), [`push.md`](./push.md) |
| 6 | [Recommendations](#6-recommendations) | [`recommendations.md`](./recommendations.md), [`recommendations-v2.md`](./recommendations-v2.md) |
| 7 | [Background jobs](#7-background-jobs) | [`push.md`](./push.md), [`../release/push-operations.md`](../release/push-operations.md), [`../release/trending-operations.md`](../release/trending-operations.md) |
| 8 | [Release architecture](#8-release-architecture) | [`../release/release-lanes.md`](../release/release-lanes.md), [`../release/safe-update-runbook.md`](../release/safe-update-runbook.md), [`../release/cloud-ota.md`](../release/cloud-ota.md) |

---

## 1. System context

```mermaid
flowchart LR
  user(["Member on iOS or Android"])
  visitor(["Web visitor"])
  founder(["Founder or operator"])

  subgraph device["Phone"]
    app["bingd. app<br/>Expo / React Native 1.1.0"]
  end

  subgraph supa["Supabase project, one per lane"]
    auth["Auth<br/>email code, Apple, Google,<br/>review-only password"]
    rest["PostgREST<br/>RLS reads, RPC writes"]
    pg[("Postgres<br/>pg_cron, pg_net, Vault")]
    storage["Storage<br/>avatars, import archives"]
    fnTmdb["Edge Function<br/>tmdb-adapter"]
    fnImport["Edge Function<br/>letterboxd-import"]
    fnPush["Edge Function<br/>push-sender"]
  end

  web["bingd.app<br/>Cloudflare Pages"]
  tmdb["TMDB API"]
  expoPush["Expo Push Service<br/>to APNs and FCM"]
  eas["EAS Build and Update"]
  gha["GitHub Actions"]
  resend["Resend<br/>Welcome email"]
  posthog["PostHog<br/>product analytics"]
  sentry["Sentry<br/>crash reports"]

  user --> app
  visitor --> web
  app -->|"user JWT"| auth
  app -->|"user JWT"| rest
  app --> storage
  app -->|"invoke"| fnTmdb
  app --> posthog
  app --> sentry
  app -->|"OTA check on launch"| eas
  rest --> pg
  web -->|"anon key, public previews"| rest
  pg -->|"pg_net"| fnImport
  pg -->|"pg_net"| fnPush
  pg -->|"pg_net, release refresh"| fnTmdb
  pg -->|"pg_net, workflow_dispatch"| gha
  fnTmdb --> tmdb
  fnImport --> tmdb
  fnPush --> expoPush
  expoPush --> device
  gha -->|"service role"| rest
  gha --> resend
  gha -->|"trending refresh"| fnTmdb
  founder --> gha
  founder --> eas
```

- The client holds the anon key and the user's JWT only. TMDB's key lives in `tmdb-adapter` and
  `letterboxd-import`. The service-role key lives only in GitHub Actions Environment secrets
  (H-1, closed by #317).
- The *workflow_dispatch* edge is `bingd-welcome-dispatch` (#331). It is live but inert: it
  returns `unconfigured` until the founder stores the production Vault token. Until then the
  Welcome workflow's own GitHub schedule starts the sends.
- Production and staging are two Supabase projects with the same migrations
  (diagram 8). The app's Preview lane points at staging only.

## 2. App architecture

```mermaid
flowchart TB
  subgraph routes["app/ (expo-router screens)"]
    authR["(auth): sign-in, verify,<br/>password-sign-in, create-profile"]
    onb["onboarding/: taste, letterboxd,<br/>people, notifications"]
    tabs["(tabs): Feed, Collection, Search,<br/>For you, Profile"]
    stack["title/[id], title/[id]/history,<br/>rank-session, activity/[id], lists/*,<br/>person/[id], u/[username], i/[token],<br/>awards/celebrate, settings/*"]
  end

  subgraph features["src/features/ (one folder per domain)"]
    fRank["ranking<br/>sessions, backlog, Refine"]
    fColl["collection<br/>wall, drag-to-rerank, TV wall,<br/>log sheet, companions"]
    fWH["watch-history"]
    fFeed["feed<br/>cards, groups, rails,<br/>reactions, comments"]
    fRecs["recommendations<br/>For You engine V1, V2 dark,<br/>Sent to You, Group Picks"]
    fImport["import<br/>Letterboxd, IMDb"]
    fOther["lists, title, people, profile,<br/>notifications, onboarding, auth,<br/>settings, awards, goals, leaderboard,<br/>search, trending, invite, share"]
  end

  subgraph shared["src/lib/ and src/ui/"]
    query["query.ts<br/>QueryClient and queryKeys"]
    supa["supabase.ts<br/>client, session storage"]
    tmdbc["tmdb-adapter.ts"]
    obs["analytics.ts (PostHog),<br/>monitoring.ts (Sentry),<br/>flight-recorder"]
    upd["updates.ts<br/>OTA apply policy"]
    ui["src/ui<br/>design system"]
  end

  subgraph backend["Supabase"]
    rpc["RPC (SECURITY DEFINER)<br/>every write, many reads"]
    views["Tables and security_invoker views<br/>RLS reads"]
    edge["tmdb-adapter"]
  end

  routes --> features
  features --> ui
  features --> query
  query --> supa
  features --> tmdbc
  tmdbc --> edge
  supa --> rpc
  supa --> views
  features --> obs
  routes --> upd
```

**TanStack Query cache strategy** (`src/lib/query.ts`, [`client.md`](./client.md) §3):

```mermaid
flowchart LR
  read["Screen reads"] --> keys["queryKeys, keyed by account<br/>collection, rankings, feed (infinite),<br/>log-state, watch-history, title, ..."]
  keys --> cache[("In-memory cache<br/>staleTime 60 s, retry 2,<br/>no refetch on window focus")]
  write["Write: RPC with operation_id"] -->|"retry 0, online only"| rpcW["Supabase RPC"]
  write -->|"optimistic where safe<br/>(drag-to-rerank ladder)"| cache
  rpcW -->|"success"| inval["Surgical invalidation<br/>invalidateAfterCollectionChange, ..."]
  inval --> cache
  signout["Sign-out"] -->|"queryClient.clear()"| cache
```

- No persisted cache, no SQLite mirror and no outbox. Every write is online, and a write RPC
  claims an `operation_id`, so a retried write applies once.
- Keys carry the account id. That keeps one account's notes, watch dates and scores out of
  another account's reads on the same device.

## 3. Database

Core entities only. All 82 tables in `public` have row-level security enabled (read
2026-11-20). Clients get `select` under policy and write only through RPCs.

```mermaid
erDiagram
  profiles ||--o{ follows : "follower or followee"
  profiles ||--o{ blocks : "blocker or blocked"
  profiles ||--o{ user_media : owns
  profiles ||--o{ rankings : owns
  profiles ||--o{ watch_events : owns
  profiles ||--o{ watchlist : owns
  profiles ||--o{ lists : owns
  profiles ||--o{ feed_events : "actor"
  profiles ||--o{ notifications : "recipient"
  profiles ||--o{ device_tokens : has
  media_items ||--o{ media_items : "series to season (parent_id)"
  media_items ||--o{ user_media : ""
  media_items ||--o{ rankings : ""
  media_items ||--o{ watch_events : ""
  rankings ||--o{ ranking_placements : "explained by"
  ranking_sessions ||--o{ comparisons : ""
  ranking_placements ||--o| show_promotions : "TV wall promotion"
  watch_events ||--o{ watch_event_companions : "watched with"
  lists ||--o{ list_items : ""
  feed_events ||--o{ feed_events : "presented_in (group)"
  feed_events ||--o{ feed_ranking_titles : "group members"
  feed_events ||--o{ feed_watchlist_titles : "session members"
  feed_events ||--o{ reactions : ""
  feed_events ||--o{ comments : ""
  notifications ||--o| push_outbox : "push copy"
  import_jobs ||--o{ import_rows : ""

  profiles {
    uuid id PK
    text username
    profile_visibility visibility
    profile_status status
  }
  media_items {
    uuid id PK
    media_kind kind "movie, series, season"
    uuid parent_id
    int tmdb_id
  }
  user_media {
    uuid user_id
    uuid media_item_id
    taste_bucket bucket
    text note
    note_visibility note_visibility
  }
  rankings {
    uuid user_id
    uuid media_item_id
    ranking_category category "movies, tv_shows, tv_seasons"
    taste_bucket bucket
    int position "dense, per user and category"
  }
  ranking_placements {
    uuid id PK
    placement_kind kind "first, rewatch, correction, refine, import, manual, backfill"
    numeric score
    uuid operation_id
  }
  watch_events {
    uuid id PK
    date watched_on
    watch_date_basis basis
    text note "owner only"
  }
  follows {
    uuid follower_id
    uuid followee_id
    follow_state state "pending, approved"
  }
  feed_events {
    uuid id PK
    uuid actor_id
    text type
    uuid presented_in "null means visible"
  }
```

**Ranking pools.** `rankings` is one table partitioned logically by `ranking_category`:
`movies`, `tv_shows` and `tv_seasons`. Each pool has its own dense positions and bucket bands
for each user. A season and its show are separate rows in separate pools. The TV wall's
season average (`SN AVG`) is computed on read and is not stored.

**Authorisation boundaries.**

```mermaid
flowchart LR
  client["Client<br/>anon key + user JWT"]
  subgraph pgb["Postgres"]
    policies["RLS select policies<br/>can_view_profile(viewer, subject):<br/>visibility, approved follow, blocks, suspension"]
    views["security_invoker views<br/>visible_collection, public_profiles, ..."]
    rpcs["SECURITY DEFINER RPCs<br/>validate, lock, write, claim operation_id"]
    internal["Internal functions (_name)<br/>no client grant; pg_cron runs them"]
    tables[("Tables")]
  end
  service["Service role<br/>GitHub Actions only"]
  client -->|"select"| policies --> tables
  client -->|"select"| views --> policies
  client -->|"rpc"| rpcs --> tables
  internal --> tables
  service --> tables
```

Owner-only at every visibility: `user_media.note` while private, watch dates, `watch_events.note`,
`profile_private`. A share or invite token resolves to an object id, never to authorisation.

## 4. Ranking flow

```mermaid
flowchart TD
  start(["Rank a title<br/>Log sheet, title page, Unranked sitting, onboarding"]) --> bucket["Choose a bucket<br/>I liked it, It was fine, I didn't like it"]
  bucket --> rs["rank_start<br/>opens ranking_session in that title's pool"]
  rs --> cmp{"Comparison<br/>this or that?"}
  cmp -->|"rank_answer"| cmp
  cmp -->|"Can't decide, Skip, Back<br/>rank_skip, rank_back"| cmp
  cmp -->|"search settles"| fin["Finalize<br/>shift positions in band,<br/>write ranking_placements"]
  fin --> first{"First ranking<br/>of this title?"}
  first -->|"yes"| post["One title_ranked post,<br/>or joins a 30-minute group"]
  first -->|"rewatch"| rpost["Rewatch post"]
  first -->|"update or correction"| silent["No new post.<br/>The latest watch's post takes the new score"]
  fin --> season{"Was it a season?"}
  season -->|"yes"| keep["Offer Update Show or Keep Show<br/>keep_show"]

  wall(["Collection wall<br/>Watched, sorted by rating, no filters"]) --> lift["Long-press, drag, drop"]
  lift --> kind{"Where it lands"}
  kind -->|"same category"| reorder["rank_reorder<br/>manual placement"]
  kind -->|"another category"| reorderX["rank_reorder with p_new_bucket<br/>bucket and score of the new place"]
  kind -->|"TV: SN AVG show"| promote["rank_promote_show<br/>becomes an explicit tv_shows ranking"]
  kind -->|"TV: explicit show"| reorder
  reorder --> guards{"Guards hold?<br/>expected position and neighbour"}
  reorderX --> guards
  promote --> guards
  guards -->|"no: 55000 or 22023"| rollback["Restore snapshot, refetch, explain"]
  guards -->|"yes"| done["Moved. Bar shows place and score, with Undo"]
  done -->|"Undo"| undo["rank_reorder back, or<br/>rank_unpromote_show"]
  done --> silent
  undo --> silent
```

- Ordinal position is the truth, and the score is derived from position and band sizes
  (`score_for`). Nothing stores a score.
- A move never creates a comparison, a watch, a session, a feed post or a notification.
  Retry resends the same `operation_id`; Undo is a new one with the same guards.
- Refine (`ranking.refine_enabled`) is built and **dark** in production.

## 5. Feed and social

```mermaid
flowchart TD
  subgraph sources["Writes that create activity"]
    rk["First ranking or rewatch"]
    wl["Watchlist save"]
    bl["Unranked sitting"]
    fo["Follow approved"]
    aw["Award or goal"]
  end
  sources --> fe[("feed_events")]
  fe --> grp{"Grouping rules<br/>feed.*_grouping_enabled"}
  grp -->|"watchlist saves within 30 min"| gW["watchlist_added group<br/>feed_watchlist_titles"]
  grp -->|"first rankings in one 30-min window,<br/>any watch date (#328)"| gR["ranking group<br/>feed_ranking_titles"]
  grp -->|"Unranked sitting"| gB["One ranking_batch post per sitting<br/>draft until the sitting ends;<br/>joins an open 30-min group"]
  gW --> hide["Members get presented_in = group id<br/>hidden by the read policy, never deleted"]
  gR --> hide

  reader(["Reader opens Feed"]) --> q["Fan-out on read:<br/>followed actors, presented_in is null,<br/>can_view_profile, blocks"]
  fe --> q
  q --> cards["Cards: single post, or<br/>poster rail for a group"]
  cards --> eng["Like (set_reaction)<br/>Comment (add_comment, mentions)"]
  eng --> notif["notifications row"]
  notif --> outbox["push_outbox"] --> drain["bingd-push-drain (pg_cron)<br/>to push-sender"]

  fs["Follow story (follow_added)"] -.->|"staging only, #322"| eng
```

- **Privacy.** A block, an unfollow or a privacy change takes effect at read time, because the
  Feed is assembled on read. Nothing is backfilled.
- **Silent updates.** Updates, moves, category changes, corrections and Refine post nothing.
- **Follow stories.** In production a follow story shows no Like or Comment. Reactions and
  comments on follow stories (#322) are on staging and Preview `5e5f55df` only, **not
  released**. That includes its migration `20261201000100`.

## 6. Recommendations

```mermaid
flowchart TD
  open(["For You tab opens"]) --> eng["recommendation_engine()<br/>v2_engine = v1, 0%, allowlist empty"]
  eng -->|"v1: every reader"| v1
  eng -.->|"v2_metadata or v2_hybrid: dark"| v2

  subgraph v1["Engine V1 (live, on device)"]
    prof1["Profile from own rankings<br/>movies, tv_shows, tv_seasons"]
    anch["Up to 6 anchors"]
    cand1["Candidates: TMDB similar for anchors<br/>(media_cache via tmdb-adapter),<br/>trending, social_candidates"]
    score1["scoreCandidate, ENGINES.v1"]
    div["Diversity ceilings<br/>per anchor, franchise, genre"]
    prof1 --> anch --> cand1 --> score1 --> div
  end

  subgraph v2["Engine V2 (shipped dark)"]
    prof2["Signed taste profile<br/>language, era, negative evidence"]
    cand2["Adds catalogue_candidates for a shortfall;<br/>hybrid adds collaborative_candidates"]
    nb[("taste_neighbours<br/>24 h TTL")]
    prof2 --> cand2
    nb --> cand2
  end

  div --> wall["Wall of 20 with derived reasons"]
  v2 -.-> wall
  wall --> imp["note_recommendations_shown<br/>recommendation_impressions"]
  wall --> dismiss["dismiss_for_you,<br/>recommendation_feedback"]

  tm["Taste Match: taste_match(a, b)<br/>live per pair, shrunk to baseline"]
  sent["Sent to You: add_recommendation<br/>title_recommendations"]
  gp["Group Picks: group_picks"]
```

- **Caches.** The TMDB facets go through `media_cache` with per-facet TTLs
  (`tmdb.cache_ttl_hours`). The V2 neighbour cache is `taste_neighbours`. V1 persists no slate.
- **Evaluation.** This is offline, on synthetic data:
  [`recommendations-v2-evaluation.md`](./recommendations-v2-evaluation.md) and
  [`recommendation-benchmark-synthetic-2026-11-17.md`](./recommendation-benchmark-synthetic-2026-11-17.md).
  Turning V2 on is an `app_config` change and a founder decision.

## 7. Background jobs

```mermaid
flowchart LR
  subgraph cron["pg_cron in each project (production and staging alike)"]
    j1["bingd-import-drain<br/>every 10 s<br/>_drain_import_jobs()"]
    j2["bingd-import-maintenance<br/>every minute<br/>sweep abandoned, enrich nudge, prune history"]
    j3["bingd-push-drain<br/>every minute<br/>_drain_push_outbox()"]
    j4["bingd-release-refresh<br/>hourly at :07<br/>_release_refresh_tick()"]
    j5["bingd-release-evaluate<br/>every 15 min<br/>_release_evaluate(), prune"]
    j6["bingd-welcome-dispatch<br/>hourly at :41<br/>_dispatch_welcome_email()"]
  end

  j1 -->|"pg_net"| li["letterboxd-import"] --> tmdb["TMDB"]
  j3 -->|"pg_net"| ps["push-sender"] --> expo["Expo Push"]
  j4 -->|"pg_net"| ta["tmdb-adapter"] --> tmdb
  j5 --> shadow[("release_shadow_ledger<br/>release.push_enabled false: shadow only")]
  j6 -->|"pg_net, production only,<br/>needs the Vault token"| ghapi["GitHub workflow_dispatch"]

  subgraph gha["GitHub Actions"]
    w1["welcome-email.yml<br/>6 times an hour + dispatch"]
    w2["trending-refresh.yml<br/>daily 04:17 UTC + manual"]
    w3["ci.yml<br/>PRs and main"]
    w4["db-races.yml<br/>migration paths"]
    w5["release-gate.yml<br/>manual and release/**"]
  end
  ghapi --> w1
  w1 --> resend["Resend"]
  w2 --> ta

  subgraph easw[".eas/workflows (manual)"]
    e1["ota-preview.yml"]
    e2["ota-production-check.yml"]
    e3["ota-production.yml"]
  end
```

- These six jobs are the complete `cron.job` list on both projects (read 2026-11-20).
  `bingd-proactive-tick` is **not** scheduled anywhere. Proactive notifications are migrated
  and dark, and `schedule_proactive_notifications()` would install it.
- `bingd-welcome-dispatch` returns `not_production` on staging. On production it returns
  `unconfigured` until the founder stores the Vault token.
- Trending refresh runs on production on schedule only while the repository variable
  `BINGD_PRODUCTION_TRENDING` is `true`. Otherwise it runs by hand.
- Operating, alerting and stopping each job: see `docs/ops/background-jobs.md` (being added by
  the reliability workstream).

## 8. Release architecture

```mermaid
flowchart TB
  pr["Pull request"] --> ci["ci.yml: Typecheck, lint, test, database<br/>(required on main)"]
  pr --> races["db-races.yml, when migrations change"]
  pr --> codex["Codex review; conversations resolved"]
  ci --> main["main"]
  codex --> main

  subgraph staging["Staging lane"]
    sdb[("bingd-staging<br/>fjxhcbowoxuzulwirzyr")]
    prev["Preview OTA, channel preview<br/>ota-preview.yml"]
  end
  subgraph production["Production lane"]
    gate["release-gate.yml on the exact commit"]
    check["ota-production-check.yml<br/>fingerprint equals live store runtime"]
    pota["ota-production.yml<br/>paired Android and iOS publish"]
    pdb[("bingd-production<br/>abheeqyjzekiowkztfxv")]
    store["Store binaries 1.1.0<br/>iOS 15, Android vc15"]
  end

  pr -->|"candidate"| sdb
  pr -->|"candidate"| prev
  prev --> qa["Founder device QA on staging"]
  qa --> main
  main --> mig["Migrations: staging first,<br/>then production, one transaction per file,<br/>by an operator under founder authorisation"]
  mig --> sdb
  mig --> pdb
  main --> gate --> check --> pota
  pota --> store
  store -->|"runtime ec79e181 / 8ea562b7"| phones(["Installed apps<br/>apply on next safe foreground or cold start"])
  main --> pages["Cloudflare Pages<br/>bingd.app from main"]
  main --> welcome["Welcome email template<br/>rendered from main per run"]
  rb["Rollback: republish the previous<br/>OTA group pair; database left as is,<br/>or a recorded rollback SQL"] -.-> pota
```

- **Isolation.** Preview builds are refused any backend but staging (`config/backends.cjs`).
  Production OTAs refuse a fingerprint that is not a live store runtime
  (`scripts/ota-gate.mjs`, `config/live-runtimes.json`). A native change therefore needs a
  new store binary, and an OTA cannot strand installed phones.
- **Edge Functions** are deployed by hand. Nothing in the release path deploys
  `supabase/functions/`.
- **Store refresh 1.2.0** (#326/#330) is built: iOS build 16 is uploaded to App Store Connect
  and the Android `.aab` is built. It is **not public**, and the store listing steps are the
  founder's.
- Records of each release: [`../release/production-state.md`](../release/production-state.md).
