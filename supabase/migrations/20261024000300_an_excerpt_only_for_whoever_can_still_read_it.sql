-- An excerpt only for whoever can still read it.
-- Security audit 2026-11-01, findings M-2 and m-5. Replaces `claim_push_batch(integer)`,
-- rebuilt in full from `20260920000200`, and `my_notifications`, rebuilt from
-- `20260901000100`.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- **Push.** `claim_push_batch` read a comment's body with no access check at all. A private
-- owner removes a follower without blocking them; that person once commented on an
-- activity; the owner later comments there, and up to 180 characters reach the removed
-- follower's lock screen. A private stranger's comment on somebody's public activity did
-- the same.
--
-- **Inbox.** `my_notifications` checked the comment's author and not the activity it sits
-- under. So a reader mentioned on an activity kept the text after that activity's owner
-- went private or blocked them, while the same row's title correctly disappeared.
--
-- ===========================================================================
-- THE RULE
--
-- **A reader sees a comment's text only if they could open that comment right now.** That
-- is `activity_comments`' own test: current access to the author and to the activity's
-- owner. `_can_read_comment` states it once and both surfaces call it, so the phone and
-- the inbox cannot disagree, and every way of losing access is covered by construction,
-- because `can_view_profile` is what each of them changes: a removal, an unfollow, a
-- block, going private, a suspension.
--
-- **Only the text moves.** A notification with no excerpt still names who acted, and the
-- sender already has words for a comment with none, because a spoiler-marked one has
-- always arrived that way.
--
-- **The proactive-notifications branch redefines both functions** with the same bodies. It
-- carries this rule in its own migration, which must stay on top of it: see the note in the
-- PR for the commit.
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
           -- Only what the recipient could open and read right now (20261024000300).
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
  'Claims up to p_limit queued pushes and returns everything needed to send them, recipients and tokens resolved server-side. Takes no recipient and cannot be pointed at one. Applies can_discover_profile exactly as my_notifications does, so a notification that raced a block is not pushed; an actorless notification (award_earned, 20260828000100) has nobody to check and survives -- a predicate 20260830000100 dropped by accident and 20260904000100 restored, with a test behind it. Five-minute lease with skip locked, so delivery is at least once, bounded at three settled failures and six claims. Reaps rows that have hit either ceiling. Carries feed_event_id since 20260826000600, comment_excerpt since 20260827000300, the actor''s own event for recommendation_ranked since 20260827000600, the mention branch since 20260830000100, import_job_id / import_counts since 20260917001500, and award_key / award_tier / award_family / award_tier_label for award_earned since 20260920000200 (the names under keys the pre-20260920000200 sender does not read, because it read award_name as the earned title). A comment_excerpt is included only while _can_read_comment says the recipient could read it (20261024000300). A job it returns may still be dropped before dispatch by live_push_jobs (20260904000100).';

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
  --
  -- The inbox says "commented on your Marty Supreme watch", and *watch* is a claim
  -- about the activity rather than about the title: a comment under a watchlist
  -- addition is not a watch. The client reads the noun off this instead of
  -- assuming one, and falls back to the neutral "activity" when it is null --
  -- which is every row with no event, and every row read by a bundle older than
  -- this column.
  --
  -- It discloses nothing the row did not already carry: it comes from the same
  -- join that resolves media_title, under the same three ownership rules and the
  -- same can_view_profile gate on the mention case.
  subject_activity_type text
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
         n.payload,
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
         fe.type
    from notifications n
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    /**
     * Whose feed event this type means, as three rules rather than one.
     *
     * A `comment` or `reaction` is on the reader's own activity, which is the general
     * case and the original constraint. A `recommendation_ranked` is the *actor's* own
     * ranking, which is the post the row reports (20260827000600).
     *
     * **A `mention` is on whichever activity the comment was made under**, which is very
     * often neither party's -- so the reader's-own constraint would leave exactly those
     * rows with no title, and a mention on somebody else's post is the ordinary case
     * rather than the edge one.
     *
     * That widening is gated on `can_view_profile` **at read time**, and the gate is not
     * belt-and-braces. `_can_mention` established that the recipient could see the
     * activity when the mention was written; it says nothing about later. The activity's
     * owner is a *third party* to this notification -- the actor is the commenter -- so
     * the outer `can_discover_profile` filter below, which is about the actor, does not
     * cover them, and neither does `block()`, which deletes rows between the pair it
     * names and not rows about them. Without this the reader keeps the title of an
     * activity whose owner has since blocked them or gone private. Independent review
     * 68 found it.
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
   where n.recipient_id = auth.uid()
     and (n.actor_id is null
          or (p.id is not null and can_discover_profile(auth.uid(), n.actor_id)))
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;


comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300. The feed-event join resolves the recipient''s own event for comment and reaction rows, the actor''s own for recommendation_ranked (20260827000600), and the event''s own for mention (20260830000100). Since 20260830000100 it also returns one line of the comment (withheld for a deleted, spoiler-marked or unviewable one, with comment_spoilers saying which) and, for watch_tag, whether the reader has already ranked the title. Since 20261024000300 the excerpt and comment_spoilers follow _can_read_comment, so they stop the moment the reader could no longer open the comment. Since 20260901000100 it returns the subject event''s type, so the row can say "your Marty Supreme watch" without assuming that every activity is one.';

grant execute on function my_notifications(integer) to authenticated;
