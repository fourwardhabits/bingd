-- Staging smoke for 20261130001200 (Remove from Sent to You). Runs entirely in one transaction
-- and ROLLS BACK: disposable accounts and a disposable title, nothing kept. Every client call
-- is made as the real `authenticated` role with a request JWT, so the policy and grants are
-- exercised as a client meets them. Prints one row per step.
begin;

create temp table smoke (n serial, step text, result jsonb) on commit drop;
grant all on smoke to authenticated;
grant usage on sequence smoke_n_seq to authenticated;

do $smoke$
declare
  a uuid := gen_random_uuid();   -- sender Ada
  b uuid := gen_random_uuid();   -- sender Ben
  r uuid := gen_random_uuid();   -- recipient
  m uuid;
  ra uuid; rb uuid;
  op1 uuid := gen_random_uuid();
  v jsonb;
  notes_before bigint; feedback_before bigint;
  v_err text;
  u uuid;
begin
  foreach u in array array[a, b, r] loop
    insert into auth.users (id, aud, role, email, created_at, updated_at)
    values (u, 'authenticated', 'authenticated', 'smoke-dismiss-' || left(u::text, 8) || '@example.invalid', now(), now());
    insert into profiles (id, username, display_name, visibility)
    values (u, 'smkd' || left(replace(u::text, '-', ''), 10), 'Smoke', 'public');
  end loop;
  insert into follows (follower_id, followee_id, state, approved_at)
  values (a, r, 'approved', now()), (r, a, 'approved', now()),
         (b, r, 'approved', now()), (r, b, 'approved', now());
  insert into media_items (kind, tmdb_id, title, release_date, provenance)
  values ('movie', 1999300001, 'Smoke Dismiss Film', '2020-01-01', 'tmdb') returning id into m;

  -- Both senders recommend the same title, as themselves.
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  ra := (recommend_title(gen_random_uuid(), r, m) ->> 'id')::uuid;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  rb := (recommend_title(gen_random_uuid(), r, m) ->> 'id')::uuid;
  execute 'reset role';

  select count(*) into notes_before from notifications where recipient_id in (a, b, r);
  select count(*) into feedback_before from recommendation_feedback where user_id = r;

  -- The recipient.
  perform set_config('request.jwt.claims', json_build_object('sub', r, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into smoke (step, result) select '1 before: list / page / banner', jsonb_build_object(
    'list', (select count(*) from recommendations_to_me(200)),
    'page', (select count(*) from recommendations_to_me_page(200)),
    'banner', (select count(*) from title_recommendations_for_me(m)));

  v := dismiss_received_recommendation(op1, ra);
  insert into smoke (step, result) select '2 dismiss Ada''s', v || jsonb_build_object(
    'list_ids_are_bens', (select array_agg(id) = array[rb] from recommendations_to_me(200)),
    'page', (select count(*) from recommendations_to_me_page(200)),
    'banner_is_bens', (select array_agg(id) = array[rb] from title_recommendations_for_me(m)));

  insert into smoke (step, result) select '3 replay same op', dismiss_received_recommendation(op1, ra);

  begin
    perform dismissed_at from title_recommendations where id = ra;
    v_err := 'readable';
  exception when insufficient_privilege then v_err := '42501';
  end;
  insert into smoke (step, result) select '4 recipient reads dismissed_at directly', to_jsonb(v_err);
  execute 'reset role';

  -- The sender: unchanged view, cannot read the column, a resend does not resurface it.
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into smoke (step, result) select '5 sender sees own row', jsonb_build_object(
    'rows', (select count(*) from title_recommendations where sender_id = a and id = ra));
  begin
    perform dismissed_at from title_recommendations where id = ra;
    v_err := 'readable';
  exception when insufficient_privilege then v_err := '42501';
  end;
  insert into smoke (step, result) select '6 sender reads dismissed_at', to_jsonb(v_err);
  insert into smoke (step, result) select '7 sender cannot dismiss', dismiss_received_recommendation(gen_random_uuid(), ra);
  insert into smoke (step, result) select '8 sender resends', recommend_title(gen_random_uuid(), r, m) - 'id';
  execute 'reset role';

  -- Ben (another user) cannot restore or dismiss the recipient's row.
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into smoke (step, result) select '9 other user restore / dismiss', jsonb_build_object(
    'restore', restore_received_recommendation(gen_random_uuid(), ra),
    'dismiss', dismiss_received_recommendation(gen_random_uuid(), rb));
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', r, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into smoke (step, result) select '10 still dismissed after resend', jsonb_build_object(
    'list', (select count(*) from recommendations_to_me(200)),
    'banner', (select count(*) from title_recommendations_for_me(m)));
  v := restore_received_recommendation(gen_random_uuid(), ra);
  insert into smoke (step, result) select '11 Undo', v || jsonb_build_object(
    'list', (select count(*) from recommendations_to_me(200)),
    'banner', (select count(*) from title_recommendations_for_me(m)));
  insert into smoke (step, result) select '12 replay dismissal after Undo', dismiss_received_recommendation(op1, ra)
    || jsonb_build_object('list', (select count(*) from recommendations_to_me(200)));
  execute 'reset role';

  insert into smoke (step, result) select '13 side effects', jsonb_build_object(
    'new_notifications', (select count(*) from notifications where recipient_id in (a, b, r)) - notes_before,
    'new_for_you_feedback', (select count(*) from recommendation_feedback where user_id = r) - feedback_before,
    'rows_kept', (select count(*) from title_recommendations where id in (ra, rb)),
    'ada_row_state', (select jsonb_build_object('state', state, 'dismissed', dismissed_at is not null, 'seen', seen_at is not null, 'opened', opened_at is not null) from title_recommendations where id = ra));

  -- anon cannot call it.
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  begin
    perform dismiss_received_recommendation(gen_random_uuid(), ra);
    v_err := 'callable';
  exception when insufficient_privilege then v_err := '42501';
  end;
  execute 'reset role';
  insert into smoke (step, result) select '14 anon', to_jsonb(v_err);
end;
$smoke$;

select n, step, result from smoke order by n;
rollback;
