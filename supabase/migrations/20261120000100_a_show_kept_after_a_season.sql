-- A show kept after a season (WS-TVC, founder spec t168u §2-§3).
--
-- Depends on 20261114000200 (a show is rankable, category tv_shows) and 20261114000300
-- (Update Show: `ranking_placements.linked_placement_id`, `_assert_linked_show_update`).
--
-- Two changes, both additive:
--
--   1. **Keep Show.** After a season is ranked, the completion screen offers Update Show
--      (an ordinary correction of the parent show, linked to the season placement) and,
--      now, Keep Show: "I considered the new season and my show score stands." That is a
--      decision worth keeping for later analysis, and it is not a ranking — it moves
--      nothing — so it cannot be a `ranking_placements` row, which is append-only and
--      written by `_rank_finalize` and nothing else. It gets its own small table,
--      `show_reaffirmations`, one row per season placement at most (unique), written only
--      by `keep_show`, readable only by its owner.
--
--      One season placement resolves to Update **or** Keep, never both, in both orders:
--      `keep_show` refuses a placement an Update Show has finalised from (or has open), and
--      `_assert_linked_show_update` (copied from its live 20261114000300 definition) now
--      refuses a placement that was kept. Both take the show's media lock first, which is
--      the lock `rank_again` and `rank_rebucket` take before the assertion, so the two
--      cannot interleave.
--
--      `keep_show` writes no ranking, placement, watch event, `user_media` change or Feed
--      row, and a repeated tap or a retry after a lost reply returns the same single row.
--
--   2. **The profile's TV count is one per series** (Design A6). The TV Collection now
--      draws one poster per parent series — the explicit show score, else the mean of the
--      ranked seasons — so `profile_title_counts.tv` counts distinct series among the
--      user's logged or ranked seasons and shows, which is the number of posters the wall
--      it sits beside draws. Movies are unchanged.
--
-- Every function changed below is copied from its live definition and changed only where
-- a 20261120000100 comment says so. No existing migration is edited; no ranking, ladder
-- order or score computation changes.

-- ===========================================================================
-- 1. The reaffirmation, durable and owner-only
-- ===========================================================================

create table if not exists show_reaffirmations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references profiles(id) on delete cascade,
  show_id             uuid not null references media_items(id) on delete cascade,
  -- One reaffirmation per completed season placement, structurally: the idempotency
  -- key, and the thing a second tap or a retry lands on.
  season_placement_id uuid not null unique references ranking_placements(id) on delete cascade,
  -- The show's latest placement at the moment it was kept, for analysis; set null if the
  -- ledger row is ever removed.
  show_placement_id   uuid references ranking_placements(id) on delete set null,
  -- A snapshot of the show's ranking at that moment. Never read as a current score.
  show_bucket         taste_bucket not null,
  show_position       integer not null,
  show_score          numeric(3,1) not null,
  created_at          timestamptz not null default now()
);

comment on table show_reaffirmations is
  'Keep Show: a reader''s explicit "my whole-show ranking stands" after ranking a season of it (20261120000100). One row per season placement, written only by keep_show. The show_* columns are a snapshot for analysis, never a current score; nothing here changes a ranking.';

create index if not exists show_reaffirmations_user_show
  on show_reaffirmations (user_id, show_id, created_at desc);

alter table show_reaffirmations enable row level security;

-- The owner reads their own; nobody writes through a policy (keep_show is the writer).
drop policy if exists show_reaffirmations_read_own on show_reaffirmations;
create policy show_reaffirmations_read_own on show_reaffirmations
  for select to authenticated
  using (user_id = auth.uid());

revoke all on show_reaffirmations from public, anon, authenticated;
grant select on show_reaffirmations to authenticated;

-- ===========================================================================
-- 2. The link, checked: refused once the show was kept for that season
-- ===========================================================================

create or replace function _assert_linked_show_update(
  p_user uuid, p_show uuid, p_linked_placement_id uuid
) returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_linked_placement_id is null then
    return;
  end if;

  if not exists (
    select 1
      from ranking_placements p
      join media_items s on s.id = p.media_item_id
     where p.id = p_linked_placement_id
       and p.user_id = p_user
       and s.kind = 'season'
       and s.parent_id = p_show
       and p.kind in ('first', 'rewatch')
       -- The season placement that offered Update Show, not an older one: it is still
       -- that season's latest placement (no later correction or re-check replaced it),
       -- and it is from the last day. The client decides "tied to a new watch" from the
       -- act itself (LogSheet's `created`, or a rewatch); this only refuses a stale or
       -- superseded link, so a modified client cannot silence an unrelated update.
       and p.created_at > now() - interval '1 day'
       and not exists (
         select 1 from ranking_placements later
          where later.user_id = p.user_id
            and later.media_item_id = p.media_item_id
            and later.created_at > p.created_at
       )
  ) then
    raise exception 'that is not a season of this show you just ranked'
      using errcode = 'P0002';
  end if;

  if not exists (select 1 from rankings r
                  where r.user_id = p_user and r.media_item_id = p_show) then
    raise exception 'the show is not ranked, so there is nothing to update'
      using errcode = 'P0002';
  end if;

  if exists (select 1 from ranking_placements q
              where q.user_id = p_user
                and q.linked_placement_id = p_linked_placement_id) then
    raise exception 'the show was already updated from that season'
      using errcode = '23505';
  end if;

  -- 20261120000100: one season placement resolves to Update or Keep, never both. A
  -- placement the reader already kept the show for cannot also link an update.
  if exists (select 1 from show_reaffirmations k
              where k.user_id = p_user
                and k.season_placement_id = p_linked_placement_id) then
    raise exception 'the show was already kept for that season'
      using errcode = '23505';
  end if;
end;
$$;

revoke execute on function _assert_linked_show_update(uuid, uuid, uuid)
  from public, anon, authenticated;

-- ===========================================================================
-- 3. keep_show: the reaffirmation, written once
-- ===========================================================================

create or replace function keep_show(p_season_placement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user      uuid := auth.uid();
  v_show      uuid;
  v_existing  show_reaffirmations%rowtype;
  v_ranking   record;
  v_bounds    record;
  v_score     numeric;
  v_show_placement uuid;
  v_kept_at   timestamptz;
  v_created   boolean;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  if p_season_placement_id is null then
    raise exception 'a season placement is required' using errcode = '22023';
  end if;

  -- Which show the placement is a season of. Only the caller's own placement is ever
  -- resolved, so another user's id answers exactly as a missing one does.
  select s.parent_id into v_show
    from ranking_placements p
    join media_items s on s.id = p.media_item_id
   where p.id = p_season_placement_id
     and p.user_id = v_user
     and s.kind = 'season';

  if v_show is null then
    raise exception 'that is not a season of this show you just ranked'
      using errcode = 'P0002';
  end if;

  -- The show's media lock: the one rank_again and rank_rebucket hold while they check the
  -- Update Show link, so a keep and an update from the same placement cannot interleave.
  perform _lock_media(v_user, v_show);

  -- A repeated tap, or a retry after a reply that never arrived: the row already exists,
  -- and that is the answer. Checked before anything that could have gone stale since.
  select * into v_existing
    from show_reaffirmations
   where season_placement_id = p_season_placement_id
     and user_id = v_user;
  if found then
    return jsonb_build_object('status', 'kept', 'created', false, 'kept_at', v_existing.created_at);
  end if;

  -- What _assert_linked_show_update checks, so Keep is offered and accepted exactly where
  -- Update Show is: the caller's own first/rewatch placement of a season of this show,
  -- still that season's latest, from the last day.
  if not exists (
    select 1
      from ranking_placements p
     where p.id = p_season_placement_id
       and p.user_id = v_user
       and p.kind in ('first', 'rewatch')
       and p.created_at > now() - interval '1 day'
       and not exists (
         select 1 from ranking_placements later
          where later.user_id = p.user_id
            and later.media_item_id = p.media_item_id
            and later.created_at > p.created_at
       )
  ) then
    raise exception 'that is not a season of this show you just ranked'
      using errcode = 'P0002';
  end if;

  -- The show must be explicitly ranked: there is nothing to keep otherwise.
  select r.bucket, r.position, r.category into v_ranking
    from rankings r
   where r.user_id = v_user and r.media_item_id = v_show;
  if not found then
    raise exception 'the show is not ranked, so there is nothing to keep'
      using errcode = 'P0002';
  end if;

  -- Update or Keep, never both: refused once an Update Show finalised from this
  -- placement, or while one is open from it.
  if exists (select 1 from ranking_placements q
              where q.user_id = v_user
                and q.linked_placement_id = p_season_placement_id)
     or exists (select 1 from ranking_sessions rs
                 where rs.user_id = v_user
                   and rs.linked_placement_id = p_season_placement_id) then
    raise exception 'the show is being or was already updated from that season'
      using errcode = '23505';
  end if;

  -- The snapshot: the show's canonical score now, the formula every score reader uses.
  select * into v_bounds from band_bounds(v_user, v_ranking.category, v_ranking.bucket);
  v_score := round(
    score_for(v_ranking.bucket, (v_ranking.position - v_bounds.lo + 1)::integer, v_bounds.size),
    1
  );

  select p.id into v_show_placement
    from ranking_placements p
   where p.user_id = v_user and p.media_item_id = v_show
   order by p.created_at desc, p.id desc
   limit 1;

  insert into show_reaffirmations (
    user_id, show_id, season_placement_id, show_placement_id,
    show_bucket, show_position, show_score
  )
  values (
    v_user, v_show, p_season_placement_id, v_show_placement,
    v_ranking.bucket, v_ranking.position, v_score
  )
  on conflict (season_placement_id) do nothing
  returning created_at into v_kept_at;

  v_created := v_kept_at is not null;
  if not v_created then
    select created_at into v_kept_at
      from show_reaffirmations
     where season_placement_id = p_season_placement_id;
  end if;

  return jsonb_build_object('status', 'kept', 'created', v_created, 'kept_at', v_kept_at);
end;
$function$;

comment on function keep_show(uuid) is
  'Keep Show (20261120000100): records that the caller considered a newly ranked season and keeps their whole-show ranking. Idempotent per season placement; mutually exclusive with a linked Update Show; writes no ranking, placement, watch, user_media or feed row.';

revoke execute on function keep_show(uuid) from public, anon;
grant execute on function keep_show(uuid) to authenticated;

-- ===========================================================================
-- 4. The profile's TV count: one per series
-- ===========================================================================

create or replace function profile_title_counts(p_user uuid)
 RETURNS TABLE(movies integer, tv integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with titles as (
    select um.media_item_id
      from user_media um
     where um.user_id = p_user
       and um.progress is distinct from 'watching'
    union
    select r.media_item_id from rankings r where r.user_id = p_user
  )
  select (count(*) filter (where mi.kind = 'movie'))::integer,
         -- 20261120000100: one per series. A season counts as its series and a show as
         -- itself, so a show, its seasons, or both are one poster on the TV Collection and
         -- one here — the number matches the wall it summarises. A season with no parent
         -- row counts as itself.
         (count(distinct case
            when mi.kind = 'series' then mi.id
            when mi.kind = 'season' then coalesce(mi.parent_id, mi.id)
          end))::integer
    from titles t
    join media_items mi on mi.id = t.media_item_id
   where can_i_view(p_user);
$function$;
