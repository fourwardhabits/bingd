-- Notifications: inbox, preferences, and device tokens.
-- Specification: docs/architecture/data-model.md §7 · AD-10 · PRD §15

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

create index notifications_recipient on notifications (recipient_id, created_at desc);
create index notifications_unread on notifications (recipient_id) where read_at is null;

-- Preferences default to enabled by absence: a missing row means enabled. This
-- avoids writing a row per category per signup, and avoids a backfill every time
-- a category is added.
create table notification_preferences (
  user_id  uuid not null references profiles(id) on delete cascade,
  category text not null,
  enabled  boolean not null default true,
  primary key (user_id, category)
);

-- Populated in v1 even though push delivery is off (AD-10). Collecting tokens
-- from the start means enabling push does not begin with an empty table and a
-- wait for every user to reopen the app.
create table device_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index device_tokens_user on device_tokens (user_id) where revoked_at is null;

alter table notifications             enable row level security;
alter table notification_preferences  enable row level security;
alter table device_tokens             enable row level security;

create policy notifications_own on notifications for select
  using (recipient_id = auth.uid());

create policy notification_preferences_own on notification_preferences for select
  using (user_id = auth.uid());

-- No read policy on device_tokens. A push token is an operational secret with no
-- reason to reach a client, including its owner's.
