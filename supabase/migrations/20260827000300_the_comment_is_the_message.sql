-- ===========================================================================
-- THE COMMENT IS THE MESSAGE
--
-- External-beta polish tranche, 2026-08-27. The founder's physical report: a
-- comment push spends its visible line on metadata — who, that they
-- commented, and a long title — and the one thing the person actually wrote
-- is nowhere. The payload prioritised provenance over content.
--
-- So `claim_push_batch` now carries `comment_excerpt` for comment jobs: the
-- first 180 characters of the comment body, resolved at claim time from the
-- `comment_id` the notification has always carried in its payload.
--
-- WHAT MAY LEAVE THE SERVER, STATED
--
-- The privacy rule in push-sender/copy.ts said no free text ever rides a
-- push, "enforced by the shape of claim_push_batch's select". This migration
-- relaxes exactly one cell of that rule, deliberately, on three conditions:
--
--   * **Already authorised.** The recipient is the activity's owner or a
--     commenter being replied to; the comment is content written *to* them,
--     readable in full one tap away. A lock screen preview of a message you
--     can read is what every messaging push is.
--   * **Never a spoiler.** `has_spoilers` is the author saying "hide this
--     behind a tap", and a lock screen is the one surface with no tap. A
--     spoiler-marked comment ships no excerpt and falls back to the old copy.
--   * **Resolved at claim time, not stored twice.** A comment deleted between
--     the notification and the drain yields null — the tombstone rule the
--     thread itself follows — and the copy falls back rather than quoting
--     something retracted.
--
-- Reviews, notes, search terms and everything else in copy.ts's list remain
-- excluded; none of them was ever content addressed to the recipient.
-- ===========================================================================

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
        -- The conversation this push is about, so a tap on the lock screen lands where
        -- a tap on the inbox row lands. See 20260826000600 §6.
        'feed_event_id',   j.feed_event_id,
        -- What the person wrote, when it may be shown at all. See the header.
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
           -- Comment jobs only. Live, spoiler-free, and bounded: 180 characters is
           -- more than any lock screen draws, and the client does the tidy ellipsis.
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
            and fe.actor_id = n.recipient_id
      left join media_items m
             on m.id = case
                         when n.subject_type = 'media_item' then n.subject_id
                         else fe.media_item_id
                       end
      left join media_items parent
             on parent.id = m.parent_id
     where n.id = any (v_claimed)
       and not (n.id = any (v_dead))
       and p.id is not null
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
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600 so a tapped push opens the conversation, and comment_excerpt since 20260827000300 -- the comment''s own words, only when live and not spoiler-marked, because the message is what the push is for.';
