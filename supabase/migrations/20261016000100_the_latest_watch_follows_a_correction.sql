-- ===========================================================================
-- THE LATEST WATCH FOLLOWS A CORRECTION; EARLIER WATCHES FREEZE
-- (founder delta QA, 2026-09-21 — the canonical rule)
--
-- A pure "Update your rating" (a `correction` placement):
--   · creates no watch and no feed activity (unchanged — the finalize posts nothing for it);
--   · changes the current ranking and score (unchanged);
--   · updates the score of the MOST RECENTLY LOGGED watch, including that watch's existing
--     `title_ranked` post, if it has one;
--   · leaves every earlier watch frozen.
--
--   Watch 1 → 3.4, Watch 2 → 3.5, pure rerank → 4.1
--   ⇒ Watch 1 post 3.4, Watch 2 post 4.1. Log Watch 3 and Watch 2 freezes at 4.1; the next
--     pure rerank moves Watch 3 only.
--
-- 20261015000100 froze every post, including the latest. This keeps that for earlier
-- watches and lets the latest one follow, by updating the one post that belongs to it
-- whenever a correction is written to the ledger. A trigger on the append-only ledger
-- rather than a sixth copy of `_rank_finalize`: the ledger row already carries the
-- corrected score, band, position and category, and the finalize writes it in the same
-- transaction, so the post and the ledger can never disagree.
--
-- Which post is the latest watch's: the post naming it (`payload.watch_event_id`), or —
-- when the latest watch is also the first one logged — the first ranking's post, which
-- names no watch. The most recent such post only (an unrank and a fresh ranking leave the
-- earlier tenure's post standing, and it is not this opinion). A latest watch with no post
-- (a backdated rewatch posts nothing) has nothing to update here; Watch History reads the
-- ledger for it.
--
-- "Most recently logged" is recording order, which is also the order a new watch
-- supersedes the previous one in ("if a Watch 3 is subsequently logged, Watch 2 freezes").
-- ===========================================================================

create or replace function _latest_watch_post(p_user uuid, p_item uuid)
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  with latest as (
    select w.id,
           (select count(*) from watch_events w0
             where w0.user_id = p_user and w0.media_item_id = p_item) = 1
           or w.id = (select w1.id from watch_events w1
                       where w1.user_id = p_user and w1.media_item_id = p_item
                       order by w1.recorded_at, w1.id limit 1) as is_first
      from watch_events w
     where w.user_id = p_user and w.media_item_id = p_item
     order by w.recorded_at desc, w.id desc
     limit 1
  )
  select fe.id
    from feed_events fe, latest
   where fe.actor_id = p_user
     and fe.media_item_id = p_item
     and fe.type = 'title_ranked'
     and (
       fe.payload ->> 'watch_event_id' = latest.id::text
       or (latest.is_first and fe.payload ->> 'watch_event_id' is null)
     )
   order by fe.created_at desc, fe.id desc
   limit 1;
$$;

revoke execute on function _latest_watch_post(uuid, uuid) from public, anon, authenticated;

create or replace function _correction_follows_latest_watch()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_post uuid;
begin
  v_post := _latest_watch_post(new.user_id, new.media_item_id);
  if v_post is null then
    return new;
  end if;

  -- Score, band, position and category together, as the rewatch enrichment writes them
  -- (20261005000100 §K): a post whose score and band disagree is internally inconsistent.
  -- No `from_*` and no outcome: the payload carries no movement.
  update feed_events
     set payload = payload || jsonb_build_object(
           'score',    new.score,
           'bucket',   new.bucket,
           'position', new.position,
           'category', new.category
         )
   where id = v_post;

  return new;
end;
$$;

revoke execute on function _correction_follows_latest_watch() from public, anon, authenticated;

drop trigger if exists ranking_placements_correction_follows_latest_watch on ranking_placements;
create trigger ranking_placements_correction_follows_latest_watch
  after insert on ranking_placements
  for each row
  when (new.kind = 'correction')
  execute function _correction_follows_latest_watch();

-- ---------------------------------------------------------------------------
-- Backfill: a correction written before this migration did not reach its title's
-- latest-watch post. For each such title, the latest-watch post takes the most recent
-- correction made after it was posted. Earlier watches' posts are not touched.
-- ---------------------------------------------------------------------------
with targets as (
  select distinct on (fe.actor_id, fe.media_item_id)
         fe.id as post_id, fe.actor_id, fe.media_item_id, fe.created_at
    from feed_events fe
   where fe.type = 'title_ranked'
     and fe.media_item_id is not null
     and fe.id = _latest_watch_post(fe.actor_id, fe.media_item_id)
),
latest_fix as (
  select t.post_id,
         (select to_jsonb(p) from ranking_placements p
           where p.user_id = t.actor_id and p.media_item_id = t.media_item_id
             and p.kind = 'correction' and p.created_at > t.created_at
           order by p.created_at desc, p.id desc limit 1) as fix
    from targets t
)
update feed_events fe
   set payload = fe.payload || jsonb_build_object(
         'score',    (lf.fix ->> 'score')::numeric,
         'bucket',   lf.fix ->> 'bucket',
         'position', (lf.fix ->> 'position')::integer,
         'category', lf.fix ->> 'category'
       )
  from latest_fix lf
 where fe.id = lf.post_id
   and lf.fix is not null;

comment on function feed_watch_scores(uuid[]) is
  'For title_ranked posts on titles with two or more viewings: the post''s own score and band (payload) and its watch number. Earlier watches'' posts are frozen; the latest watch''s post follows a correction (20261016000100). Returns no position or movement. Visibility is the feed''s own can_i_view.';
