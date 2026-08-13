-- Foundation: extensions, enumerations, runtime configuration, idempotency.
-- Specification: docs/architecture/data-model.md §1, §12

-- citext gives case-insensitive usernames, so a lookup does not depend on every
-- caller remembering to lowercase its input.
--
-- gen_random_uuid() is core Postgres from 13 onward and needs no extension.
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Enumerations (data-model.md §1)
--
-- taste_bucket stores 'loved' / 'fine' / 'not_for_me', never the user-facing
-- labels. open-questions.md §3 expects those labels to be reworded after user
-- testing, and storing display strings would turn a copy change into a data
-- migration.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Runtime configuration (AD-8, AD-10)
--
-- Tuning values live here rather than in constants because PRD §13 requires
-- them to be "configurable and versioned rather than hard-coded", and because a
-- change in TMDB's terms should move a retention window without a migration.
-- ---------------------------------------------------------------------------

create table app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_config enable row level security;

-- Read-only to clients, and only for keys the client legitimately needs. There
-- is no client write path: configuration changes are an operator action.
create policy app_config_read on app_config for select
  using (key like 'public.%');

insert into app_config (key, value) values
  -- AD-10: push delivery is built in v1 but off. Flipping this is an operator
  -- action, not a deploy.
  ('push.delivery_enabled', 'false'::jsonb),

  -- AD-8 / TMDB terms: all provider-derived retention stays under six months.
  -- See docs/reference/tmdb-integration.md.
  ('tmdb.metadata_max_age_days', '150'::jsonb),
  ('tmdb.cache_ttl_hours', '{"availability": 12, "credits": 720, "keywords": 720, "similar": 168}'::jsonb),

  -- PRD §10: after three skips the title is placed at the midpoint.
  ('ranking.max_skips', '3'::jsonb),

  -- PRD §11: the "rank a few more" prompt quiets around here. The server always
  -- answers honestly; the client decides whether to ask.
  ('ranking.nudge_quiet_after', '50'::jsonb),

  -- PRD §20: the free tier's in-app list ceiling.
  ('lists.base_free_limit', '3'::jsonb),

  -- PRD §14: tag fan-out cap per watch.
  ('tagging.max_per_watch', '10'::jsonb),

  -- data-model.md §9: below this overlap no match score row is written, and the
  -- UI shows no match rather than a meaningless number.
  ('match.min_shared_titles', '5'::jsonb),

  ('public.min_supported_build', '1'::jsonb);

-- ---------------------------------------------------------------------------
-- Idempotency (PRD §18)
--
-- Every outbox-eligible RPC inserts here first. A duplicate key means the
-- operation already ran, so the function returns without repeating the write.
-- Rows older than 30 days are pruned by a scheduled job.
-- ---------------------------------------------------------------------------

create table processed_operations (
  operation_id uuid primary key,
  user_id      uuid not null,
  processed_at timestamptz not null default now()
);

create index processed_operations_pruning on processed_operations (processed_at);

alter table processed_operations enable row level security;
-- No policy: clients never read or write this table directly. Absence of a
-- policy means no access (data-model.md conventions).
