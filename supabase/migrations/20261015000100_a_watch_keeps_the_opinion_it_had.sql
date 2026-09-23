-- ===========================================================================
-- A WATCH KEEPS THE OPINION IT HAD (founder delta QA, 2026-09-21)
--
-- 20261014000100 froze a SUPERSEDED viewing's post at the latest placement of its span, and
-- read the LATEST viewing live. The founder's rule is stricter and simpler:
--
--   · a watch's score is the opinion the reader held AT that watch;
--   · a pure Update your rating creates no watch and must not rewrite any watch's score —
--     not an old one, and not the latest one either;
--   · the current score (title page, Collection, Search) is what moves.
--
-- Every watch-backed `title_ranked` post already carries exactly that number:
-- `payload.score`, written by the same `_rank_finalize` that writes the placement
-- (20260815010000), enriched once when the viewing's own re-rank completes
-- (20261005000100 §K), and never touched by a correction or a refine. So this answers
-- with the post's own frozen score and band for every mapped post, and the span arithmetic
-- — which let a correction amend the latest viewing — goes.
--
-- Shape unchanged (event_id, score, bucket, watch_number), so the installed preview client
-- keeps working: it overrides the live score with `score` when it is present, which is now
-- the post's own historical score. Grants, visibility (`can_i_view`) and the 50-id bound
-- are unchanged. No position, no movement, nothing §K keeps private leaves it.
-- ===========================================================================

create or replace function feed_watch_scores(p_event_ids uuid[])
returns table (
  event_id     uuid,
  score        numeric,
  bucket       taste_bucket,
  watch_number integer
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_ids is null then
    raise exception 'feed_watch_scores requires event ids' using errcode = '22023';
  end if;
  if coalesce(array_length(p_event_ids, 1), 0) > 50 then
    raise exception 'feed_watch_scores accepts at most 50 ids' using errcode = '22023';
  end if;

  return query
    with ev as (
      select fe.id, fe.actor_id, fe.media_item_id, fe.payload,
             case when (fe.payload ->> 'watch_event_id') ~* '^[0-9a-f-]{36}$'
                  then (fe.payload ->> 'watch_event_id')::uuid end as payload_watch
        from feed_events fe
       where fe.id = any (p_event_ids)
         and fe.type = 'title_ranked'
         and fe.media_item_id is not null
         and can_i_view(fe.actor_id)
         and (select count(*) from watch_events w
               where w.user_id = fe.actor_id and w.media_item_id = fe.media_item_id) >= 2
    )
    select ev.id,
           case when (ev.payload ->> 'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
                then (ev.payload ->> 'score')::numeric end,
           case when ev.payload ->> 'bucket' in ('loved', 'fine', 'not_for_me')
                then (ev.payload ->> 'bucket')::taste_bucket end,
           -- The viewing's ordinal in Watch History's own order (undated first, then by
           -- date, then by recording), so "2nd watch" on a card and on the history screen
           -- are the same number. Null for a post that names no viewing.
           (select o.n
              from (select w3.id,
                           row_number() over (
                             order by w3.watched_on nulls first, w3.recorded_at, w3.id
                           )::integer as n
                      from watch_events w3
                     where w3.user_id = ev.actor_id and w3.media_item_id = ev.media_item_id) o
             where o.id = ev.payload_watch)
      from ev;
end;
$$;

comment on function feed_watch_scores(uuid[]) is
  'For title_ranked posts on titles with two or more viewings: the post''s OWN frozen score and band (payload, written at that viewing''s ranking and never changed by a correction) and its watch number. Returns no position or movement. Visibility is the feed''s own can_i_view.';

-- The span helper existed only for the rule this replaces.
drop function if exists _watch_span_placement(uuid, uuid, uuid, timestamptz, timestamptz);

notify pgrst, 'reload schema';
