-- An award push that names the award, and opens it.
--
-- ---------------------------------------------------------------------------
-- What the founder saw
-- ---------------------------------------------------------------------------
--
-- An award push read as a generic "new award" (founder, physical QA, 2026-09-14), and
-- tapping it opened the Awards list, while the inbox row for the same award names it
-- ("You earned Seedling", "Kept 25 titles on your watchlist") and opens that award's
-- celebration.
--
-- ---------------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------------
--
-- Both have one cause: the push job never carried which award it was. 20260828000100
-- added `award_name` to `claim_push_batch`; the 20260830000100 rebuild was assembled
-- from an older ancestor and dropped it, and every rebuild since (including
-- 20260917001500, which says so in its comment) carried the gap forward. So the sender
-- could only say "You earned a new Award", and the tap payload had no key or tier for
-- the client to route with, so it fell back to the Awards list.
--
-- ---------------------------------------------------------------------------
-- What changes
-- ---------------------------------------------------------------------------
--
-- `claim_push_batch` returns four more keys, for `award_earned` jobs only, read from
-- the notification's own payload (which has carried all four since 20260828000100):
-- `award_key`, `award_tier`, `award_family` (the payload's `award_name`) and
-- `award_tier_label` (its `tier_label`). Nothing else in the claim
-- moves: rebuilt in full from its newest definition (20260917001500), with the two
-- additions below as the only change, because a create-or-replace assembled from an
-- ancestor is exactly how the name was lost the first time.
--
-- The sender composes the words from the award's canonical copy (push-sender
-- `award-copy.ts`, generated from the app's `awardAnnouncement` and checked against it
-- in Jest), and puts the key and tier in the tap payload so the app opens the same
-- celebration the inbox row does.
--
-- **The names are deliberately not called `award_name`.** That is the key the deployed
-- sender (push-sender v4) already reads, and it holds the track's *family* name: an old
-- sender handed it would say "You earned Queue Dragon" for Seedling, the family-name
-- mistake 2026-08-29 removed from the inbox (independent review, 2026-09-14). Under new
-- names an old sender ignores all four and says what it says today, so this migration and
-- the sender deploy are safe in either order. A database that predates this gives the new
-- sender no key, and it says "You earned a new Award" and opens the Awards list.
--
-- Delivery is unchanged: one `award_earned` notification per (recipient, award, tier)
-- by its unique index, one outbox row per notification, the same lease and ceilings.
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

comment on function claim_push_batch(integer) is
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives -- a predicate 20260830000100 dropped by accident and 20260904000100 restored, with a test behind it. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, the mention branch since 20260830000100, import_job_id / import_counts since 20260917001500, and award_key / award_tier / award_family / award_tier_label for award_earned since 20260920000200 (the names under keys the pre-20260920000200 sender does not read, because it read award_name as the earned title). A job it returns may still be dropped before dispatch by live_push_jobs (20260904000100).';
