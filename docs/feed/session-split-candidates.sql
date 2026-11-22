-- Read-only dry run for the historical split of mixed session posts
-- (20261130001000, `split_mixed_sessions`).
--
-- A pure SELECT, safe on production with `read_only: true`: it creates nothing, writes
-- nothing, and calls no function (the read-only role may not, and production may not have
-- 20261130001000 yet). It is `_session_split_plan`'s own query, word for word; the test
-- `session-split.test.mjs` runs this file and holds it to the function.
--
-- Parameters, substituted (every occurrence) before running:
--   :'since', :'until'   the range of window anchors (the function allows at most 31 days)
--   :'actor'             one account's uuid for the founder-first batch, or '' for everyone
--
-- Output: one JSON report of aggregate counts, with each author as an ordinal (never an id,
-- a name or a handle).
with plan as (
  with params as (
    select make_interval(mins => greatest(1, coalesce(
             (select (c.value)::integer from app_config c where c.key = 'feed.ranking_group_minutes'),
             30))) as win
  ),
  posts as (
    select e.id, e.actor_id, e.type, e.media_item_id, e.created_at, e.payload,
           coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) as anchor
      from feed_events e
     where e.presented_in is null
       and e.type in ('ranking_batch', 'watchlist_added')
       and (nullif(:'actor', '')::uuid is null or e.actor_id = nullif(:'actor', '')::uuid)
       and coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) >= :'since'::timestamptz
       and coalesce((e.payload ->> 'started_at')::timestamptz, e.created_at) < :'until'::timestamptz
  ),
  kids as (
    select c.id, c.type, c.presented_in as post, c.media_item_id, c.created_at, c.payload
      from feed_events c
      join posts p on c.presented_in = p.id
  ),
  raw as (
    select p.id as post, frt.media_item_id, 'ranking'::text as cat
      from posts p join feed_ranking_titles frt on frt.event_id = p.id
    union all
    select p.id, wt.media_item_id, 'watchlist'
      from posts p join feed_watchlist_titles wt on wt.event_id = p.id
    union all
    select k.post, k.media_item_id, 'ranking'
      from kids k where k.type = 'title_ranked' and k.media_item_id is not null
    union all
    select k.post, frt.media_item_id, 'ranking'
      from kids k join feed_ranking_titles frt on frt.event_id = k.id
    union all
    select k.post, wt.media_item_id, 'watchlist'
      from kids k join feed_watchlist_titles wt on wt.event_id = k.id
  ),
  mixed as (
    select p.* from posts p
     where exists (select 1 from raw r where r.post = p.id and r.cat = 'ranking')
       and exists (select 1 from raw r where r.post = p.id and r.cat = 'watchlist')
  ),
  logged as (
    select distinct on (l.group_event_id) l.group_event_id, l.created_group, l.prior_type
      from feed_consolidation_log l
     where l.kind = 'session' and l.member_event_id is null
       and l.group_event_id in (select m.id from mixed m)
     order by l.group_event_id, l.id desc
  ),
  kept as (
    select m.*,
           case
             when lg.group_event_id is not null then
               case when not lg.created_group and lg.prior_type = 'watchlist_added'
                    then 'watchlist' else 'ranking' end
             when coalesce(m.payload ->> 'origin', '') in ('session', 'title', 'history', 'split')
               then 'ranking'
             when exists (select 1 from feed_ranking_titles f where f.event_id = m.id) then 'ranking'
             when exists (select 1 from feed_watchlist_titles f where f.event_id = m.id) then 'watchlist'
             else 'ranking'
           end as keep,
           (select count(distinct r.media_item_id) from raw r
             where r.post = m.id and r.cat = 'ranking')::integer as ranked,
           (select count(distinct r.media_item_id) from raw r
             where r.post = m.id and r.cat = 'watchlist')::integer as saved,
           exists (select 1 from feed_ranking_titles f where f.event_id = m.id) as own_ranking_rows,
           -- The newest of the post's own saves that no other watchlist post carries.
           (select wt.media_item_id from feed_watchlist_titles wt
             where wt.event_id = m.id
               and not exists (select 1 from feed_events o
                                where o.actor_id = m.actor_id and o.type = 'watchlist_added'
                                  and o.media_item_id = wt.media_item_id and o.id <> m.id)
             order by wt.added_at desc, wt.id desc limit 1) as free_save,
           exists (select 1 from comments c where c.feed_event_id = m.id)
             or exists (select 1 from reactions r where r.feed_event_id = m.id)
             or exists (select 1 from notifications n
                         where n.subject_type = 'feed_event' and n.subject_id = m.id)
             or exists (select 1 from proactive_cluster_actors pa where pa.feed_event_id = m.id)
             or exists (select 1 from feed_event_causes fc where fc.feed_event_id = m.id) as referenced
      from mixed m
      left join logged lg on lg.group_event_id = m.id
  ),
  candidates as (
    select k.*,
           case when k.keep = 'watchlist' then
             (select c.id from kids c where c.post = k.id and c.type = 'ranking_batch'
               order by coalesce((c.payload ->> 'count')::integer, 0) desc, c.created_at, c.id limit 1)
           else
             (select c.id from kids c where c.post = k.id and c.type = 'watchlist_added'
               order by coalesce((c.payload ->> 'count')::integer, 1) desc, c.created_at, c.id limit 1)
           end as group_kid,
           (select c.id from kids c where c.post = k.id and c.type = 'title_ranked'
             order by c.created_at, c.id limit 1) as single_kid
      from kept k
  ),
  decided as (
    select c.*,
           case when c.group_kid is not null then c.group_kid
                when c.keep = 'watchlist' and c.ranked = 1 and not c.own_ranking_rows
                  then c.single_kid
           end as partner
      from candidates c
  )
  select d.id as post_id,
         d.actor_id,
         d.anchor,
         d.keep,
         d.partner as partner_id,
         case when d.keep = 'ranking' then 'watchlist_added'
              when d.partner is not null and d.partner = d.single_kid
                   and d.partner is distinct from d.group_kid then 'title_ranked'
              else 'ranking_batch' end as partner_type,
         case when d.keep = 'ranking' and d.partner is null then d.free_save end as partner_title,
         d.ranked,
         d.saved,
         d.referenced,
         case
           when d.anchor + (select win from params) > now() then 'window_open'
           when exists (select 1 from kids x where x.post = d.id
                         and x.type not in ('title_ranked', 'ranking_batch', 'watchlist_added'))
             then 'unknown_member'
           when exists (select 1 from kids x join feed_events y on y.presented_in = x.id
                         where x.post = d.id)
             then 'nested_member'
           when exists (select 1 from kids x where x.post = d.id and (
                  (x.type = 'ranking_batch'
                   and exists (select 1 from feed_watchlist_titles w where w.event_id = x.id))
               or (x.type = 'watchlist_added'
                   and exists (select 1 from feed_ranking_titles f where f.event_id = x.id))))
             then 'mixed_member'
           when d.keep = 'watchlist' and d.free_save is null then 'no_watchlist_title'
           when d.keep = 'ranking' and d.partner is null and d.free_save is null
             then 'no_watchlist_title'
           when d.keep = 'watchlist' and d.group_kid is not null and exists (
                  select 1 from feed_ranking_titles a
                    join feed_ranking_titles b on b.media_item_id = a.media_item_id
                   where a.event_id = d.id and b.event_id = d.group_kid)
             then 'title_conflict'
         end as exception
    from decided d
   order by d.actor_id, d.anchor, d.id
),
numbered as (
  select p.*, dense_rank() over (order by p.actor_id) as actor_n from plan p
)
select jsonb_build_object(
  'mixed_posts', count(*),
  'to_split', count(*) filter (where exception is null),
  'actors', count(distinct actor_id) filter (where exception is null),
  'keep_ranking', count(*) filter (where exception is null and keep = 'ranking'),
  'keep_watchlist', count(*) filter (where exception is null and keep = 'watchlist'),
  'partners_reused', count(*) filter (where exception is null and partner_id is not null),
  'partners_created', count(*) filter (where exception is null and partner_id is null),
  'reused_by_type', coalesce((select jsonb_object_agg(x.partner_type, x.n) from (
      select n2.partner_type, count(*) as n from numbered n2
       where n2.exception is null and n2.partner_id is not null group by n2.partner_type) x),
    '{}'::jsonb),
  'created_by_type', coalesce((select jsonb_object_agg(x.partner_type, x.n) from (
      select n2.partner_type, count(*) as n from numbered n2
       where n2.exception is null and n2.partner_id is null group by n2.partner_type) x),
    '{}'::jsonb),
  'with_engagement', count(*) filter (where referenced),
  'titles_ranked', coalesce(sum(ranked) filter (where exception is null), 0),
  'titles_saved', coalesce(sum(saved) filter (where exception is null), 0),
  'exceptions', coalesce((select jsonb_object_agg(x.exception, x.n) from (
      select n2.exception, count(*) as n from numbered n2
       where n2.exception is not null group by n2.exception) x),
    '{}'::jsonb),
  'by_actor', coalesce((select jsonb_agg(jsonb_build_object(
        'actor', x.actor_n, 'posts', x.posts, 'reused', x.reused, 'created', x.created,
        'exceptions', x.exceptions) order by x.actor_n) from (
      select n2.actor_n,
             count(*) filter (where n2.exception is null) as posts,
             count(*) filter (where n2.exception is null and n2.partner_id is not null) as reused,
             count(*) filter (where n2.exception is null and n2.partner_id is null) as created,
             count(*) filter (where n2.exception is not null) as exceptions
        from numbered n2 group by n2.actor_n) x),
    '[]'::jsonb)
) as report
from numbered;
