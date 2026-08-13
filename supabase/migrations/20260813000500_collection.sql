-- Collection: the Logged and Ranked two-state model.
-- Specification: docs/architecture/data-model.md §5 · docs/architecture/ranking.md
--
-- This is the most important structural decision in the schema. Two tables
-- rather than one table with a nullable position, because with one table the
-- import path and the ranking path write the same rows and nothing but
-- discipline stops an import from setting a position.
--
-- With two, the import worker has no reason to open `rankings` at all — which is
-- what makes PRD Principle 3 ("a position is never derived from a rating")
-- impossible to violate rather than merely forbidden.

-- LOGGED. Watched, optionally bucketed. No position, ever.
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

-- Serves the unranked queue, highest bucket first (PRD §11, ranking.md §10).
create index user_media_bucket on user_media (user_id, bucket)
  where bucket is not null;

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

-- I4: no two titles share a position.
--
-- Deferrable because insertion shifts every position at or below the insertion
-- point, and that UPDATE transiently produces two rows with the same position.
-- A deferred constraint checks at commit, by which time the shift is complete.
create unique index rankings_position_unique
  on rankings (user_id, category, position);

alter table rankings add constraint rankings_position_unique
  unique using index rankings_position_unique deferrable initially deferred;

create index rankings_lookup on rankings (user_id, category, position);

-- bucket appears on both tables: on user_media it is the user's reaction, on
-- rankings it identifies the band. The ranking RPCs are the only writers of
-- either, which is what keeps them in step (I3).

-- ---------------------------------------------------------------------------
-- Comparison history
--
-- Recorded for analytics and future recalibration. The ranking itself is derived
-- from rankings.position, never replayed from this table.
-- ---------------------------------------------------------------------------

create table comparisons (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  winner_id  uuid not null references media_items(id) on delete cascade,
  loser_id   uuid not null references media_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint no_self_comparison check (winner_id <> loser_id)
);

create index comparisons_user on comparisons (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Insertion sessions (ranking.md §2)
--
-- A comparison sequence spans several round trips, and PRD §12 requires the
-- post-import anchor session to be resumable. So the search state lives on the
-- server rather than in the client.
--
-- lo and hi bound the *insertion point*, not the candidate range. The invariant
-- is that the correct final position lies in [lo, hi]. When lo = hi the search
-- is over.
--
-- These are not the outbox. They are server state for an online-only operation:
-- with no connectivity a session can neither be created nor advanced (PRD §18).
-- ---------------------------------------------------------------------------

create table ranking_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  category      ranking_category not null,
  bucket        taste_bucket not null,
  lo            integer not null,
  hi            integer not null,
  history       jsonb   not null default '[]',
  skips         smallint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Starting a session for a title that already has one resumes it rather than
  -- restarting. Resumability satisfied by a constraint rather than by logic.
  unique (user_id, media_item_id),
  constraint session_range_valid check (lo <= hi)
);

create table watchlist (
  user_id       uuid not null references profiles(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id)
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table user_media       enable row level security;
alter table rankings         enable row level security;
alter table comparisons      enable row level security;
alter table ranking_sessions enable row level security;
alter table watchlist        enable row level security;

-- Rankings are the shareable surface: they carry a position and a bucket band,
-- both of which are public information on a public profile.
create policy rankings_read on rankings for select
  using (can_view_profile(auth.uid(), user_id));

-- user_media is stricter, because it carries note and watched_on, which PRD §22
-- classifies as always-private. Other users never read this table; the bucket is
-- exposed through rankings instead.
create policy user_media_own on user_media for select
  using (user_id = auth.uid());

create policy watchlist_own on watchlist for select
  using (user_id = auth.uid());

create policy comparisons_own on comparisons for select
  using (user_id = auth.uid());

create policy ranking_sessions_own on ranking_sessions for select
  using (user_id = auth.uid());
