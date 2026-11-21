-- Read-only dry run for the historical consolidation into activity sessions
-- (20261130000900, `consolidate_feed_sessions`).
--
-- A pure SELECT, safe on production with `read_only: true`: it creates nothing, writes
-- nothing, and calls no function of 20261130000900 (which production may not have yet).
-- It inlines `_session_consolidation_plan` and `_group_members`; the test
-- `session-consolidation.test.mjs` runs this file and holds it to the function's own plan.
--
-- Parameters, substituted before running:
--   :'since', :'until'       the range of first activity (at most 8 days)
--   :'include_reviewed'      'true' to fold reviewed first rankings (founder decision), else 'false'
--   :'actor'                 one account's uuid for a first small batch, or '' for everyone
--
-- Output: one JSON report of aggregate counts, with each planned session's event ids and the
-- author as an ordinal (never an id, a name or a handle).
with recursive params as (
  select (:'since')::timestamptz as since, (:'until')::timestamptz as until,
         interval '30 minutes' as win,
         (:'include_reviewed')::boolean as include_reviewed,
         nullif(:'actor', '')::uuid as actor
),
scope as (
  select e.*
    from feed_events e, params p
   where e.created_at >= p.since - interval '1 day' and e.created_at < p.until + interval '1 day'
     and (p.actor is null or e.actor_id = p.actor)
     and e.presented_in is null
     and e.type in ('watchlist_added', 'title_ranked', 'ranking_batch')
     and not coalesce((e.payload ->> 'dissolved')::boolean, false)
),
refs as (
  select s.id,
         exists (select 1 from comments c where c.feed_event_id = s.id) as has_comments,
         exists (select 1 from reactions r where r.feed_event_id = s.id) as has_reactions,
         exists (select 1 from notifications n where n.subject_type = 'feed_event' and n.subject_id = s.id) as has_notifications,
         exists (select 1 from proactive_cluster_actors pa where pa.feed_event_id = s.id) as has_proactive,
         exists (select 1 from feed_event_causes fc where fc.feed_event_id = s.id) as has_causes
    from scope s
),
member_rows as (
  select s.id as event_id, frt.media_item_id, frt.placed_at as at, true as ranked
    from scope s join feed_ranking_titles frt on frt.event_id = s.id
  union all
  select s.id, wt.media_item_id, wt.added_at, false
    from scope s join feed_watchlist_titles wt on wt.event_id = s.id
  union all
  select s.id, c.media_item_id, c.created_at, true
    from scope s join feed_events c on c.presented_in = s.id
   where c.type = 'title_ranked' and c.media_item_id is not null
  union all
  select s.id, frt.media_item_id, frt.placed_at, true
    from scope s join feed_events c on c.presented_in = s.id
    join feed_ranking_titles frt on frt.event_id = c.id
  union all
  select s.id, wt.media_item_id, wt.added_at, false
    from scope s join feed_events c on c.presented_in = s.id
    join feed_watchlist_titles wt on wt.event_id = c.id
),
members as (
  select m.event_id, m.media_item_id, min(m.at) as first_at,
         coalesce(max(m.at) filter (where m.ranked), max(m.at)) as acted_at
    from member_rows m
   group by m.event_id, m.media_item_id
),
group_span as (
  select event_id, min(first_at) as started, max(acted_at) as ended, count(*)::integer as titles
    from members group by event_id
),
flags as (
  select s.id, s.actor_id, s.type, s.created_at, s.media_item_id, s.payload,
         (r.has_comments or r.has_reactions or r.has_notifications or r.has_proactive or r.has_causes) as referenced,
         r.has_comments, r.has_reactions, r.has_notifications, r.has_proactive, r.has_causes,
         (s.type = 'title_ranked' and exists (
            select 1 from user_media um
             where um.user_id = s.actor_id and um.media_item_id = s.media_item_id
               and um.note_visibility = 'public' and nullif(btrim(coalesce(um.note, '')), '') is not null)) as reviewed,
         (s.type = 'title_ranked' and (coalesce((s.payload ->> 'update')::boolean, false)
                                       or coalesce((s.payload ->> 'again')::boolean, false))) as not_first,
         exists (select 1 from feed_events c where c.presented_in = s.id) as presents
    from scope s join refs r on r.id = s.id
),
units as (
  select f.actor_id, f.id as unit_id,
         case when f.type = 'title_ranked' then 'ranking'
              when f.type = 'watchlist_added' and coalesce((f.payload ->> 'count')::integer, 1) <= 1
                   and not f.presents then 'save'
              else 'group' end as unit_kind,
         f.type as unit_type,
         case when f.type = 'title_ranked' then f.created_at else coalesce(g.started, f.created_at) end as started,
         case when f.type = 'title_ranked' then f.created_at else coalesce(g.ended, f.created_at) end as ended,
         f.referenced,
         case when f.type = 'title_ranked' then 1 else coalesce(g.titles, 0) end as titles
    from flags f
    left join group_span g on g.event_id = f.id, params p
   where f.media_item_id is not null
     and (f.type <> 'title_ranked'
          or (not f.not_first and not f.referenced and not f.presents
              and (p.include_reviewed or not f.reviewed)))
),
bounded as (
  select u.*, row_number() over (partition by u.actor_id order by u.started, u.unit_id) as rn
    from units u, params p
   where u.started >= p.since and u.started < p.until and u.titles > 0
),
windows as (
  select b.actor_id, b.rn, b.unit_id, b.started as window_start
    from bounded b where b.rn = 1
  union all
  select n.actor_id, n.rn, n.unit_id,
         case when n.ended < w.window_start + (select win from params) then w.window_start
              else n.started end
    from windows w
    join bounded n on n.actor_id = w.actor_id and n.rn = w.rn + 1
),
sized as (
  select w.*, count(*) over (partition by w.actor_id, w.window_start) as units_in_window
    from windows w
),
plan as (
  select b.actor_id, s.window_start, b.unit_id, b.unit_kind, b.unit_type, b.started, b.ended,
         b.referenced, b.titles
    from sized s join bounded b on b.unit_id = s.unit_id
   where s.units_in_window >= 2
),
sessions as (
  select p.actor_id, p.window_start,
         count(*) as units,
         count(*) filter (where p.unit_kind = 'ranking') as rankings,
         count(*) filter (where p.unit_kind = 'save') as saves,
         count(*) filter (where p.unit_kind = 'group' and p.unit_type = 'ranking_batch') as ranking_groups,
         count(*) filter (where p.unit_kind = 'group' and p.unit_type = 'watchlist_added') as watchlist_groups,
         count(*) filter (where p.referenced) as referenced,
         sum(p.titles) as titles,
         jsonb_agg(p.unit_id order by p.started, p.unit_id) as event_ids
    from plan p
   group by p.actor_id, p.window_start
),
actors as (
  select actor_id, dense_rank() over (order by min(window_start), actor_id) as ordinal
    from sessions group by actor_id
),
range_flags as (
  select f.* from flags f, params p where f.created_at >= p.since and f.created_at < p.until
)
select jsonb_build_object(
  'range', jsonb_build_object('since', (select since from params), 'until', (select until from params)),
  'include_reviewed', (select include_reviewed from params),
  'actor_scoped', (select actor is not null from params),
  'planned', jsonb_build_object(
    'sessions', (select count(*) from sessions),
    'actors', (select count(*) from actors),
    'units', (select count(*) from plan),
    'by_kind', jsonb_build_object(
      'ranking', (select count(*) from plan where unit_kind = 'ranking'),
      'save', (select count(*) from plan where unit_kind = 'save'),
      'group', (select count(*) from plan where unit_kind = 'group'),
      'ranking_group', (select count(*) from plan where unit_kind = 'group' and unit_type = 'ranking_batch'),
      'watchlist_group', (select count(*) from plan where unit_kind = 'group' and unit_type = 'watchlist_added')),
    'referenced_units', (select count(*) from plan where referenced),
    'cards_before', (select count(*) from plan),
    'cards_after', (select count(*) from sessions)
                   + (select coalesce(sum(greatest(referenced - 1, 0)), 0) from sessions),
    'mixed_sessions', (select count(*) from sessions
                        where (rankings + ranking_groups) > 0 and (saves + watchlist_groups) > 0),
    'largest_session_titles', (select coalesce(max(titles), 0) from sessions)),
  'excluded', jsonb_build_object(
    'with_comments', (select count(*) from range_flags where has_comments),
    'with_reactions', (select count(*) from range_flags where has_reactions),
    'notification_refs', (select count(*) from range_flags where has_notifications),
    'proactive_refs', (select count(*) from range_flags where has_proactive),
    'award_causes', (select count(*) from range_flags where has_causes),
    'reviewed_rankings', (select count(*) from range_flags where reviewed),
    'reviewed_rankings_left_alone', (select count(*) from range_flags, params p
                                      where reviewed and not referenced and not not_first
                                        and not p.include_reviewed),
    'rewatch_or_update', (select count(*) from range_flags where not_first)),
  'by_actor', coalesce((select jsonb_agg(jsonb_build_object(
       'actor', a.ordinal,
       'sessions', (select count(*) from sessions s where s.actor_id = a.actor_id),
       'units', (select sum(units) from sessions s where s.actor_id = a.actor_id),
       'cards_removed', (select sum(units - 1 - greatest(referenced - 1, 0)) from sessions s
                          where s.actor_id = a.actor_id)) order by a.ordinal)
     from actors a), '[]'::jsonb),
  'sessions', coalesce((select jsonb_agg(jsonb_build_object(
       'actor', a.ordinal,
       'window_start', s.window_start,
       'units', s.units, 'rankings', s.rankings, 'saves', s.saves,
       'ranking_groups', s.ranking_groups, 'watchlist_groups', s.watchlist_groups,
       'referenced', s.referenced, 'titles', s.titles,
       'event_ids', s.event_ids) order by a.ordinal, s.window_start)
     from sessions s join actors a on a.actor_id = s.actor_id), '[]'::jsonb)
) as report;
