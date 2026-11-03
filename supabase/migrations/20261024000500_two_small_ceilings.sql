-- Two small ceilings.
-- Security audit 2026-11-01, findings m-2 and m-12.
--
-- **How many devices one account can hold.** `register_device_token` had no limit, and
-- every live token is copied into every push job, so one account could register three
-- hundred synthetic tokens and turn the sender's batch bound into a number nobody chose.
--
-- A trigger rather than a check in the function, for two reasons. The proactive
-- notifications branch redefines `register_device_token` with a new signature, and a rule
-- written into this body would quietly stop applying when that merged. And it evicts
-- rather than refuses: a token is left behind by every reinstall, so a person who hit a
-- refusing limit would lose push on the phone in their hand to keep a dead one.
--
-- Ten live tokens, newest kept. The eviction is the same act as a sign-out releasing the
-- device, so re-registering brings a token straight back. An account already over the
-- ceiling is brought under it here, because the trigger only runs on the next registration
-- and every push until then would still go out oversized.
--
-- **The one rate limit a null id could step around.** `create_list` counts its daily ceiling
-- from the operation ledger, and `_claim_operation_result` lets a null id through without
-- writing to it, so a modified client could skip the ceiling up to the hundred-list limit.
-- That path exists for the ranking RPCs' old clients, and `_claim_operation` already refuses
-- null everywhere else. `create_list` is rebuilt in full from `20261010000100`.

create or replace function _cap_device_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Per account, so two registrations at once cannot each count the other out.
  perform pg_advisory_xact_lock(hashtextextended('device_tokens:' || new.user_id::text, 0));

  update device_tokens d
     set revoked_at = now()
   where d.id in (
     select o.id
       from device_tokens o
      where o.user_id = new.user_id
        and o.revoked_at is null
        and o.id <> new.id
      order by o.updated_at desc, o.id desc
     offset 9
   );

  return null;
end;
$$;

comment on function _cap_device_tokens() is
  'Keeps one account to ten live device tokens, the newest ten, by revoking the rest. Every live token is copied into every push job, so this is what bounds the sender. A trigger so that it holds whichever writer registered the token. Internal.';

revoke execute on function _cap_device_tokens() from public, anon, authenticated;

drop trigger if exists device_tokens_cap on device_tokens;

-- `when` is what stops the eviction re-entering: the rows it touches are no longer live.
create trigger device_tokens_cap
  after insert or update of user_id, revoked_at on device_tokens
  for each row
  when (new.revoked_at is null)
  execute function _cap_device_tokens();

-- After the trigger, not before. A registration that finished first is visible to this
-- statement, and one that starts later passes through the trigger, so none falls between.
update device_tokens d
   set revoked_at = now()
 where d.id in (
   select r.id
     from (
       select t.id,
              row_number() over (partition by t.user_id order by t.updated_at desc, t.id desc) as n
         from device_tokens t
        where t.revoked_at is null
     ) r
    where r.n > 10
 );


create or replace function create_list(
  p_operation_id       uuid,
  p_title              text,
  p_description        text default null,
  p_visibility         list_visibility default 'private',
  p_order_style        text default 'unranked',
  p_first_media_item_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim   record;
  v_count   integer;
  v_id      uuid;
  v_title   text;
begin
  perform assert_can_write();

  -- The ceiling below counts the ledger, and a null id writes nothing to it. Nothing has
  -- ever sent one here: this function shipped after every client carried an id.
  if p_operation_id is null then
    raise exception 'operation_id is required' using errcode = '22023';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'create_list');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('status', 'already_applied'));
  end if;

  -- Spam guard, counted from the ledger like every other rate in this schema.
  perform _assert_operation_rate(
    'create_list', 'lists.max_created_per_day', 20, interval '1 day');

  v_title := btrim(coalesce(p_title, ''));
  if v_title = '' then
    raise exception 'a list needs a title' using errcode = '22023';
  end if;

  if p_order_style not in ('ranked', 'unranked') then
    raise exception 'unknown order style' using errcode = '22023';
  end if;

  -- **Counted before the insert, and returned.** This is the source of truth for
  -- `would_have_exceeded_3_lists` (§M): a later SQL snapshot cannot see a list that
  -- was created and then deleted, so the number has to leave the server at the moment
  -- of creation.
  --
  -- `source = 'in_app'` only. PRD §12 exempts imported lists from every count, so an
  -- importer arriving with fifteen Letterboxd lists is neither blocked by their own
  -- history nor allowed to wash out the monetisation signal.
  select count(*) into v_count
    from lists
   where owner_id = auth.uid() and source = 'in_app';

  if v_count >= _list_config('lists.max_per_user', 100) then
    -- A sanity ceiling, not a tier. The copy the client shows is "You've reached the
    -- maximum number of lists."
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'list_limit', 'in_app_count_before', v_count));
  end if;

  if p_visibility = 'public' and _profile_is_private(auth.uid()) then
    return _record_operation_result(
      p_operation_id,
      jsonb_build_object('status', 'profile_private', 'in_app_count_before', v_count));
  end if;

  insert into lists (owner_id, title, description, visibility, order_style)
  values (
    auth.uid(),
    v_title,
    nullif(btrim(coalesce(p_description, '')), ''),
    p_visibility,
    p_order_style
  )
  returning id into v_id;

  -- The zero-lists path: ⋯ → Add to list… on a title with no lists yet opens New list
  -- with that title already chosen, and one round trip is what makes that one act.
  if p_first_media_item_id is not null then
    perform _add_list_item_unchecked(v_id, p_first_media_item_id);
  end if;

  return _record_operation_result(
    p_operation_id,
    jsonb_build_object(
      'status', 'ok',
      'id', v_id,
      'in_app_count_before', v_count));
end;
$$;

