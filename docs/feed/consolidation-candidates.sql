-- Read-only dry run for the one-time historical consolidation (Feed PR 2, 20261128000100;
-- the date rule removed by 20261130000200).
--
-- A pure SELECT, safe on production with `read_only`: it creates nothing, writes nothing,
-- and needs none of the migrations' functions (their rules are inlined below, and the test
-- `ranking-grouping-window.test.mjs` runs this file and holds it to the same plan as
-- `consolidate_feed_history`). A first-time ranking is eligible whatever its watch date.
--
-- :since / :until bound the range (at most 8 days). Fixed 30-minute windows from each
-- window's first eligible post, per actor and family. Returns one JSON report.
with recursive params as (
  select (:'since')::timestamptz as since, (:'until')::timestamptz as until, interval '30 minutes' as win
),
scope as (
  select e.*
    from feed_events e, params p
   where e.created_at >= p.since and e.created_at < p.until
     and e.type in ('watchlist_added', 'title_ranked')
     -- Already shown through a group (20261128000100): not a candidate, as in the function.
     and e.presented_in is null
),
flags as (
  select s.id, s.actor_id, s.type, s.media_item_id, s.created_at,
         case when s.type = 'watchlist_added' then 'watchlist' else 'ranking' end as fam,
         (exists (select 1 from comments c where c.feed_event_id = s.id)
          or exists (select 1 from reactions r where r.feed_event_id = s.id)
          or exists (select 1 from notifications n where n.subject_type = 'feed_event' and n.subject_id = s.id)
          or exists (select 1 from proactive_cluster_actors pa where pa.feed_event_id = s.id)
          or exists (select 1 from feed_event_causes fc where fc.feed_event_id = s.id)) as referenced,
         (exists (select 1 from comments c where c.feed_event_id = s.id)) as has_comments,
         (exists (select 1 from reactions r where r.feed_event_id = s.id)) as has_reactions,
         (s.type = 'title_ranked' and exists (
            select 1 from user_media um
             where um.user_id = s.actor_id and um.media_item_id = s.media_item_id
               and um.note_visibility = 'public' and nullif(btrim(coalesce(um.note, '')), '') is not null)) as reviewed,
         (s.type = 'title_ranked' and (coalesce((s.payload ->> 'update')::boolean, false)
                                       or coalesce((s.payload ->> 'again')::boolean, false))) as not_first,
         ((s.type = 'watchlist_added' and coalesce((s.payload ->> 'count')::integer, 1) > 1)
          or exists (select 1 from feed_events c where c.presented_in = s.id)) as already_group
    from scope s
),
eligible as (
  select f.*, row_number() over (partition by f.actor_id, f.fam order by f.created_at, f.id) as rn
    from flags f
   where f.media_item_id is not null and not f.referenced and not f.already_group
     and (f.type = 'watchlist_added' or (not f.reviewed and not f.not_first))
),
windows as (
  select e.actor_id, e.fam, e.rn, e.id, e.created_at, e.created_at as win_start
    from eligible e where e.rn = 1
  union all
  select n.actor_id, n.fam, n.rn, n.id, n.created_at,
         case when n.created_at < w.win_start + (select win from params) then w.win_start else n.created_at end
    from windows w
    join eligible n on n.actor_id = w.actor_id and n.fam = w.fam and n.rn = w.rn + 1
),
groups as (
  select actor_id, fam, win_start, count(*) as members
    from windows group by actor_id, fam, win_start
   having count(*) >= 2
)
select jsonb_build_object(
  'range', jsonb_build_object('since', (select since from params), 'until', (select until from params)),
  'scanned', jsonb_build_object(
     'watchlist', (select count(*) from flags where fam = 'watchlist'),
     'ranking', (select count(*) from flags where fam = 'ranking')),
  'eligible', jsonb_build_object(
     'watchlist', (select count(*) from eligible where fam = 'watchlist'),
     'ranking', (select count(*) from eligible where fam = 'ranking')),
  'groups', jsonb_build_object(
     'watchlist', (select count(*) from groups where fam = 'watchlist'),
     'ranking', (select count(*) from groups where fam = 'ranking')),
  'members_consolidated', jsonb_build_object(
     'watchlist', (select coalesce(sum(members), 0) from groups where fam = 'watchlist'),
     'ranking', (select coalesce(sum(members), 0) from groups where fam = 'ranking')),
  'visible_cards_removed', (select coalesce(sum(members - 1), 0) from groups),
  'actors_affected', (select count(distinct actor_id) from groups),
  'excluded', jsonb_build_object(
     'with_comments', (select count(*) from flags where has_comments),
     'with_reactions', (select count(*) from flags where has_reactions),
     'referenced_any', (select count(*) from flags where referenced),
     'reviewed', (select count(*) from flags where reviewed),
     'rewatch_or_update', (select count(*) from flags where not_first),
     'already_grouped', (select count(*) from flags where already_group)),
  'integrity', jsonb_build_object(
     'watchlist_posts_without_membership', (select count(*) from scope s where s.type = 'watchlist_added'
        and not exists (select 1 from feed_watchlist_titles wt where wt.event_id = s.id)),
     'duplicate_first_rankings', (select count(*) from (
        select actor_id, media_item_id from scope where type = 'title_ranked'
           and not coalesce((payload ->> 'update')::boolean, false) and not coalesce((payload ->> 'again')::boolean, false)
         group by 1, 2 having count(*) > 1) d),
     'largest_group', (select coalesce(max(members), 0) from groups))
) as report;
