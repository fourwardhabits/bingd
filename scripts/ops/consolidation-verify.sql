with g as (
  select distinct l.batch, l.group_event_id id, l.created_group from feed_consolidation_log l where l.member_event_id is null and l.batch like 'history-20261117-w%'
), h as (select * from feed_events where presented_in is not null)
select jsonb_build_object(
 'batches', (select jsonb_object_agg(batch, n) from (select batch, count(*) n from g group by batch) x),
 'groups', (select count(*) from g),
 'groups_by_type', (select jsonb_object_agg(type, n) from (select fe.type, count(*) n from g join feed_events fe on fe.id = g.id group by fe.type) x),
 'groups_not_visible', (select count(*) from g join feed_events fe on fe.id = g.id where fe.presented_in is not null),
 'group_count_mismatch', (select count(*) from g join feed_events fe on fe.id = g.id where coalesce((fe.payload->>'count')::int, -1) <> _group_title_count(g.id)),
 'groups_under_two', (select count(*) from g where _group_title_count(g.id) < 2),
 'group_title_total', (select sum(_group_title_count(g.id)) from g),
 'largest_group', (select max(_group_title_count(g.id)) from g),
 'groups_over_12', (select count(*) from g where _group_title_count(g.id) > 12),
 'hidden_total', (select count(*) from h),
 'hidden_not_logged', (select count(*) from h where not exists (select 1 from feed_consolidation_log l where l.member_event_id = h.id)),
 'hidden_bad_target', (select count(*) from h join feed_events t on t.id = h.presented_in
     where t.presented_in is not null or t.actor_id <> h.actor_id or t.type not in ('ranking_batch','watchlist_added')
        or (h.type = 'watchlist_added' and t.type <> 'watchlist_added') or (h.type = 'title_ranked' and t.type <> 'ranking_batch')),
 'hidden_wrong_type', (select count(*) from h where h.type not in ('title_ranked','watchlist_added')),
 'hidden_referenced', (select count(*) from h where _feed_event_referenced(h.id)),
 'hidden_reviewed', (select count(*) from h where h.type = 'title_ranked' and _feed_title_reviewed(h.actor_id, h.media_item_id)),
 'hidden_not_first', (select count(*) from h where coalesce((payload->>'update')::boolean,false) or coalesce((payload->>'again')::boolean,false)),
 'groups_referenced', (select count(*) from g where _feed_event_referenced(g.id)),
 'promoted_with_prior_payload', (select count(*) from feed_consolidation_log where member_event_id is null and not created_group and prior_payload is not null and batch like 'history-20261117-w%'),
 'created_groups_tagged', (select count(*) from g join feed_events fe on fe.id = g.id where g.created_group and fe.payload->>'consolidation_batch' = g.batch and fe.payload->>'origin' = 'history'),
 'created_group_time_matches_first_member', (select count(*) from g join feed_events fe on fe.id = g.id where g.created_group
     and fe.causal_at = (select min(m.causal_at) from feed_events m where m.presented_in = g.id)),
 'visible_null_causal', (select count(*) from feed_events where presented_in is null and (causal_at is null or causal_step is null)),
 'visible_dup_sort_key', (select count(*) from (select causal_at, causal_step, id from feed_events where presented_in is null group by 1,2,3 having count(*) > 1) d),
 'drafts', (select count(*) from feed_events where type = 'ranking_batch_draft'),
 'sitting_joins_orphans', (select count(*) from feed_ranking_sitting_joins j where not exists (select 1 from feed_events e where e.id = j.event_id)),
 'notifications_since_run', (select count(*) from notifications where created_at >= '2026-11-17 01:20:00+00'),
 'visible', (select count(*) from feed_events where presented_in is null)
) as r
