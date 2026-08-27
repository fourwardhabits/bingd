-- ===========================================================================
-- A RECOMMENDATION THAT HEARS BACK
--
-- Notification tranche, 2026-08-27. The founder's request: when somebody ranks
-- a title another person recommended to them, the recommender should hear about
-- it — "Suraj ranked The Martian from your recommendation" — and tapping that
-- notification should open the recipient's exact ranking Feed post.
--
-- WHAT "FULFILLED" MEANS, PRECISELY
--
-- A recommendation is fulfilled when its recipient reaches a completed RANKED
-- state for the title — the `insert into rankings` inside `_rank_finalize`,
-- which has been the one place a ranking is created since 20260825000200. Not
-- when a sheet opens, not when a bucket is picked, not when a session starts,
-- and not on a log or a watchlist add.
--
-- And only a *first* ranking fulfils: `not v_replaced`, the same fact that has
-- gated the `title_ranked` feed event since 20260826000500. A Rank Again, a
-- bucket change, a re-rank — corrections to an opinion already recorded — fulfil
-- nothing, because the recommendation was answered the first time. The two
-- gates sharing one fact is what guarantees the notification always has a feed
-- event to point at: a fulfilling rank always posts one.
--
-- ONCE, AND WHY IT STAYS ONCE
--
-- `title_recommendations.fulfilled_at` is the durable state, written in the
-- same transaction as the ranking. The `fulfilled_at is null` guard makes the
-- claim idempotent under every replay this schema knows about: a lost reply
-- retried through `_claim_operation_result` never re-enters the body at all,
-- and a genuinely repeated first ranking (unrank on another device, rank
-- again) finds the timestamp already set. The partial unique index below is
-- the backstop for a writer that has not been written yet, on the same
-- reasoning as `notifications_one_welcome_per_account`.
--
-- Deliberately NOT a fourth enum value on `state`: the recipient policy is
-- `state = 'delivered'`, so a `fulfilled` state would silently vanish the row
-- from `recommendations_to_me` — and fulfilment is a fact *about* a delivered
-- recommendation, not a place it moves to.
--
-- WHO IS TOLD, AND WHO IS NOT
--
-- Every outstanding delivered recommendation for that (recipient, title) is
-- fulfilled at once — two recommenders each sent their own, so each receives
-- their own row. But fulfilment and notification are separate questions:
-- every matching row gets its timestamp, and only senders who could already
-- see the ranking get told. `can_view_profile(sender, ranker)` is the feed's
-- own predicate — a block in either direction, a suspension, or a private
-- ranker the sender does not follow all refuse — so this notification can
-- never tell a recommender anything the Feed would not show them. A sender
-- refused here is refused for ever, which is the correct reading of "once":
-- the moment passed, and a notification arriving days later when the block
-- lifts would be news about nothing.
--
-- A `pending` recommendation (a held request the recipient never accepted)
-- does not fulfil: it is not in the recipient's list, and its sender is
-- precisely the person the hold exists to keep at arm's length. If the
-- request is accepted later the row arrives `delivered` with the title
-- already ranked, and simply never fulfils — the recommendation did not
-- precede the ranking it would be claiming credit for. For the same reason
-- nothing here backfills: rows already ranked when this migration ships stay
-- silent.
--
-- THE EXACT POST, AND WHAT RIDES ON THAT
--
-- `subject_type = 'feed_event'`, `subject_id` = the freshly inserted
-- `title_ranked` event — the same shape `add_comment` writes, so the client's
-- existing activity chain (inbox tap and push tap both) opens the exact post
-- with no new routing machinery. `unlog` already deletes notifications whose
-- subject event it removes, so a fulfilment notification cannot outlive the
-- post it points at; the client's chain handles the gap in between.
--
-- The one wrinkle: `my_notifications` and `claim_push_batch` resolve a feed
-- event's title through a join narrowed to "the recipient's own activity".
-- This event belongs to the notification's *actor* — the ranker — so both
-- readers widen that join for this type alone. Nothing else changes shape.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The durable fact
-- ---------------------------------------------------------------------------
--
-- No grant, and that is load-bearing: `20260826000400` restated the column
-- list precisely so a new column would arrive invisible to clients. The sender
-- learns of fulfilment through the notification or not at all — the column
-- must not become an oracle on what the recipient did with their evening.

alter table title_recommendations
  add column fulfilled_at timestamptz;

comment on column title_recommendations.fulfilled_at is
  'When the recipient first reached a completed ranking for this title after the recommendation was delivered. Written by _rank_finalize in the ranking''s own transaction; null means not yet. Once set it is never cleared -- an unrank does not un-fulfil, and a later re-rank notifies nobody twice. Granted to no client role: the sender hears through the notification, when privacy allows it, and this column must not say more than that.';

-- The backstop. `fulfilled_at is null` is the mechanism; this is the invariant
-- stated where a future writer cannot miss it: one fulfilment notification per
-- recommendation, ever.
create unique index notifications_one_fulfillment_per_recommendation
  on notifications (((payload ->> 'recommendation_id')::uuid))
  where type = 'recommendation_ranked';

-- ---------------------------------------------------------------------------
-- 2. The preference gate learns the type
--
-- Rebuilt from `20260823000100` with one line added: `recommendation_ranked`
-- rides the existing `recommendations` category. Being told a recommendation
-- landed and being told it was taken are two ends of one exchange, and a
-- reader who switched that conversation off switched off both ends of it.
-- No new category, so the preferences screen needs no new switch.
-- ---------------------------------------------------------------------------

create or replace function _apply_notification_preference()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_category text;
begin
  -- A request is always delivered: an account that could silence it would receive
  -- requests it can never see and never answer.
  if new.type = 'follow_request' then
    return new;
  end if;

  -- A welcome is always delivered. See 20260823000100.
  if new.type = 'invite_welcome' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'                then 'follows'
    when 'follow_approved'       then 'follow_accepted'
    when 'comment'               then 'comments'
    when 'reaction'              then 'reactions'
    when 'watch_tag'             then 'watch_tags'
    when 'recommendation'        then 'recommendations'
    when 'recommendation_ranked' then 'recommendations'
    when 'invite_activated'      then 'invites'
    when 'award_earned'          then 'awards'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added
  -- later and forgotten here should reach its recipient, not vanish -- the failure
  -- mode of the other default is silent and undetectable.
  if v_category is null then
    return new;
  end if;

  if _notifies(new.recipient_id, v_category) then
    return new;
  end if;

  return null;
end;
$fn$;

comment on function _apply_notification_preference() is
  'Before-insert gate on notifications. Drops a row whose category the recipient has '
  'switched off. follow_request and invite_welcome are exempt and always delivered. '
  'recommendation_ranked shares the recommendations category (20260827000600): two ends '
  'of one exchange, one switch.';

-- ---------------------------------------------------------------------------
-- 3. Push eligibility
--
-- Rebuilt from `20260825000300` with `recommendation_ranked` added. It is a
-- normal social notification -- somebody acted on something you sent them --
-- and it rides the pipeline every such notification rides. Nine of the
-- eleven; `follow_approved`, `friendship` and `award_earned` remain the
-- deliberate absences.
-- ---------------------------------------------------------------------------

create or replace function _push_eligible(p_type text)
returns boolean
language sql immutable
set search_path = public
as $$
  select p_type = any (array[
    'follow',
    'follow_request',
    'comment',
    'reaction',
    'watch_tag',
    'recommendation',
    'recommendation_ranked',
    'invite_activated',
    'invite_welcome'
  ]::text[]);
$$;

comment on function _push_eligible(text) is
  'Which notification types are delivered as push. Nine of the twelve: follow_approved is excluded by PRD §15, friendship is the reader''s own action (20260827000200), and award_earned has no writer. An unmapped type is not eligible -- the opposite of the preference trigger''s rule, because an unreviewed push costs more than a missing one. Internal.';

-- ---------------------------------------------------------------------------
-- 4. `_rank_finalize`, rebuilt from `20260826000500` §3
--
-- Everything that migration built is carried across unchanged -- the category
-- lock, the last-moment drop, the band recomputed inside the lock, the
-- placement guard, the `user_media` re-assertion, the event gated on
-- `p_new_watch or not v_replaced`. Two additions: the event's id is kept, and
-- a first ranking settles the recommendations that asked for it. Same
-- signature, so `create or replace` and every caller in the rank family is
-- untouched.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false,
  p_replaces boolean default false,
  p_new_watch boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_band      record;
  v_size      integer;
  v_rank      integer;
  v_score     numeric;
  v_activated boolean;
  v_replaced  boolean := false;
  v_event_id  uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- The old position, dropped at the last possible moment rather than at the
  -- first (20260826000500). Everything above this line in the reader's session --
  -- opening the sheet, every comparison, every skip, closing it and coming back --
  -- left the ranking they already had exactly where it was.
  if p_replaces and exists (
    select 1 from rankings where user_id = target and media_item_id = item
  ) then
    perform _rank_unrank_impl(target, item);
    v_replaced := true;
  end if;

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw. With the drop above, that
  -- is now also the numbering the session's offsets were computed in.
  select * into v_band from band_bounds(target, cat, b);

  -- Valid insertion points run from the top of the band to one past its end. An
  -- empty band yields hi = lo - 1, so the only valid point is lo, which is what
  -- this reduces to.
  if pos < v_band.lo or pos > v_band.hi + 1 then
    raise exception
      'refusing to place a % title at position %, outside the % band (% to %)',
      b, pos, b, v_band.lo, v_band.hi + 1
      using errcode = '22023';
  end if;

  update rankings
     set position = position + 1
   where user_id = target and category = cat and position >= pos;

  insert into rankings (user_id, media_item_id, category, bucket, position)
  values (target, item, cat, b, pos);

  -- The collection row this ranking is a claim about, re-asserted from the ranking
  -- itself (20260825000200 §3). It closes I1 and I3 against anything that committed in
  -- the gap between the session opening and this transaction -- and it is the *only*
  -- writer of a provisional band change: `rank_rebucket` does not move
  -- `user_media.bucket` up front (20260826000500).
  insert into user_media (user_id, media_item_id, bucket)
  values (target, item, b)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket, updated_at = now()
   where user_media.bucket is distinct from excluded.bucket;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

  -- The founder's four War Dogs (20260826000500). A correction to an opinion already
  -- recorded is not a thing that happened to anybody else, so it does not become an
  -- activity. A first ranking always is one; another watch always is one. The id is
  -- kept now, because the fulfilment below points at it.
  if p_new_watch or not v_replaced then
    insert into feed_events (actor_id, type, media_item_id, payload)
    values (
      target,
      'title_ranked',
      item,
      jsonb_build_object(
        'position', pos,
        'bucket',   b,
        'category', cat,
        'score',    v_score
      )
    )
    returning id into v_event_id;
  end if;

  -- NEW (20260827000600). A first ranking settles the recommendations that asked
  -- for it. `not v_replaced` is the same fact that just decided the feed event, so
  -- a fulfilling rank always has an event to point at -- and a Rank Again or a
  -- bucket change, being `v_replaced`, settles nothing and notifies nobody.
  --
  -- Fulfilment and notification are decided separately, in one statement: every
  -- outstanding delivered recommendation gets its timestamp -- once, ever, by the
  -- `fulfilled_at is null` guard -- and only senders the feed itself would answer
  -- get a row. `can_view_profile(sender, ranker)` refuses a block either way, a
  -- suspended sender's view of nothing, and a private ranker the sender does not
  -- follow; the active-status join refuses a suspended or half-deleted sender. A
  -- sender refused now is not queued for later: the moment passed.
  --
  -- One notification per sender because there is one recommendation row per
  -- sender (`unique (sender_id, recipient_id, media_item_id)`), each carrying its
  -- own id in the payload -- which is what the backstop index measures.
  if not v_replaced then
    with fulfilled as (
      update title_recommendations tr
         set fulfilled_at = now()
       where tr.recipient_id = target
         and tr.media_item_id = item
         and tr.state = 'delivered'
         and tr.fulfilled_at is null
      returning tr.id, tr.sender_id
    )
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select f.sender_id,
           'recommendation_ranked',
           target,
           'feed_event',
           v_event_id,
           jsonb_build_object('recommendation_id', f.id)
      from fulfilled f
      join profiles sp
        on sp.id = f.sender_id
       and sp.status = 'active'
     where can_view_profile(f.sender_id, target)
    on conflict (((payload ->> 'recommendation_id')::uuid))
      where type = 'recommendation_ranked'
      do nothing;
  end if;

  -- PRD §28's activation, from the one place a ranking is created.
  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated
  );
end;
$$;

comment on function _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean) is
  'The one moment in the schema where a ranking is created. Carries 20260826000500''s behaviour whole: the drop happens inside the category lock, the band is recomputed there, and the title_ranked event posts iff p_new_watch or the placement created a position where there was none. Since 20260827000600 a first ranking also fulfils every outstanding delivered recommendation for the title -- once each, by the fulfilled_at guard -- and notifies the senders the feed itself would answer, pointing at the exact event it just posted. Internal.';

-- ---------------------------------------------------------------------------
-- 5. `my_notifications`, rebuilt from `20260827000200`
--
-- One join widened. The feed-event join resolved titles for "the recipient's
-- own feed event, and only ever theirs" -- true for a comment or a reaction,
-- which are about something the reader posted. A fulfilment is the mirror
-- image: the event belongs to the notification's *actor*, the person who
-- ranked. The join now says whose event each type means, and nothing else
-- about this function changes -- same return type, so `create or replace`
-- and the grants stand.
-- ---------------------------------------------------------------------------

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
  payload            jsonb
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
         n.payload
    from notifications n
    -- Left, because actor_id is nullable: a notification with no actor is a system
    -- notice and must not be dropped by the join that exists to name a person.
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    -- Whose feed event this type means. A comment or a reaction is on the reader's
    -- own post; a fulfilment (20260827000600) is the actor's own ranking, which is
    -- the thing the reader is being told about. Still never a third party's.
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and fe.actor_id = case
                              when n.type = 'recommendation_ranked' then n.actor_id
                              else auth.uid()
                            end
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
    -- A season's own title is "Season 2" and names nothing on its own. The client's
    -- `fullTitle` joins the two; this supplies the half it did not have.
    left join media_items parent
           on parent.id = m.parent_id
   where n.recipient_id = auth.uid()
     -- A row whose actor has been suspended stops appearing, rather than being drawn
     -- without a name. Consistent with public_profiles, search_users and the feed.
     --
     -- `can_discover_profile` is the part added by 20260819000300, and it subsumes the
     -- suspension check above rather than replacing it: the join still governs whether
     -- a name can be drawn at all, and this governs whether it may be.
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300 -- deliberately not can_view_profile, which would strand a private account''s follow request for ever. The feed-event join resolves the recipient''s own event for comment and reaction rows, and the actor''s own event for recommendation_ranked (20260827000600), which is the ranking the row reports.';

-- ---------------------------------------------------------------------------
-- 6. `claim_push_batch`, rebuilt from `20260827000300`
--
-- The same widened join, for the same reason, in the reader the drain uses.
-- Everything else -- the reap, the lease, the claim generation, the excerpt
-- rules, the discoverability drop -- is carried across verbatim.
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
        -- The conversation this push is about, so a tap on the lock screen lands where
        -- a tap on the inbox row lands. See 20260826000600 §6.
        'feed_event_id',   j.feed_event_id,
        -- What the person wrote, when it may be shown at all. See 20260827000300.
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
      -- Whose feed event this type means -- the same rule, in the same words, as
      -- `my_notifications`: the recipient's own post for a comment or a reaction,
      -- the actor's own ranking for a fulfilment (20260827000600).
      left join feed_events fe
             on n.subject_type = 'feed_event'
            and fe.id = n.subject_id
            and fe.actor_id = case
                                when n.type = 'recommendation_ranked' then n.actor_id
                                else n.recipient_id
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
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600 so a tapped push opens the conversation, comment_excerpt since 20260827000300 -- the comment''s own words, only when live and not spoiler-marked -- and resolves a recommendation_ranked job''s title through the actor''s own event since 20260827000600, because the ranking is the actor''s post.';
