-- Identity: profiles and the username redirect window.
-- Specification: docs/architecture/data-model.md §2 · PRD §8, §22

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

comment on column profiles.visibility is
  'Defaults to public per PRD §22.';

-- Flipped to false by a migration when paid beta opens. Defaulting to true
-- means no backfill is needed if that date moves (PRD §17).
comment on column profiles.founding_member is
  'Every account created before paid beta qualifies. Default true avoids a backfill.';

-- Stored to enforce the 13+ gate (PRD §22). Never exposed by any read policy and
-- never present in an API response, including the owner's own. Only the derived
-- boolean below is reachable.
comment on column profiles.date_of_birth is
  'Never returned by any API. Use is_over_13().';

create index profiles_invited_by on profiles (invited_by) where invited_by is not null;

-- ---------------------------------------------------------------------------
-- The 90-day username redirect (INF-2)
--
-- A username resolves if it is live in profiles, or present here with
-- redirect_until > now(). Rows are retained past redirect_until, so the primary
-- key blocks reuse permanently: a released username never returns to the
-- available pool.
-- ---------------------------------------------------------------------------

create table username_history (
  username       citext primary key,
  profile_id     uuid not null references profiles(id) on delete cascade,
  released_at    timestamptz not null default now(),
  redirect_until timestamptz not null
);

create index username_history_profile on username_history (profile_id);

-- ---------------------------------------------------------------------------
-- Derived age check
--
-- A function rather than a column so date_of_birth never needs to leave the
-- database to answer the only question the product asks of it.
-- ---------------------------------------------------------------------------

create or replace function is_over_13(target uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select date_of_birth <= (current_date - interval '13 years')
    from profiles where id = target;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table username_history enable row level security;

-- Profile rows are readable subject to the visibility helper in the next
-- migration. Until it exists, the owner-only policy below is the floor; the
-- broader policy is added in 20260813000300 once blocks and follows exist.
create policy profiles_read_own on profiles for select
  using (id = auth.uid());

-- No insert, update, or delete policy on any table in this schema. Writes go
-- through SECURITY DEFINER functions so RLS and invariants are enforced in one
-- place (AD-4).
