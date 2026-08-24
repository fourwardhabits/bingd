# Bingd — Data Model

**Version:** v1 (public alpha)
**Specification:** [`../product/PRD.md`](../product/PRD.md) v0.6 · [`README.md`](./README.md)

All SQL is Postgres 15 as provided by Supabase.

**The migrations in [`../../supabase/migrations/`](../../supabase/migrations/) are now the source of truth.** This document explains the reasoning; the migrations are what runs. They are applied to real Postgres in CI and the structural guarantees in §15 are each tested by attempting to violate them, so the two cannot drift silently.

Three differences from the SQL sketched below, all deliberate:

- **`pgcrypto` is not installed.** `gen_random_uuid()` has been core Postgres since 13, so the extension was dead weight.
- **Check constraints replace comments** wherever this document listed valid values in prose — `media_cache.facet`, `feed_events.type`, `import_jobs.status`, `import_rows.status`, `share_tokens.object_type`, `recommendation_feedback.kind`, and now `reactions.kind`. Same information, in a place where it cannot rot.
- **`can_view_profile` handles a null viewer explicitly**, returning public profiles only. Unauthenticated reads happen on the public web pages in PRD §16, and leaving that case to `case` fallthrough would have returned null rather than false.

> **Corrected 2026-08-13** by `20260813001400_security_fixes.sql` and `20260813001500_integrity_fixes.sql`, after an independent review. Each correction is described where the affected table is defined, and the reasoning is in `change-log-v0.6.md` §7.
>
> Two of them mattered more than the rest. **`date_of_birth` was readable by any signed-in user**, because a comment claimed a column-level guarantee that row level security cannot provide. And **a released username was still claimable**, because the protection was credited to a primary key that had no connection to `profiles.username`. Both were guarantees asserted in prose and enforced nowhere, which is the failure mode this document has to be read for.
>
> **Reporting and moderation (§13) landed separately** in `20260813001700_moderation.sql`, on their own branch and with their own review, because a missing subsystem is not a correction and should not ride along with fixes to unrelated tables.

---

## Conventions

- Every table has RLS enabled with **no permissive default**. Absence of a policy means no access.
- Clients hold `select` grants only. Every write goes through a `SECURITY DEFINER` function (AD-4).
- `id` columns are `uuid default gen_random_uuid()` unless the table has a natural composite key.
- Timestamps are `timestamptz`, never bare `timestamp`.
- Soft deletion is used only where history matters. Everything else deletes.
- **Every view is created `with (security_invoker = true)`.** This one is easy to miss and expensive to miss. A Postgres view runs with its *owner's* permissions by default, which means a view over an RLS-protected table hands out rows the caller could never select directly. `visible_collection` is the sharpest example: `user_media` is owner-only precisely because it carries notes and watch dates, and a default-owner view over it would publish them to every caller. `security_invoker` makes the view evaluate the caller's own policies, which is the behaviour every view in §10 of [`api.md`](./api.md) assumes.
- Writes additionally call `assert_can_write()`, which refuses suspended accounts (§13).
- **Function execute privileges are default-deny, with an allow-list in `20260813001800`.** This one reads backwards and cost us six exposed functions. Postgres grants `EXECUTE` on a new function to `PUBLIC`, so `grant execute on function f() to authenticated` *adds* a role to a set that already contains everyone — it looks like a restriction and is an expansion. Any function a client may call is named explicitly in that migration; anything absent is unreachable. Two categories need a grant and only two: client-facing RPCs, and helpers called from inside RLS policies, since a policy is evaluated as the *querying* role and a policy calling a function the caller cannot execute fails the whole query rather than filtering it.

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
  avatar_path         text,   -- object path in the public avatars bucket, always {id}/{file}
  visibility          profile_visibility not null default 'public',
  invited_by          uuid   references profiles(id) on delete set null,
  founding_member     boolean not null default true,
  username_changed_at timestamptz,
  created_at          timestamptz not null default now(),

  constraint username_format check (username ~ '^[a-z0-9_]{3,24}$')
);

create table username_history (
  username       citext primary key,
  profile_id     uuid references profiles(id) on delete set null,
  released_at    timestamptz not null default now(),
  redirect_until timestamptz not null
);

-- No read policy, deliberately. See the note below.
create table profile_private (
  profile_id    uuid primary key references profiles(id) on delete cascade,
  date_of_birth date not null
);
```

**`visibility` defaults to `public`** per PRD §22. **`founding_member` defaults to `true`** and is flipped to `false` by a migration when paid beta opens — every account created before that date qualifies (PRD §17), and defaulting to true means no backfill is needed if the switch happens later than planned. The `status` column that §13 uses as the suspension lever arrives with the moderation migration.

`username_history` implements the 90-day redirect (INF-2). A username is resolvable if it is live in `profiles`, or present in `username_history` with `redirect_until > now()`. A released username **never** returns to the available pool.

Three database objects hold that last sentence up, and it is worth naming them because the guarantee was asserted here for a while with only one of them in place. `reserve_username_on_profile_delete` writes a reservation when an account is deleted; `reserve_username_on_rename` writes one when a username changes, and is also the only writer of `profiles.username_changed_at`; `assert_username_available` refuses any insert or rename that would take a name already in the history table. The rename trigger was missing until a review tested the claim rather than reading it — deletion was covered, renaming quietly returned the name to the pool.

> **This document previously credited that guarantee to the primary key, and the primary key does not provide it.** That key is unique within `username_history`; nothing connected it to `profiles.username`, so a new account could take a retired name while the history row sat there looking like protection. The reservation is now enforced by a trigger on `profiles` that refuses any insert or update naming a username reserved to somebody else — `assert_username_available` in `20260813001500`. Tested by having a second account attempt the claim, which is the only assertion that would have caught the original defect.

> **Corrected 2026-08-13.** `profile_id` was `not null ... on delete cascade`, which meant deleting an account destroyed its history rows and removed the live username from `profiles`, putting the name back in the pool immediately. That is the impersonation vector INF-2 was written to close, reachable by a shorter route than a username change: delete the account, and every previously shared `bingd.app/u/<name>` link points at whoever claims the name next.
>
> `profile_id` is now nullable and detaches on delete, and a `before delete` trigger on `profiles` writes a tombstone for the live username with `redirect_until = now()`. A deleted account has nothing to redirect *to*, so the row does not resolve — but the primary key goes on blocking reuse forever, which is the property that matters. The trigger also expires that account's earlier redirects for the same reason.
>
> This tightens INF-2 rather than implementing it exactly: the inference said released names "can never be *instantly* reused," and the schema makes reuse permanent. Permanent is the safe direction, and the namespace cost is negligible at alpha scale, but it is a divergence from the recorded wording and is flagged in `open-questions.md` §2.

> **Note on `date_of_birth`.** Stored to enforce the 13+ gate (PRD §22), in its own table with row level security enabled and **no policy at all** — which denies every client, the owner included. The only route to it is `is_over_13`, a `SECURITY DEFINER` function returning a boolean, and that function is not executable by client roles either.
>
> **It used to be a column on `profiles`, carrying a comment that promised exactly the behaviour above, and the comment was false.** Row level security is *row*-level: `profiles_read` admits a row, and an admitted row is readable in every one of its columns. Any signed-in user could select the exact birth date of every public account. A guarantee about a single column cannot be written as a policy, so it moved to where it can be structural.
>
> A column privilege would also have worked and was rejected: any later `grant all on profiles` silently undoes it, and nothing would fail. A separate table with no policy cannot be opened by accident.

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

-- Added 2026-08-13 with the seed catalogue; see Provenance below.
alter table media_items
  add column provenance   catalogue_provenance not null default 'tmdb',
  add column wikidata_qid text;

-- Added 2026-08-14 with search_titles; see Search below.
alter table media_items
  add column search_vec tsvector generated always as (media_search(title, original_title)) stored,
  add column sort_key   text     generated always as (media_sort_key(title))               stored;

create index media_items_search   on media_items using gin (search_vec);
create index media_items_sort_key on media_items (sort_key text_pattern_ops);

-- The two scalars the metadata line is made of. Columns rather than facets for the
-- reason 20260817000900 gives: each is a short value rendered beside the year and the
-- runtime, which are columns, so a facet would make the line wait on a second query.
alter table media_items
  -- 20260817000900. The **US** certification: PG-13 from a movie's release_dates,
  -- TV-MA from a series' content_ratings. Null where TMDB publishes none, which is
  -- common. Never a fabricated NR.
  add column certification text,
  -- 20260820000400. Seasons only. From the per-season episode_count TMDB returns on
  -- the series detail, or from counting the episodes on a direct season enrichment.
  -- Null, never zero: an unaired season has no count rather than a count of none.
  add column episode_count integer;
```

One table for movies, series, and seasons (AD-1). Seasons carry a `parent_id` to their series. **Only `movie` and `season` rows are ever rankable** — series exist for browsing and grouping, and PRD §10 forbids ranking a whole series.

The rankable category is derived, not stored: `movie` → `movies`, `season` → `tv_seasons`.

**A season row is descriptively thin, and that is TMDB's shape rather than an oversight.** `tmdb_upsert_seasons` writes no `genres`, no `original_language` and no `certification`, because TMDB publishes all three on the *series*. They are resolved at read time by `src/lib/media-metadata.ts` — own value first, parent series second, absent stays absent — rather than copied onto every season row, which would need a backfill and a re-run on every re-enrichment. `episode_count` is the deliberate exception: it is the one descriptive field that is genuinely the season's own, and there is nothing to inherit it from, since a series' `runtime_minutes` is the length of a single episode.

### Provenance — added 2026-08-13

```sql
create type catalogue_provenance as enum ('tmdb', 'wikidata', 'manual');

alter table media_items
  add column provenance   catalogue_provenance not null default 'tmdb',
  add column wikidata_qid text;

create unique index on media_items (wikidata_qid) where wikidata_qid is not null;
```

The table was designed around one provider, and PRD §19 requires TMDB-derived metadata to refresh or reduce to an identifier inside six months. `fetched_at` measures the window, but nothing said whether the window applied, so a retention job would have had to treat every row as TMDB's or none of them.

That became concrete with the seed catalogue below, whose rows are CC0 and expire never. **The default is `'tmdb'` on purpose**, even though it is the one that causes work: the two ways of being wrong are not symmetrical. Defaulting to `'tmdb'` can expire a row that need not expire, which costs a refetch. Defaulting to `'wikidata'` would silently exempt provider data from the six-month rule and turn a forgotten argument into a licence breach.

`wikidata_qid` is how a refresh finds the row it produced, and how a title stays identifiable if its `tmdb_id` turns out to be wrong. It is also the conflict target the seed upserts on, for that reason: a corrected TMDB id is routine and a Q-number is stable, so keying on the id that does not move lets a refresh update the row instead of colliding with the other unique index and aborting the whole migration.

**`media_refresh_due` filters on it.** The same migration rebuilt the view, because a provenance column the retention job does not read decides nothing: the job would still have offered CC0 rows to TMDB for refresh, and the paragraph above would have been true of the schema and false of the code. The column is projected too, so a job draining the view can branch on it without joining back.

### The seed catalogue — added 2026-08-13

`*_seed_catalogue.sql` — one timestamped file, currently `20260814001131` — inserts roughly 380 films, 190 series and 1,400 seasons. It is generated — `supabase/seed/fetch-catalogue.mjs` queries Wikidata into `catalogue.json`, and `make-seed-migration.mjs` writes the migration from it. Neither runs in CI, and the SQL is never hand-edited.

**Why it exists.** Nothing can enter `media_items` yet: the provider adapter is unwritten, and the licence question governing it is unanswered — TMDB's terms make anything beyond personal use a commercial negotiation, and no answer has come back. A catalogue is needed to test the core loop now. Wikidata's content is CC0: no attribution obligation, no retention window, and nothing to renegotiate when a private test stops being private.

**Why a migration rather than a script.** `supabase db push` is already how every environment gets its schema and the harness already replays every migration, so a seed arriving that way needs no second mechanism and no step anyone can forget. `app_config` is seeded the same way. A refresh is a **new** generated migration — the filename carries a timestamp and the generator refuses to overwrite an existing file, because `db push` records a version as applied and then skips it, so regenerating in place would freeze the hosted catalogue at the first version while every fresh database got the new one.

Its upserts correct the same rows rather than duplicating them, and three cases are asserted: a byte-identical re-application, a title whose local copy has drifted, and a **corrected `tmdb_id`**, which is the case that actually happens and the one that used to abort the migration.

A refresh also stays in its own lane. Each `do update` carries `where media_items.provenance = 'wikidata'`, so a row the adapter has already enriched is left untouched. Without that clause a refresh reset `provenance` to `'wikidata'` while leaving the provider's poster, synopsis and score in place — relabelling TMDB content as CC0 and exempt from expiry, which is the failure this column exists to prevent, arrived at from the other side.

**What it does not have.** No posters, because a poster is not a free work and Wikidata has none to give — so the client must look right without artwork, which is better learned now than after screens assume it. No `popularity`, because PRD §19 defines that as the provider's score; the ordering that chose these titles is Wikipedia sitelink count, a proxy for "widely known" and not the same measure. No `overview`, `original_title` or `backdrop_path` either — `overview` being the body text of a title detail screen, which will be empty until a provider fills it.

Every film and series carries its `tmdb_id`, so once the licence is settled the adapter enriches those rows in place instead of building a second catalogue beside them. Seasons carry a Wikidata id but no TMDB one, because Wikidata has no property for a TMDB season: a season matches through its parent series and its number. That matters more than it sounds, since the season is the rankable television unit under PRD §10 — it is how the TV half of the catalogue stays connected to a provider at all.

Two known blemishes in the data, both from the source rather than the pipeline: `original_language` is null for any title Wikidata records in more than one language, because `P364` lists every language spoken and does not identify the original, and the genre strings are Wikidata's taxonomy rather than a viewer's vocabulary — `huis-clos film` and `flashback film` appear. Mapping them to a controlled set is worth doing before genres are put in front of anyone.

```sql
create table media_cache (
  media_item_id uuid not null references media_items(id) on delete cascade,
  facet         text not null,          -- 'credits' | 'keywords' | 'providers' | 'similar' | 'videos'
  payload       jsonb not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (media_item_id, facet)
);

create index on media_cache (expires_at);
```

Facet-level TTLs match PRD §19: availability expires in hours, credits and keywords in weeks. `expires_at` is computed by `tmdb-adapter` from configuration in `app_config`, **not** from a constant. Bingd caps all TMDB-derived retention under six months to stay inside the API terms ([`../reference/tmdb-integration.md`](../reference/tmdb-integration.md)), and that window must be adjustable without a migration.

**A provider list is not a facet.** Added 2026-08-16 with trending. Every facet above answers "what does TMDB say about *this title*", and the primary key says so: `media_item_id` is `not null` and references `media_items`. Trending answers "what is TMDB featuring right now", which belongs to no title and has no id to key on. So `provider_list_cache` is a sibling with the same lifecycle contract — jsonb payload, `fetched_at`, `expires_at` from `app_config`, a closed key set, world-readable — keyed on the list instead:

```sql
create table provider_list_cache (
  list_key   text not null,          -- 'trending.movie.day' | '.week' | 'trending.series.day' | '.week'
  payload    jsonb not null,         -- {"ids": [...]}, most trending first
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (list_key)
);
```

The payload holds `media_items` ids and nothing else. The titles are written through `tmdb_upsert_titles` before the list row is, so a trending poster comes from `media_items` and expires on the retention clock rather than on this six-hour one — one copy, one expiry. Replacing the row whole is what keeps a refreshed list free of the previous generation, which is the property a facet row per trending title could not have offered.

**A person is neither.** Added 2026-08-17 with the person page (`20260817000500`). A person is the first provider entity here that is not a title and not a global list: `media_cache` has no id to key it on, and `provider_list_cache` has a closed set of four literal keys and a writer that enforces `{"ids": [...]}`. Widening either would leave one table whose contract is "anything", which is how a cache stops being checkable. So a third sibling, with the same lifecycle again and TMDB's own person id as the key — there is no Bingd person, deliberately, because minting one would be a second identity to reconcile with the provider on every refresh:

```sql
create table person_cache (
  tmdb_person_id bigint not null check (tmdb_person_id > 0),
  payload        jsonb not null,      -- {"person": {...}, "credits": [{"id", "kind", "role", "as"}], "credit_total": n}
  fetched_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  primary key (tmdb_person_id)
);
```

Same rule as trending: the credited titles are written through `tmdb_upsert_titles` first, so the payload holds `media_items` ids plus the two facts a title row cannot hold — which Bingd id it is, and what this person did in it. A character name is a property of the pairing, not of the film. Seven-day TTL from `app_config`, capped at the same six-month window; the credits are ordered by provider popularity and capped at forty, with `credit_total` recording how many TMDB had.

Nothing viewer-relative is stored in it. Whether the reader has ranked, watched or saved a credited title is answered by the tables that already answer it, under the policies that already gate them — which is why this table can be world-readable alongside the other two.

> **Corrected 2026-08-13.** `media_cache` had an expiry; `media_items` did not. Title, overview, poster path, and genres are the bulk of the provider-derived data, and they carried only `fetched_at` — with no index on it and no job defined to act on it. A row referenced by somebody's ranking and untouched for seven months was retained provider data that nothing could find.
>
> `title` is also `not null`, so the "reduce to a bare identifier" fallback described in the integration note was not actually available without a schema change.
>
> Added: an index on `fetched_at`, and a `media_refresh_due` view listing rows past `tmdb.metadata_max_age_days` (currently 150, giving a 30-day margin on the six-month limit) that a user collection still references. `tmdb-adapter` drains it. Rows nobody references are pruned rather than refreshed, which reaches the same compliance for less provider quota. **The quota cost of that refresh belongs in the PRD §19 cost model**, because it scales with the number of distinct titles the user base has ever touched rather than with current activity.



> **Read access is public** on `media_items`, `media_cache`, `provider_list_cache` and `person_cache`. Catalog metadata is not user data. These are the only unrestricted reads in the schema.

### Search — added 2026-08-14

`media_items` was searchable only by `like 'Incep%'`, which the `(title text_pattern_ops)` index above serves. That index cannot do case-insensitive matching, cannot fold an accent, and cannot match a word in the middle of a title — "knight" would never have found The Dark Knight.

So there are three immutable helpers and two stored generated columns built from them. `media_fold(text)` composes to NFC, lower-cases and strips Latin diacritics; `media_search(title, original_title)` builds a `to_tsvector('simple', …)` from the folded pair into `search_vec`; `media_sort_key(title)` reduces the folded title to words separated by single spaces into `sort_key`, which is what the ordering compares a query against. All three are `IMMUTABLE`, which is what allows a generated column at all. `media_search` and `media_sort_key` are revoked from every client role — they exist to generate columns, not to be called. `media_fold` is granted to `authenticated`, because `search_titles` runs as the caller and folds the query text through it. `search_titles` is the single read path, documented in [`api.md`](./api.md) §10.

**Stored columns rather than an expression index.** The first version indexed the expression and had the function repeat it — once in the `where`, once in the `order by`. Recomputing the vector for every matched row was 96% of the query's cost: at 100k rows a one-letter query took 7.6 seconds, and search-as-you-type issues a one-letter query on the first keystroke. It also left two copies of one expression free to drift apart, which would keep results correct while silently abandoning the index. A generated column has one expression and ranking reads a column, so both problems are gone; the same 100k-row query now takes 110ms.

Two choices are worth keeping straight. The `simple` configuration rather than `english`, because stemming buys little on proper nouns while the stop-word list actively breaks things — under `english`, searching "the" produces an empty tsquery and therefore no rows. And **no extension**: `pg_trgm` and `unaccent` would each do this better, and neither exists in PGlite, which is the test harness. An extension-based search would have been exercised by nothing until it reached the hosted database, and search is on the path of every screen. The cost is a fold that handles Latin script only and loses the second letter of a ligature. Non-Latin titles are not lost by it — the tokenizer is Unicode-aware on both sides, so they match as they stand.

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
  updated_at      timestamptz not null default now(),
  note_updated_at timestamptz,
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

`bucket` appears on both tables. On `user_media` it is the user's reaction; on `rankings` it identifies the band. They are kept in step by the ranking RPCs and by `set_bucket`, which refuses a title that is already ranked rather than moving one side of the pair.

**Why the note has its own timestamp.** `updated_at` answers "when did this row last change," which is what a bucket tap, a watch date, and a note edit all change. `note_updated_at` answers "when did the note last change," and only a note edit advances it. `offline-sync.md` §5's conflict rule needs the second question: keyed to `updated_at`, an ordinary offline bucket tap invalidated a queued note edit and produced a conflict prompt about a note nothing had touched. Null means no note has ever been stored, so there is nothing a stale edit could destroy.

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

`user_media` is more restrictive, because it carries `watched_on`, which is always-private under PRD §22, and `note`, which is private unless its author publishes it as a review:

```sql
alter table user_media enable row level security;

create policy user_media_own on user_media for select
  using (user_id = auth.uid());
```

Other users never read `user_media` directly, and that policy has never been widened.

> **As built — 2026-08-23. Two claims in this section describe a design rather than the database.**
>
> - **`visible_collection` does not exist.** No migration creates it. The bucket reaches another reader through `rankings` and through nothing else, so a *logged but unranked* title is not visible to anybody but its owner — which is stricter than the founder decision quoted below, not looser. The decision stands as intent; the view that would implement it was never built. Recorded rather than fixed, because building it is a schema change and a product question about whether the unranked half of a collection should be visible at all.
> - **`watchlist` is no longer always private.** `watchlist_own` became `watchlist_read using (can_i_view(user_id))` on 2026-08-20 (`20260820000200`), so it inherits profile visibility exactly as `rankings` does. The sentence that used to sit here said the opposite.
>
> What is unchanged, and was verified exhaustively on 2026-08-23: **`watched_on` is owner-only on every path there is.** The two review projections (`public_notes`, `title_reviews`) omit the column deliberately, no `feed_events.payload` carries a date, and no view or `returns table` in the whole migration tree names it.

> **Founder decision, 2026-08-13.** The **Logged collection inherits profile visibility** — on a public profile it is public, on a private profile it is visible only to approved followers. The collection is part of the profile and follows the same rules; it is not a separate privacy domain. PRD §22's always-public table never listed it either way, so the behaviour was arriving as a side effect of a view definition rather than as a decision.
>
> ~~This is what the schema already did, and it is why the column split matters. `visible_collection` exposes `media_item_id`, `bucket`, and `progress`. It does **not** expose `note` or `watched_on`, which stay always-private regardless of profile visibility, and it is not a path to `watchlist`, which stays owner-only at every visibility level. A watchlist is forward-looking intent about things you have not watched, which is a different kind of disclosure from a reaction to something you have; PRD §22 keeps it private and this decision does not change that.~~
>
> **Corrected 2026-08-23.** The paragraph above described a view that was never created and a watchlist rule that has since been reversed — see the As-built block above it. What survives intact is the column split it was arguing for: `note` and `watched_on` are not exposed by anything, and `watched_on` never becomes visible at any visibility level.

### Yearly goals — added 2026-08-16

> **Founder decision, 2026-08-16.** One row per `(user_id, year, medium)`. Movies and TV goals are independently optional and independently editable.

```sql
create table watch_goals (
  user_id  uuid             not null references profiles(id) on delete cascade,
  year     integer          not null,
  category ranking_category not null,   -- 'movies' | 'tv_seasons'
  target   integer          not null,
  primary key (user_id, year, category)
);
```

**Absence is the only representation of "no goal".** There is no nullable target and nothing seeds a row, so "never set one", "set one and cleared it", and "set one for the other medium" are not three states a reader has to tell apart. The alternative — one row per `(user, year)` with two nullable targets — makes independence a convention rather than a consequence of the key.

The medium is `ranking_category` and not a new enum, because that split already *is* what this app means by medium: it is how rankings are kept, how the collection screen filters, and what `rankable_category` maps a media kind onto. `'tv_seasons'` reads slightly oddly on a goal; two enums to keep in step by hand would read worse.

Own-read only, matching `user_media` rather than `rankings`. No specification has placed a goal on a shareable surface, and private is the half of that choice that can be widened later without having published anything first.

**How progress is counted — decided 2026-08-16, and deliberately not in the database.** The table stores the target and nothing counts against it in SQL. The rule lives in `src/features/goals/goals.ts`, where it can be read as prose and tested as arithmetic:

- **`watched_on` is the only clock.** Never `created_at`. The date a row entered Bingd is a fact about the app, and an import would otherwise credit a decade of watching to one afternoon.
- **A null `watched_on` counts for nothing.** Onboarding logs historical favourites with no date on purpose (§Onboarding), so this is a live case rather than a hypothetical.
- **A series never counts.** `rankable_category` returns null for a series and the TV goal counts seasons, so a nine-season show is neither one tick nor nine.
- **Distinct entities.** Counting is over `media_item_id`, so a rewatch is one. `user_media`'s primary key makes that true already; stating it here is what stops a future watch-history table turning a goal of 52 into a goal of 52 viewings.

> **Known limitation, recorded 2026-08-16 by independent review.** `user_media` holds **one** `watched_on` per `(user, media item)`, and `log_watched` replaces it when a non-null date is supplied. So a film watched in 2025 and rewatched in 2026 does not count once in each year: logging the rewatch moves its only recorded date forward, and 2025's count silently drops by one.
>
> This is not fixable without a watch-history table, and the founder decision that specified goals ruled that out in as many words — "do not create a complicated historical-backfill system; yearly goals are intentionally simple". It is accepted rather than overlooked.
>
> Its practical reach today is nil, because the only year any screen displays is the current one and a rewatch inside the current year cannot lose a count it is also adding. It becomes visible the day a year-in-review or a past-year selector ships, and that surface must not ship before this is resolved.
>
> **Design landed 2026-08-23, still not built.** [`../product/deferred-roadmap.md`](../product/deferred-roadmap.md) §19 is now the canonical answer: an append-only `watch_events` table, with `user_media.watched_on` kept as a denormalized *last watched* cache so every reader here keeps working and the migration stays reversible. §19.5 is explicit that repointing Goals and Awards at the new table is the step that actually fixes this paragraph, and that it is a **separate, later pass** rather than part of the schema migration. Until then the limitation stands exactly as written above.

There is no `watch_goal_progress` RPC, and that is a choice. Both halves are the caller's own rows under policies that already say so (`watch_goals_own`, `user_media_own`), so a function would be either a query with a grant attached or a screen's arithmetic promoted to `security definer` code taking a year from the client. The read is one person's own rows for one year, bounded by a range filter on `watched_on`.

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
  primary key (feed_event_id, user_id),
  constraint reactions_known_kind
    check (kind in ('love', 'agree', 'disagree', 'funny', 'wow', 'moved'))
);
```

The primary key on `reactions` enforces PRD §14's one-reaction-per-user rule at the database level. Changing a reaction is an upsert; removing it is a delete. **There is no text column**, which is what keeps reactions free of moderation surface.

> **Corrected 2026-08-13.** `kind` shipped as unconstrained `text`, which quietly undid that last guarantee: a column that accepts any string *is* a free-text field, whatever the client puts in it. The constraint closes it.
>
> Values are semantic rather than glyphs, for the same reason `taste_bucket` stores `loved` instead of `I liked it` — which emoji renders is a copy decision and should not be a data migration.
>
> **The set is a founder decision as of 2026-08-13** (PRD §14), and it includes `disagree`. An earlier inference left the negative reaction out, reasoning that a downvote counter is a pile-on mechanic. That reasoning applies to a public network; among a cohort of friends, disagreeing with someone's ranking is the mechanic the product is for. The safeguard is in the read path rather than the schema: **no query aggregates reactions onto a profile.** `disagree` is countable on the activity item it belongs to and nowhere else.

`feed_events.list_id` is declared as a bare `uuid` in the feed migration and gains its foreign key in `20260813000800` once `lists` exists, which is the only order the dependency allows. It was reported in review as missing; it is not. Noted because the constraint is not where a reader looks for it.

`payload` on `feed_events` holds a denormalized snapshot — the position at the time of ranking, the bucket, the tagged users. Denormalizing here is deliberate: a feed item should show what was true when it happened, and re-deriving a historical position from current data would be both expensive and wrong.

Feed reads use `can_view_profile` against `actor_id` (AD-6).

### `watchlist_added`, and the two lifetimes a feed event can have — `20260820000300`

Adding a title to the watchlist writes an event (PRD §14). Three things about it are worth stating here because they are the contract a future event type will be read against.

**It is written inside `set_watchlist`, in the same transaction as the `watchlist` row.** `feed_events` has no insert policy and never has; every event in this schema comes from a `security definer` function that authorised the caller first. Two writes would be two failure modes — a committed row with no event is an add nobody saw, an event with no row is a claim about a watchlist that does not hold it — and the operation ledger's idempotency only covers a writer it is inside of.

**Uniqueness is per type, by partial index:**

```sql
create unique index feed_events_watchlist_once
  on feed_events (actor_id, media_item_id)
  where type = 'watchlist_added';
```

Partial is the whole point. `title_ranked` must stay free to repeat — `_rank_finalize` writes a new one on every rerank and rebucket, and `20260817001100` reads the latest of many — while `watchlist_added` is one per pair. The insert repeats the predicate on its conflict target so Postgres can infer the index; without that it raises rather than choosing the wrong one, the same hazard `20260817000900` records.

**Two lifetimes.** A feed event is either a claim about *current state* or a record of a *past act*, and which one it is decides whether a state change should delete it:

| | Deleted when the state moves | Why |
|---|---|---|
| `title_ranked`, `title_logged`, `season_completed` | **Yes** — `unlog` removes them (`20260818000100`) | Each asserts the title is in the collection. Removal makes that a false claim about a person, and it is the one the app makes loudest. |
| `watchlist_added`, `list_added` | **No** | Neither asserts collection state. "Added it to their watchlist" is past tense and stays true after a remove, a watch or an unlog — and deleting it would cascade away other people's reactions and comments, ending a conversation because its subject changed their mind. |

So `_leave_watchlist` deleting the row when a title is watched leaves the activity standing, which is the intended outcome and required no code — only that nothing was added to remove it. A re-add after a remove restores the row and inherits the original event.

**Nothing was added to the read path**, which is what makes the privacy argument short: `feed_events_read` is type-independent, so the event is visible to exactly the accounts that may see the actor's rankings — and `20260820000200` set `watchlist`'s own select policy to the same visibility. `reactions_read`, `add_comment` and `set_reaction` all key on the event id and never on `type`, so a new type inherits the social controls by construction.

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

> **As built, 2026-08-19 — absence resolves to the *category's* default.** `20260819000300` replaced "absence means enabled" with `_notification_default(category)`, because `reactions` and `awards` default **off** and the old rule could not express that without a row per account per signup. Six of the eight categories still default on, so for those nothing changed. The paragraph above describes the v0.6 design.

> **As built, 2026-08-19 — a block is a barrier, not a filter.** Every writer that acts on a *pair* of accounts takes `_lock_pair` before the check that reads `follows` or `blocks`, and holds it through the `notifications` insert. Without it a writer's check passes, `block()` commits and deletes both inboxes, and the writer's row lands afterwards — a row that cannot exist under the product model, because `block` removes every row between the pair and every writer is refused thereafter.
>
> `20260819000400` brought `add_comment`, `set_reaction` and `set_watch_tags` under the rule the other seven writers already followed. The order is **check → lock → check again**: the pair is not known until the feed event has been read, and moving the check after the lock instead of repeating it makes the refusal *timeable*, which is an oracle rather than a refactor — see the migration header. `set_watch_tags` holds one lock per companion, **ordered by uuid**, because it is the only writer holding more than one.
>
> This is demonstrated rather than argued: `supabase/tests/concurrency` races real PostgreSQL sessions and correlates each wait against the exact advisory key the function computes. `npm run test:race`, and `npm run test:race:mutants` for the proof that removing the lock turns it red.
>
> **Still un-locked, and correctly so:** the per-day cap on `reports` (§10) is counted without a lock and is advisory by design; its idempotency is a partial unique index, which concurrency cannot defeat.

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

```sql
alter table match_scores enable row level security;

create policy match_scores_read on match_scores for select
  using (
    (user_a = auth.uid() and can_view_profile(auth.uid(), user_b))
    or (user_b = auth.uid() and can_view_profile(auth.uid(), user_a))
  );
```

The `user_a < user_b` constraint stores each pair once. Both indexes exist because a lookup may arrive from either side.

The read policy is the one place a single-subject visibility check is not enough, because a match row is about two people. A caller may read a row only if they are **one of the two parties** and can view the other, which satisfies PRD §13's rule that a match involving a private user is shown only to that user's approved followers — and also settles the leaderboard question without a second rule, since a private account simply produces no readable row for a non-follower.

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
  inviter_id   uuid references profiles(id) on delete set null,
  token_id     uuid references invite_tokens(id) on delete set null,
  accepted_at  timestamptz,
  activated_at timestamptz
);

create index on invite_attributions (inviter_id);
```

The partial unique index on `owner_id` enforces PRD §17's **one reusable personal link per user**. Regenerating revokes the old row and inserts a new one; the index permits any number of revoked rows and exactly one live one.

`invite_attributions` is keyed by `invitee_id` because a person is invited once. `activated_at` is set when the invitee ranks their first title, which is what makes the invite-to-activation metric in PRD §28 a single query — and what would make any future reward farm-resistant.

`env` prevents a nonprod token resolving in production (PRD §17).

> **Corrected 2026-08-13.** `inviter_id` was `not null ... on delete cascade`, so an inviter deleting their account destroyed the invitee's attribution row along with `activated_at`. Decision log §5 marks growth provenance **Required** — "impossible to reconstruct later," "Never remove" — so the cascade broke the one rule this table exists to satisfy, and it would have broken it silently and permanently.
>
> `inviter_id` now detaches instead. The attribution and activation facts survive; the departed account's identity does not, which is also the right privacy answer for someone who has asked to be deleted. `profiles.invited_by` already behaved this way, so the two are now consistent.

### When the attribution row is written — Required

PRD §17 tracks `invite_signup_attributed` and `invite_accepted` as **distinct** events, and `accepted_at` is nullable, so the lifecycle needs stating rather than inferring:

1. A row is inserted at **signup** when the account arrived through an invite link or short code, with `accepted_at` null. This is the referral fact.
2. `accepted_at` is set when the recipient **explicitly taps Accept**, which is also when the follow is created.
3. `activated_at` is set when the invitee ranks their first title.

A row with `accepted_at` null is therefore a real state — an attributed signup that has not yet accepted — which is what PRD §17 and api.md `block` mean by voiding a *pending* invitation. Without step 1 the two analytics events cannot be distinguished and the "pending invitation" language has no referent.

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
  operation_id uuid not null,
  user_id      uuid not null references profiles(id) on delete cascade,
  kind         text,
  processed_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
```

Every outbox-eligible RPC begins by inserting here. A duplicate key means the operation already ran, and the function answers `{"status": "already_applied"}` — not the prior result, which is not stored — and repeats no write. This is the whole of PRD §18's idempotency requirement, in one table.

**The key is per account, not global — corrected 2026-08-13.** `20260813000100` built it as `operation_id uuid primary key`, and `20260813002300` narrowed it when the first real callers arrived. Ids are generated on the device, so a shared key means an id disclosed by one account can silence another's genuine write while its client reports success. Idempotency only has to hold within one account's queue, so scoping it there costs nothing. The same migration added the foreign key this section had described all along, so a deleted account no longer leaves its ledger behind. `kind` records which function claimed the id, for debugging a stuck outbox.

**No prune job exists yet.** This section previously said rows older than 30 days were pruned by a scheduled job; nothing schedules anything. The `processed_at` index is in place for when one is written, and the table grows unbounded until then — a few rows per write per user, which is not a problem at alpha scale and is not a permanent answer.

---

## 13. Moderation and account status

Added 2026-08-13. PRD §22 marks reporting **Required** by policy, §23 lists a `reports` entity, and AC 26.15.5 requires a working report flow — but no `reports` table was ever created. Blocking shipped and reporting did not, which left the product carrying user-generated usernames, display names, and list titles with nowhere for a complaint about them to arrive. This is the largest single gap the review found, and it is a store-review and platform-obligation problem rather than a nice-to-have.

```sql
create table reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid references profiles(id) on delete set null,
  subject_type  report_subject not null,
  subject_id    uuid not null,
  subject_owner uuid references profiles(id) on delete set null,
  reason        text not null,
  note          text,
  state         report_state not null default 'open',
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
```

`reporter_id` detaches rather than cascading, because a harassment complaint must not disappear when its author leaves. A partial unique index allows **one open report per reporter per subject**: filing the same complaint fifty times is itself an abuse vector, and PRD §22 requires that reporting cannot be turned into harassment.

### Suspension

Before this, the only lever available against an account was deletion — which destroys the evidence needed to judge whether the deletion was right. `profiles.status` adds a reversible one:

```sql
create type profile_status as enum ('active', 'suspended');
alter table profiles add column status profile_status not null default 'active';
```

Suspension is threaded through `can_view_profile`, which is the entire payoff of AD-5. One clause hides a suspended account from the feed, the leaderboard, discovery, match scores, tagging, and the public web pages simultaneously, instead of seven separate changes that could each be forgotten. The self-check stays first, so a suspended user can still load their own profile and be told what happened.

Reads and writes are separate questions, so writes get their own guard. Every write RPC calls `assert_can_write()`, which refuses a suspended account with `BG403`. Without it a suspended user would go on ranking, following, and tagging into a void, and everything they did would appear at once the moment the suspension lifted.

> **The first draft of this defined `assert_can_write` and never called it from anywhere.** Suspension therefore stopped nothing, while this document read as though the account were contained — the same failure as the `date_of_birth` comment in §2, and arguably worse, because a safety control that silently does nothing is relied upon.
>
> The guard is applied by renaming each ranking RPC to an unguarded implementation and re-exposing it through a thin wrapper that calls `assert_can_write()` first. Wrapping rather than rewriting keeps the ranking logic in one migration; copying five hundred lines into the moderation migration would have produced two versions that immediately began to drift.
>
> **The wiring is asserted structurally**, not by inspection: a test queries `pg_proc.prosrc` for every client-facing `rank_*` function and fails if any of them lacks the call, and a second test confirms the unguarded implementations are not executable by client roles. A future write RPC that forgets the guard fails in CI rather than in production.

### Filing a report

There is no insert policy on `reports` and no client write grant anywhere in the schema, so `report(subject_type, subject_id, reason, note?)` is the only way a report can come into existence. An earlier draft created the table and no function, which is a mailbox with no slot.

**The subject's owner is resolved server-side** rather than accepted from the caller. Trusting a client-supplied owner would let anyone attribute a report to an account of their choosing, which is precisely the reporting-as-harassment vector PRD §22 names.

> **The subjects, and what `subject_id` means in each — extended 2026-08-25 (`20260825000100`).** `subject_id` is a single `uuid` column whose *meaning* depends on `subject_type`, and reading it as one kind of thing is the mistake that wastes an operator's time:
>
> | `subject_type` | `subject_id` | Owner resolved from |
> |---|---|---|
> | `profile`, `display_name`, `username` | `profiles.id` | itself |
> | `list`, `list_title` | `lists.id` | `lists.owner_id` |
> | `watch_tag` | `watch_tags.id` | `watch_tags.tagger_id` |
> | `comment` | `comments.id` | `comments.author_id` — the author, **not** the event's actor |
> | `review` | `user_media.id` | `user_media.user_id`, and only while the note is public |
>
> **A review needed a name before it could be a subject, and that is why `user_media` gained a surrogate `id`.** The column is unique and is *not* the primary key — `(user_id, media_item_id)` still is, and every writer still addresses rows by the pair. The alternative was to report a review by its `media_item_id`, which fails in a way no test would have caught by accident: two people's reviews of the same film collide on `reports_one_open_per_reporter`, so the second complaint a reporter filed about that title hits `on conflict do nothing` and is discarded **while the reporter is told it was received**. A moderation system that quietly drops the second report about a popular title is worse than one with no button, because the first one lies.
>
> **There is no subject for a private note and there must not be.** A private note has exactly one reader, so nobody else can be harmed by it and nobody else can report it; a subject would exist only to be probed — a way of asking the server whether a given row carries private writing, which is the question `public_notes` was written to refuse. The `review` branch resolves only while `note_visibility = 'public'`, which keeps that structural rather than merely intended.
>
> **The subject is stored as `review` rather than `note`** because that is the word the reporter saw on the button. An operator reading `moderation_queue` should not have to translate.

**Reporting is not gated on visibility**, only on the subject existing. An earlier draft of this section and the comment beside the function both claimed the opposite, and a review found the code had never done it. The behaviour is correct and the claim was wrong: the obvious gate would make an abuser unreportable the moment they blocked the person they abused, so being blocked after the fact would withdraw the ability to report it. The cost is that a caller can confirm a UUID names a real row, which is a fair trade.

**The per-day cap is advisory.** It is counted before the insert without a lock, so simultaneous calls from one reporter can exceed it slightly. Idempotency is not advisory — one open report per reporter per subject is held by a partial unique index, which concurrency cannot defeat.

Reporting the same subject twice is silently idempotent. Telling the reporter that a report already exists would disclose which of their earlier complaints is still open, which is not their business.

**`reaction` is deliberately not a reportable subject type.** Reactions come from a closed set of six values (PRD §14), so there is nothing in one to report; a reaction someone dislikes is a person they can block.

### The operator surface

Deliberately **not** an admin application. For a cohort of 30–60 alpha users, the operator surface is two `security_invoker` views — `moderation_queue` (open reports, worst-offender first) and `moderation_history` — read as `service_role` from the Supabase SQL editor, plus a `moderation_actions` table recording what was done and why. Building a console before there is any triage experience is the expensive way to find out what the console should contain.

What this defers, explicitly: no appeals flow, no user-facing notice on suspension beyond the state being visible on one's own profile, and no automated detection of any kind. All three are acceptable at alpha scale with a single operator and none are acceptable at mass market.

---

## 14. Index summary

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
| `media_items (fetched_at)` | Finding provider rows past the retention window |
| `reports (state, created_at)` | Moderation triage queue |

---

## 15. What this model makes impossible

The point of several choices above is that a violation cannot be written, not merely that it is forbidden.

| PRD requirement | Why violating it is hard |
|---|---|
| A position is never derived from a rating | The import path writes `user_media`; positions live in `rankings`, which it has no reason to open |
| A capability limit never deletes data | `resolve_capabilities` is called only from insert paths (AD-9) |
| Early Access grants cannot become permanent | `early_access_must_expire` check constraint |
| One reaction per user per item | Primary key on `(feed_event_id, user_id)` |
| Reactions carry no moderation surface | No text column exists, and `kind` is a closed set |
| A released username is never reusable, whether released by deletion or rename | `assert_username_available` refuses it, checking reservations written by `reserve_username_on_profile_delete` and `reserve_username_on_rename`. Not the `username_history` primary key, which this row credited until a review pointed out it only prevents duplicate history rows |
| Growth provenance is never destroyed | `invite_attributions.inviter_id` detaches instead of cascading |
| A suspended account is invisible everywhere at once | One clause in `can_view_profile` (AD-5) |
| A view cannot leak past RLS | Every view is `security_invoker` |
| One reusable invite link per user | Partial unique index on live rows |
| A token is never authorization | The resolver returns an object reference; visibility is applied afterward |
| A block overrides public visibility | The block test precedes the public test in `can_view_profile` |
| Two titles never share a position | Unique constraint on `(user_id, category, position)` |
| Tagging never alters the tagged user's collection | `watch_tags` references neither `user_media` nor `rankings` |
