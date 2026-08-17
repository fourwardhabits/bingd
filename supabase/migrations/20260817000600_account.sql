-- Settings becomes real: an editable identity, a privacy switch that means something,
-- an inbox that can be answered, and a way out.
-- Specification: master prompt Phase F · PRD §15 (inbox), §16 (profile), §22 (privacy)
-- · api.md §3 · founder addendum 2026-08-16 §4 (the two-user gate).
--
-- ===========================================================================
-- WHAT WAS MISSING, AND WHY IT SURVIVED
--
-- Settings said, in one sentence: "Privacy, notifications, and account controls are not
-- built yet." That was accurate. What is worth recording is what the *database* already
-- had, because in three of the four cases the machinery was complete and only the
-- entry point was absent:
--
--   Renaming.       `username_changed_at`, `username_history`, the 90-day redirect,
--                   `reserve_username_on_rename` and `assert_username_available` have
--                   all existed since 20260813002000, which says in as many words that
--                   they are "not reachable today: no rename RPC exists". This is that
--                   RPC.
--
--   Privacy.        `profiles.visibility` has been read by `can_view_profile` since day
--                   one and decides, right now, whether a follow is approved or pending
--                   and whether a profile is discoverable at all. Nothing could set it.
--                   Every account in the database is `public` because that is the
--                   column default, not because anybody chose it.
--
--   Follow requests. `respond_follow_request` was built and tested at 20260817000200
--                   and the `follow_request` notification row has been written since.
--                   **Nothing read it.** A private account could receive requests and
--                   had no surface on which to see them, which made the private setting
--                   a way to make yourself unreachable rather than a way to choose.
--
--   Deletion.       `reserve_username_on_profile_delete` has existed since
--                   20260813001500 and fires `before delete on profiles`, and every
--                   foreign key in the schema was already given a deliberate delete
--                   rule. The whole cascade was designed for a deletion nothing could
--                   trigger.
--
-- So most of this migration is entry points to existing semantics, which is the
-- opposite of what "build Settings" usually means. The one genuinely new decision is
-- what account deletion keeps, and it is stated in full in section 5.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- A **bio**. There is no `profiles.bio` column, and adding one is not a column — it is
-- a free-text field on a public page, which means a moderation surface, a length rule,
-- a control-character rule, a spoiler question and a report subject. The founder's
-- instruction was to implement it "only if backed by proper persisted storage and
-- reviewed writes" and otherwise to ship no fake one. There is no fake one: the
-- hardcoded "Movie and TV collector" was removed from the profile screen when it was
-- found. Blank until there is a real one.
--
-- A **deactivated** status. `profile_status` is (`active`, `suspended`) and stays that
-- way. Temporary deactivation is not a V1 state, it is a third value that every filter
-- in the schema would have to learn about, and the founder has ruled it out of this
-- run explicitly. Deletion below is real and permanent, which is the thing a beta
-- actually owes its testers.
--
-- A **notification preference matrix**. `notification_preferences` exists and nothing
-- writes it. It stays that way: there is one delivery channel (the inbox), it cannot
-- be turned off without making follow requests unanswerable, and a screen of switches
-- over a table nothing reads would be exactly the "switches that do nothing" the brief
-- forbids.
-- ===========================================================================

-- ===========================================================================
-- 1. Editing the display name
--
-- The one identity field that is free text, already constrained by
-- `display_name_shape` (1-50 characters, no control characters) since 20260813002200,
-- and already validated in `create_profile`. The check is restated here rather than
-- left to the constraint for the reason `create_profile` restates it: a constraint
-- violation reports as 23514 with no indication of which rule was broken, and this is
-- a form field somebody is typing into.
--
-- Takes an operation id like every other client write, so a retry after a dropped
-- response is not a second edit. Rate-limited, because a display name renders on every
-- social surface and an account rewriting it a hundred times an hour is not editing
-- their profile.
-- ===========================================================================

create or replace function update_profile(p_operation_id uuid, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'update_profile') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('update_profile', 'profile.max_edits_per_day', 20);

  if char_length(v_name) < 1 or char_length(v_name) > 50 or v_name ~ '[[:cntrl:]]' then
    raise exception 'display name must be 1 to 50 characters, on one line'
      using errcode = '22023';
  end if;

  update profiles set display_name = v_name where id = auth.uid();

  -- A profile that does not exist is not an error worth distinguishing: the caller is
  -- authenticated and mid-signup, and the create flow is where they belong.
  if not found then
    raise exception 'no profile to update' using errcode = '42704';
  end if;

  return jsonb_build_object('status', 'ok', 'display_name', v_name);
end;
$$;

comment on function update_profile(uuid, text) is
  'Sets the caller''s display name, 1 to 50 characters on one line. Idempotent by operation id and rate-limited per day. The only free-text identity field there is: there is no bio column, deliberately (see the header of 20260817000600).';

-- ===========================================================================
-- 2. Changing the handle
--
-- 20260813002000 built the entire mechanism for this and said plainly that it was
-- "not reachable today: no rename RPC exists. It is fixed now rather than when that
-- RPC is written, because the gap only becomes visible at the moment it becomes
-- exploitable, and the person adding a change_username function has no reason to
-- suspect this is missing." This is that function, and the note was right — nothing
-- about the two triggers is visible from here.
--
-- What happens on the update, without this function doing any of it:
--
--   `profiles_reserve_username_on_rename` writes the old name into `username_history`
--   with a 90-day redirect and stamps `username_changed_at`.
--   `profiles_username_not_reserved` refuses a name in somebody else's history.
--   The unique index refuses a name in live use.
--
-- WHY A COOLDOWN
--
-- Every rename **permanently burns a name**: `username_history` retains the row past
-- `redirect_until` precisely so the name never returns to the pool. Without a cooldown
-- one account could exhaust every short handle in an afternoon, and each of those
-- reservations is irreversible without a manual delete. Thirty days is long enough
-- that renaming is a decision and short enough that a mistyped handle is fixable
-- within a beta.
--
-- The cooldown is a separate refusal from the rate limiter, which counts operations
-- rather than successful renames — a rename that failed on a taken name should not
-- consume the month.
--
-- One error code for "taken" and "reserved", carried over from `create_profile`: the
-- caller's next action is the same either way, and distinguishing them would say
-- whether a name belonged to a deleted account.
-- ===========================================================================

insert into app_config (key, value)
values ('username.change_cooldown_days', '30'::jsonb)
on conflict (key) do nothing;

create or replace function change_username(p_operation_id uuid, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text := lower(btrim(coalesce(p_username, '')));
  v_current citext;
  v_changed timestamptz;
  v_days    integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'change_username') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('change_username', 'profile.max_edits_per_day', 20);

  -- Format first, so a mistyped handle is reported as a mistyped handle rather than as
  -- an eligibility decision. Same rule and same message as `create_profile`.
  if v_name !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'username must be 3 to 24 characters, lowercase letters, numbers, or underscores'
      using errcode = '22023';
  end if;

  -- `for update`, and this is the whole of the cooldown's integrity.
  --
  -- Independent review 14, second Major: without it two concurrent calls both read
  -- the same `username_changed_at`, both pass the check, and serialise only at the
  -- UPDATE — where the second one no longer re-reads the timestamp the first just
  -- wrote. Two different operation ids therefore perform two successful "first"
  -- renames seconds apart, and each of them retires a handle for good.
  --
  -- A row lock rather than an advisory one: the contended resource *is* this row,
  -- there is exactly one row per caller so nobody contends with anybody else, and the
  -- lock is held by the same statement that reads the value it protects.
  select p.username, p.username_changed_at into v_current, v_changed
    from profiles p where p.id = auth.uid()
    for update;

  if v_current is null then
    raise exception 'no profile to rename' using errcode = '42704';
  end if;

  -- Not an error. Somebody re-submitting the name they already have has reached the
  -- state they meant, and refusing it would burn a cooldown on a no-op.
  if v_current = v_name::citext then
    return jsonb_build_object('status', 'ok', 'username', v_current::text);
  end if;

  select coalesce((value)::integer, 30) into v_days
    from app_config where key = 'username.change_cooldown_days';
  v_days := coalesce(v_days, 30);

  if v_changed is not null and v_changed > now() - make_interval(days => v_days) then
    raise exception 'you can change your username again after %',
      to_char(v_changed + make_interval(days => v_days), 'DD Mon YYYY')
      using errcode = '53400';
  end if;

  -- Both triggers fire on this one statement. 23505 arrives either from the unique
  -- index (live name) or from `assert_username_available` (reserved name), and the
  -- caller gets the same answer for both on purpose.
  update profiles set username = v_name::citext where id = auth.uid();

  return jsonb_build_object('status', 'ok', 'username', v_name);
end;
$$;

comment on function change_username(uuid, text) is
  'Renames the caller''s handle, first writer for the 90-day redirect machinery built in 20260813002000. Thirty-day cooldown, because username_history retains every released name permanently and a rename burns one for good. 23505 for a name that is taken or reserved -- one code, because distinguishing them would say whether a name belonged to a deleted account.';

-- ===========================================================================
-- 3. Privacy
--
-- `profiles.visibility` is the single most load-bearing column in the visibility
-- architecture and has never been settable. `can_view_profile` reads it; `follow`
-- reads it to decide approved versus pending; `search_users` inherits it through
-- `can_i_view`; `public_notes`, `community_score`, `taste_match` and the feed all sit
-- behind it. Every account is public because that is the default.
--
-- WHAT SWITCHING TO PRIVATE DOES, AND DOES NOT DO
--
-- It does not remove existing followers. Somebody already approved stays approved,
-- which is what `remove_follower` is for. Going private means "from now on, ask" — it
-- is not a retroactive revocation, and treating it as one would silently sever
-- relationships the user did not name.
--
-- WHAT SWITCHING TO PUBLIC DOES
--
-- Approves every pending request, silently.
--
-- The alternative — leaving them pending — produces a state nothing else in the schema
-- can create: a public account with people waiting on it, where a *new* follower is
-- approved instantly and the ones who asked first are still queued. That asymmetry is
-- not a privacy property, it is a bug the user would report.
--
-- Silently, and this is the deliberate half. `respond_follow_request` sends
-- `follow_approved` because somebody made a decision about a specific person. Nobody
-- made a decision here — the account stopped requiring them — and firing "X approved
-- your request" at everyone waiting would attribute an act to the user that they did
-- not perform. The request rows are cleared from the inbox instead, because there is
-- nothing left to respond to. The requester's own client sees "Following" on its next
-- read, which is the truth.
--
-- Nothing is lost by approving them: a public account can be followed by anyone with
-- one tap, so the only thing the pending state was still costing was the tap.
-- ===========================================================================

create or replace function set_profile_visibility(
  p_operation_id uuid,
  p_visibility   profile_visibility
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current  profile_visibility;
  v_approved integer := 0;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_profile_visibility') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('set_profile_visibility', 'profile.max_edits_per_day', 20);

  if p_visibility is null then
    raise exception 'visibility is required' using errcode = '22023';
  end if;

  -- `for update`, for a race that the pair lock cannot reach.
  --
  -- Independent review 14, third Major. `follow` takes `_lock_pair(caller, target)`,
  -- which serialises it against other writers *on that pair* — and the account going
  -- public is not one of them. So a follower can read `private`, be told to wait
  -- while this transaction promotes everybody it can see, and then insert a `pending`
  -- row and a `follow_request` notification into a profile that is now public. The
  -- committed state is exactly the inconsistency this function exists to prevent, and
  -- neither party did anything wrong.
  --
  -- The pair lock cannot help because the second party is not known: a follower who
  -- does not exist yet hashes to a key this transaction has no reason to take. What
  -- both sides *do* touch is this one profile row, so that is where they meet —
  -- `follow` takes `for share` on it (20260817000600 amends it below) and this takes
  -- `for update`. The two conflict, so whichever arrives second sees the other's
  -- committed answer rather than a stale one.
  select p.visibility into v_current from profiles p where p.id = auth.uid()
    for update;
  if v_current is null then
    raise exception 'no profile to update' using errcode = '42704';
  end if;

  if v_current = p_visibility then
    return jsonb_build_object('status', 'ok', 'visibility', p_visibility, 'approved', 0);
  end if;

  update profiles set visibility = p_visibility where id = auth.uid();

  if p_visibility = 'public' then
    with promoted as (
      update follows
         set state = 'approved', approved_at = now()
       where followee_id = auth.uid()
         and state = 'pending'
      returning follower_id
    )
    select count(*) into v_approved from promoted;

    -- The requests have been answered by the setting rather than by the user, so the
    -- inbox rows go with them. Left behind they would offer Approve and Decline for a
    -- decision that has already been made.
    delete from notifications
     where recipient_id = auth.uid()
       and type = 'follow_request';
  end if;

  return jsonb_build_object('status', 'ok', 'visibility', p_visibility, 'approved', v_approved);
end;
$$;

-- ---------------------------------------------------------------------------
-- `follow` learns to read the visibility under a lock
--
-- The other half of the race above. `follow` decides `approved` versus `pending`
-- from `profiles.visibility`, and it read that value under no lock at all — so the
-- decision could be made against a setting that had already changed by the time the
-- row was inserted.
--
-- Rebuilt in full rather than patched, and the whole body is carried over unchanged
-- apart from the two lines marked below. That is deliberate: `create or replace` in a
-- schema with a history is the trap 20260817000200 records — `_assert_operation_rate`
-- lost its advisory lock that way, invisibly, because the diff against the *previous*
-- migration showed nothing. Reproducing the body here means the diff against
-- 20260817000200 is the thing a reviewer reads.
--
-- `for share` rather than `for update`: several people may be following the same
-- account at once and they do not contend with each other, only with a change to the
-- row they are all reading. `for key share` would be weaker still and is not enough —
-- it does not conflict with `for update`.
-- ---------------------------------------------------------------------------

create or replace function follow(p_operation_id uuid, p_followee_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visibility profile_visibility;
  v_state      follow_state;
  v_existing   follow_state;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'follow') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- Per hour, not per day (api.md §11). A mass-follow script is a burst.
  perform _assert_operation_rate('follow', 'follow.max_per_hour', 60, interval '1 hour');

  -- Before the reachability check, not after: the check is what reads `blocks`, and a
  -- block committing between the check and the insert is precisely the race.
  perform _lock_pair(auth.uid(), p_followee_id);

  -- NEW (20260817000600). The followee's own row, shared, so that a concurrent
  -- `set_profile_visibility` on that account either commits before this reads it or
  -- waits until after this has inserted. Without it, a follow can decide `pending`
  -- against a setting that has since become public, and land after the promotion
  -- sweep that would have caught it.
  perform 1 from profiles where id = p_followee_id for share;

  v_visibility := _assert_reachable(p_followee_id);

  -- A public account is followed outright; a private one receives a request. This is
  -- the only place in the schema that decides which, and it decides it from the
  -- target's own setting rather than from anything the caller sends.
  v_state := case when v_visibility = 'private' then 'pending' else 'approved' end;

  select f.state into v_existing
    from follows f
   where f.follower_id = auth.uid() and f.followee_id = p_followee_id;

  -- Already there. Return the state rather than raising: following someone you follow
  -- is a tap that reached the state it meant, and a retry after a dropped response
  -- must not be an error.
  --
  -- Critically, an existing row is **never downgraded**. If an approved follow exists
  -- and the account has since become private, re-following must not demote it to
  -- pending — that would let anyone revoke their own approved access by tapping twice,
  -- and worse, would fire a fresh request notification at the followee.
  if v_existing is not null then
    return jsonb_build_object('status', 'ok', 'state', v_existing);
  end if;

  insert into follows (follower_id, followee_id, state, approved_at)
  values (auth.uid(), p_followee_id, v_state,
          case when v_state = 'approved' then now() end);

  -- PRD §15's inbox row. Two types, because they are two different things to be
  -- told: somebody followed you, or somebody is waiting on you.
  insert into notifications (recipient_id, type, actor_id, subject_type, subject_id)
  values (p_followee_id,
          case when v_state = 'approved' then 'follow' else 'follow_request' end,
          auth.uid(), 'profile', auth.uid());

  return jsonb_build_object('status', 'ok', 'state', v_state);
end;
$$;

comment on function follow(uuid, uuid) is
  'Follows a public account outright and files a request against a private one. Refuses a missing, suspended or blocked target with the same P0002, because telling them apart tells a blocked caller they are blocked. Never downgrades an existing approved follow to pending. Takes a share lock on the followee''s profile row so that a concurrent visibility change cannot leave a public account holding a pending request (20260817000600). Rate-limited per hour (api.md §11).';

comment on function set_profile_visibility(uuid, profile_visibility) is
  'Sets the caller''s profile visibility, first writer for a column can_view_profile has read since day one. Going public approves every pending request *silently* -- nobody decided about those people, the account stopped requiring a decision, and a follow_approved notification would attribute an act the user did not perform. Going private does not remove existing followers: that is remove_follower''s job, and a retroactive revocation would sever relationships the user did not name.';

-- ===========================================================================
-- 4. The inbox
--
-- `notifications` has had a recipient-scoped read policy since 20260813000900 and six
-- writers since. Nothing has ever read it.
--
-- WHY THIS IS DEFINER, WHICH IS THE WHOLE DESIGN QUESTION
--
-- A row names an actor, and drawing it needs their handle, name and picture. Those
-- live in `profiles`, behind `profiles_read`, which is `can_i_view(id)`.
--
-- **A private account requesting to follow another private account is invisible to the
-- person who has to answer them.** `can_view_profile(recipient, requester)` is false —
-- correctly, they do not follow each other — so an invoker-rights query returns a
-- notification with no name attached, and the one control that resolves it cannot be
-- drawn. The request would be permanently unanswerable, which makes the private
-- setting a trap rather than a choice.
--
-- This is exactly the shape of `my_blocks` (20260817000200 §5), and it earns definer
-- the same way: the filter is `recipient_id = auth.uid()`, it is not a parameter, and
-- it cannot be made one. The function answers "what is in my inbox" and there is no
-- way to ask it about anybody else.
--
-- WHAT IT DISCLOSES, STATED PLAINLY
--
-- The handle, display name and avatar of every account that has acted on the caller.
-- That set is, by construction, people who chose to interact with them: they followed
-- them, requested to, reacted, commented, or tagged them in a watch. A blocked account
-- discloses nothing, because `block` deletes the notification rows in both directions.
--
-- A **suspended** actor is filtered out, which is what every other surface in this
-- schema does with `status = 'active'`. Their row simply stops appearing rather than
-- being drawn without a name.
--
-- WHY THE SUBJECT IS RESOLVED HERE
--
-- "Alice commented on your activity" with no indication of which activity is a
-- notification that requires a second app to answer. The subject of a `comment` or a
-- `reaction` is a `feed_events` row, and the join is constrained to
-- `actor_id = auth.uid()` — the recipient's own event, which is the only kind these
-- writers ever name. A `watch_tag` names a `media_item` directly, which is catalogue
-- data and world-readable. Neither can reach anybody else's row.
-- ===========================================================================

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
  media_title        text
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
         m.title
    from notifications n
    -- Left, because actor_id is nullable: a notification with no actor is a system
    -- notice and must not be dropped by the join that exists to name a person.
    left join profiles p
           on p.id = n.actor_id
          and p.status = 'active'
    -- The recipient's own feed event, and only ever theirs. Both writers that use this
    -- subject type set recipient_id to the event's own actor.
    left join feed_events fe
           on n.subject_type = 'feed_event'
          and fe.id = n.subject_id
          and fe.actor_id = auth.uid()
    left join media_items m
           on m.id = case
                       when n.subject_type = 'media_item' then n.subject_id
                       else fe.media_item_id
                     end
   where n.recipient_id = auth.uid()
     -- A row whose actor has been suspended stops appearing, rather than being drawn
     -- without a name. Consistent with public_profiles, search_users and the feed.
     and (n.actor_id is null or p.id is not null)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

comment on function my_notifications(integer) is
  'The caller''s own inbox, with the actor named and the subject title resolved. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Suspended actors drop out, like everywhere else.';

-- ---------------------------------------------------------------------------
-- Marking it read
--
-- `read_at` and the `notifications_unread` partial index have existed since
-- 20260813000900. This is their first writer.
--
-- All at once, and only the caller's own. There is no per-row mark because there is no
-- surface for one: the inbox is a list somebody opens, and the useful meaning of "read"
-- is "has seen this screen". A per-notification version can be added when something
-- needs it; a boolean nobody sets is what this migration is here to stop repeating.
--
-- Not idempotency-guarded and not rate-limited. It is idempotent by construction —
-- the `read_at is null` filter means a second call updates nothing — and an operation
-- id on a write that costs nothing and changes nothing visible would be ceremony.
-- ---------------------------------------------------------------------------

create or replace function mark_notifications_read()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  perform assert_can_write();

  with marked as (
    update notifications
       set read_at = now()
     where recipient_id = auth.uid()
       and read_at is null
    returning 1
  )
  select count(*) into v_count from marked;

  return v_count;
end;
$$;

comment on function mark_notifications_read() is
  'Marks every unread notification of the caller''s as read, and returns how many. First writer for read_at and the notifications_unread index, both declared in 20260813000900. Idempotent by construction: the read_at is null filter makes a second call a no-op.';

-- ===========================================================================
-- 5. Deleting an account
--
-- The one genuinely new decision in this migration, and the only one that cannot be
-- undone. What follows is the full inventory, because "we delete your data" is a claim
-- that has to be checkable against the schema rather than asserted.
--
-- HOW IT WORKS
--
-- One statement: `delete from auth.users where id = auth.uid()`. `profiles.id`
-- references it `on delete cascade`, and every table below hangs off `profiles`. There
-- is no bespoke deletion order to keep in step with future tables — a new table with a
-- foreign key to `profiles` is covered the day it is created, and one *without* a
-- delete rule fails this loudly rather than leaving an orphan.
--
-- This is the same mechanism `create_profile` already uses for the under-13 age gate
-- (20260813002200), which is deployed and exercised. Its comment names the hazard that
-- applies here too: a future foreign key without ON DELETE CASCADE blocks the delete,
-- and `storage.objects` is the usual culprit — which is why the avatars go first.
--
-- WHAT IS DELETED, BY CASCADE
--
--   the auth user            email, phone, provider identities, sessions
--   profiles                 handle, display name, avatar pointer, visibility
--   profile_private          date of birth
--   rankings, comparisons, ranking_sessions      the whole ordered collection
--   user_media, watchlist, watch_goals           what they watched, saved, aimed for
--   follows (both directions)                    every edge in and out
--   blocks (both directions)                     see the note below
--   feed_events, reactions, comments             everything they said or reacted to
--   watch_tags (as tagger and as tagged)         companion attributions
--   notifications (sent and received)            both directions
--   notification_preferences, device_tokens      delivery state
--   lists, share_tokens, invite_tokens           anything they published a link to
--   import_jobs                                  upload history
--   capability_grants                            entitlements
--   processed_operations                         their idempotency ledger
--   match_scores, recommendation_*               everything derived about them
--   tmdb_request_log                             their provider quota window
--
-- THE AVATARS, WHICH TAKE TWO STEPS AND ONLY ONE OF THEM IS HERE
--
--   `storage.objects` under `{id}/` in the avatars bucket. The bucket is public and
--   the URL contains only the account's uuid, so an avatar left behind is a face that
--   stays fetchable by anybody who kept a link — precisely the bargain 20260815030000
--   §2 says the delete policy exists to close.
--
--   **Deleting the row here does not delete the file.** Supabase is explicit that
--   objects must be removed through the Storage API and that a SQL delete leaves the
--   stored object orphaned. Independent review 14 raised this as a Blocker against an
--   earlier version of this function that removed the row and described it as removing
--   the picture. It was not the same thing and the difference is bytes on a disk.
--
--   So the removal is two steps and they are in the right order:
--
--     1. The client calls the Storage API (`deleteAllAvatars`), which removes every
--        object in the account's folder — every picture it has ever uploaded, since
--        each upload writes a fresh filename. That is the step that removes bytes.
--     2. This function deletes any `storage.objects` rows still standing.
--
--   Step 2 is a backstop rather than the mechanism, and it does two things worth
--   having even when step 1 succeeded: it makes the deletion correct for a caller
--   whose storage request failed after the confirmation, and it is what keeps the
--   `delete from auth.users` below possible at all — `20260813002200` names
--   `storage.objects` as the likely blocker of exactly that statement.
--
--   What can survive both: an object file whose metadata row this removed but whose
--   bytes the API never reached. Nothing resolves it — the public URL is served from
--   the metadata — but it exists in the bucket until an operator prunes it. That is
--   stated rather than hidden, and it is the honest limit of what a database function
--   can promise about an object store.
--
-- WHAT IS ANONYMISED RATHER THAN DELETED, AND WHY
--
--   username_history.profile_id -> null      (the FK's own rule)
--       The reservation stays; the pointer goes. This is what stops a released handle
--       being taken by somebody else and inheriting old links — the INF-2
--       impersonation outcome 20260813002000 exists to prevent. The row that remains
--       is a string and a timestamp: it names a handle nobody owns.
--
--   profiles.invited_by -> null              (the FK's own rule)
--       Somebody else's row. Deleting their account because their inviter left would
--       be absurd.
--
--   invite_attributions.inviter_id -> null   (the FK's own rule)
--       Growth provenance about accounts that still exist. `20260813001500` §2 made
--       this SET NULL deliberately: destroying it when the inviter leaves corrupts the
--       invite metrics rather than protecting anybody. What remains carries no
--       identifier of the departed account.
--
--   reports.reporter_id / subject_owner -> null   (the FK's own rule)
--       Deleting a report because the reporter left would let an account erase every
--       complaint it made by closing itself, and deleting one because the *subject*
--       left would erase the record of why an account was removed.
--
-- WHAT IS KEPT AS A SAFETY RECORD, AND IS NOT ANONYMOUS
--
-- Independent review 14, fourth Major, and the correction is to the claim rather than
-- to the behaviour. The two nulled columns above are not the whole of a report:
--
--   reports.subject_id      still holds the deleted account's uuid when the report was
--                           *about a profile*, because that is what the report is about
--                           and nulling it would leave a complaint about nobody.
--   reports.note            free text somebody typed, which may name or describe the
--                           account.
--   moderation_actions.subject_id, .rationale
--                           no foreign key reaches either. The operator's own record of
--                           what was done and why.
--
-- These are retained **deliberately and knowingly**, and the reason is the one thing a
-- deletion right cannot be allowed to buy: an account that is the subject of reports
-- must not be able to erase them by closing itself and opening another. A safety record
-- that any subject can delete is not a safety record.
--
-- What matters is that this is said rather than glossed. An earlier version of the
-- Account & Data screen listed reports under "kept, with nothing left that points at
-- you", which was false. It now says what is kept and why, in its own category.
--
-- WHAT SURVIVES AND IS NOT ABOUT THEM
--
--   media_items, media_cache, person_cache, provider_list_cache. Catalogue rows the
--   account happened to be the first to look up. They carry no user reference of any
--   kind and are TMDB's data, not the user's.
--
-- WHAT IS NOT LEFT ORPHANED, CHECKED RATHER THAN ASSUMED
--
--   `account-deletion.test.mjs` sweeps `information_schema` for every foreign key
--   pointing at `profiles` or `auth.users`, deletes a fully-populated account, and
--   fails if any row survives in a table whose rule is CASCADE. A table added later
--   without a delete rule fails that test rather than silently retaining somebody.
--
-- THE CONFIRMATION
--
-- The caller must pass their own handle. A yes/no dialog is a mistap; typing the
-- handle is not, and it is the one string that is both known to the user and specific
-- to the account. Compared case-insensitively because `username` is `citext` and the
-- keyboard capitalises.
--
-- IDEMPOTENCY WITHOUT AN OPERATION ID
--
-- `_claim_operation` cannot help here: it writes to `processed_operations`, which this
-- very operation deletes by cascade, so the claim is destroyed by the thing it was
-- meant to make repeatable. The natural guard is stronger — a second call finds no
-- profile and returns `already_applied` without touching anything. That is tested.
--
-- NOT `assert_can_write`
--
-- A suspended account may delete itself. Suspension is a moderation state about what
-- somebody may do *to other people*; erasure is not that, and refusing it would mean
-- the accounts most likely to want out are the ones that cannot leave. Deliberate, and
-- the only writer in this schema that skips the guard.
-- ===========================================================================

create or replace function delete_account(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_username citext;
  v_avatars  integer := 0;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  select p.username into v_username from profiles p where p.id = v_user;

  -- Already gone. Not an error: a retry after a dropped response must not report a
  -- failure for an account that no longer exists. Nothing is deleted on this path,
  -- including the auth user -- an authenticated caller with no profile is mid-signup,
  -- and `create_profile` owns that state.
  if v_username is null then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if lower(btrim(coalesce(p_confirmation, ''))) is distinct from lower(v_username::text) then
    raise exception 'type your username to confirm' using errcode = '22023';
  end if;

  -- The metadata rows, as the second of the two steps described in the header. The
  -- client has already asked the Storage API to remove the objects themselves, which
  -- is the step that removes bytes; this is what makes the deletion correct when that
  -- request failed after the confirmation, and it is what keeps the
  -- `delete from auth.users` below possible — 20260813002200 names `storage.objects`
  -- as its likely blocker.
  --
  -- The count returned is rows removed *here*, so it is normally zero on the happy
  -- path and non-zero exactly when the client's request did not land. It is reported
  -- rather than swallowed for that reason.
  --
  -- Guarded, because the storage schema is Supabase's rather than ours and the test
  -- harness has none. On a database without it this is inert rather than fatal.
  if to_regclass('storage.objects') is not null then
    execute format(
      'delete from storage.objects
        where bucket_id = %L
          and (storage.foldername(name))[1] = %L',
      'avatars', v_user::text
    );
    get diagnostics v_avatars = row_count;
  end if;

  -- The whole deletion. Everything in the inventory above follows from this one
  -- statement through foreign keys that were each given a deliberate rule.
  --
  -- Raised rather than swallowed, for the reason `create_profile` gives about the age
  -- gate: returning success when the delete did not happen would tell somebody we
  -- removed their account while keeping it, and that is the one statement this
  -- function must never make falsely.
  begin
    delete from auth.users where id = v_user;
  exception when others then
    raise exception 'account deletion failed: %', sqlerrm using errcode = 'P0001';
  end;

  if exists (select 1 from profiles where id = v_user) then
    raise exception 'account deletion did not remove the profile' using errcode = 'P0001';
  end if;

  return jsonb_build_object('status', 'ok', 'avatar_rows_swept', v_avatars);
end;
$$;

comment on function delete_account(text) is
  'Permanently deletes the caller''s account. Sweeps any remaining avatar metadata rows -- the objects themselves are removed by the client through the Storage API, because a SQL delete leaves the file orphaned -- then deletes the auth user, from which every cascade in the schema follows. Requires the caller''s own handle as confirmation. Deliberately does not call assert_can_write: a suspended account may still leave. Idempotent by nature rather than by operation id, because the ledger that would record the claim is deleted by the operation itself. Moderation reports and actions are retained and are not anonymous, so that a reported account cannot erase the record by closing itself. The full inventory is in the header of 20260817000600.';

-- ===========================================================================
-- 6. An avatar path may not nest
--
-- Independent review 14c. `set_avatar` has always validated the pointer as
-- `{uuid}/<filename>` — one segment, no slash — but the *storage* insert policy in
-- 20260815030000 checks only `(storage.foldername(name))[1] = auth.uid()::text`. The
-- two rules were meant to say the same thing in the two places they are enforced by
-- different subsystems, and they did not: a modified client could write
-- `{uuid}/nested/file.jpg`, which the profile column would never point at and which
-- nothing in the app would ever render — but which would sit in a public bucket, and
-- which the deletion sweep would see only as a folder entry.
--
-- So the policy is narrowed to what `set_avatar` already required. The regex is the
-- same shape: the caller's own uuid, one slash, and a filename that cannot contain
-- another. `storage.foldername` is left out of it deliberately — the whole failure was
-- that asking about the first segment says nothing about the rest.
--
-- The client half is `deleteAllAvatars`, which now refuses to report success when it
-- meets anything that is not a plain object. This closes the door; that one is honest
-- about whatever came through it before.
-- ===========================================================================

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'no storage schema; skipping the avatars path narrowing';
    return;
  end if;

  drop policy if exists avatars_insert on storage.objects;
  drop policy if exists avatars_update on storage.objects;

  create policy avatars_insert on storage.objects for insert
    with check (
      bucket_id = 'avatars'
      and auth.uid() is not null
      and name ~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]{1,80}$')
    );

  -- Present so overwriting one's own avatar at a stable path works. The client does
  -- not do that -- it writes a fresh name each time so the CDN cannot keep serving the
  -- previous face -- but a policy set that forbids update while allowing insert and
  -- delete is a trap for the next person. Narrowed alongside insert, or the same
  -- nested path could arrive by renaming into it.
  create policy avatars_update on storage.objects for update
    using (
      bucket_id = 'avatars'
      and name ~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]{1,80}$')
    )
    with check (
      bucket_id = 'avatars'
      and name ~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]{1,80}$')
    );

  -- `avatars_delete` is deliberately **not** narrowed. It is the policy that lets an
  -- account remove its own objects, and an object that predates this narrowing must
  -- stay removable by the person it belongs to. Keying it on the first segment is
  -- correct there for exactly the reason it was wrong above.
end;
$$;

-- ===========================================================================
-- 7. Privileges
--
-- Explicit, following the convention in data-model.md: the allow-list is the artefact
-- that gets reviewed, and a function whose grants are implicit is one nobody checks.
-- Postgres grants EXECUTE to PUBLIC on creation, so the revoke does the work.
--
-- `anon` gets none of them. Every one is about the caller's own account and
-- `auth.uid()` is null for a signed-out client, so a grant would buy nothing but a
-- surface.
-- ===========================================================================

revoke execute on function update_profile(uuid, text)                          from public, anon, authenticated;
revoke execute on function change_username(uuid, text)                         from public, anon, authenticated;
revoke execute on function set_profile_visibility(uuid, profile_visibility)    from public, anon, authenticated;
revoke execute on function my_notifications(integer)                           from public, anon, authenticated;
revoke execute on function mark_notifications_read()                           from public, anon, authenticated;
revoke execute on function delete_account(text)                                from public, anon, authenticated;

grant execute on function update_profile(uuid, text)                       to authenticated;
grant execute on function change_username(uuid, text)                      to authenticated;
grant execute on function set_profile_visibility(uuid, profile_visibility) to authenticated;
grant execute on function my_notifications(integer)                        to authenticated;
grant execute on function mark_notifications_read()                        to authenticated;
grant execute on function delete_account(text)                             to authenticated;

insert into app_config (key, value)
values ('profile.max_edits_per_day', '20'::jsonb)
on conflict (key) do nothing;
