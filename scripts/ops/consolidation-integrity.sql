select jsonb_build_object(
 'rankings',          (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from rankings t),
 'ranking_placements',(select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from ranking_placements t),
 'watchlist',         (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from watchlist t),
 'watch_events',      (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from watch_events t),
 'user_media',        (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from user_media t),
 'comments',          (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from comments t),
 'reactions',         (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from reactions t),
 'comment_reactions', (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from comment_reactions t),
 'notifications',     (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from notifications t),
 'feed_event_causes', (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from feed_event_causes t),
 'feed_watchlist_titles',(select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from feed_watchlist_titles t),
 'feed_ranking_titles',  (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(t::text, '|' order by t::text),''))) from feed_ranking_titles t),
 'feed_event_identity', (select jsonb_build_object('n',count(*),'h',md5(coalesce(string_agg(concat_ws(',',id,type,actor_id,media_item_id,created_at,causal_at,causal_step), '|' order by id),''))) from feed_events
                          where id not in (select group_event_id from feed_consolidation_log where created_group and member_event_id is null)),
 'feed_events_total', (select count(*) from feed_events),
 'visible',           (select count(*) from feed_events where presented_in is null),
 'hidden',            (select count(*) from feed_events where presented_in is not null),
 'drafts',            (select count(*) from feed_events where type = 'ranking_batch_draft'),
 'groups_visible',    (select jsonb_object_agg(type, n) from (select type, count(*) n from feed_events where presented_in is null and type in ('ranking_batch','watchlist_added') group by type) x),
 'log_rows',          (select count(*) from feed_consolidation_log)
) as r
