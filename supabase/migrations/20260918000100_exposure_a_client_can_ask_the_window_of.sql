-- Exposure a client can ask the window of.
--
-- ---------------------------------------------------------------------------
-- Why a second reader, and not a longer window on the first
-- ---------------------------------------------------------------------------
--
-- For You V2 (client, `src/features/recommendations/selection.ts`) decays each title's
-- exposure from its `last_shown_at` -- strongly the same day, halving every 96 hours -- so
-- it needs impressions older than the three days `recommendation_exposure()` returns
-- (`foryou.impression_window_hours` = 72). Measured on real production profiles
-- (aggregates only, `docs/product/recommendations.md` §11), visits four days apart share
-- 14.0 / 8.0 / 5.5 / 3.8 of twenty titles with the 72-hour read and 9.0 / 4.3 / 3.5 / 2.3
-- with a fortnight's (First Five / ~20 / ~60 / 100+ ranked films).
--
-- **Raising the shared setting was the obvious change and it is the wrong one.** Clients
-- that cannot take the V2 update -- the App Store build and the stranded Android runtimes --
-- read the same function into the old tier engine, which caps a title's count at three and
-- only reorders inside its top sixty. Over a fortnight a daily reader's whole pool reaches
-- the top tier and stays there, the tiers flatten, and every launch shows the same
-- near-score-order wall: more repetition for exactly the readers who cannot get the fix.
-- Independent review of V2 found it.
--
-- So `recommendation_exposure()` and its 72-hour setting are **untouched**, and V2 asks for
-- its own window here. A client asking for more than `foryou.exposure_max_window_hours`
-- (720, thirty days) gets that ceiling; a null or non-positive ask gets the old 72.
--
-- ---------------------------------------------------------------------------
-- What it can and cannot return
-- ---------------------------------------------------------------------------
--
-- Exactly `recommendation_exposure()`'s shape and perspective: the caller's own rows,
-- aggregated per title, `auth.uid()` only, no timestamps beyond the latest. Definer for the
-- same reason -- `recommendation_impressions` has RLS and deliberately no read policy. A
-- distinct name rather than an overload, so PostgREST never has to choose between two
-- signatures for one call.
--
-- Cost: one read per For You session over the caller's own rows, served by
-- `recommendation_impressions_cooldown (user_id, media_item_id, shown_at desc)` and bounded
-- by `foryou.impression_rows_per_day` (2000) × the ceiling.
-- ===========================================================================

insert into app_config (key, value) values
  ('foryou.exposure_max_window_hours', '720'::jsonb)
on conflict (key) do nothing;

create or replace function recommendation_exposure_within(p_hours integer)
returns table (media_item_id uuid, shown_count integer, last_shown_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select i.media_item_id,
         count(*)::integer,
         max(i.shown_at)
    from recommendation_impressions i
   where auth.uid() is not null
     and i.user_id = auth.uid()
     and i.shown_at > now() - make_interval(
           hours => least(
             case when coalesce(p_hours, 0) > 0 then p_hours else 72 end,
             greatest(
               1,
               coalesce(
                 (select (value)::integer from app_config where key = 'foryou.exposure_max_window_hours'),
                 720
               )
             )
           )
         )
   group by i.media_item_id;
$$;

comment on function recommendation_exposure_within(integer) is
  'recommendation_exposure() with a caller-chosen window, for For You V2''s decaying exposure: the caller''s own For You impressions inside p_hours (null or non-positive means 72; capped at foryou.exposure_max_window_hours), aggregated per title with the latest shown_at. The original function and foryou.impression_window_hours stay as they are for clients that have not updated, whose tier engine would repeat more over a longer window.';

revoke execute on function recommendation_exposure_within(integer) from public, anon, authenticated;
grant  execute on function recommendation_exposure_within(integer) to authenticated;
