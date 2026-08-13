# Bingd — Data Model

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) v0.6 · [`README.md`](./README.md)

All SQL is Postgres 15 as provided by Supabase.

**The migrations in [`../../supabase/migrations/`](../../supabase/migrations/) are now the source of truth.** This document explains the reasoning; the migrations are what runs. They are applied to real Postgres in CI and the structural guarantees in §14 are each tested by attempting to violate them, so the two cannot drift silently.

Three differences from the SQL sketched below, all deliberate:

- **`pgcrypto` is not installed.** `gen_random_uuid()` has been core Postgres since 13, so the extension was dead weight.
- **Check constraints replace comments** wherever this document listed valid values in prose — `media_cache.facet`, `feed_events.type`, `import_jobs.status`, `import_rows.status`, `share_tokens.object_type`, `recommendation_feedback.kind`. Same information, in a place where it cannot rot.
- **`can_view_profile` handles a null viewer explicitly**, returning public profiles only. Unauthenticated reads happen on the public web pages in PRD §16, and leaving that case to `case` fallthrough would have returned null rather than false.

---

## Conventions

- Every table has RLS enabled with **no permissive default**. Absence of a policy means no access.
- Clients hold `select` grants only. Every write goes through a `SECURITY DEFINER` function (AD-4).
- `id` columns are `uuid default gen_random_uuid()` unless the table has a natural composite key.
- Timestamps are `timestamptz`, never bare `timestamp`.
- Soft deletion is used only where history matters. Everything else deletes.

---

## 1. Enumerations

```sql
create type media_kind         as enum ('movie', 'series', 'season');
create type ranking_category   as enum ('movies', 'tv_seasons');
create type taste_bucket       as enum ('loved', 'fine', 'not_for_me');
create type season_progress    as enum ('watching', 'completed');
create type profile_visibility as enum ('public', 'private');
create type follow_state       as enum ('pending', 'approved');
create type list_visibility    as enum ('public', 'private', 'link');
create type content_source     as enum ('in_app', 'imported');
create type capability_source  as enum ('base_free', 'alpha_early_access',
                                        'paid_entitlement', 'promotional_grant');
```

> `taste_bucket` values are stored as `loved` / `fine` / `not_for_me`, never as the user-facing labels. PRD `open-questions.md` §3 expects the labels to be reworded after user testing; storing display strings would turn a copy change into a data migration.

---

## 2. Identity

```sql
create table profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  username            citext not null unique,
  display_name        text   not null,
  avatar_url          text,
  visibility          profile_visibility not null default 'public',
  date_of_birth       date   not null,
  invited_by          uuid   references profiles(id) on delete set null,
  founding_member     boolean not null default true,
  username_changed_at timestamptz,
  created_at          timestamptz not null default now(),

  constraint username_format check (username ~ '^[a-z0-9_]{3,24}$')
);

create table username_history (
  username       citext primary key,
  profile_id     uuid not null references profiles(id) on delete cascade,
  released_at    timestamptz not null default now(),
  redirect_until timestamptz not null
);
```

**`visibility` defaults to `public`** per PRD §22. **`founding_member` defaults to `true`** and is flipped to `false` by a migration when paid beta opens — every account created before that date qualifies (PRD §17), and defaulting to true means no backfill is needed if the switch happens later than planned.

`username_history` implements the 90-day redirect (INF-2). A username is resolvable if it is live in `profiles`, or present in `username_history` with `redirect_until > now()`. A released username **never** returns to the available pool, because rows are retained past `redirect_until` — the primary key blocks reuse permanently.

> **Note on `date_of_birth`.** Stored to enforce the 13+ gate (PRD §22). It is never exposed by any read policy and never appears in an API response, including the user's own. Only `is_over_13` is derivable through a function.

---

## 3. Social graph

```sql
create table follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid not null references profiles(id) on delete cascade,
  state       follow_state not null,
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

create index on follows (followee_id, state);
create index on follows (follower_id, state);

create table blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create index on blocks (blocked_id);
```

A follow of a public account is inserted directly as `approved`. A follow of a private account is inserted as `pending`. This is one table rather than a separate requests table, because the state transition is the whole difference and splitting it would double every follower query.

### The visibility helper

PRD §22 requires blocking to affect feed, leaderboard, discovery, match, tagging, and public pages at once. That rule exists **once**:

```sql
create or replace function can_view_profile(viewer uuid, subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when viewer = subject then true
    when exists (
      select 1 from blocks
       where (blocker_id = viewer  and blocked_id = subject)
          or (blocker_id = subject and blocked_id = viewer)
    ) then false
    when (select visibility from profiles where id = subject) = 'public' then true
    else exists (
      select 1 from follows
       where follower_id = viewer and followee_id = subject and state = 'approved'
    )
  end;
$$;
```

Every read policy on user-visible content calls this. The block check precedes the public check, so a block overrides public visibility — which is the behavior PRD §22 requires and the easiest thing to get backwards.

---

## 4. Media

```sql
create table media_items (
  id                uuid primary key default gen_random_uuid(),
  kind              media_kind not null,
  tmdb_id           integer,
  parent_id         uuid references media_items(id) on delete cascade,
  season_number     integer,
  title             text not null,
  original_title    text,
  release_date      date,
  runtime_minutes   integer,
  overview          text,
  poster_path       text,
  backdrop_path     text,
  original_language text,
  genres            text[] not null default '{}',
  popularity        real,
  fetched_at        timestamptz not null default now(),

  constraint season_has_parent check (
    (kind = 'season' and parent_id is not null and season_number is not null) or
    (kind <> 'season' and parent_id is null     and season_number is null)
  )
);

create unique index on media_items (kind, tmdb_id) where kind in ('movie','series');
create unique index on media_items (parent_id, season_number) where kind = 'season';
create index on media_items using gin (genres);
create index on media_items (title text_pattern_ops);
```

One table for movies, series, and seasons (AD-1). Seasons carry a `parent_id` to their series. **Only `movie` and `season` rows are ever rankable** — series exist for browsing and grouping, and PRD §10 forbids ranking a whole series.

The rankable category is derived, not stored: `movie` → `movies`, `season` → `tv_seasons`.

```sql
create table media_cache (
  media_item_id uuid not null references media_items(id) on delete cascade,
  facet         text not null,          -- 'credits' | 'keywords' | 'providers' | 'similar'
  payload       jsonb not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (media_item_id, facet)
);

create index on media_cache (expires_at);
```

Facet-level TTLs match PRD §19: availability expires in hours, credits and keywords in weeks. `expires_at` is computed by `tmdb-adapter` from configuration in `app_config`, **not** from a constant. Bingd caps all TMDB-derived retention under six months to stay inside the API terms ([`../reference/tmdb-integration.md`](../reference/tmdb-integration.md)), and that window must be adjustable without a migration.

> **Read access is public** on `media_items` and `media_cache`. Catalog metadata is not user data. This is the only unrestricted read in the schema.

---

## 5. Collection: Logged and Ranked

The two-state model in PRD §11 is two tables. This is the single most important structural decision in the schema, because it is what makes "a position is never derived from a rating" (PRD Principle 3) impossible to violate rather than merely forbidden.

```sql
-- LOGGED. Watched, optionally bucketed. No position.
create table user_media (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  bucket        taste_bucket,
  progress      season_progress,
  watched_on    date,
  note          text,
  source        content_source not null default 'in_app',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, media_item_id)
);

create index on user_media (user_id, bucket) where bucket is not null;

-- RANKED. Has an exact position, earned through comparisons.
create table rankings (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  category      ranking_category not null,
  bucket        taste_bucket not null,
  position      integer not null check (position > 0),
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id)
);

create unique index rankings_position_unique
  on rankings (user_id, category, position);

alter table rankings add constraint rankings_position_unique
  unique using index rankings_position_unique deferrable initially deferred;

create index on rankings (user_id, category, position);
```

**Why two tables rather than a nullable `position` column on one.** With one table, the import path and the ranking path write to the same rows, and nothing but discipline stops an import from setting a position. With two, the import worker has no reason to touch `rankings` at all — and PRD §25 can assert that it never does. A logged title is a `user_media` row; ranking it adds a `rankings` row. The `user_media` row persists either way.

**Why the unique constraint is deferrable.** Insertion shifts every position at or below the insertion point (AD-2). That `UPDATE` transiently produces two rows with the same position. A deferred constraint checks at commit, by which time the shift is complete.

`bucket` appears on both tables. On `user_media` it is the user's reaction; on `rankings` it identifies the band. They are kept in step by the ranking RPCs, which are the only writers of either.

```sql
create table comparisons (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  winner_id  uuid not null references media_items(id) on delete cascade,
  loser_id   uuid not null references media_items(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index on comparisons (user_id, created_at desc);
```

Comparisons are recorded for analytics and for future recalibration. The ranking itself is derived from `rankings.position`, not replayed from this table.

One further table, `ranking_sessions`, holds the in-progress state of a comparison sequence so it survives the app being backgrounded and satisfies the resumability requirement in PRD §12. It is defined in [`ranking.md`](./ranking.md) §2 alongside the algorithm that uses it, since it is meaningless in isolation.

```sql
create table watchlist (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id)
);
```

### Read policies

```sql
alter table rankings enable row level security;

create policy rankings_read on rankings for select
  using (can_view_profile(auth.uid(), user_id));
```

`user_media` is more restrictive, because it carries `note` and `watched_on`, which PRD §22 classifies as always-private:

```sql
alter table user_media enable row level security;

create policy user_media_own on user_media for select
  using (user_id = auth.uid());
```

Other users never read `user_media` directly. The bucket, where it should be visible, is exposed through `rankings` or through a view that projects only non-private columns. **`watchlist` is always private** and has an owner-only policy.

---

## 6. Tagging, lists, and feed

```sql
create table watch_tags (
  id              uuid primary key default gen_random_uuid(),
  tagger_id       uuid not null references profiles(id) on delete cascade,
  tagged_id       uuid not null references profiles(id) on delete cascade,
  media_item_id   uuid not null references media_items(id) on delete cascade,
  removed_by_tagged boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (tagger_id, tagged_id, media_item_id),
  constraint no_self_tag check (tagger_id <> tagged_id)
);
```

A tag is a row on the **tagger's** watch. It has no effect on the tagged user's collection (PRD §14) — structurally guaranteed, because nothing in this table references `user_media` or `rankings`. `removed_by_tagged` hides the tag without altering the tagger's log, which is exactly the behavior the PRD specifies.

The 10-tag limit and the follow-relationship requirement are enforced in the tagging RPC, since both are multi-row conditions.

```sql
create table lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  title       text not null,
  description text,
  visibility  list_visibility not null default 'private',
  source      content_source not null default 'in_app',
  created_at  timestamptz not null default now()
);

create index on lists (owner_id, source);

create table list_items (
  list_id       uuid not null references lists(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  position      integer not null,
  added_at      timestamptz not null default now(),
  primary key (list_id, media_item_id)
);
```

**`source` is what makes the three-list limit measurable.** PRD §12 requires all lists to import regardless of the limit, and PRD §28 requires the ceiling metric to count in-app creation only. The limit check in `create_list` counts `where source = 'in_app'`, so an importer with 15 lists is not blocked by their own history — and the monetization signal is not washed out by it.

```sql
create table feed_events (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references profiles(id) on delete cascade,
  type          text not null,
  media_item_id uuid references media_items(id) on delete cascade,
  list_id       uuid references lists(id) on delete cascade,
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index on feed_events (actor_id, created_at desc);
create index on feed_events (created_at desc);

create table reactions (
  feed_event_id uuid not null references feed_events(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  kind          text not null,
  created_at    timestamptz not null default now(),
  primary key (feed_event_id, user_id)
);
```

The primary key on `reactions` enforces PRD §14's one-reaction-per-user rule at the database level. Changing a reaction is an upsert; removing it is a delete. **There is no text column**, which is what keeps reactions free of moderation surface.

`payload` on `feed_events` holds a denormalized snapshot — the position at the time of ranking, the bucket, the tagged users. Denormalizing here is deliberate: a feed item should show what was true when it happened, and re-deriving a historical position from current data would be both expensive and wrong.

Feed reads use `can_view_profile` against `actor_id` (AD-6).

---

## 7. Notifications

```sql
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  type         text not null,
  actor_id     uuid references profiles(id) on delete cascade,
  subject_type text,
  subject_id   uuid,
  payload      jsonb not null default '{}',
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index on notifications (recipient_id, created_at desc);
create index on notifications (recipient_id) where read_at is null;

create table notification_preferences (
  user_id  uuid not null references profiles(id) on delete cascade,
  category text not null,
  enabled  boolean not null default true,
  primary key (user_id, category)
);

create table device_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('ios','android')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

`device_tokens` is populated in v1 even though push delivery is off (PRD §15, AD-10). Collecting tokens from the start means that enabling push does not begin with an empty table and a wait for every user to reopen the app.

Preferences default to enabled by absence: a missing row means enabled. This avoids writing seven rows per signup and avoids a backfill every time a category is added.

---

## 8. Recommendations

```sql
create table recommendation_generations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  config_version text not null
);

create table recommendations (
  generation_id uuid not null references recommendation_generations(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  rank          integer not null,
  score         real not null,
  source_family text not null,
  evidence      jsonb not null,
  primary key (generation_id, media_item_id)
);

create table recommendation_impressions (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  shown_at      timestamptz not null default now(),
  primary key (user_id, media_item_id, shown_at)
);

create index on recommendation_impressions (user_id, media_item_id, shown_at desc);

create table recommendation_feedback (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  kind          text not null,  -- 'dismiss' | 'already_seen' | 'saved' | 'opened'
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id, kind)
);
```

**`evidence` is the explanation-integrity mechanism.** PRD §13 requires every reason to be reproducible from stored signals and forbids invented social proof. The recommendation row stores the actual evidence — which users endorsed it, their match scores, which content features matched — and the client renders a sentence from that structure. The client has no path to compose a reason of its own, because it is never given the raw candidate pool.

`config_version` on the generation makes a slate reproducible after tuning values change, which is what allows a quality regression to be diagnosed rather than guessed at.

---

## 9. Match scores

```sql
create table match_scores (
  user_a       uuid not null references profiles(id) on delete cascade,
  user_b       uuid not null references profiles(id) on delete cascade,
  score        smallint not null check (score between 0 and 100),
  shared_count integer  not null,
  computed_at  timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint ordered_pair check (user_a < user_b)
);

create index on match_scores (user_a, score desc);
create index on match_scores (user_b, score desc);
```

The `user_a < user_b` constraint stores each pair once. Both indexes exist because a lookup may arrive from either side.

**Method.** For the set of titles both users have in `rankings`, count the pairs `(x, y)` where both users ordered them the same way, and divide by the total comparable pairs. This is Kendall's tau-a rescaled to 0–100.

Chosen over Spearman because it degrades more gracefully on small overlaps, which is the common case in a young network, and because it answers exactly the question the product asks: *when we have both seen two films, how often do we agree on which was better?* That maps directly onto the pairwise mechanic users already understand.

`shared_count` is stored alongside so the UI can show `88% match · 126 shared` in one read (PRD §13).

Computation is scheduled, not on demand (AD-7), and only for pairs whose overlap exceeds a floor. Below the floor no row exists, and the UI shows no match rather than a meaningless number.

---

## 10. Capabilities

```sql
create table capability_grants (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  capability text not null,
  source     capability_source not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create index on capability_grants (user_id)
  where revoked_at is null;

alter table capability_grants add constraint early_access_must_expire
  check (source <> 'alpha_early_access' or expires_at is not null);
```

**The `early_access_must_expire` constraint is PRD §20's "grants cannot silently become permanent" requirement, made structural.** A grant of `alpha_early_access` without an expiry cannot be inserted.

```sql
create or replace function resolve_capabilities(target uuid)
returns text[]
language sql stable security definer
set search_path = public
as $$
  select array_agg(distinct capability) from (
    select 'base_free'::text as capability
    union
    select capability from capability_grants
     where user_id = target
       and revoked_at is null
       and (expires_at is null or expires_at > now())
  ) c;
$$;
```

Every insert-path RPC that guards a limit calls this. Per AD-9, **no delete path and no read policy calls it**, which makes the destructive over-limit case structurally impossible.

---

## 11. Tokens, invitations, and import

```sql
create table invite_tokens (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles(id) on delete cascade,
  token      text not null unique,
  short_code text not null unique,
  env        text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index on invite_tokens (owner_id) where revoked_at is null;

create table invite_attributions (
  invitee_id   uuid primary key references profiles(id) on delete cascade,
  inviter_id   uuid not null references profiles(id) on delete cascade,
  token_id     uuid references invite_tokens(id) on delete set null,
  accepted_at  timestamptz,
  activated_at timestamptz
);

create index on invite_attributions (inviter_id);
```

The partial unique index on `owner_id` enforces PRD §17's **one reusable personal link per user**. Regenerating revokes the old row and inserts a new one; the index permits any number of revoked rows and exactly one live one.

`invite_attributions` is keyed by `invitee_id` because a person is invited once. `activated_at` is set when the invitee ranks their first title, which is what makes the invite-to-activation metric in PRD §28 a single query — and what would make any future reward farm-resistant.

`env` prevents a nonprod token resolving in production (PRD §17).

```sql
create table share_tokens (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  token       text not null unique,
  object_type text not null,
  object_id   uuid not null,
  env         text not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
```

**A share token resolves to an object reference and nothing more.** The resolver returns `(object_type, object_id)`; the caller then applies normal visibility rules to that object. There is no code path where holding a token produces content — which is how PRD §16's "a token is never authorization" becomes structural rather than aspirational.

```sql
create table import_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  status       text not null default 'pending',
  storage_path text,
  counts       jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table import_rows (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references import_jobs(id) on delete cascade,
  raw           jsonb not null,
  media_item_id uuid references media_items(id) on delete set null,
  status        text not null,   -- 'matched'|'ambiguous'|'unmatched'|'duplicate'|'applied'
  candidates    jsonb
);

create index on import_rows (job_id, status);
```

`import_rows` exists so the mandatory preview (PRD §12) can be produced, reviewed, and resolved **before** anything is written to the user's collection. `storage_path` is nulled when the job completes, and the file is deleted.

Idempotent re-upload is achieved by the apply step upserting into `user_media` on its primary key. Re-running an import changes nothing that is already correct.

---

## 12. Configuration and idempotency

```sql
create table app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
```

Holds the push delivery flag (AD-10), cache retention windows (AD-8), and every tuning value in PRD `open-questions.md` §6. Runtime configuration rather than constants, because PRD §13 requires tuning values to be "configurable and versioned rather than hard-coded," and because a change in TMDB's terms should move a retention window without a migration.

```sql
create table processed_operations (
  operation_id uuid primary key,
  user_id      uuid not null references profiles(id) on delete cascade,
  processed_at timestamptz not null default now()
);
```

Every outbox-eligible RPC begins by inserting here. A duplicate key means the operation already ran, and the function returns the prior result rather than repeating the write. This is the whole of PRD §18's idempotency requirement, in one table.

Rows older than 30 days are pruned by a scheduled job.

---

## 13. Index summary

Indexes justified by a specific query rather than added speculatively.

| Index | Serves |
|---|---|
| `rankings (user_id, category, position)` | Ranking list pagination; the position shift on insert |
| `user_media (user_id, bucket)` partial | The unranked queue, highest bucket first (PRD §11) |
| `follows (followee_id, state)` | Follower lists; pending request counts |
| `follows (follower_id, state)` | Feed assembly (AD-6) |
| `feed_events (actor_id, created_at desc)` | Feed assembly; profile activity |
| `notifications (recipient_id) where read_at is null` | Unread badge count |
| `match_scores (user_a, score desc)` + mirror | Leaderboard, both directions |
| `recommendation_impressions (user_id, media_item_id, shown_at desc)` | Cooldown check during re-ranking |
| `lists (owner_id, source)` | The in-app-only list limit check |
| `invite_tokens (owner_id) where revoked_at is null` | One live token per user |
| `media_items (kind, tmdb_id)` partial | Adapter upsert |
| `media_items using gin (genres)` | Genre diversity constraints in re-ranking |

---

## 14. What this model makes impossible

The point of several choices above is that a violation cannot be written, not merely that it is forbidden.

| PRD requirement | Why violating it is hard |
|---|---|
| A position is never derived from a rating | The import path writes `user_media`; positions live in `rankings`, which it has no reason to open |
| A capability limit never deletes data | `resolve_capabilities` is called only from insert paths (AD-9) |
| Early Access grants cannot become permanent | `early_access_must_expire` check constraint |
| One reaction per user per item | Primary key on `(feed_event_id, user_id)` |
| Reactions carry no moderation surface | No text column exists |
| One reusable invite link per user | Partial unique index on live rows |
| A token is never authorization | The resolver returns an object reference; visibility is applied afterward |
| A block overrides public visibility | The block test precedes the public test in `can_view_profile` |
| Two titles never share a position | Unique constraint on `(user_id, category, position)` |
| Tagging never alters the tagged user's collection | `watch_tags` references neither `user_media` nor `rankings` |
