-- The excerpt rule, on this branch's own bodies.
-- Security audit 2026-11-01, findings M-2 and m-5. Carries the rule from the security
-- remediation's `20261024000300` onto `claim_push_batch(integer, timestamptz)` and
-- `my_notifications`.
--
-- ===========================================================================
-- WHY THIS IS HERE AS WELL
--
-- `20261028000100` drops `claim_push_batch(integer)` and this branch's later migrations
-- rebuild both functions, so a fix made only on main's one-argument function would be
-- replaced the moment this branch merged, with the same bug back in production.
--
-- **The rule.** A reader sees a comment's text only if they could open that comment right
-- now: current access to its author and to the owner of the activity it sits under. The
-- audit's case: a private owner removes a follower without blocking them, later comments,
-- and the text reaches that person's lock screen.
--
-- Both bodies are rebuilt in full from `20261031000100`. The excerpt predicates are the
-- only change: every lock, the claim's ordering, the proactive checks and the volatility
-- are carried across unchanged. Any later rebuild of either function has to start from
-- these, and `comment-excerpt-access.test.mjs` fails if one does not.
--
-- `_can_read_comment` is defined here too, identically, so this branch stands alone
-- before the security PR reaches it. Replacing it with the same body is a no-op, in either
-- order.
-- ===========================================================================


create or replace function _can_read_comment(p_reader uuid, p_comment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from comments c
      join feed_events e on e.id = c.feed_event_id
     where c.id = p_comment_id
       and can_view_profile(p_reader, c.author_id)
       and can_view_profile(p_reader, e.actor_id)
  );
$$;

comment on function _can_read_comment(uuid, uuid) is
  'Whether p_reader could open this comment right now: current access to its author and to the owner of the activity it sits under, the same two checks activity_comments makes. The one test every surface that quotes a comment outside the thread applies, so a push and an inbox row cannot disagree. Takes a reader, so a client grant would be a follow-graph and block-graph oracle. Internal.';

revoke execute on function _can_read_comment(uuid, uuid) from public, anon, authenticated;


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
           case when n.type = 'import_completed' then n.payload end as import_counts,
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


do $$
begin
  execute format('comment on function claim_push_batch(integer, timestamptz) is %L',
    obj_description('claim_push_batch(integer, timestamptz)'::regprocedure, 'pg_proc')
    || ' Since 20261101000100: a comment_excerpt is included only while _can_read_comment says the recipient could read it.');
end;
$$;


create or replace function my_notifications(p_limit integer default 50)
returns table (
  id                 uuid,
  kind               text,
  created_at         timestamptz,
  read_at            timestamptz,
  actor_id           uuid,
  actor_username     text,
  actor_display_name text,
  actor_avatar_path  text,
  subject_type       text,
  subject_id         uuid,
  media_item_id      uuid,
  media_kind         media_kind,
  media_title        text,
  series_title       text,
  payload            jsonb,
  -- One line of what was written, or null. See the header for the three
  -- conditions and for why the server rather than the client withholds it.
  comment_excerpt    text,
  -- True when the live comment this row is about is spoiler-marked. The reason
  -- there is no excerpt, said out loud, so the row can draw "Contains spoilers"
  -- rather than an empty second line that reads as a rendering bug.
  comment_spoilers   boolean,
  -- `watch_tag` only: whether this reader has already ranked the title. Decides
  -- whether the row offers Rank, and goes true on the next refetch after they do.
  viewer_ranked      boolean,
  -- The subject feed event's own type, for the row's sentence (20260901000100).
  subject_activity_type text,
  -- watchlist_social only (20261028000100): up to three members, as
  -- [{username, display_name, avatar_path}], and how many there are in all. Strongest
  -- first by affinity, then earliest, since 20261031000100.
  cluster_actors     jsonb,
  cluster_count      integer
)
language sql stable security definer
set search_path = public
as $$
  select n.id,
         n.type,
         n.created_at,
         n.read_at,
         n.actor_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         n.subject_type,
         n.subject_id,
         m.id,
         m.kind,
         m.title,
         parent.title,
         -- A theatrical row states the release's date as it stands NOW, not the date it
         -- was written with (Codex re-review): see the filter below.
         case when n.type = 'theatrical_release'
              then n.payload || jsonb_build_object('opens_on', rel.opens_on)
              -- 20261031000100. A season row states the verified date as it is now.
              when n.type = 'season_premiere'
              then n.payload || jsonb_build_object('available_on', sea.available_on)
              else n.payload end,
         case
           when n.type in ('comment', 'mention') then (
             select left(c.body, 140)
               from comments c
              where c.id = (n.payload ->> 'comment_id')::uuid
                and c.deleted_at is null
                and not c.has_spoilers
                and _can_read_comment(auth.uid(), c.id)
           )
         end,
         coalesce(
           case
             when n.type in ('comment', 'mention') then (
               select c.has_spoilers
                 from comments c
                where c.id = (n.payload ->> 'comment_id')::uuid
                  and c.deleted_at is null
                  and _can_read_comment(auth.uid(), c.id)
             )
           end,
           false
         ),
         case
           when n.type = 'watch_tag' then exists (
             select 1 from rankings r
              where r.user_id = auth.uid()
                and r.media_item_id = case
                                        when n.subject_type = 'media_item' then n.subject_id
                                        else null
                                      end
           )
           else false
         end,
         fe.type,
         cl.actors,
         cl.n
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one. See
     * 20260901000100 for the full reasoning; carried across unchanged.
     */
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and case
                when n.type = 'recommendation_ranked' then fe.actor_id = n.actor_id
                when n.type = 'mention' then can_view_profile(auth.uid(), fe.actor_id)
                else fe.actor_id = auth.uid()
              end
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    left join media_items parent
           on parent.id = m.parent_id
    left join proactive_candidates pc
           on n.type in ('watchlist_social', 'theatrical_release', 'season_premiere')
          and pc.notification_id = n.id
    /**
     * theatrical_release: the date the release event holds now. A film still scheduled
     * opens on its current scheduled date; one that has opened, on the day it did. One
     * that was withdrawn, lost its date, or is gone has none, and its row is not drawn
     * (Codex re-review): a postponed film must not keep saying the old date, and a
     * cancelled one must not keep saying it opens at all. Read-time, so it is true
     * whenever the inbox is read, before or after the push, with one row throughout.
     */
    left join lateral (
      select case
               when re.state = 'scheduled' then re.scheduled_date
               when re.state = 'released'  then coalesce(re.released_on, re.scheduled_date)
             end as opens_on
        from release_events re
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
    ) rel on pc.type = 'theatrical_release'
    /**
     * season_premiere (20261031000100): the verified date, while the verification row
     * still exists and still agrees with a release event that is still released on that
     * date. Removed, moved or retracted: no date, and the row is not drawn. Expiry of the
     * verification does not hide it (it is a dated fact); it only stops delivery.
     */
    left join lateral (
      select v.available_on
        from release_events re
        join proactive_season_availability v
          on v.release_event_id = re.id
         and v.region = coalesce(pc.metadata ->> 'region', 'US')
       where re.id = (pc.metadata ->> 'release_event_id')::uuid
         and re.state = 'released'
         and re.scheduled_date = re.released_on
         and v.available_on = re.released_on
    ) sea on pc.type = 'season_premiere'
    left join lateral (
      select count(*)::integer as n,
             jsonb_agg(jsonb_build_object('username', s.username,
                                          'display_name', s.display_name,
                                          'avatar_path', s.avatar_path)
                       order by s.rn) filter (where s.rn <= 3) as actors
        from _proactive_ranked_social_actors(pc.id, auth.uid(), now()) s
    ) cl on pc.type = 'watchlist_social'
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
     -- 20261028000100. The push-only type's carrier row is never part of the inbox.
     and n.type <> 'watchlist_resurface'
     -- And a social row nobody is left in says nothing true.
     and (n.type <> 'watchlist_social' or coalesce(cl.n, 0) > 0)
     -- And a theatrical row whose release no longer has a date says nothing true.
     and (n.type <> 'theatrical_release' or rel.opens_on is not null)
     -- And a season row whose availability is no longer on record says nothing true.
     and (n.type <> 'season_premiere' or sea.available_on is not null)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;


do $$
begin
  execute format('comment on function my_notifications(integer) is %L',
    obj_description('my_notifications(integer)'::regprocedure, 'pg_proc')
    || ' Since 20261101000100: the excerpt and comment_spoilers follow _can_read_comment, so they stop the moment the reader could no longer open the comment.');
end;
$$;
