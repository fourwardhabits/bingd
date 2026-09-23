-- Lists v1 — the backend.
-- Specification: docs/product/lists-prd.md §E (data model), §F (visibility), §K
-- (utility behaviour), §N (QA). PR L1 of the six in §O.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS ALREADY HERE, AND WHY THIS IS AN ALTER RATHER THAN A CREATE
-- ---------------------------------------------------------------------------
--
-- `lists`, `list_items`, the `list_visibility` enum, the report subjects `list` and
-- `list_title`, the account-deletion cascade, the catalogue-retention rule and the
-- `feed_events.list_id` foreign key have all been deployed to staging and production
-- since 20260813000800. None of them ever had a writer, so the tables are empty and
-- the feature has never existed above the schema.
--
-- Applied migrations are immutable, so the two tables are altered here rather than
-- corrected there, and the two functions that already read a link list
-- (`list_by_id`, `list_items_by_list`) are **redefined** with their existing
-- signatures and grants rather than dropped. That matters more than it looks: they
-- are granted to `anon`, they are pinned by `function-grants.test.mjs`, and a second
-- readability rule living inside them is exactly how a privacy model comes to
-- disagree with itself. After this migration there is one predicate and four callers.
--
-- ---------------------------------------------------------------------------
-- THE ONE RULE
-- ---------------------------------------------------------------------------
--
-- `_list_readable(list, viewer)` is §F's matrix, in one place, granted to nobody.
-- Every reader in this file calls it. The two things worth saying out loud about it:
--
--   - **`link` deliberately skips `can_view_profile`.** That is the object-level
--     sharing exception (PRD §P.2): holding the URL grants exactly one list and its
--     items, and nothing else about the owner. It still honours a moderation hide, a
--     suspension, and — for a signed-in viewer — a block.
--
--   - **`public` still goes through `can_view_profile`.** The writers refuse `public`
--     while the owner's profile is private, so under normal operation this equals
--     "the profile is public". The case it exists for is the legacy one: a profile
--     made private *after* publishing a list, where the list follows the profile's
--     audience rather than being silently rewritten (§F.4).
--
-- The `lists_read` select policy keeps its shape — owner, or `public` plus
-- `can_i_view(owner)` — and gains `hidden_at is null`. It never admits `link`, which
-- is what keeps link lists un-enumerable (20260813001400 §4). `list_items_read`
-- mirrors it.

-- ---------------------------------------------------------------------------
-- 1. The tables
-- ---------------------------------------------------------------------------

alter table lists
  add column if not exists updated_at  timestamptz not null default now(),
  -- 'by_my_ranking' is reserved and not accepted: a live slice of the owner's
  -- ranking is a different object from a list of titles they chose, and PRD §D
  -- rules it out of v1. The check is written so that adding it later is one
  -- migration and no data change.
  add column if not exists order_style text not null default 'unranked',
  -- Moderation hide (runbook §2d). Null is the normal state. It is not a visibility
  -- level: it outranks every one of them, and the owner still sees the list.
  add column if not exists hidden_at   timestamptz;

alter table lists
  drop constraint if exists lists_order_style_known;
alter table lists
  add constraint lists_order_style_known
  check (order_style in ('ranked', 'unranked'));

-- Length bounds on the two free-text columns. They are declared rather than checked
-- in the writers because a CHECK cannot be forgotten by a second writer, and because
-- `23514` is already in the client's refusal set (`lib/write-outcome.ts`).
alter table lists
  drop constraint if exists lists_title_length;
alter table lists
  add constraint lists_title_length
  check (char_length(btrim(title)) between 1 and 100);

alter table lists
  drop constraint if exists lists_description_length;
alter table lists
  add constraint lists_description_length
  check (description is null or char_length(description) <= 1000);

-- The My lists sort key, and the only index that screen needs.
create index if not exists lists_owner_recent on lists (owner_id, updated_at desc);

/**
 * Positions are unique within a list, deferrably.
 *
 * `move_list_item` renumbers a run of rows in one statement, and the intermediate
 * states of that statement necessarily collide. Deferring to commit is what lets the
 * move be a single `update` rather than a shuffle through a temporary offset — and
 * the constraint is still real, so two devices cannot leave a list with two items
 * claiming the same slot.
 */
alter table list_items
  drop constraint if exists list_items_position_unique;
alter table list_items
  add constraint list_items_position_unique
  unique (list_id, "position") deferrable initially deferred;

/**
 * Where the web page's opens are counted. A copy of `invite_link_opens`.
 *
 * No IP, no user agent, no referrer, and no viewer id — this answers "did anybody
 * open the link", which is the §M success metric, and nothing about who. Its only
 * writer is `record_list_open`, and clients cannot reach the table at all.
 */
create table if not exists list_web_opens (
  id        uuid primary key default gen_random_uuid(),
  list_id   uuid not null references lists(id) on delete cascade,
  platform  text,
  opened_at timestamptz not null default now()
);

create index if not exists list_web_opens_recent on list_web_opens (list_id, opened_at desc);

alter table list_web_opens enable row level security;

-- No policy at all, which is the point: RLS with no policy denies every client read,
-- and the operator reads it as service_role. `revoke` is belt and braces against the
-- default privileges Supabase hands out (20260813001800's lesson).
revoke all on list_web_opens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The one readability predicate
-- ---------------------------------------------------------------------------

create or replace function _list_readable(p_list_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- coalesce, so a list that does not exist answers false rather than null. Every
  -- caller treats this as a boolean, and a null that propagated into an `and` would
  -- read as "not false" in some of them.
  select coalesce((
    select case
      -- The owner sees their own list in every state, including hidden — they get a
      -- banner rather than a disappearance (§F.10).
      when l.owner_id = p_viewer then true
      when l.hidden_at is not null then false
      when (select p.status from profiles p where p.id = l.owner_id) <> 'active' then false
      -- Signed-in only. A logged-out reader cannot be matched to a block, which is
      -- stated as an accepted bound in §F.7 rather than papered over here.
      when p_viewer is not null and blocked_between(p_viewer, l.owner_id) then false
      when l.visibility = 'private' then false
      -- The object-level exception. See the header.
      when l.visibility = 'link' then true
      else can_view_profile(p_viewer, l.owner_id)
    end
    from lists l
   where l.id = p_list_id
  ), false);
$$;

comment on function _list_readable(uuid, uuid) is
  'The whole of lists-prd.md §F, in one place. Every list reader calls it, including the two that predate it. Internal, and granted to nobody: it takes a viewer, so a client grant would turn it into a block-graph and follow-graph oracle in exactly the way can_view_profile was (20260813001900).';

revoke execute on function _list_readable(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The select policies gain the moderation hide
-- ---------------------------------------------------------------------------
--
-- Shape unchanged from 20260813001900. `link` stays out, which is what keeps it
-- un-enumerable, and a hidden list leaves the discoverable set for everyone but its
-- owner.

drop policy if exists lists_read on lists;
create policy lists_read on lists for select
  using (
    owner_id = auth.uid()
    or (visibility = 'public' and hidden_at is null and can_i_view(owner_id))
  );

drop policy if exists list_items_read on list_items;
create policy list_items_read on list_items for select
  using (exists (
    select 1 from lists l
     where l.id = list_id
       and (
         l.owner_id = auth.uid()
         or (l.visibility = 'public' and l.hidden_at is null and can_i_view(l.owner_id))
       )
  ));

-- ---------------------------------------------------------------------------
-- 4. The two existing readers, redefined onto the predicate
-- ---------------------------------------------------------------------------
--
-- Same signatures, same grants, same returned columns. What changes is that they can
-- no longer disagree with `list_view`: both gated `link` on `can_view_profile`, which
-- has not matched the approved semantics since §P.2 was decided. Their removal is a
-- later cleanup, once nothing calls them.

create or replace function list_by_id(target uuid)
returns table (
  id          uuid,
  owner_id    uuid,
  title       text,
  description text,
  visibility  list_visibility,
  created_at  timestamptz
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.id, l.owner_id, l.title, l.description, l.visibility, l.created_at
    from lists l
   where l.id = target
     and _list_readable(l.id, auth.uid());
$$;

comment on function list_by_id is
  'The original read path for a link-visibility list, kept for compatibility and redefined onto _list_readable so it cannot disagree with list_view. New clients call list_view, which answers the owner block and the viewer flags this one has no columns for.';

grant execute on function list_by_id(uuid) to anon, authenticated;

create or replace function list_items_by_list(target uuid)
returns table (
  media_item_id uuid,
  "position"    integer,
  added_at      timestamptz
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select li.media_item_id, li.position, li.added_at
    from list_items li
   where li.list_id = target
     and _list_readable(target, auth.uid())
   order by li.position;
$$;

grant execute on function list_items_by_list(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Limits
-- ---------------------------------------------------------------------------
--
-- `lists.base_free_limit` is **not** in this set, and the row that already exists is
-- re-commented rather than deleted. See §M and §P.1: the three-list cap is a
-- hypothetical that is *measured* on every creation and never enforced, never shown
-- and never branched on by a client. Deleting the row would lose the number the
-- measurement is defined against.

insert into app_config (key, value) values
  ('lists.max_per_user',       '100'::jsonb),
  ('lists.max_items',          '500'::jsonb),
  ('lists.max_created_per_day', '20'::jsonb),
  ('lists.max_opens_per_list_per_minute', '60'::jsonb)
on conflict (key) do nothing;

comment on table app_config is
  'Server-side knobs. Note lists.base_free_limit: it is HYPOTHETICAL. Nothing enforces it, nothing shows it, and no client branches on it -- create_list returns in_app_count_before so the product can measure how many creations *would* have been refused under a three-list cap (lists-prd.md §M). The only enforced list count is lists.max_per_user.';

-- One reader for the three integer knobs, so a missing row is a documented fallback
-- rather than a null that silently disables a limit.
create or replace function _list_config(p_key text, p_fallback integer)
returns integer
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select (value)::integer from app_config where key = p_key), p_fallback);
$$;

revoke execute on function _list_config(text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Writers
-- ---------------------------------------------------------------------------
--
-- Every one takes `p_operation_id`, goes through the ledger, and calls
-- `assert_can_write` first. The ones whose *answer* matters on a replay
-- (`create_list`, `add_list_item`) use `_claim_operation_result` and record what they
-- said, so a lost reply retried with the same id is answered identically rather than
-- refused — which for `create_list` is the difference between one list and two.

/**
 * True when the caller's own profile is private.
 *
 * Its own function because three writers ask, and "public requires a public profile"
 * (§F.3) is the kind of rule that grows a second spelling the third time it is typed.
 */
create or replace function _profile_is_private(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p.visibility = 'private' from profiles p where p.id = p_user_id), true);
$$;

revoke execute on function _profile_is_private(uuid) from public, anon, authenticated;

create or replace function create_list(
  p_operation_id       uuid,
  p_title              text,
  p_description        text default null,
  p_visibility         list_visibility default 'private',
  p_order_style        text default 'unranked',
  p_first_media_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim   record;
  v_count   integer;
  v_id      uuid;
  v_title   text;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'create_list');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  -- Spam guard, counted from the ledger like every other rate in this schema.
  perform _assert_operation_rate(
    'create_list', 'lists.max_created_per_day', 20, interval '1 day');

  v_title := btrim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception 'a list needs a title' using errcode = '22023';
  end if;

  if p_order_style not in ('ranked', 'unranked') then
    raise exception 'unknown order style' using errcode = '22023';
  end if;

  -- **Counted before the insert, and returned.** This is the source of truth for
  -- `would_have_exceeded_3_lists` (§M): a later SQL snapshot cannot see a list that
  -- was created and then deleted, so the number has to leave the server at the moment
  -- of creation.
  --
  -- `source = 'in_app'` only. PRD §12 exempts imported lists from every count, so an
  -- importer arriving with fifteen Letterboxd lists is neither blocked by their own
  -- history nor allowed to wash out the monetisation signal.
  select count(*) into v_count
    from lists
   where owner_id = auth.uid() and source = 'in_app';

  if v_count >= _list_config('lists.max_per_user', 100) then
    -- A sanity ceiling, not a tier. The copy the client shows is "You've reached the
    -- maximum number of lists."
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'list_limit', 'in_app_count_before', v_count));
  end if;

  if p_visibility = 'public' and _profile_is_private(auth.uid()) then
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'profile_private', 'in_app_count_before', v_count));
  end if;

  insert into lists (owner_id, title, description, visibility, order_style)
  values (
    auth.uid(),
    v_title,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_visibility,
    p_order_style
  )
  returning id into v_id;

  -- The zero-lists path: ⋯ → Add to list… on a title with no lists yet opens New list
  -- with that title already chosen, and one round trip is what makes that one act.
  if p_first_media_item_id is not null then
    perform _add_list_item_unchecked(v_id, p_first_media_item_id);
  end if;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object(
      'status', 'ok',
      'id', v_id,
      'in_app_count_before', v_count));
end;
$$;

comment on function create_list(uuid, text, text, list_visibility, text, uuid) is
  'Creates one list for the caller. Refuses public while the caller''s profile is private (profile_private), and refuses past lists.max_per_user (list_limit); both are returned as a status rather than raised, so the client can say which happened. in_app_count_before is the measurement behind would_have_exceeded_3_lists and counts in-app lists only -- imported lists are exempt per PRD §12. Idempotent by the operation ledger, and the answer is stored, so a retry after a lost reply returns the first list rather than creating a second.';

grant execute on function create_list(uuid, text, text, list_visibility, text, uuid) to authenticated;

/**
 * The insert half of `add_list_item`, with no authorisation of its own.
 *
 * Internal and deliberately unchecked: both callers have already established that the
 * caller owns the list — `create_list` because it just made it, `add_list_item`
 * because it asked. Duplicating the ownership test here would be a second copy of the
 * rule, and the danger of a helper like this is a third caller, so it is revoked from
 * every client role and named for what it does not do.
 */
create or replace function _add_list_item_unchecked(p_list_id uuid, p_media_item_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  media_kind;
  v_count integer;
  v_next  integer;
begin
  -- Raises P0002 for a title that does not exist, which is the same answer every
  -- other writer in this schema gives.
  v_kind := _media_kind(p_media_item_id);

  -- Movies, seasons and whole series, and nothing else. A series is not *loggable*
  -- (AD-1) and is perfectly listable: "watch The Bear" is a thing somebody means.
  if v_kind not in ('movie', 'season', 'series') then
    raise exception 'that kind of title cannot go in a list' using errcode = '22023';
  end if;

  if exists (select 1 from list_items
              where list_id = p_list_id and media_item_id = p_media_item_id) then
    return 'already';
  end if;

  select count(*) into v_count from list_items where list_id = p_list_id;
  if v_count >= _list_config('lists.max_items', 500) then
    return 'item_limit';
  end if;

  -- Appended. `position` is a stored integer with gaps; the number a reader sees is
  -- the read-time ordinal, so a removal never leaves a hole on screen (§E).
  select coalesce(max("position"), 0) + 1 into v_next
    from list_items where list_id = p_list_id;

  insert into list_items (list_id, media_item_id, "position")
  values (p_list_id, p_media_item_id, v_next);

  update lists set updated_at = now() where id = p_list_id;

  return 'added';
end;
$$;

revoke execute on function _add_list_item_unchecked(uuid, uuid) from public, anon, authenticated;

/**
 * Resolves a list the caller owns, or raises.
 *
 * One function so that every owner-only writer refuses in exactly the same way, with
 * the same SQLSTATE, and so that "not yours" and "does not exist" are one answer. A
 * writer that distinguished them would confirm that a uuid names a real list.
 */
create or replace function _own_list(p_list_id uuid)
returns lists
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_list lists;
begin
  select * into v_list from lists where id = p_list_id and owner_id = auth.uid();

  if v_list.id is null then
    raise exception 'no such list' using errcode = 'P0002';
  end if;

  return v_list;
end;
$$;

revoke execute on function _own_list(uuid) from public, anon, authenticated;

create or replace function update_list(
  p_operation_id uuid,
  p_list_id      uuid,
  p_title        text            default null,
  p_description  text            default null,
  p_visibility   list_visibility default null,
  p_order_style  text            default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_list  lists;
  v_title text;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'update_list') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  v_list := _own_list(p_list_id);

  -- A hidden list is frozen at whatever it was when an operator hid it. Letting the
  -- owner flip it to private and back would be a way to launder a moderated list
  -- into a fresh audience (runbook §2d).
  if v_list.hidden_at is not null
     and p_visibility is not null
     and p_visibility <> v_list.visibility then
    return jsonb_build_object('status', 'hidden');
  end if;

  if p_visibility = 'public' and _profile_is_private(auth.uid()) then
    return jsonb_build_object('status', 'profile_private');
  end if;

  if p_order_style is not null and p_order_style not in ('ranked', 'unranked') then
    raise exception 'unknown order style' using errcode = '22023';
  end if;

  if p_title is not null then
    v_title := btrim(p_title);
    if v_title = '' then
      raise exception 'a list needs a title' using errcode = '22023';
    end if;
  end if;

  update lists
     set title       = coalesce(v_title, title),
         -- An explicit empty description clears it; a null argument leaves it alone.
         -- Those are two different intentions and the sheet can express both.
         description = case
                         when p_description is null then description
                         else nullif(btrim(p_description), '')
                       end,
         visibility  = coalesce(p_visibility, visibility),
         order_style = coalesce(p_order_style, order_style),
         updated_at  = now()
   where id = p_list_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function update_list(uuid, uuid, text, text, list_visibility, text) is
  'Owner-only edit of one list''s title, description, visibility and order style. A null argument leaves a field alone; an empty description clears it. Refuses public while the profile is private (profile_private) and refuses any visibility change while the list is hidden by moderation (hidden). Toggling order_style never reorders anything -- it only decides whether numbers are drawn.';

grant execute on function update_list(uuid, uuid, text, text, list_visibility, text) to authenticated;

create or replace function delete_list(p_operation_id uuid, p_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'delete_list') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _own_list(p_list_id);

  -- Hard, per §F.12. Items and web opens cascade; the URL answers "unavailable"
  -- afterwards, which is the same answer every other refusal gives.
  delete from lists where id = p_list_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function delete_list(uuid, uuid) is
  'Owner-only hard delete. list_items and list_web_opens cascade. There is no soft delete and no tombstone: the URL answers the same zero rows a private list does.';

grant execute on function delete_list(uuid, uuid) to authenticated;

create or replace function add_list_item(
  p_operation_id  uuid,
  p_list_id       uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim  record;
  v_result text;
  v_count  integer;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'add_list_item');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  perform _own_list(p_list_id);

  v_result := _add_list_item_unchecked(p_list_id, p_media_item_id);

  select count(*) into v_count from list_items where list_id = p_list_id;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object('status', v_result, 'count_after', v_count));
end;
$$;

comment on function add_list_item(uuid, uuid, uuid) is
  'Owner-only append of one title. Answers added, already (the PK forbids duplicates, and saying so is better than raising on a double tap) or item_limit. Movies, seasons and whole series only. count_after backs the list_item_added analytics property.';

grant execute on function add_list_item(uuid, uuid, uuid) to authenticated;

create or replace function remove_list_item(
  p_operation_id  uuid,
  p_list_id       uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'remove_list_item') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _own_list(p_list_id);

  delete from list_items
   where list_id = p_list_id and media_item_id = p_media_item_id;

  -- Bumped whether or not a row went, so that an Undo of an Undo still sorts the list
  -- to the top of My lists. `updated_at` is the screen's whole sort story.
  update lists set updated_at = now() where id = p_list_id;

  -- Positions are deliberately **not** compacted. The gap is invisible: every reader
  -- draws the read-time ordinal (§E), and renumbering on every removal would be a
  -- write proportional to the list for no visible gain.
  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function remove_list_item(uuid, uuid, uuid) is
  'Owner-only removal of one title. Leaves a gap in the stored positions on purpose -- readers draw the read-time ordinal, so the numbers a person sees stay 1..N.';

grant execute on function remove_list_item(uuid, uuid, uuid) to authenticated;

/**
 * Moves one item to a zero-based index, renumbering compactly.
 *
 * **One item is named, not an array of ids**, and that is the concurrency answer.
 * Two devices each holding a stale copy of the whole order would overwrite each
 * other silently; two devices each moving one item resolve to "last move wins",
 * which is what a person would expect and is the whole of the conflict story.
 *
 * The renumber is one `update` over the affected run, under the deferrable unique —
 * so the intermediate collisions never reach a constraint check.
 */
create or replace function move_list_item(
  p_operation_id  uuid,
  p_list_id       uuid,
  p_media_item_id uuid,
  p_to_index      integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
  v_from  integer;
  v_to    integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'move_list_item') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _own_list(p_list_id);

  -- Serialises this list against itself. Without it, two simultaneous moves each
  -- compute an ordering from a snapshot the other is about to invalidate, and the
  -- deferred unique turns that into a failed commit rather than a wrong answer --
  -- which is safe and is still a refusal the person did not earn.
  perform pg_advisory_xact_lock(hashtextextended(p_list_id::text, 0));

  select count(*) into v_total from list_items where list_id = p_list_id;
  if v_total = 0 then
    return jsonb_build_object('status', 'ok');
  end if;

  -- The item's current zero-based ordinal, which is what the client is moving from
  -- and is not the stored position.
  select ord - 1 into v_from
    from (
      select media_item_id, row_number() over (order by "position") as ord
        from list_items where list_id = p_list_id
    ) ranked
   where ranked.media_item_id = p_media_item_id;

  if v_from is null then
    raise exception 'that title is not in this list' using errcode = 'P0002';
  end if;

  -- Clamped rather than refused: a client whose copy of the list is one item stale
  -- asking for index 14 of a 13-item list means "the end", and that is a useful
  -- answer where an error is not.
  v_to := greatest(0, least(coalesce(p_to_index, v_from), v_total - 1));

  if v_to = v_from then
    return jsonb_build_object('status', 'ok');
  end if;

  -- Renumbered to a contiguous 1..N in the new order, in one statement.
  update list_items li
     set "position" = moved.new_position
    from (
      select media_item_id,
             row_number() over (
               order by case
                 when media_item_id = p_media_item_id then v_to::numeric
                 -- Everything else keeps its relative order; the half-step is what
                 -- puts the moved row on the correct side of its new neighbour
                 -- without a second pass.
                 when ord - 1 < v_from and ord - 1 >= v_to then (ord - 1) + 0.5
                 when ord - 1 > v_from and ord - 1 <= v_to then (ord - 1) - 0.5
                 else (ord - 1)::numeric
               end
             )::integer as new_position
        from (
          select media_item_id, row_number() over (order by "position") as ord
            from list_items where list_id = p_list_id
        ) ordered
    ) moved
   where li.list_id = p_list_id
     and li.media_item_id = moved.media_item_id;

  update lists set updated_at = now() where id = p_list_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function move_list_item(uuid, uuid, uuid, integer) is
  'Owner-only move of one item to a zero-based index, clamped into range. Names a single item rather than an order, so two devices resolve to last-move-wins instead of one silently overwriting the other. Renumbers to a contiguous 1..N in one statement under the deferrable unique.';

grant execute on function move_list_item(uuid, uuid, uuid, integer) to authenticated;

/**
 * Every unseen, unsaved title on a readable list, onto the caller's Watchlist.
 *
 * **It writes no `feed_events`, and that is a product decision rather than an
 * oversight.** `set_watchlist` writes one durable `watchlist_added` event per title,
 * which is right for a deliberate single add and wrong for a bulk one: twenty rows
 * in somebody's feed from one tap is the feature announcing itself, and §K says
 * plainly that the bulk add is silent.
 *
 * The Watchlist invariant is untouched: each title still clears on watch, by the
 * same trigger that has always cleared it.
 */
create or replace function add_list_to_watchlist(p_operation_id uuid, p_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim   record;
  v_added   integer := 0;
  v_seen    integer := 0;
  v_present integer := 0;
begin
  perform assert_can_write();

  select * into v_claim
    from _claim_operation_result(p_operation_id, 'add_list_to_watchlist');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  if not _list_readable(p_list_id, auth.uid()) then
    raise exception 'no such list' using errcode = 'P0002';
  end if;

  with items as (
    select li.media_item_id,
           _viewer_has_seen(auth.uid(), li.media_item_id) as seen,
           exists (select 1 from watchlist w
                    where w.user_id = auth.uid()
                      and w.media_item_id = li.media_item_id) as present
      from list_items li
     where li.list_id = p_list_id
  ),
  inserted as (
    insert into watchlist (user_id, media_item_id)
    select auth.uid(), media_item_id from items
     where not seen and not present
    on conflict (user_id, media_item_id) do nothing
    returning 1
  )
  select (select count(*) from inserted),
         (select count(*) from items where seen),
         (select count(*) from items where present and not seen)
    into v_added, v_seen, v_present;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object(
      'status', 'ok',
      'added', v_added,
      'skipped_seen', v_seen,
      'skipped_present', v_present));
end;
$$;

comment on function add_list_to_watchlist(uuid, uuid) is
  'Adds every unseen, unsaved title on a readable list to the caller''s own watchlist. Writes NO feed_events -- one tap must not produce twenty activity rows (lists-prd.md §K). Works on anybody''s readable list, which is the point: it is how somebody else''s list becomes your plan.';

grant execute on function add_list_to_watchlist(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Seen, for whoever is reading
-- ---------------------------------------------------------------------------

/**
 * Whether this viewer has seen this title, by §K's definition.
 *
 *   - **movie** — they have a `user_media` row for it.
 *   - **season** — a row whose `progress` is not `watching`. A season half-watched is
 *     honestly not seen, and the list's whole utility is "what have I got left".
 *   - **series** — any season of it logged. **A documented approximation**: a person
 *     who has watched one season of eight has "seen" the series here, and the
 *     alternative — requiring every season — would mark a currently-airing show unseen
 *     forever. Stated in §K rather than hidden.
 *
 * Never stored, computed for whoever is asking, and answers false for a null viewer.
 */
create or replace function _viewer_has_seen(p_viewer uuid, p_media_item_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case
    when p_viewer is null then false
    else coalesce((
      select case m.kind
        when 'movie' then exists (
          select 1 from user_media um
           where um.user_id = p_viewer and um.media_item_id = m.id
        )
        when 'season' then exists (
          select 1 from user_media um
           where um.user_id = p_viewer
             and um.media_item_id = m.id
             and um.progress is distinct from 'watching'
        )
        when 'series' then exists (
          select 1
            from media_items s
            join user_media um
              on um.media_item_id = s.id and um.user_id = p_viewer
           where s.parent_id = m.id
             and um.progress is distinct from 'watching'
        )
        else false
      end
      from media_items m where m.id = p_media_item_id
    ), false)
  end;
$$;

comment on function _viewer_has_seen(uuid, uuid) is
  'lists-prd.md §K''s seen rule, for one viewer and one title. The series case is a documented approximation -- any logged season counts -- because requiring every season would mark an airing show unseen forever. Internal: it takes a viewer, so a grant would report what somebody else has watched.';

revoke execute on function _viewer_has_seen(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Readers
-- ---------------------------------------------------------------------------

/**
 * One list's header, for whoever can read it.
 *
 * **Zero rows is the only failure.** Private, deleted, hidden, suspended, blocked and
 * "no such uuid" are one answer, and the client renders one "List unavailable" for
 * all of them. A reader that distinguished them would be an oracle for exactly the
 * facts §F is protecting.
 *
 * The `owner` block is §E's attribution table. For a link-only list whose owner's
 * profile the viewer cannot see, it is **limited identity** — handle, display name,
 * avatar — which is the same set search already discloses about a private account
 * (20260828000400), and **no owner id at all for an anonymous reader**.
 */
create or replace function list_view(p_list_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when l.id is null then null else
    jsonb_strip_nulls(jsonb_build_object(
      'id',          l.id,
      'title',       l.title,
      'description', l.description,
      'order_style', l.order_style,
      'item_count',  (select count(*) from list_items li where li.list_id = l.id),
      'updated_at',  l.updated_at,
      'is_owner',    l.owner_id = auth.uid(),
      -- The owner may share anything that is not private (tapping Share on a private
      -- list opens the consent prompt first, client-side). A non-owner may share a
      -- public list only: a link-only URL is the owner's to give out, and a Share
      -- button on it would turn every reader into a redistributor.
      'shareable_by_viewer', case
        when l.owner_id = auth.uid() then l.visibility <> 'private'
        else l.visibility = 'public'
      end,
      -- Owner-only fields. A viewer has no business knowing whether the list they are
      -- reading is public or link-only.
      'visibility', case when l.owner_id = auth.uid() then l.visibility::text end,
      'hidden',     case when l.owner_id = auth.uid() then l.hidden_at is not null end,
      'owner', (
        select case
          when can_view_profile(auth.uid(), p.id) then
            jsonb_build_object(
              'id',              p.id,
              'username',        p.username::text,
              'display_name',    p.display_name,
              'avatar_path',     p.avatar_path,
              'profile_visible', true)
          else
            -- Limited identity. Note the id is included for a signed-in viewer, who
            -- needs it for nothing this screen does but already has the handle, and
            -- omitted for anon -- jsonb_strip_nulls removes the key entirely.
            jsonb_strip_nulls(jsonb_build_object(
              'id',              case when auth.uid() is not null then p.id end,
              'username',        p.username::text,
              'display_name',    p.display_name,
              'avatar_path',     p.avatar_path,
              'profile_visible', false))
        end
        from profiles p where p.id = l.owner_id
      )
    ))
  end
  from lists l
  where l.id = p_list_id
    and _list_readable(l.id, auth.uid());
$$;

comment on function list_view(uuid) is
  'One list''s header for whoever may read it, or zero rows. Every refusal is the same zero rows -- private, hidden, deleted, suspended, blocked and nonexistent are indistinguishable by design. The owner block carries full identity when the viewer can see the profile and limited identity (no id for anon) when they cannot, which is the link-only attribution rule of lists-prd.md §F.2.';

grant execute on function list_view(uuid) to anon, authenticated;

/**
 * One keyset page of a list's items.
 *
 * `ordinal` is computed over the **whole** list and then filtered, which is what makes
 * the number on screen 1..N regardless of gaps in the stored positions and regardless
 * of which page it arrived on.
 *
 * `viewer_seen` and `viewer_watchlisted` are null for an anonymous reader rather than
 * false. Null is "no viewer to ask about"; false would be a claim.
 */
create or replace function list_items_page(
  p_list_id        uuid,
  p_after_position integer default null,
  p_limit          integer default 100
)
returns table (
  media_item_id      uuid,
  kind               media_kind,
  title              text,
  year               integer,
  poster_path        text,
  season_number      integer,
  parent_title       text,
  "position"         integer,
  ordinal            integer,
  viewer_seen        boolean,
  viewer_watchlisted boolean
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with ranked as (
    select li.media_item_id,
           li."position",
           row_number() over (order by li."position")::integer as ordinal
      from list_items li
     where li.list_id = p_list_id
       and _list_readable(p_list_id, auth.uid())
  )
  select r.media_item_id,
         m.kind,
         m.title,
         extract(year from m.release_date)::integer as year,
         m.poster_path,
         m.season_number,
         parent.title as parent_title,
         r."position",
         r.ordinal,
         case when auth.uid() is null then null
              else _viewer_has_seen(auth.uid(), r.media_item_id) end,
         case when auth.uid() is null then null
              else exists (select 1 from watchlist w
                            where w.user_id = auth.uid()
                              and w.media_item_id = r.media_item_id) end
    from ranked r
    join media_items m on m.id = r.media_item_id
    left join media_items parent on parent.id = m.parent_id
   where p_after_position is null or r."position" > p_after_position
   order by r."position"
   limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

comment on function list_items_page(uuid, integer, integer) is
  'A keyset page of one readable list, ordered by stored position and numbered by read-time ordinal -- so removal gaps are invisible and the number is the same whichever page it came on. viewer_seen and viewer_watchlisted are null for anon, which says "no viewer" rather than claiming false.';

grant execute on function list_items_page(uuid, integer, integer) to anon, authenticated;

/**
 * "You've seen X of N", for whoever is reading.
 *
 * **Strictly viewer-private**, and the phrasing in §K matters: the owner sees *their
 * own* progress through their own list and never any other reader's. There is no call
 * shape here that could return somebody else's figure — it takes no viewer argument.
 */
create or replace function list_viewer_progress(p_list_id uuid)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when not _list_readable(p_list_id, auth.uid()) then null else
    jsonb_build_object(
      'seen',  (select count(*) from list_items li
                 where li.list_id = p_list_id
                   and _viewer_has_seen(auth.uid(), li.media_item_id)),
      'total', (select count(*) from list_items li where li.list_id = p_list_id))
  end
  where auth.uid() is not null;
$$;

comment on function list_viewer_progress(uuid) is
  'The caller''s own progress through a readable list. Takes no viewer argument, so it cannot be pointed at anybody else -- an owner reading their own list sees their own figure and never a reader''s. Not granted to anon: there is no viewer to have progress, and the web page deliberately never shows this line.';

grant execute on function list_viewer_progress(uuid) to authenticated;

/**
 * The My lists screen, and nothing else.
 *
 * **It takes no owner argument at all.** That is what makes it the one path that may
 * return `link` and `private` lists without being an enumeration hole (§F.6): it can
 * only ever answer for `auth.uid()`.
 */
create or replace function my_lists(
  p_before_updated_at timestamptz default null,
  p_limit             integer default 30
)
returns table (
  id          uuid,
  title       text,
  item_count  integer,
  order_style text,
  visibility  list_visibility,
  hidden      boolean,
  updated_at  timestamptz,
  posters     text[]
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.id,
         l.title,
         (select count(*) from list_items li where li.list_id = l.id)::integer,
         l.order_style,
         l.visibility,
         l.hidden_at is not null,
         l.updated_at,
         -- The 2x2 cover: the first four posters in list order, nulls dropped, so a
         -- list whose first three titles have no artwork still shows the fourth.
         (select coalesce(array_agg(p order by ord), '{}'::text[])
            from (
              select m.poster_path as p,
                     row_number() over (order by li."position") as ord
                from list_items li
                join media_items m on m.id = li.media_item_id
               where li.list_id = l.id and m.poster_path is not null
               order by li."position"
               limit 4
            ) covers)
    from lists l
   where l.owner_id = auth.uid()
     and (p_before_updated_at is null or l.updated_at < p_before_updated_at)
   order by l.updated_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 50);
$$;

comment on function my_lists(timestamptz, integer) is
  'Every list the caller owns, every visibility, newest-edited first. It takes no owner argument, which is precisely why it may return link and private lists: it cannot be pointed at another account, so it is not the enumeration path 20260813001400 §4 closed. Backs app/lists/index.tsx and nothing else.';

grant execute on function my_lists(timestamptz, integer) to authenticated;

/**
 * The Profile `LISTS` shelf — **public lists only, for every caller including the
 * owner** (§Q.4).
 *
 * The owner's own shelf deliberately shows what a visitor sees. An owner holding four
 * private lists gets the "nothing public yet" line and learns the privacy model by
 * looking at it, and no private or link-only list is ever drawn on an identity
 * surface. `Manage ›` is always there, so nothing is unreachable.
 */
create or replace function profile_lists(
  p_owner_id          uuid,
  p_before_updated_at timestamptz default null,
  p_limit             integer default 10
)
returns table (
  id          uuid,
  title       text,
  item_count  integer,
  order_style text,
  updated_at  timestamptz,
  posters     text[]
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.id,
         l.title,
         (select count(*) from list_items li where li.list_id = l.id)::integer,
         l.order_style,
         l.updated_at,
         (select coalesce(array_agg(p order by ord), '{}'::text[])
            from (
              select m.poster_path as p,
                     row_number() over (order by li."position") as ord
                from list_items li
                join media_items m on m.id = li.media_item_id
               where li.list_id = l.id and m.poster_path is not null
               order by li."position"
               limit 4
            ) covers)
    from lists l
   where l.owner_id = p_owner_id
     and l.visibility = 'public'
     and l.hidden_at is null
     and can_view_profile(auth.uid(), p_owner_id)
     and (p_before_updated_at is null or l.updated_at < p_before_updated_at)
   order by l.updated_at desc
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

comment on function profile_lists(uuid, timestamptz, integer) is
  'Public, unhidden lists on one profile, for whoever can view that profile -- including the owner, whose own shelf deliberately shows what a visitor would see (lists-prd.md §Q.4). private and link are never returned by this path to anyone. An unviewable profile and one with no public lists both answer zero rows, which is ProfileWatchlist''s rule: the two must be indistinguishable or the absence is itself a disclosure.';

grant execute on function profile_lists(uuid, timestamptz, integer) to authenticated;

/**
 * The Add-to-list sheet: the caller's lists, with a membership flag for one title.
 *
 * Most recently updated first, which is the same order My lists uses — the list
 * somebody is working on is the one they are most likely to be adding to.
 */
create or replace function my_lists_for_title(p_media_item_id uuid)
returns table (
  id          uuid,
  title       text,
  item_count  integer,
  visibility  list_visibility,
  contains    boolean,
  updated_at  timestamptz
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.id,
         l.title,
         (select count(*) from list_items li where li.list_id = l.id)::integer,
         l.visibility,
         exists (select 1 from list_items li
                  where li.list_id = l.id and li.media_item_id = p_media_item_id),
         l.updated_at
    from lists l
   where l.owner_id = auth.uid()
   order by l.updated_at desc
   limit 100;
$$;

comment on function my_lists_for_title(uuid) is
  'The caller''s own lists with a contains flag for one title, newest-edited first. Backs the Add to list sheet, where a row toggles membership in both directions.';

grant execute on function my_lists_for_title(uuid) to authenticated;

/**
 * What the web page was opened on. Anonymous, fire and forget.
 *
 * Records only for a list an **anonymous** reader could have read — `_list_readable`
 * with a null viewer — so a probe cannot turn this into an existence oracle by timing
 * or by counting, and a signed-in-only list is never counted as a web open.
 *
 * Bounded rather than exact, for the reason `record_invite_open` gives: this is a
 * check and an insert with no lock, so N simultaneous loads can overshoot the cap by
 * roughly the concurrency. What it buys is that a list posted publicly cannot fill
 * the table without bound, and it buys that whether or not it is exact.
 */
create or replace function record_list_open(p_list_id uuid, p_platform text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap integer;
begin
  -- A signed-in caller is suspension-checked exactly as everywhere else; an
  -- anonymous one has no account to suspend, which is why this cannot be the
  -- unconditional first line. Same shape as record_invite_open.
  if auth.uid() is not null then
    perform assert_can_write();
  end if;

  if p_list_id is null then
    return;
  end if;

  if not _list_readable(p_list_id, null) then
    return;
  end if;

  v_cap := _list_config('lists.max_opens_per_list_per_minute', 60);

  if (select count(*) from list_web_opens o
       where o.list_id = p_list_id
         and o.opened_at > now() - interval '1 minute') >= v_cap then
    return;
  end if;

  insert into list_web_opens (list_id, platform)
  -- A closed set, so the column cannot become a free-text field somebody puts a user
  -- agent in.
  values (p_list_id, case when p_platform in ('ios', 'android', 'other') then p_platform end);
end;
$$;

comment on function record_list_open(uuid, text) is
  'Counts one open of a list''s public web page. Records only when the list is readable by an ANONYMOUS viewer, so it cannot be used to probe for a list a signed-in reader could see. No IP, no user agent, no referrer, no viewer. Rate-bounded per list per minute.';

grant execute on function record_list_open(uuid, text) to anon, authenticated;

/**
 * The three strings a link preview may carry (§F.9, §P.3).
 *
 * **The owner is named only when their profile is public.** A third-party unfurl
 * cache is a place the owner did not choose, so a private account's handle is kept
 * out of it even though the list itself is readable by whoever holds the URL.
 *
 * Zero rows unless an anonymous reader could read the list, which is what makes the
 * Pages Function's fallback correct for private, hidden, deleted and suspended alike.
 */
create or replace function list_preview(p_list_id uuid)
returns table (
  title       text,
  item_count  integer,
  owner_label text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.title,
         (select count(*) from list_items li where li.list_id = l.id)::integer,
         (select case when p.visibility = 'public' and p.status = 'active'
                      then '@' || p.username::text end
            from profiles p where p.id = l.owner_id)
    from lists l
   where l.id = p_list_id
     and _list_readable(l.id, null);
$$;

comment on function list_preview(uuid) is
  'Title, count and -- only for a public-profile owner -- the @handle, for the Cloudflare Pages Function that sets og:title and og:description on /lists/*. Gated on anonymous readability, so private, hidden, deleted and suspended lists all fall back to the generic card.';

grant execute on function list_preview(uuid) to anon;

-- ---------------------------------------------------------------------------
-- 9. Moderation
-- ---------------------------------------------------------------------------
--
-- `report('list', …)` and `report('list_title', …)` have resolved their owner from
-- `lists.owner_id` since 20260825000100 and need no change. What was missing is the
-- operator's other half: the hide, and the way back from it.
--
-- `moderation_actions.action` is a closed set, so the two new verbs are added to it.
-- Rebuilt rather than patched, because a CHECK cannot be extended in place: the
-- constraint is dropped and restated in full, which is also the only readable record
-- of what the permitted set now is.

alter table moderation_actions
  drop constraint if exists moderation_actions_known_action;
alter table moderation_actions
  add constraint moderation_actions_known_action check (action in (
    'suspend_account', 'restore_account', 'remove_content',
    'force_username_change', 'dismiss_report', 'warn',
    -- 20261010000100. A list hide is not remove_content: it is reversible, it leaves
    -- the owner''s copy in place, and the way back from it has to be auditable too.
    'hide_list', 'unhide_list'
  ));

create or replace function hide_list(p_list_id uuid, p_rationale text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from lists where id = p_list_id;
  if v_owner is null then
    raise exception 'no such list' using errcode = 'P0002';
  end if;

  update lists set hidden_at = now(), updated_at = now() where id = p_list_id;

  -- The subject is the list, not its owner: hiding one list is not an action against
  -- an account, and recording it as one would make an operator's history unreadable.
  insert into moderation_actions (subject_type, subject_id, action, rationale)
  values ('list', p_list_id, 'hide_list', p_rationale);

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function hide_list(uuid, text) is
  'Operator-only (runbook §2d). Hides one list from everybody but its owner, who keeps the row with a banner and cannot change its visibility until this is cleared. Recorded in moderation_actions. Service role only: there is no client entry and there must not be one.';

revoke execute on function hide_list(uuid, text) from public, anon, authenticated;

create or replace function unhide_list(p_list_id uuid, p_rationale text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from lists where id = p_list_id;
  if v_owner is null then
    raise exception 'no such list' using errcode = 'P0002';
  end if;

  update lists set hidden_at = null, updated_at = now() where id = p_list_id;

  insert into moderation_actions (subject_type, subject_id, action, rationale)
  values ('list', p_list_id, 'unhide_list', p_rationale);

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function unhide_list(uuid, text) is
  'Clears a moderation hide (runbook §2d). Service role only.';

revoke execute on function unhide_list(uuid, text) from public, anon, authenticated;
