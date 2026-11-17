-- A group shown as its posters (Feed Poster Rails, PR 1, 2026-11-16).
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------------
--
-- A grouped watchlist post (20261125000100) and a grouped ranking sitting (20261020000100,
-- 20261126000100) now draw a horizontal rail of their titles' posters in the Feed. The Feed
-- page already carries each post's representative title and count; the rail needs a short,
-- ordered preview of the members, for a whole page at once.
--
-- One read-only function. No table, no trigger, no write path, no flag: how groups are
-- formed is untouched, and nothing here can change a post, a ranking or a watchlist row.
--
--   * **Batched.** One call for the visible page: at most 50 event ids, and at most
--     `p_limit` (default 12, at most 20) members per post. The complete list stays the
--     job of `watchlist_group_titles` and `ranking_batch_titles`, which the "View all"
--     sheets keep calling.
--   * **The same visibility as the post.** Every event is gated on
--     `can_view_profile(auth.uid(), fe.actor_id)`, the predicate `feed_events_read`
--     (`can_i_view`) and both member readers use, read from the row and never taken from
--     the caller. A post the caller may not see returns no rows: blocks, suspension,
--     private accounts and unapproved follows all answer the same silence. Anonymous
--     callers get nothing.
--   * **Only groups.** `watchlist_added` and `ranking_batch` and nothing else; a draft
--     (`ranking_batch_draft`) is never read, so an unfinished sitting cannot leak through.
--   * **The author's own score, on its own ladder.** For a ranking member the score is
--     derived exactly as `ranking_batch_titles` derives it: the author's current
--     `rankings` row, its own `category` and bucket, `band_bounds` for that author and
--     ladder, `score_for`. A movie is never scored against seasons. A title the author has
--     since unranked comes back with no score and `ranked = false` — the poster stays, the
--     number is not invented. Never the community score.
--   * **Membership order**, as the sheets read it: watchlist members in save order
--     (`feed_watchlist_titles.id`), ranking members by `placed_at` then title.
--
-- Rollback: the client falls back to the representative artwork when this errors or is
-- absent, so dropping the function is safe; nothing depends on it server-side.

create or replace function feed_group_previews(p_event_ids uuid[], p_limit integer default 12)
returns table (
  event_id      uuid,
  ordinal       integer,
  media_item_id uuid,
  kind          media_kind,
  title         text,
  season_number integer,
  release_date  date,
  poster_path   text,
  parent_title  text,
  score         numeric,
  ranked        boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select greatest(1, least(coalesce(p_limit, 12), 20)) as lim
  ),
  -- The posts asked for, bounded, and only those the caller may see.
  posts as (
    select fe.id, fe.type, fe.actor_id
      from feed_events fe
     where fe.id = any ((coalesce(p_event_ids, '{}'::uuid[]))[1:50])
       and fe.type in ('watchlist_added', 'ranking_batch')
       and auth.uid() is not null
       and can_view_profile(auth.uid(), fe.actor_id)
  ),
  watchlist_members as (
    select p.id as event_id,
           (row_number() over (partition by p.id order by wt.id))::integer as ordinal,
           wt.media_item_id
      from posts p
      join feed_watchlist_titles wt on wt.event_id = p.id
     where p.type = 'watchlist_added'
  ),
  ranking_members as (
    select p.id as event_id,
           p.actor_id,
           (row_number() over (partition by p.id order by frt.placed_at, mi.title, frt.media_item_id))::integer as ordinal,
           frt.media_item_id
      from posts p
      join feed_ranking_titles frt on frt.event_id = p.id
      join media_items mi          on mi.id = frt.media_item_id
     where p.type = 'ranking_batch'
  ),
  ranked as (
    select rm.event_id, rm.ordinal, rm.media_item_id, rm.actor_id,
           r.position, r.category, r.bucket
      from ranking_members rm
      left join rankings r on r.user_id = rm.actor_id and r.media_item_id = rm.media_item_id
     where rm.ordinal <= (select lim from params)
  ),
  -- One band per (author, ladder, bucket) on the page, never per row.
  bands as (
    select d.actor_id, d.category, d.bucket, bb.lo, bb.size
      from (select distinct actor_id, category, bucket from ranked where category is not null) d
      cross join lateral band_bounds(d.actor_id, d.category, d.bucket) bb
  ),
  members as (
    select wm.event_id, wm.ordinal, wm.media_item_id,
           null::numeric as score, false as ranked
      from watchlist_members wm
     where wm.ordinal <= (select lim from params)
    union all
    select rk.event_id, rk.ordinal, rk.media_item_id,
           case when rk.position is null or b.lo is null then null
                else score_for(rk.bucket, (rk.position - b.lo + 1)::integer, b.size)
           end,
           rk.position is not null
      from ranked rk
      left join bands b
        on b.actor_id = rk.actor_id and b.category = rk.category and b.bucket = rk.bucket
  )
  select m.event_id, m.ordinal, mi.id, mi.kind, mi.title, mi.season_number,
         mi.release_date, mi.poster_path, parent.title, m.score, m.ranked
    from members m
    join media_items mi          on mi.id = m.media_item_id
    left join media_items parent on parent.id = mi.parent_id
   order by m.event_id, m.ordinal;
$$;

comment on function feed_group_previews(uuid[], integer) is
  'Feed poster rails (20261127000100): an ordered preview of up to p_limit (default 12, max '
  '20) members of each grouped watchlist_added / ranking_batch post among p_event_ids (max '
  '50), gated per post on can_view_profile(auth.uid(), actor). Ranking members carry the '
  'author''s current score on its own ladder (band_bounds, score_for), or none if unranked. '
  'Read-only.';

revoke execute on function feed_group_previews(uuid[], integer) from public, anon;
grant execute on function feed_group_previews(uuid[], integer) to authenticated;
