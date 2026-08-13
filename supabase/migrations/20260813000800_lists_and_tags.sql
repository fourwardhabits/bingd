-- Lists, list items, and watch tagging.
-- Specification: docs/architecture/data-model.md §6 · PRD §12, §14

-- source is what makes the three-list limit measurable. PRD §12 requires all
-- lists to import regardless of the limit, and PRD §28 requires the ceiling
-- metric to count in-app creation only. The limit check counts
-- `where source = 'in_app'`, so an importer with fifteen lists is not blocked by
-- their own history, and the monetization signal is not washed out by it.
create table lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  title       text not null,
  description text,
  visibility  list_visibility not null default 'private',
  source      content_source not null default 'in_app',
  created_at  timestamptz not null default now()
);

create index lists_owner_source on lists (owner_id, source);

create table list_items (
  list_id       uuid not null references lists(id) on delete cascade,
  media_item_id uuid not null references media_items(id) on delete cascade,
  position      integer not null,
  added_at      timestamptz not null default now(),
  primary key (list_id, media_item_id)
);

create index list_items_order on list_items (list_id, position);

alter table feed_events
  add constraint feed_events_list_fk
  foreign key (list_id) references lists(id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Watch tagging (PRD §14)
--
-- A tag is a row on the *tagger's* watch. It has no effect on the tagged user's
-- collection — structurally guaranteed, because nothing in this table references
-- user_media or rankings.
--
-- removed_by_tagged hides the tag without altering the tagger's log, which is
-- exactly the behaviour the PRD specifies.
--
-- The per-watch tag cap and the follow-relationship requirement are enforced in
-- the tagging RPC, since both are multi-row conditions.
-- ---------------------------------------------------------------------------

create table watch_tags (
  id                uuid primary key default gen_random_uuid(),
  tagger_id         uuid not null references profiles(id) on delete cascade,
  tagged_id         uuid not null references profiles(id) on delete cascade,
  media_item_id     uuid not null references media_items(id) on delete cascade,
  removed_by_tagged boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (tagger_id, tagged_id, media_item_id),
  constraint no_self_tag check (tagger_id <> tagged_id)
);

create index watch_tags_tagged on watch_tags (tagged_id) where not removed_by_tagged;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table lists      enable row level security;
alter table list_items enable row level security;
alter table watch_tags enable row level security;

-- A private list is owner-only. A 'link' list is readable by anyone holding the
-- reference, which is a named visibility level rather than a token bypass: the
-- server still authorizes the request, against a level that happens to permit
-- link bearers (PRD §16).
create policy lists_read on lists for select
  using (
    owner_id = auth.uid()
    or (visibility in ('public', 'link') and can_view_profile(auth.uid(), owner_id))
  );

create policy list_items_read on list_items for select
  using (exists (
    select 1 from lists l
     where l.id = list_id
       and (
         l.owner_id = auth.uid()
         or (l.visibility in ('public', 'link') and can_view_profile(auth.uid(), l.owner_id))
       )
  ));

create policy watch_tags_read on watch_tags for select
  using (
    tagger_id = auth.uid()
    or tagged_id = auth.uid()
    or (not removed_by_tagged and can_view_profile(auth.uid(), tagger_id))
  );
