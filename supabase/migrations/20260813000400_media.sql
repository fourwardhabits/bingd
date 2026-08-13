-- Media catalog: one table for movies, series, and seasons.
-- Specification: docs/architecture/data-model.md §4 · AD-1 · PRD §19

-- Only 'movie' and 'season' rows are ever rankable. Series exist for browsing
-- and grouping, because PRD §10 forbids ranking a whole series.
--
-- The rankable category is derived, never stored: movie -> movies,
-- season -> tv_seasons. See rankable_category() below.
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

create unique index media_items_tmdb on media_items (kind, tmdb_id)
  where kind in ('movie', 'series');
create unique index media_items_season on media_items (parent_id, season_number)
  where kind = 'season';
create index media_items_genres on media_items using gin (genres);
create index media_items_title on media_items (title text_pattern_ops);

-- Artwork is referenced by path and served from the provider CDN, never
-- rehosted on Bingd infrastructure (PRD §19).
comment on column media_items.poster_path is
  'Provider path only. Artwork is served from the provider CDN, never rehosted.';

-- fetched_at drives the rolling refresh that keeps provider-derived metadata
-- under the retention window in app_config (AD-8).
comment on column media_items.fetched_at is
  'Drives rolling refresh under tmdb.metadata_max_age_days. Bingd''s own collection data has no such limit.';

create or replace function rankable_category(k media_kind)
returns ranking_category
language sql immutable
as $$
  select case k
    when 'movie'  then 'movies'::ranking_category
    when 'season' then 'tv_seasons'::ranking_category
    else null  -- series are not rankable (PRD §10)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Facet cache
--
-- expires_at is computed by the adapter from app_config, not from a constant,
-- so the retention window moves without a migration.
-- ---------------------------------------------------------------------------

create table media_cache (
  media_item_id uuid not null references media_items(id) on delete cascade,
  facet         text not null,
  payload       jsonb not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (media_item_id, facet),
  constraint media_cache_known_facet
    check (facet in ('credits', 'keywords', 'providers', 'similar'))
);

create index media_cache_expiry on media_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Catalog metadata is not user data. This is the only unrestricted read in the
-- schema, and it is deliberate.
-- ---------------------------------------------------------------------------

alter table media_items enable row level security;
alter table media_cache enable row level security;

create policy media_items_read on media_items for select using (true);
create policy media_cache_read on media_cache for select using (true);
