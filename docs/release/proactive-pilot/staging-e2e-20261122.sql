begin;

create temp table e2e (n serial, step text, result jsonb) on commit drop;
create sequence pg_temp.e2e_seq start 1999100000;
create function pg_temp._e2e_title() returns uuid language sql as $f$
  insert into public.media_items (kind, tmdb_id, title, release_date, provenance)
  values ('movie', nextval('pg_temp.e2e_seq')::int, 'E2E Pilot Post', '2020-01-01', 'tmdb') returning id
$f$;

do $e2e$
declare
  v_evening timestamptz;
  v_late    timestamptz;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid; r8 uuid;
  f1 uuid; f2 uuid; f3 uuid; fb uuid; fp uuid; fbare uuid; frx uuid;
  m1 uuid; m2 uuid; mb uuid; mx uuid;
  v_ids uuid[];
  v_job jsonb;
  v_jobs jsonb;
  v_note uuid;
  i int;

  tmdb int := 1999000000;

  -- helpers as nested blocks below
begin
  -- The next 17:30 UTC after now: inside a UTC reader's 17:00-20:00 window.
  v_evening := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '17 hours 30 minutes';
  if v_evening <= now() then v_evening := v_evening + interval '1 day'; end if;
  v_late := v_evening + interval '3 hours';

  -- Switches, inside this transaction only (rolled back at the end).
  update app_config set value = 'true'::jsonb
   where key in ('proactive.generation_enabled', 'proactive.push_enabled', 'proactive.social_enabled');

  -- Disposable accounts, UTC, US.
  for i in 1..15 loop
    v_ids := v_ids || gen_random_uuid();
    insert into auth.users (id, aud, role, email, created_at, updated_at)
    values (v_ids[i], 'authenticated', 'authenticated', 'e2e-pilot-' || i || '-' || left(v_ids[i]::text, 8) || '@example.invalid', now(), now());
    insert into profiles (id, username, display_name, visibility)
    values (v_ids[i], 'e2ep' || i || left(replace(v_ids[i]::text, '-', ''), 8), 'E2E ' || i,
            case when i = 12 then 'private' else 'public' end::profile_visibility);
    insert into account_context (user_id, timezone, region) values (v_ids[i], 'UTC', 'US');
  end loop;
  r1 := v_ids[1]; r2 := v_ids[2]; r3 := v_ids[3]; r4 := v_ids[4]; r5 := v_ids[5];
  r6 := v_ids[6]; r7 := v_ids[7]; r8 := v_ids[8];
  f1 := v_ids[9]; f2 := v_ids[10]; f3 := v_ids[11]; fp := v_ids[12]; fb := v_ids[13];
  fbare := v_ids[14]; frx := v_ids[15];

  -- Devices: r1 a capable phone and an old tablet; r6 only an old build; r7 none (permission
  -- never granted, so no token); everyone else a capable phone.
  insert into device_tokens (user_id, token, platform, proactive_version)
  select u, 'ExponentPushToken[e2e-' || u || ']', 'ios', 2
    from unnest(array[r1, r2, r3, r4, r5, r8]) u;
  insert into device_tokens (user_id, token, platform, proactive_version)
  values (r1, 'ExponentPushToken[e2e-old-' || r1 || ']', 'android', null),
         (r6, 'ExponentPushToken[e2e-old-' || r6 || ']', 'ios', 1);

  -- The pilot allowlist: everyone but r5.
  update app_config set value = to_jsonb(array[r1, r2, r3, r4, r6, r7, r8]::text[])
   where key = 'proactive.pilot_recipients';
  insert into e2e (step, result) select 'status after enabling (in txn)',
    jsonb_build_object('pilot', proactive_status() -> 'pilot', 'social', proactive_status() -> 'social_enabled',
                       'theatrical', proactive_status() -> 'theatrical_enabled',
                       'threshold', proactive_status() -> 'friend_min_affinity');

  -- Disposable titles.
  insert into media_items (kind, tmdb_id, title, release_date, provenance) values ('movie', tmdb + 1, 'E2E Pilot One', '2020-01-01', 'tmdb') returning id into m1;
  insert into media_items (kind, tmdb_id, title, release_date, provenance) values ('movie', tmdb + 2, 'E2E Pilot Two', '2020-01-01', 'tmdb') returning id into m2;
  insert into media_items (kind, tmdb_id, title, release_date, provenance) values ('movie', tmdb + 3, 'E2E Pilot Three', '2020-01-01', 'tmdb') returning id into mb;
  insert into media_items (kind, tmdb_id, title, release_date, provenance) values ('movie', tmdb + 4, 'E2E Pilot Post', '2020-01-01', 'tmdb') returning id into mx;

  -- Everyone saved m1; r1 also m2.
  insert into watchlist (user_id, media_item_id) select u, m1 from unnest(array[r1, r2, r3, r4, r5, r6, r7, r8]) u;
  insert into watchlist (user_id, media_item_id) values (r1, m2);

  -- Friendships. f1, f2, f3: mutual with every reader, and every reader commented on a post
  -- of each (meaningful affinity 2.5). fbare: mutual with r4, never interacted. frx: mutual
  -- with r4, reactions only. fb: mutual with r3 and talked to, then blocked r3. fp: private,
  -- follows r3, r3's request to fp still pending; fp commented on r3's post.
  declare
    rd uuid; fr uuid; ev uuid;
  begin
    foreach rd in array array[r1, r2, r3, r4, r5, r6, r7, r8] loop
      foreach fr in array array[f1, f2, f3] loop
        insert into follows (follower_id, followee_id, state, approved_at) values (rd, fr, 'approved', now()), (fr, rd, 'approved', now());
        insert into feed_events (actor_id, type, media_item_id) values (fr, 'watchlist_added', pg_temp._e2e_title()) returning id into ev;
        insert into comments (feed_event_id, author_id, body) values (ev, rd, 'e2e');
      end loop;
    end loop;
    insert into follows (follower_id, followee_id, state, approved_at) values (r4, fbare, 'approved', now()), (fbare, r4, 'approved', now());
    insert into follows (follower_id, followee_id, state, approved_at) values (r4, frx, 'approved', now()), (frx, r4, 'approved', now());
    for i in 0..7 loop
      insert into feed_events (actor_id, type, media_item_id) values (frx, 'watchlist_added', pg_temp._e2e_title()) returning id into ev;
      insert into reactions (feed_event_id, user_id, kind, created_at) values (ev, r4, 'love', now() - make_interval(days => i / 2));
      insert into feed_events (actor_id, type, media_item_id) values (r4, 'watchlist_added', pg_temp._e2e_title()) returning id into ev;
      insert into reactions (feed_event_id, user_id, kind, created_at) values (ev, frx, 'funny', now() - make_interval(days => i / 2));
    end loop;
    insert into follows (follower_id, followee_id, state, approved_at) values (r3, fb, 'approved', now()), (fb, r3, 'approved', now());
    insert into feed_events (actor_id, type, media_item_id) values (fb, 'watchlist_added', pg_temp._e2e_title()) returning id into ev;
    insert into comments (feed_event_id, author_id, body) values (ev, r3, 'e2e');
    insert into follows (follower_id, followee_id, state, approved_at) values (fp, r3, 'approved', now());
    insert into follows (follower_id, followee_id, state) values (r3, fp, 'pending');
    insert into feed_events (actor_id, type, media_item_id) values (r3, 'watchlist_added', pg_temp._e2e_title()) returning id into ev;
    insert into comments (feed_event_id, author_id, body) values (ev, fp, 'e2e');
  end;
  -- r3 blocks... no: fb blocks r3 (block() removes follows; here the row alone is the block).
  insert into blocks (blocker_id, blocked_id) values (fb, r3);
  -- r2: Watchlist & discovery off.
  insert into notification_preferences (user_id, category, enabled) values (r2, 'watchlist_discovery', false);

  insert into e2e (step, result) select 'affinity (qualifies?)', jsonb_build_object(
    'reader_to_commented_friend', _proactive_friend_qualifies(r1, f1, now()),
    'mutual_only', _proactive_friend_qualifies(r4, fbare, now()),
    'reactions_only', _proactive_friend_qualifies(r4, frx, now()),
    'reactions_only_score', _proactive_affinity(r4, frx, now()),
    'blocked_pair', _proactive_friend_qualifies(r3, fb, now()));

  -- THE TRIGGER. Each ranking is its own transaction in the app; here the per-transaction
  -- marker is cleared before each insert to stand for that.
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f1, 'title_ranked', m1);
  insert into e2e (step, result) select 'after friend 1 ranks m1', jsonb_build_object(
    'r1_candidates', (select jsonb_agg(jsonb_build_object('state', state, 'eligible', eligible_at is not null, 'block', last_block_reason)) from proactive_candidates where recipient_id = r1),
    'r1_inbox_rows', (select count(*) from notifications where recipient_id = r1 and type = 'watchlist_social'));
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f2, 'title_ranked', m1);
  -- Non-qualifying actors on r4's title, and the blocked and private actors on r3's.
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (fbare, 'title_ranked', m1);
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (frx, 'title_ranked', m1);
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (fb, 'title_ranked', m1);
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (fp, 'title_ranked', m1);
  -- r1's second title, for the cap.
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f1, 'title_ranked', m2);
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f2, 'title_ranked', m2);

  insert into e2e (step, result)
  select 'after two qualifying friends (and the non-qualifying ones)', jsonb_object_agg(lbl, x)
    from (
      select lbl, jsonb_build_object(
               'candidates', (select count(*) from proactive_candidates c where c.recipient_id = u),
               'eligible', (select count(*) from proactive_candidates c where c.recipient_id = u and c.eligible_at is not null),
               'inbox_rows', (select count(*) from notifications n where n.recipient_id = u and n.type = 'watchlist_social'),
               'members_counted', (select coalesce(max((select count(*) from _proactive_social_actors(c.id, u))), 0) from proactive_candidates c where c.recipient_id = u)) as x
        from (values ('r1_happy', r1), ('r2_pref_off', r2), ('r3_block_private', r3), ('r4_mutual_and_reactions', r4),
                     ('r5_not_in_pilot', r5), ('r6_old_client', r6), ('r7_no_device', r7), ('r8_kill', r8)) v(lbl, u)
    ) s;
  -- r3 and r4 have qualifying friends f1, f2 too; isolate what the non-qualifying actors did:
  insert into e2e (step, result) select 'cluster members who are not f1/f2 (must be 0)', jsonb_build_object(
    'r3', (select count(*) from proactive_cluster_actors a join proactive_candidates c on c.id = a.candidate_id where c.recipient_id = r3 and a.actor_id not in (f1, f2)),
    'r4', (select count(*) from proactive_cluster_actors a join proactive_candidates c on c.id = a.candidate_id where c.recipient_id = r4 and a.actor_id not in (f1, f2)));

  -- The inbox, as r1 sees it.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', r1, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', r1::text, true);
  execute 'set local role authenticated';
  select jsonb_agg(jsonb_build_object('kind', kind, 'subject_is_m', media_item_id in (m1, m2),
           'cluster_count', cluster_count, 'actors_named', jsonb_array_length(coalesce(cluster_actors, '[]'::jsonb)),
           'unread', read_at is null))
    into v_jobs
    from my_notifications(50) where kind = 'watchlist_social';
  execute 'reset role';
  insert into e2e (step, result) values ('r1 inbox (my_notifications)', v_jobs);

  -- Quiet hours: after 20:00 the window holds everything.
  insert into e2e (step, result) select 'arbitrate at 20:30 UTC', _proactive_arbitrate(v_late);
  insert into e2e (step, result) select 'holds after 20:30', jsonb_agg(jsonb_build_object('reader', lbl, 'state', c.state, 'block', c.last_block_reason))
    from proactive_candidates c join (values ('r1', r1), ('r6', r6), ('r7', r7), ('r8', r8)) v(lbl, u) on u = c.recipient_id
   where c.eligible_at is not null;

  -- The evening window.
  insert into e2e (step, result) select 'arbitrate at 17:30 UTC', _proactive_arbitrate(v_evening);
  insert into e2e (step, result) select 'states after 17:30', jsonb_agg(jsonb_build_object('reader', lbl, 'title', case when c.media_item_id = m1 then 'm1' else 'm2' end, 'state', c.state, 'block', c.last_block_reason, 'reason', c.suppression_reason) order by lbl, c.created_at)
    from proactive_candidates c join (values ('r1', r1), ('r6', r6), ('r7', r7), ('r8', r8)) v(lbl, u) on u = c.recipient_id
   where c.eligible_at is not null;
  insert into e2e (step, result) select 'push_outbox rows', jsonb_build_object(
    'r1', (select count(*) from push_outbox where recipient_id = r1),
    'r6_old', (select count(*) from push_outbox where recipient_id = r6),
    'r7_no_device', (select count(*) from push_outbox where recipient_id = r7),
    'r8', (select count(*) from push_outbox where recipient_id = r8),
    'outbox_is_the_selected_row', (select bool_and(o.notification_id = c.notification_id) from push_outbox o join proactive_candidates c on c.recipient_id = o.recipient_id and c.state = 'selected' where o.recipient_id = r1));

  -- Kill switch for r8 only: let r1's claim go first, then switch off and claim r8.
  -- (claim_push_batch takes the whole queue, so: claim once with push on, keep r1's job.)
  update push_outbox set state = 'claimed', claimed_at = now() where recipient_id = r8;  -- park r8's row
  v_jobs := claim_push_batch(100, v_evening);
  select j into v_job from jsonb_array_elements(v_jobs) j
   where (j ->> 'notification_id')::uuid in (select id from notifications where recipient_id = r1) limit 1;
  insert into e2e (step, result) select 'r1 job (claim_push_batch)', jsonb_build_object(
    'jobs_for_r1', (select count(*) from jsonb_array_elements(v_jobs) j where (j ->> 'notification_id')::uuid in (select id from notifications where recipient_id = r1)),
    'type', v_job ->> 'type',
    'media_is_m1', (v_job ->> 'media_item_id')::uuid = m1,
    'media_title', v_job ->> 'media_title',
    'proactive_type', v_job -> 'proactive' ->> 'type',
    'actor_count', v_job -> 'proactive' -> 'actor_count',
    'actor_names_n', jsonb_array_length(v_job -> 'proactive' -> 'actor_names'),
    'deliver_by', v_job -> 'proactive' -> 'deliver_by',
    'tokens_n', jsonb_array_length(v_job -> 'tokens'),
    'old_token_included', exists (select 1 from jsonb_array_elements(v_job -> 'tokens') tk where tk ->> 'token' like 'ExponentPushToken[e2e-old-%'),
    'keys', (select jsonb_agg(k order by k) from jsonb_object_keys(v_job) k));
  insert into e2e (step, result) select 'r1 candidates after claim', jsonb_agg(jsonb_build_object('title', case when media_item_id = m1 then 'm1' else 'm2' end, 'state', state, 'sent', sent_at is not null, 'actor_count_at_send', actor_count_at_send, 'block', last_block_reason) order by created_at)
    from proactive_candidates where recipient_id = r1;

  -- Dedup: a third friend ranks m1 after the push.
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f3, 'title_ranked', m1);
  perform set_config('bingd.proactive.social_event_id', '', true);
  insert into feed_events (actor_id, type, media_item_id) values (f3, 'title_ranked', m2);
  insert into e2e (step, result) select 'arbitrate again 30 min later', _proactive_arbitrate(v_evening + interval '30 minutes');
  v_jobs := claim_push_batch(100, v_evening + interval '30 minutes');
  insert into e2e (step, result) select 'dedup and cap after a third friend', jsonb_build_object(
    'new_jobs_for_r1', (select count(*) from jsonb_array_elements(v_jobs) j where (j ->> 'notification_id')::uuid in (select id from notifications where recipient_id = r1)),
    'r1_all', (select jsonb_agg(jsonb_build_object('state', state, 'block', last_block_reason, 'members', (select count(*) from _proactive_social_actors(id, r1))) order by state) from proactive_candidates where recipient_id = r1),
    'r1_inbox_rows_total', (select count(*) from notifications where recipient_id = r1 and type = 'watchlist_social'));

  -- Kill switch: push off, then r8's parked row comes back and is claimed.
  update app_config set value = 'false'::jsonb where key = 'proactive.push_enabled';
  update push_outbox set state = 'pending', claimed_at = null where recipient_id = r8;
  v_jobs := claim_push_batch(100, v_evening + interval '31 minutes');
  insert into e2e (step, result) select 'kill switch at claim (r8)', jsonb_build_object(
    'jobs_for_r8', (select count(*) from jsonb_array_elements(v_jobs) j where (j ->> 'notification_id')::uuid in (select id from notifications where recipient_id = r8)),
    'r8', (select jsonb_build_object('state', state, 'reason', suppression_reason) from proactive_candidates where recipient_id = r8 and eligible_at is not null));
end;
$e2e$;

select n, step, result from e2e order by n;
rollback;
