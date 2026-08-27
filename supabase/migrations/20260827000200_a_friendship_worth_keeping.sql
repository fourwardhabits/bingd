-- ===========================================================================
-- A FRIENDSHIP WORTH KEEPING
--
-- External-beta polish tranche, 2026-08-27. The founder's report: accept a
-- follow request and the notification simply vanishes. The task was dealt
-- with, the *record* was destroyed — the Bell keeps every other social fact
-- and lost the one where two people connected.
--
-- The shape chosen is resolve-and-create, not transform: the actionable
-- `follow_request` row is still deleted exactly as before (an Accept control
-- must never be drawable twice), and the approval now also files a new,
-- pre-read row to the accepter — type `friendship`, actor the requester —
-- so the history says what happened. The requester's own `follow_approved`
-- is untouched.
--
-- Exactly-once without new machinery: the insert rides the same consumption
-- of the pending `follows` row, under the same `_lock_pair`, that has always
-- made approval single-shot. A replayed operation id returns
-- `already_applied` before touching anything; a second approval finds no
-- pending row and raises P0002 before the insert's savepoint commits.
--
-- `payload.mutual` records whether the accepter also followed the requester
-- *at the moment of acceptance* — the fact the copy needs ("You and Abisola
-- are now friends" versus "Abisola now follows you"), frozen when it was
-- true rather than re-derived against a graph that keeps moving.
--
-- Deliberately not pushed and not silenceable: `_push_eligible` does not
-- list `friendship` (a phone buzzing about the reader's own tap is noise),
-- and `_apply_notification_preference` delivers unmapped types, which is the
-- correct default for a record of one's own action.
-- ===========================================================================

create or replace function respond_follow_request(
  p_operation_id uuid,
  p_requester_id uuid,
  p_approve      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found  boolean := false;
  v_mutual boolean := false;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'respond_follow_request') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _lock_pair(auth.uid(), p_requester_id);

  if p_approve then
    update follows
       set state = 'approved', approved_at = now()
     where follower_id = p_requester_id
       and followee_id = auth.uid()
       and state = 'pending';
    v_found := found;

    if v_found then
      -- The requester is told they are in. Without this the pending state is a
      -- silence they have to keep checking.
      insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
      values (p_requester_id, 'follow_approved', auth.uid(), 'profile', auth.uid());

      -- NEW (20260827000200). The accepter's own durable record, replacing the
      -- silence where the request row used to be. Pre-read: it reports the
      -- reader's own tap, and a row born unread would put a badge on an action
      -- they just took. `mutual` is the fact at this moment, for the copy.
      v_mutual := exists (
        select 1 from follows
         where follower_id = auth.uid()
           and followee_id = p_requester_id
           and state = 'approved'
      );
      insert into notifications
        (recipient_id, type, actor_id, subject_type, subject_id, payload, read_at)
      values
        (auth.uid(), 'friendship', p_requester_id, 'profile', p_requester_id,
         jsonb_build_object('mutual', v_mutual), now());

      -- NEW (20260826000400). The other half of the release, and the half that is easy
      -- to miss: the caller here is the **sender** of the held recommendations, and
      -- the requester is the recipient. A private account approving a follower is that
      -- follower deciding to trust them, answered late.
      perform _release_recommendations(auth.uid(), p_requester_id);
    end if;
  else
    delete from follows
     where follower_id = p_requester_id
       and followee_id = auth.uid()
       and state = 'pending';
    v_found := found;
    -- Declining is deliberately silent. Telling somebody they were turned down is a
    -- message nobody chose to send. Nothing is released: the follow did not happen.
  end if;

  -- The request has been dealt with either way, so it should stop appearing.
  delete from notifications
   where recipient_id = auth.uid()
     and actor_id = p_requester_id
     and type = 'follow_request';

  if not v_found then
    -- No pending request from that account. Same P0002 whether the requester does not
    -- exist, never asked, or has already been answered.
    raise exception 'no such request' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'ok', 'approved', p_approve);
end;
$$;

comment on function respond_follow_request(uuid, uuid, boolean) is
  'Approves or declines a pending request to follow the caller. Declining is silent by design and releases nothing -- the follow did not happen. Approving releases every recommendation the caller was holding for that requester (20260826000400), and files a pre-read friendship record to the caller (20260827000200) so the history keeps what the cleared request no longer says; payload.mutual freezes whether the connection was mutual at that moment. Clears the request from the caller''s inbox either way. P0002 when there is no pending request.';


-- ---------------------------------------------------------------------------
-- The inbox reader gains the payload, which the friendship row is the first
-- type to need. A new column in the return type, so: drop and recreate, with
-- the grants restated because a dropped function keeps nothing.
-- ---------------------------------------------------------------------------

drop function if exists my_notifications(integer);

create function my_notifications(p_limit integer default 50)
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
    -- The recipient's own feed event, and only ever theirs.
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and fe.actor_id = auth.uid()
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
  'The caller''s own inbox, with the actor named, the subject title resolved and the row''s payload carried through (20260827000200 -- friendship.mutual is the first fact a client draws from it). Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300, which closes the check-then-insert race between a writer and a block -- and deliberately not through can_view_profile, which would hide a private account''s follow request and strand it for ever.';

revoke execute on function my_notifications(integer) from public, anon;
grant  execute on function my_notifications(integer) to authenticated;
