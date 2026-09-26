-- ---------------------------------------------------------------------------
-- A switch that actually stops delivery.
--
-- Founder direction, 2026-09-07: an emergency push kill switch is wanted, and
-- the row that looks like one is not one. `app_config['push.delivery_enabled']`
-- was seeded `false` by 20260813000100 ("AD-10: push delivery is built in v1 but
-- off. Flipping this is an operator action, not a deploy") and has never been
-- read by anything. The 2026-08-26 diagnosis wrote it down
-- (`docs/release/push-operations.md` §10: "nothing consumes it") and left it.
-- Meanwhile delivery is ON: the trigger queues, the tick posts, the sender
-- sends, and the one row an operator would reach for in an emergency says
-- `false` while phones buzz. That is operationally misleading, and this
-- migration makes the row mean what it says.
--
-- **Where the gate goes, and why there.** Three places could honour the switch:
--
--   * `_enqueue_push`, the trigger. Rejected. A notification that arrives while
--     the switch is off would never be queued, so re-enabling delivery would
--     silently lose everything that happened in between -- and a kill switch
--     whose cost is permanent loss is one an operator hesitates to use.
--   * `push-sender`, the Edge Function. Rejected. A switch that needs a deploy
--     is not a switch, and the sender is deliberately the component that holds
--     no opinion about this schema.
--   * `claim_push_batch`, the sender's one read. Chosen, with the scheduler
--     tick beside it. While the switch is off nothing is claimed, nothing is
--     attempted, no attempt counter moves and no lease is taken: the outbox
--     simply HOLDS. Flip it back and the next tick drains what waited, oldest
--     first, exactly as a sender outage would have. `_drain_push_outbox` checks
--     the same switch first so pg_cron does not invoke an Edge Function a minute
--     to be told nothing, and so the "not configured" raise -- which exists to
--     make a broken pipeline visible -- does not fire for a pipeline that was
--     stopped on purpose.
--
-- The client nudge (`push-sender` is also invoked from the app after a write)
-- needs nothing: it calls the same function, claims nothing, and returns.
--
-- **Hold, not drop, and the one thing to know before re-enabling.** Because rows
-- wait rather than expire, an outage measured in days re-enables into a burst
-- of stale buzzes. If the reason for the switch was the CONTENT of what was
-- being sent, empty the queue before flipping it back:
--
--     delete from push_outbox;                                  -- optional
--     update app_config set value = 'true'::jsonb, updated_at = now()
--      where key = 'push.delivery_enabled';
--
-- The in-app inbox is untouched throughout -- `notifications` rows are written
-- exactly as before -- so "stop the phones" never means "lose the message".
--
-- **The only value that stops delivery is the JSON boolean `false`.** A missing
-- row, a `true`, or anything else reads as enabled. That is fail-open on
-- purpose: this switch exists to stop delivery deliberately, and the failure
-- mode of a typo or a lost row must not be a silent outage.
--
-- **THE DEPLOYMENT-TIME CHOICE, stated so it cannot be made by accident.** The
-- row is `false` today on every database this schema has ever been applied to,
-- including production, and delivery is on because nothing read it. A migration
-- that starts honouring that `false` would stop every push the instant it
-- applied. So section 5 below sets the row to `true` where it is `false`,
-- which preserves exactly the behaviour production has now. That is a choice
-- and it is recorded here as one: to ship with delivery OFF, change the literal
-- in section 5 before applying. Nothing else in this file depends on which way
-- it goes.
--
-- Not changed: the preference axis (a category somebody switched off still
-- enqueues nothing), the retry ceilings, the lease, the reaper, the settle
-- path, the copy, the sender. `unschedule_push_drain()` remains the coarser
-- tool and still works; this is the finer one and needs no cron privilege.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The reader
--
-- `stable`, so a caller inside one transaction reads it once. Definer and
-- revoked from every client role, like every other reader of a non-`public.%`
-- key: `app_config` is operator configuration and a client has no business
-- knowing whether push is switched on.
-- ---------------------------------------------------------------------------

create or replace function _push_delivery_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select c.value <> 'false'::jsonb from app_config c where c.key = 'push.delivery_enabled'),
    true
  );
$$;

comment on function _push_delivery_enabled() is
  'Whether push delivery is switched on: app_config[push.delivery_enabled] is anything but the JSON boolean false, or absent. Read by claim_push_batch and _drain_push_outbox (20260911000200). Fail-open by design. Internal.';

revoke execute on function _push_delivery_enabled() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The claim, restated whole
--
-- 20260904000100's body with the switch checked before anything moves -- before
-- the reaper, before the lease, before an attempt is charged. Everything else
-- is that migration's text, including its restored actorless predicate.
-- ---------------------------------------------------------------------------

create or replace function claim_push_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
begin
  -- 20260911000200. Off means nothing moves: no reap, no lease, no attempt charged.
  -- The rows wait, and the next claim after the switch flips back takes them oldest
  -- first exactly as if a sender had been down.
  if not _push_delivery_enabled() then
    return jsonb_build_array();
  end if;

  delete from push_outbox o
   where (o.failures >= 3 or o.attempts >= 6)
     and (o.state = 'pending' or o.claimed_at < now() - interval '5 minutes');

  with due as (
    select o.notification_id
      from push_outbox o
     where o.failures < 3
       and o.attempts  < 6
       and (
         o.state = 'pending'
         or (o.state = 'claimed' and o.claimed_at < now() - interval '5 minutes')
       )
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
     for update skip locked
  ),
  taken as (
    update push_outbox o
       set state      = 'claimed',
           claimed_at = now(),
           attempts   = o.attempts + 1
      from due
     where o.notification_id = due.notification_id
    returning o.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_claimed from taken;

  if array_length(v_claimed, 1) is null then
    return jsonb_build_array();
  end if;

  select coalesce(array_agg(n.id), '{}'::uuid[]) into v_dead
    from notifications n
   where n.id = any (v_claimed)
     and (
       (n.actor_id is not null and not can_discover_profile(n.recipient_id, n.actor_id))
       or not exists (
         select 1 from device_tokens d
          where d.user_id = n.recipient_id and d.revoked_at is null
       )
     );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id', j.id,
        'attempt',         j.attempt,
        'type',            j.type,
        'actor_username',  j.actor_username,
        'actor_name',      j.actor_name,
        'media_item_id',   j.media_item_id,
        'media_kind',      j.media_kind,
        'media_title',     j.media_title,
        'series_title',    j.series_title,
        'feed_event_id',   j.feed_event_id,
        'comment_excerpt', j.comment_excerpt,
        'tokens',          j.tokens
      )
      order by j.created_at
    ),
    jsonb_build_array()
  )
  into v_jobs
  from (
    select n.id,
           o.attempts                              as attempt,
           n.type,
           n.created_at,
           p.username::text                        as actor_username,
           coalesce(p.display_name, p.username::text) as actor_name,
           m.id                                    as media_item_id,
           m.kind::text                            as media_kind,
           m.title                                 as media_title,
           parent.title                            as series_title,
           case when n.subject_type = 'feed_event' then n.subject_id end as feed_event_id,
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
           )                                       as tokens
      from notifications n
      join push_outbox o on o.notification_id = n.id
      left join profiles p
             on p.id = n.actor_id
            and p.status = 'active'
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            -- The same three rules `my_notifications` states, in the same words, from
            -- the recipient's side -- including the read-time `can_view_profile` on a
            -- mention's activity owner, so a title whose owner has since blocked the
            -- recipient or gone private is not pushed to their lock screen.
            and case
                  when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                  when n.type = 'mention' then can_view_profile(n.recipient_id, fe.actor_id)
                  else fe.actor_id = n.recipient_id
                end
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       -- **Restored 2026-08-30 (20260904000100).** An actorless notification has nobody
       -- to have gone, and this predicate was the actorless filter by accident until
       -- 20260828000100 wrote the escape. The 20260830000100 rebuild -- which added the
       -- mention join two lines up -- was assembled from an ancestor that predated that
       -- escape and dropped it again, silently: an award congratulations was claimed,
       -- filtered out here, and its outbox row deleted by the reap below, so it never
       -- retried and never sent. Exactly the failure 20260828000100 warns a
       -- create-or-replace can make invisible in a diff.
       and (p.id is not null or n.actor_id is null)
  ) j;

  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The scheduler tick, restated whole
--
-- 20260826000700's body with the switch checked first. The idle check, the
-- Vault read, the raise and the asynchronous post are that migration's text.
-- ---------------------------------------------------------------------------

create or replace function _drain_push_outbox()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_due bigint;
  v_url text;
  v_key text;
begin
  -- 20260911000200. Switched off on purpose is not "not configured": no request is
  -- posted, and the raise below -- which exists to make a BROKEN pipeline visible in
  -- cron.job_run_details -- does not fire for a pipeline an operator stopped. The
  -- count is returned so a reader of the job log can see what is waiting.
  if not _push_delivery_enabled() then
    select count(*) into v_due from push_outbox;
    return jsonb_build_object('status', 'disabled', 'due', v_due);
  end if;

  -- Cheap, and it is the difference between a scheduler that costs an Edge Function
  -- invocation a minute for ever and one that costs nothing while nothing is happening.
  -- It is also what keeps the raise below from firing on an idle unconfigured project.
  select count(*) into v_due from push_outbox;
  if v_due = 0 then
    return jsonb_build_object('status', 'idle', 'due', 0);
  end if;

  select value #>> '{}' into v_url from app_config where key = 'functions.base_url';

  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets
     where name = 'service_role_key';
  exception when others then
    -- No Vault on this database at all. Distinguished from "the secret is missing" only in
    -- the message, because the operator action is the same and the difference is not this
    -- function's to explain.
    v_key := null;
  end;

  if nullif(v_url, '') is null or nullif(v_key, '') is null then
    /**
     * **Raise, and this is the whole point of the migration.**
     *
     * This was `raise warning` followed by a normal return, and pg_cron recorded
     * `succeeded` 1,221 times over a pipeline that had never sent a single request. A
     * warning goes to the Postgres log, where nobody was looking; the return value went
     * nowhere at all, because `cron.job_run_details` keeps `return_message`, which for a
     * function that returns cleanly is the string `1 row`.
     *
     * An exception is the only thing pg_cron can record as a failure, and a failed run is
     * the only thing that makes `push_drain_status().last_run` tell the truth.
     *
     * Naming which input is missing and never its value: an operator needs to know whether
     * to set `app_config` or the Vault, and nobody needs the key echoed into a job log.
     */
    raise exception
      'push drain: not configured — functions.base_url is %, vault secret service_role_key is %; % row(s) waiting and none can be sent',
      case when nullif(v_url, '') is null then 'MISSING' else 'set' end,
      case when nullif(v_key, '') is null then 'MISSING' else 'set' end,
      v_due
      using errcode = '55000',
            hint = 'Set functions.base_url in app_config, and/or store the service-role key: select vault.create_secret(''<service role key>'', ''service_role_key''). See docs/release/push-operations.md.';
  end if;

  -- Asynchronous: pg_net queues the request and a background worker sends it, so a slow or
  -- dead Edge Function cannot hold a cron slot open. The reply is discarded -- the sender's
  -- own logs are the record, and its body is deliberately uninformative to anybody but
  -- service_role.
  perform net.http_post(
    url     := v_url || '/push-sender',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key,
                 'apikey',        v_key
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );

  return jsonb_build_object('status', 'posted', 'due', v_due);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The readout, restated whole
--
-- One field added (`delivery_enabled`) and one problem string
-- (`delivery_disabled`). Nothing removed and nothing renamed: the readout is read
-- by `scripts/bootstrap-production.mjs`, quoted in the runbooks and matched on by
-- `push-drain-acceptance.mjs`, and 20260826000700 says why its keys are stable.
-- ---------------------------------------------------------------------------

create or replace function push_drain_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job      jsonb := null;
  v_last     jsonb := null;
  v_queued   bigint;
  v_stalled  bigint;
  v_url      boolean;
  v_secret   boolean := false;
  v_vault    boolean := false;
  v_net      boolean := false;
  v_proc     regprocedure;
  v_problems text[] := array[]::text[];
  -- 20260911000200. The switch, so "why is nothing sending" has a one-field answer.
  v_enabled  boolean := _push_delivery_enabled();
begin
  select count(*) into v_queued from push_outbox;
  select count(*) into v_stalled
    from push_outbox
   where created_at < now() - interval '15 minutes';

  -- Present *and* non-empty. An `app_config` row holding `""` set the old boolean true and
  -- would have sent the tick to `v_url || '/push-sender'` — a POST to `/push-sender`,
  -- relative to nothing.
  select exists (
    select 1 from app_config
     where key = 'functions.base_url' and nullif(value #>> '{}', '') is not null
  ) into v_url;

  /**
   * The field whose absence is the reason this migration exists.
   *
   * Dynamic, and guarded by `to_regclass`, for the same reason every `cron.` read in this
   * file is: the local suite replays into PGlite, which has no `vault` schema, and a
   * static reference would plan and fail the moment this branch was reached there.
   *
   * `v_vault` and `v_secret` are separate because they are different operator actions —
   * enable the extension, or store the secret — and collapsing them would send somebody
   * to the dashboard to look for a secret in a Vault that is not switched on.
   */
  if to_regclass('vault.decrypted_secrets') is not null then
    v_vault := true;
    begin
      execute $q$
        select exists (
          select 1 from vault.decrypted_secrets
           where name = 'service_role_key' and nullif(decrypted_secret, '') is not null
        )
      $q$ into v_secret;
    exception when others then
      -- Readable by the owner and by nobody else; if this function's owner cannot read it,
      -- the honest answer is "cannot confirm", and the honest answer fails closed.
      v_secret := false;
    end;
  end if;

  /**
   * The transport, which is a dependency exactly as much as the scheduler and the secret
   * are — review 46b.
   *
   * `_drain_push_outbox()` ends in `net.http_post`. If `pg_net` is disabled or dropped, a
   * project with an active job, a good URL, a stored secret and an empty queue answered
   * `healthy: true` while being completely unable to send the next push; the truth only
   * surfaced later, as an undefined-function error on the first tick that had work. That is
   * the same "healthy until somebody needs it" shape as the incident above.
   *
   * **The exact signature the tick binds to, and executable by this function's owner** —
   * review 46c, which caught the first attempt matching on the name alone. A stray
   * `net.http_post(text)` left behind by anything at all would have satisfied that, and so
   * would a `net.http_post` whose EXECUTE had been revoked; in both cases the drain still
   * cannot post and the summary still said it could.
   *
   * `to_regprocedure` resolves the one overload `perform net.http_post(url := …, headers :=
   * …, body := …, timeout_milliseconds := …)` actually binds to, and returns null rather
   * than raising when the schema, the function or that signature is absent. Pinning the
   * signature means this check goes red on the same day the drain does if pg_net ever
   * changes it, which is the correct coupling: they have to agree or one of them is lying.
   */
  v_proc := to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)');
  v_net := v_proc is not null and has_function_privilege(v_proc, 'execute');

  if to_regclass('cron.job') is not null then
    execute $q$
      select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
        from cron.job where jobname = 'bingd-push-drain'
    $q$ into v_job;

    if v_job is not null and to_regclass('cron.job_run_details') is not null then
      execute $q$
        select jsonb_build_object('status', status, 'ended', end_time, 'message', left(return_message, 200))
          from cron.job_run_details
         where jobid = ($1 ->> 'jobid')::bigint
         order by start_time desc limit 1
      $q$ into v_last using v_job;
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Every reason this pipeline could be dead, named. The strings are an interface:
  -- runbooks and `push-drain-acceptance.mjs` match on them, so they are stable and
  -- lowercase and say the thing rather than a grade.
  -- ---------------------------------------------------------------------------
  if v_job is null then
    v_problems := v_problems || 'scheduler_not_installed'::text;
  elsif not coalesce((v_job ->> 'active')::boolean, false) then
    v_problems := v_problems || 'scheduler_inactive'::text;
  end if;

  if not v_url then
    v_problems := v_problems || 'base_url_missing'::text;
  end if;

  -- The transport. Without it the tick cannot post, whatever else is in place.
  if not v_net then
    v_problems := v_problems || 'pg_net_unavailable'::text;
  end if;

  if not v_vault then
    v_problems := v_problems || 'vault_unavailable'::text;
  elsif not v_secret then
    v_problems := v_problems || 'vault_service_role_key_missing'::text;
  end if;

  /**
   * A run that ended any way other than `succeeded`, including the new raise above — and,
   * separately, **no run at all**.
   *
   * Independent review 46 was right that the second one is not a detail. A scheduled job
   * that has never executed has demonstrated nothing, and `last_run = null` on a job that
   * has been active for more than a minute is a real and already-documented failure:
   * pg_cron installed but not running jobs, which is what happens when the extension was
   * enabled in the wrong database. Treating "no evidence" as "fine" is the same mistake as
   * treating `succeeded` as "delivered", one layer up.
   *
   * It self-clears within a minute of a genuine install, and
   * `scripts/bootstrap-production.mjs` — the one caller that knows it has *just* scheduled
   * the job — downgrades this single problem to a note for exactly that reason. Nothing
   * else does.
   */
  if v_job is not null and v_last is null then
    v_problems := v_problems || 'last_run_missing'::text;
  elsif v_last is not null and coalesce(v_last ->> 'status', '') <> 'succeeded' then
    v_problems := v_problems || 'last_run_not_succeeded'::text;
  end if;

  -- Rows arriving and nothing taking them. This was already the number the runbook alerted
  -- on; it is now also a reason `healthy` is false, rather than a figure beside a `true`.
  if v_stalled > 0 then
    v_problems := v_problems || 'outbox_stalled'::text;
  end if;

  -- 20260911000200. Deliberate, and still not healthy: an operator reading this
  -- during an incident needs the switch named beside the queue it is holding.
  if not v_enabled then
    v_problems := v_problems || 'delivery_disabled'::text;
  end if;

  return jsonb_build_object(
    'environment',    environment_name(),
    'job',            v_job,
    'last_run',       v_last,
    'queued',         v_queued,
    'older_than_15m', v_stalled,
    'base_url_set',   v_url,
    -- Boolean, never the value, and never its length either: a length is a fingerprint of
    -- which key it is.
    'pg_net_available', v_net,
    'vault_available',  v_vault,
    'vault_secret_set', v_secret,
    'delivery_enabled', v_enabled,
    'problems',       to_jsonb(v_problems),
    -- The one field a caller should branch on. False unless every dependency above is
    -- present and the last run and the queue both look right.
    'healthy',        cardinality(v_problems) = 0
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The initial state -- THE DEPLOYMENT-TIME CHOICE
--
-- See the header. `true` preserves the behaviour every environment has today,
-- because until this migration the row was inert and delivery was on. Change
-- the literal to `false` to apply this with delivery switched off. Scoped to a
-- row that still holds the seed value, so an operator who has already set it
-- is not overruled; the insert covers a database that never had the row.
-- ---------------------------------------------------------------------------

update app_config
   set value = 'true'::jsonb, updated_at = now()
 where key = 'push.delivery_enabled'
   and value = 'false'::jsonb;

insert into app_config (key, value)
values ('push.delivery_enabled', 'true'::jsonb)
on conflict (key) do nothing;
