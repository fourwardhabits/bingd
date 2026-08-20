-- Notes become social content, and a title gains a community score.
-- Specification: founder decision 2026-08-16, amending PRD §22 and §10.
--
-- Three separable things ship together because they are one product change: a note
-- is now something other people can read, so it needs a visibility, a spoiler flag,
-- and a read path that exposes the note *without* exposing the rest of the row.
--
-- ---------------------------------------------------------------------------
-- What the founder decided, and what that does and does not authorise
--
-- PRD §22 classifies notes as always-private, and 20260813000500 implements that
-- literally: `user_media_own` is the only select policy on the table, so nobody but
-- the owner has ever read one. That is superseded **for content created from now
-- on**. It is deliberately not superseded retroactively.
--
-- The distinction is the whole design of this migration. Every note already in the
-- database was written by someone who was told, in the log sheet's own words, "Only
-- you can read this." Publishing those retroactively would be a promise broken by a
-- schema change, which is the one category of privacy regression that cannot be
-- undone by a later fix — the text is out.
--
-- So: the column defaults to 'private', every existing row is explicitly set
-- private, and 'public' is only ever reached by a caller that names it. The forward
-- default lives in the RPCs, where it applies to a note being written for the first
-- time and to nothing else.
-- ---------------------------------------------------------------------------

create type note_visibility as enum ('public', 'private');

comment on type note_visibility is
  'Who may read a note. Two values on purpose: an "unlisted"/"followers only" third state would need its own read path and its own row in every visibility test, and nothing in the product asks for one. See user_media.note_visibility.';

alter table user_media
  add column note_visibility note_visibility not null default 'private';

alter table user_media
  add column note_has_spoilers boolean not null default false;

comment on column user_media.note_visibility is
  'Whether this note is social content. Defaults to private so that any row created outside the collection writers -- an import, a backfill, a future RPC written without thinking about this -- is private by omission rather than public by omission. New notes are made public by log_watched/save_note, which pass the forward-facing default explicitly.';

comment on column user_media.note_has_spoilers is
  'Author''s own claim that the note spoils the exact title it is attached to. Not inferred and never set by the server: a spoiler tag is an editorial judgement about one''s own writing. Consumed by the client, which masks the text for viewers who have not logged this exact media item.';

-- Explicit rather than relying on the column default, so the retroactive-privacy
-- decision is visible in the migration rather than implied by DDL ordering.
update user_media set note_visibility = 'private' where note is not null;

-- The read path below filters on visibility for rows that have a note. An index on
-- the public ones keeps the community and profile queries off a sequential scan
-- once the table is mostly private rows.
create index user_media_public_notes
  on user_media (media_item_id, note_updated_at desc)
  where note is not null and note_visibility = 'public';

create index user_media_public_notes_by_user
  on user_media (user_id, note_updated_at desc)
  where note is not null and note_visibility = 'public';

-- ---------------------------------------------------------------------------
-- 1. Writing a visibility
--
-- Both note writers gain two parameters. They are added with defaults and the old
-- signatures are dropped, rather than left standing as overloads: PostgREST resolves
-- an RPC by the set of named arguments in the body, and two functions whose names
-- match and whose argument sets are a subset of each other resolve ambiguously. A
-- client built before this migration still calls the new function, because every
-- parameter it omits has a default.
--
-- The null semantics are the load-bearing part:
--
--   p_note_visibility null  ->  leave whatever is stored alone, except on a note
--                               that has never existed, where it means 'public'.
--   p_note_visibility given ->  set it. The client always sends the value it
--                               displayed, so the state the user saw is the state
--                               that gets written.
--
-- "A note that has never existed" is `note_updated_at is null`, which the trigger in
-- 20260813002300 maintains: it advances only when the note text changes, so a null
-- there means no note has ever been stored on this row. That is precisely the test
-- for "this is new content", and it is why a legacy row carrying a private note
-- stays private through an edit while a legacy row that only ever held a bucket and
-- a watch date gets the forward default when its first note is written.
-- ---------------------------------------------------------------------------

drop function if exists log_watched(uuid, uuid, date, text);

create or replace function log_watched(
  p_operation_id    uuid,
  p_media_item_id   uuid,
  p_watched_on      date default null,
  p_note            text default null,
  p_note_visibility note_visibility default null,
  p_note_spoilers   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_version timestamptz;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'log_watched') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _assert_note_length(v_note);

  -- current_date + 1, not current_date. The server is UTC and the client sends a local
  -- date, so for the first hours of the day everywhere east of UTC the local date is
  -- already tomorrow in server terms. Comparing against today refuses a correct
  -- "I watched this tonight" for a large part of every day, depending on longitude.
  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  insert into user_media (
    user_id, media_item_id, watched_on, note, note_visibility, note_has_spoilers
  )
  values (
    auth.uid(),
    p_media_item_id,
    p_watched_on,
    v_note,
    -- An insert always creates the note, so there is no stored visibility to
    -- preserve and the forward default applies.
    case when v_note is null then 'private'::note_visibility
         else coalesce(p_note_visibility, 'public'::note_visibility) end,
    coalesce(p_note_spoilers, false)
  )
  on conflict (user_id, media_item_id) do update
    set watched_on = coalesce(excluded.watched_on, user_media.watched_on),
        note       = coalesce(excluded.note,       user_media.note),
        -- Only moves when the caller named a value, or when this call is what
        -- brings the row its first note.
        note_visibility = case
          when p_note_visibility is not null then p_note_visibility
          when v_note is not null and user_media.note_updated_at is null then 'public'::note_visibility
          else user_media.note_visibility
        end,
        note_has_spoilers = case
          when p_note_spoilers is not null then p_note_spoilers
          when v_note is not null and user_media.note_updated_at is null then false
          else user_media.note_has_spoilers
        end
  returning note_updated_at into v_version;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

drop function if exists save_note(uuid, uuid, text, timestamptz);

create or replace function save_note(
  p_operation_id     uuid,
  p_media_item_id    uuid,
  p_note             text,
  p_base_updated_at  timestamptz default null,
  p_note_visibility  note_visibility default null,
  p_note_spoilers    boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_current user_media;
  v_version timestamptz;
  v_new     boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'save_note') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_note_length(v_note);

  select * into v_current
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  if not found then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  -- A null stored version means no note has ever been written here, so there is
  -- nothing a stale edit could destroy and nothing to ask the user about.
  if p_base_updated_at is not null
     and v_current.note_updated_at is not null
     and date_trunc('milliseconds', v_current.note_updated_at)
      <> date_trunc('milliseconds', p_base_updated_at) then
    raise exception 'the note changed elsewhere'
      using errcode = '55000',
            detail  = jsonb_build_object(
              'conflict',       'note',
              'server_version', v_current.note_updated_at
            )::text;
  end if;

  v_new := v_current.note_updated_at is null and v_note is not null;

  update user_media
     set note = v_note,
         note_visibility = case
           when p_note_visibility is not null then p_note_visibility
           when v_new then 'public'::note_visibility
           else v_current.note_visibility
         end,
         note_has_spoilers = case
           -- Clearing the note clears the claim about it. Leaving the flag set on
           -- an empty note would mean the next note written through log_watched's
           -- coalescing path inherits a spoiler tag its author never chose.
           when v_note is null then false
           when p_note_spoilers is not null then p_note_spoilers
           when v_new then false
           else v_current.note_has_spoilers
         end
   where user_id = auth.uid() and media_item_id = p_media_item_id
  returning note_updated_at into v_version;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

comment on function log_watched(uuid, uuid, date, text, note_visibility, boolean) is
  'Marks a title watched, optionally with a note. Outbox-eligible. Upserts, so a repeat with a corrected date is not a conflict. A note written here is public unless the caller says otherwise; an existing note keeps the visibility it already had.';
comment on function save_note(uuid, uuid, text, timestamptz, note_visibility, boolean) is
  'Writes or clears a note, and the two claims attached to it: who may read it, and whether it spoils the title. Assigns rather than coalescing, which is what lets a note be deleted. Refuses with 55000 when the base version no longer matches (offline-sync.md §5).';

-- ---------------------------------------------------------------------------
-- 2. Reading someone else's note
--
-- `user_media` cannot gain a select policy for this. A policy admits a *row*, and
-- the row also carries `watched_on`, `bucket` and `progress` -- watch dates are
-- still always-private under PRD §22, and column privileges cannot help because
-- they are granted per role, not per policy, and the same role reads its own rows.
--
-- So the exposure is a function that projects exactly the note columns. Definer,
-- because it must read past `user_media_own`; it takes no viewer, so it cannot be
-- turned into the kind of oracle 20260813001900 closed -- the only perspective it
-- will answer from is `auth.uid()`'s own.
--
-- Filters are required. With both null this would be "every public note in the
-- database", which is a scraping endpoint rather than a screen's query.
-- ---------------------------------------------------------------------------

create or replace function public_notes(
  p_user_ids       uuid[] default null,
  p_media_item_ids uuid[] default null,
  p_limit          integer default 50
)
returns table (
  user_id       uuid,
  media_item_id uuid,
  note          text,
  has_spoilers  boolean,
  updated_at    timestamptz
)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_user_ids is null and p_media_item_ids is null then
    raise exception 'public_notes requires a user or a title filter'
      using errcode = '22023';
  end if;

  return query
    select um.user_id,
           um.media_item_id,
           um.note,
           um.note_has_spoilers,
           um.note_updated_at
      from user_media um
     where um.note is not null
       and um.note_visibility = 'public'
       and (p_user_ids is null       or um.user_id       = any (p_user_ids))
       and (p_media_item_ids is null or um.media_item_id = any (p_media_item_ids))
       -- AD-5, from the caller's own perspective. Covers suspension, blocks,
       -- private accounts and approved follows in one place.
       and can_view_profile(auth.uid(), um.user_id)
     order by um.note_updated_at desc nulls last
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

comment on function public_notes(uuid[], uuid[], integer) is
  'Public notes for a set of authors, a set of titles, or both. The only cross-user read path for note text. Projects the note columns alone, because the row it comes from also carries the watch date, which PRD §22 keeps private at every visibility level. Refuses an unfiltered call.';

-- ---------------------------------------------------------------------------
-- 3. The community score
--
-- Beli lets you set your rating beside everyone else's, and the founder wants the
-- same on a title page. Four constraints came with the request, and each shows up
-- in the query:
--
--   "current canonical user-ranking-derived scores, not stale feed snapshots"
--       -> it derives from `rankings` and `band_bounds` at read time. The snapshot
--          in feed_events.payload is deliberately not used; that one records what a
--          moment was, which is right for an activity item and wrong for an average.
--
--   "aggregate the exact entity only; never blend seasons into a parent series"
--       -> the filter is `r.media_item_id = p_media_item_id`. A season and its
--          series are different rows, so this is true by construction rather than
--          by a rule someone has to remember.
--
--   "include or make accessible the number of ratings"
--       -> returned always, including below the threshold, because "2 ratings" is
--          an honest thing to show and a hidden count invites the reader to assume
--          a big one.
--
--   "not display a misleading community number with an extremely tiny sample"
--       -> `min_ratings`, below which `score` is null. The client renders the
--          count and no number.
--
-- Only public, active accounts are counted, and that is a privacy decision rather
-- than a tidiness one. A private account's rankings reach approved followers only
-- (PRD §22). Folding one into a global average would leak it in aggregate -- and
-- worse, differentially: a viewer who can compute the public raters' scores from
-- `rankings`, which RLS already allows, could subtract them out and recover the
-- private one exactly whenever there is only one. Restricting the population to
-- accounts whose individual scores the viewer could already derive means the
-- aggregate discloses nothing the schema did not already disclose.
--
-- A block is not applied. It would make the number viewer-dependent, and a block is
-- about not being shown a person, not about un-counting them from a global
-- statistic. Stated so the absence reads as a decision.
--
-- The threshold is configuration, not a constant: three is a judgement about an
-- alpha with a handful of testers, and the founder should be able to raise it as
-- the cohort grows without a migration. It is the smallest sample where the average
-- is not simply one identifiable person's opinion wearing the word "community".
-- ---------------------------------------------------------------------------

insert into app_config (key, value)
values ('score.community_min_ratings', '3'::jsonb)
on conflict (key) do nothing;

create or replace function community_score(p_media_item_id uuid)
returns table (
  score        numeric,
  rating_count integer,
  min_ratings  integer
)
language sql stable security definer
set search_path = public
as $$
  with threshold as (
    select coalesce(
      (select (value)::integer from app_config where key = 'score.community_min_ratings'),
      3
    ) as k
  ),
  rated as (
    select
      round(avg(score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)), 1) as avg_score,
      count(*)::integer as n
      from rankings r
      join profiles p
        on p.id = r.user_id
       and p.visibility = 'public'
       and p.status = 'active'
      join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
     where r.media_item_id = p_media_item_id
  )
  select case when rated.n >= threshold.k then rated.avg_score end,
         rated.n,
         threshold.k
    from rated, threshold;
$$;

comment on function community_score(uuid) is
  'The mean canonical score for exactly one media item, over public active accounts, with the sample size. Null score below app_config score.community_min_ratings. Derived live from rankings rather than read from feed_events.payload, which holds a historical snapshot.';

-- ---------------------------------------------------------------------------
-- 4. Privileges
--
-- 20260813001800 made execute default-deny and 20260813002100 issued the global
-- form, so these arrive unreachable and each grant is deliberate. Re-granting the
-- two note writers is not optional -- dropping a function drops its grants with it.
-- ---------------------------------------------------------------------------

grant execute on function log_watched(uuid, uuid, date, text, note_visibility, boolean)
  to authenticated;
grant execute on function save_note(uuid, uuid, text, timestamptz, note_visibility, boolean)
  to authenticated;
grant execute on function public_notes(uuid[], uuid[], integer)   to authenticated;
grant execute on function community_score(uuid)                   to authenticated;
