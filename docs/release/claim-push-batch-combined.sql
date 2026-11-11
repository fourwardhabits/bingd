-- NOT A MIGRATION. Kept in docs/release so nothing applies it by accident.
--
-- The combined claim_push_batch for #254 (Affinity B1) + #256 (IMDb import), per
-- docs/release/claim-push-batch-reconciliation.md. The PR that merges SECOND copies this file
-- to supabase/migrations/<version>_one_claim_for_every_push.sql, with a version that sorts
-- after every migration of both PRs (§3 of the doc).
--
-- claim_push_batch, reconciled (#254 Affinity B1 + #256 IMDb import), 2026-11-11.
-- Verified locally (PGlite, every migration): see the doc, §4.
--
-- #254 owns claim_push_batch(integer, timestamptz): 20261028000100 dropped the one-argument
-- form and 20261028000100 / 20261031000100 / 20261101000100 rebuilt it with the proactive
-- ledger (lock-then-judge, settle, deliver_by, capable tokens, sent marking) on top of the
-- security release's comment-excerpt rule (20261024000300). #256 (20261111000300) recreated
-- the ONE-argument form from main's body with one change: import_started and import_failed
-- carry their payload, as import_completed already did. This file is #254's body with
-- #256's one change. It belongs to whichever PR merges second, and that PR's #256 migration
-- must not create claim_push_batch(integer) where the two-argument form exists (deleted when
-- #256 merges second, guarded when it merges first; see the doc), so no file boundary ever
-- leaves two overloads.
--
-- Two overloads must never coexist: push-sender's rpc('claim_push_batch', { p_limit })
-- matches both and every push stops. The drop below is a backstop for an environment that
-- somehow has one. And a one-argument form re-created after 20261028000100's drop is a NEW
-- function, whose privileges come from the migration role's defaults (service role only in
-- this repo's chain since 20260813002100's global revoke, checked 2026-11-11; it depends on
-- the role that runs the push), so the grants are stated explicitly below.

drop function if exists claim_push_batch(integer);

create or replace function claim_push_batch(p_limit integer default 20, p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid[];
  v_jobs    jsonb;
  v_dead    uuid[];
  v_pro_dead uuid[];
  v_sent    uuid[];
  v_mine    uuid[];
  v_busy    uuid[];
begin
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

  -- 20261028000100. LOCK FIRST, THEN JUDGE, AND NEVER WAIT (Codex final reviews, MAJOR).
  --
  -- Every proactive candidate behind this batch is locked before anything about it is
  -- checked, and stays locked until it is marked sent at the end of this transaction, so
  -- nothing (a mute, a social writer) can change it between the checks and the send.
  --
  -- SKIP LOCKED, so the claim never waits on a candidate row. A candidate another
  -- transaction owns at this moment (a mute suppressing it, a friend joining its cluster)
  -- is not judged, not sent and not charged: its job is put back in the queue exactly as
  -- it was before this claim (pending, no lease, the attempt given back), and the next
  -- drain judges it afresh with every check, dropping it if it was muted, suppressed or
  -- expired meanwhile. A claim that waits could close a lock cycle with a writer that
  -- holds rows of several readers; one that skips cannot be in any cycle. Optional
  -- delivery prefers late or missed over blocked, deadlocked or duplicated.
  --
  -- THIS DEPENDS ON claim_push_batch STAYING VOLATILE (the default; do not mark it stable
  -- or immutable). Under READ COMMITTED a volatile function takes a fresh snapshot for
  -- each statement, so the checks below read the very row version this statement locked,
  -- including a change committed an instant before. A stable function shares one snapshot
  -- across its whole body and could judge an older version than the one it holds.
  select coalesce(array_agg(s.notification_id), '{}'::uuid[]) into v_mine
    from (
      select pc.notification_id
        from proactive_candidates pc
       where pc.notification_id = any (v_claimed)
       order by pc.id
         for update skip locked
    ) s;

  select coalesce(array_agg(pc.notification_id), '{}'::uuid[]) into v_busy
    from proactive_candidates pc
   where pc.notification_id = any (v_claimed)
     and not (pc.notification_id = any (v_mine));

  if array_length(v_busy, 1) is not null then
    -- Back to a clean, claimable state, as if this claim had never taken it.
    update push_outbox o
       set state      = 'pending',
           claimed_at = null,
           attempts   = greatest(o.attempts - 1, 0)
     where o.notification_id = any (v_busy);
    v_claimed := array(select unnest(v_claimed) except select unnest(v_busy));
    if array_length(v_claimed, 1) is null then
      return jsonb_build_array();
    end if;
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

  -- 20261028000100 (a). The proactive jobs that must not go, and the candidate told why.
  -- At most once: a job whose candidate is already `sent` (an expired lease, a retry) is
  -- dropped and its outbox row deleted below; the candidate stays `sent`. Reactive jobs
  -- are not in this set and keep their at-least-once retries unchanged.
  with pro as (
    select pc.id, pc.notification_id, pc.state,
           _proactive_claim_reason(pc.id, p_now) as reason
      from proactive_candidates pc
     where pc.notification_id = any (v_claimed)
  ),
  settled as (
    update proactive_candidates pc
       set state              = case when pro.reason in ('expired', 'outside_window', 'no_timezone')
                                     then 'expired' else 'suppressed' end,
           suppression_reason = pro.reason,
           decided_at         = p_now
      from pro
     where pc.id = pro.id and pro.reason is not null and pc.state = 'selected'
    returning pc.id
  )
  select coalesce(array_agg(pro.notification_id) filter (where pro.reason is not null), '{}'::uuid[])
    into v_pro_dead
    from pro;

  v_dead := v_dead || v_pro_dead;

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
        -- 20260917001500. The job an import notification is about, and the summary its
        -- completion push quotes. Null for every other type.
        'import_job_id',   j.import_job_id,
        'import_counts',   j.import_counts,
        -- 20260920000200. Which award and tier an award_earned push is about, and the
        -- names its row was written with. Null for every other type. Not `award_name`:
        -- see the header.
        'award_key',        j.award_key,
        'award_tier',       j.award_tier,
        'award_family',     j.award_family,
        'award_tier_label', j.award_tier_label,
        -- 20261028000100. goal_completed's year, medium and target. Null otherwise.
        'goal',            j.goal,
        -- 20261028000100. A proactive job's copy facts, resolved now. Null otherwise.
        'proactive',       j.proactive,
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
           case when n.subject_type = 'import_job' then n.subject_id end as import_job_id,
           -- #256 (20261111000300): every import push carries its notification's payload,
           -- so push-sender can name the provider (IMDb or Letterboxd) at start and failure
           -- as well as at completion. Before #256 the payload of a start or failure is just
           -- {job_id}, which push-sender reads as Letterboxd: safe either way.
           case when n.type in ('import_started', 'import_completed', 'import_failed')
                then n.payload end as import_counts,
           -- award_earned only (20260920000200). The keys the celebration route takes and
           -- the push copy is looked up by; the names are the fallback for a key the
           -- sender does not know.
           case when n.type = 'award_earned' then n.payload ->> 'award' end      as award_key,
           case when n.type = 'award_earned' then n.payload ->> 'tier' end       as award_tier,
           case when n.type = 'award_earned' then n.payload ->> 'award_name' end as award_family,
           case when n.type = 'award_earned' then n.payload ->> 'tier_label' end as award_tier_label,
           -- goal_completed only (20261028000100).
           case when n.type = 'goal_completed' then jsonb_build_object(
             'year',     n.payload -> 'year',
             'category', n.payload ->> 'category',
             'target',   n.payload -> 'target'
           ) end                                   as goal,
           -- Proactive only (20261028000100). Ids, dates and display names: nothing
           -- anybody wrote.
           case when pc.id is not null then jsonb_build_object(
             'type',        pc.type,
             'opens_on',    pc.metadata ->> 'opens_on',
             'local_today', (p_now at time zone coalesce(ac.timezone, 'UTC'))::date,
             -- The last instant this push may reach a phone (Codex re-review, MAJOR): the
             -- earlier of the candidate's own expiry and the close of the evening it was
             -- selected for, in the reader's zone. push-sender sends it to Expo as the
             -- message's `expiration`, so a phone that is offline at 19:59 is not woken
             -- by it the next morning, and drops the message itself if it is already past.
             'deliver_by',  least(
                              pc.expires_at,
                              (pc.selected_local_date
                                 + make_time(_proactive_int('proactive.window_end_hour', 20), 0, 0))
                                at time zone coalesce(ac.timezone, 'UTC')),
             'reason',      pc.metadata ->> 'reason',
             'actor_count', case when pc.type = 'watchlist_social'
                              then (select count(*) from _proactive_social_actors(pc.id, n.recipient_id)) end,
             -- 20261031000100: the two STRONGEST visible friends by affinity, then the
             -- earliest. Names only; the affinity itself never leaves the database.
             'actor_names', case when pc.type = 'watchlist_social' then (
                              select jsonb_agg(coalesce(nullif(s.display_name, ''), s.username)
                                               order by s.rn)
                                from (select * from _proactive_ranked_social_actors(pc.id, n.recipient_id, p_now)
                                       order by rn limit 2) s
                            ) end,
             -- 20261031000100, season_premiere only: which season, and the verified date.
             'season_number', case when pc.type = 'season_premiere'
                                then (pc.metadata ->> 'season_number')::integer end,
             'available_on',  case when pc.type = 'season_premiere'
                                then pc.metadata ->> 'available_on' end
           ) end                                   as proactive,
           -- Comment jobs only, and `mention` is deliberately not one of them.
           -- See the header: a mention push says who and where, never what.
           -- Only what the recipient could open and read right now.
           case when n.type = 'comment' then (
             select left(c.body, 180)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and _can_read_comment(n.recipient_id, c.id)
           ) end                                   as comment_excerpt,
           (
             select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform))
               from device_tokens d
              where d.user_id = n.recipient_id
                and d.revoked_at is null
                -- 20261028000100 (b). A proactive job goes only to devices whose build can
                -- route it; a reactive job, as always, to every live device.
                and (pc.id is null or _proactive_capable_token(d))
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
      left join proactive_candidates pc
             on pc.notification_id = n.id
      left join account_context ac
             on ac.user_id = n.recipient_id
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

  -- 20261028000100 (c). Handed to push-sender. Not Expo acceptance, not delivery.
  with sent as (
    update proactive_candidates pc
       set state               = 'sent',
           sent_at             = now(),
           actor_count_at_send = (job -> 'proactive' ->> 'actor_count')::integer
      from jsonb_array_elements(v_jobs) as job
     where pc.notification_id = (job ->> 'notification_id')::uuid
       and pc.state = 'selected'
    returning pc.notification_id
  )
  select coalesce(array_agg(notification_id), '{}'::uuid[]) into v_sent from sent;

  -- A proactive job goes out ONLY if its candidate went selected -> sent in this claim.
  -- Under the lock above that is every proactive job that passed the checks; this is the
  -- guarantee written down rather than inferred, so no future path can return a proactive
  -- job whose ledger row does not say it was sent (and so counted against the caps).
  -- Reactive jobs carry no proactive facts and are untouched.
  select coalesce(jsonb_agg(job order by ord), jsonb_build_array())
    into v_jobs
    from jsonb_array_elements(v_jobs) with ordinality as e(job, ord)
   where jsonb_typeof(job -> 'proactive') is distinct from 'object'
      or (job ->> 'notification_id')::uuid = any (v_sent);

  -- Everything claimed and not returned leaves the queue, including a proactive job the
  -- line above withheld, so it cannot be claimed again and leak later.
  delete from push_outbox o
   where o.notification_id = any (v_claimed)
     and o.notification_id not in (
       select (job ->> 'notification_id')::uuid from jsonb_array_elements(v_jobs) as job
     );

  return v_jobs;
end;
$$;


revoke execute on function claim_push_batch(integer, timestamptz) from public, anon, authenticated;
grant execute on function claim_push_batch(integer, timestamptz) to service_role;

do $$
begin
  execute format('comment on function claim_push_batch(integer, timestamptz) is %L',
    obj_description('claim_push_batch(integer, timestamptz)'::regprocedure, 'pg_proc')
    || ' Since the #254/#256 reconciliation: import_started and import_failed carry their payload (the provider) as import_completed does, and claim_push_batch(integer) is dropped.');
end;
$$;
