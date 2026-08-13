-- Feed events and reactions.
-- Specification: docs/architecture/data-model.md §6 · AD-5, AD-6 · PRD §14

-- Fan-out on read (AD-5): one row per event, queried against the viewer's
-- follow set at read time. No per-user inbox to write to or keep consistent.
--
-- payload holds a denormalized snapshot — the position at the time of ranking,
-- the bucket, the tagged users. Deliberate: a feed item should show what was
-- true when it happened, and re-deriving a historical position from current data
-- would be both expensive and wrong.
create table feed_events (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid not null references profiles(id) on delete cascade,
  type          text not null,
  media_item_id uuid references media_items(id) on delete cascade,
  list_id       uuid,
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now(),

  constraint feed_events_known_type check (type in (
    'title_ranked',
    'title_logged',
    'season_completed',
    'list_created',
    'list_added',
    'milestone_reached',
    'joined_from_invitation'
  ))
);

create index feed_events_actor on feed_events (actor_id, created_at desc);
create index feed_events_recent on feed_events (created_at desc);

-- The primary key enforces PRD §14's one-reaction-per-user rule at the database
-- level. Changing a reaction is an upsert; removing it is a delete.
--
-- There is deliberately no text column, which is what keeps reactions free of
-- moderation surface.
create table reactions (
  feed_event_id uuid not null references feed_events(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  kind          text not null,
  created_at    timestamptz not null default now(),
  primary key (feed_event_id, user_id)
);

create index reactions_event on reactions (feed_event_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table feed_events enable row level security;
alter table reactions   enable row level security;

-- Feed reads authorize against the actor (AD-6). Unfollowing removes future
-- events from a viewer's feed; it does not retroactively rewrite history the
-- viewer already saw, because visibility is evaluated per read.
create policy feed_events_read on feed_events for select
  using (can_view_profile(auth.uid(), actor_id));

create policy reactions_read on reactions for select
  using (
    can_view_profile(auth.uid(), user_id)
    and exists (
      select 1 from feed_events e
       where e.id = feed_event_id
         and can_view_profile(auth.uid(), e.actor_id)
    )
  );
