-- A request released only to a mutual pair (FU1113-E D1, founder decision t180u).
--
-- ===========================================================================
-- THE DEFECT
--
-- `_release_recommendations` (20260826000400 §4) moves a sender's held Requests into the
-- recipient's Sent to You when a follow toward the sender becomes approved. It checked the
-- block and nothing else. So:
--
--   sender follows recipient, sends (one-way: held as a Request)
--   sender unfollows recipient          -- the Request stays held
--   recipient follows sender            -- released into Sent to You
--
-- and the row was delivered at a moment the pair was **not** mutual. Sent to You is meant to
-- hold only what arrives between mutual follows (20260826000400: "Recipient also follows
-- sender -> delivered").
--
-- ===========================================================================
-- THE FIX, AND ONLY THE FIX
--
-- The release now also requires both approved edges, sender -> recipient and recipient ->
-- sender, read inside the caller's transaction. Every caller (`follow`,
-- `respond_follow_request`, `set_profile_visibility`, and the two invite-accept functions)
-- writes the approved edge *before* it calls this, and takes `_lock_pair` first, as does
-- `unfollow` — so a concurrent unfollow either commits before the release reads the edge (and
-- nothing is released) or queues behind it (and the release happened while the pair was
-- mutual, which is the rule).
--
-- When the guard fails the rows simply **stay pending**, in the recipient's Requests, where
-- they can Add or Dismiss them. Nothing is deleted and nothing is refused.
--
-- DOCUMENTED CONSEQUENCE: there is deliberately no release when the *sender* re-follows. A
-- Request held across an unfollow therefore stays in Requests until the recipient Adds or
-- Dismisses it, even if the pair later becomes mutual again by the sender's follow. A later
-- follow by the recipient (the release paths above) does release it once the pair is mutual.
--
-- Nothing else changes: not `follow`, `unfollow`, `respond_follow_request`,
-- `set_profile_visibility`, the invite-accept functions, `recommend_title`,
-- `_may_recommend_to`, `_delivers_directly_to`, `add_recommendation` or
-- `recommendation_requests`. The body below is 20260826000400 §4 verbatim apart from the
-- block marked NEW.
--
-- Rollback (in the PR body as well): `create or replace` this function exactly as
-- 20260826000400 §4 defines it, with that migration's comment and the same revoke.
-- ===========================================================================

create or replace function _release_recommendations(p_sender uuid, p_recipient uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  if p_sender is null or p_recipient is null or p_sender = p_recipient then
    return 0;
  end if;

  -- Defence in depth. Every caller has already established that no block exists --
  -- `block` deletes both follow edges, so an approved follow and a block cannot
  -- coexist -- but a release is a write into somebody's list and "usually" is not a
  -- privacy argument.
  if blocked_between(p_sender, p_recipient) then
    return 0;
  end if;

  -- NEW (20261121000300). Sent to You is for mutual follows. A Request held from a sender who
  -- has since unfollowed stays in Requests, where the recipient can still Add or Dismiss it.
  if not exists (select 1 from follows f
                  where f.follower_id = p_sender and f.followee_id = p_recipient
                    and f.state = 'approved')
     or not exists (select 1 from follows f
                     where f.follower_id = p_recipient and f.followee_id = p_sender
                       and f.state = 'approved') then
    return 0;
  end if;

  update title_recommendations
     set state = 'delivered'
   where sender_id = p_sender
     and recipient_id = p_recipient
     and state = 'pending';

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

comment on function _release_recommendations(uuid, uuid) is
  'Moves every pending recommendation from one sender to one recipient into delivered, exactly once, and silently -- but only while the pair is mutual: both approved follow edges must exist (20261121000300). Otherwise nothing moves and the rows stay pending in the recipient''s Requests, where they can be added or dismissed. Called from follow, respond_follow_request, set_profile_visibility and the invite-accept paths, after they write the approved edge. Dismissed rows are excluded, which is what makes a dismissal final. Files no notification. No release happens when the sender re-follows. Internal.';

revoke execute on function _release_recommendations(uuid, uuid) from public, anon, authenticated;
