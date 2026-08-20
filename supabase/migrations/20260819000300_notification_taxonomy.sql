-- Notification taxonomy: one category per kind of thing, and defaults that differ.
-- Specification: docs/architecture/data-model.md §7 · AD-10 · PRD §15
--
-- ===========================================================================
-- WHAT THIS CHANGES AND WHY
--
-- `20260817000800` made preferences real by putting a before-insert trigger on
-- `notifications` and giving it **two** categories:
--
--   social   reaction, comment, watch_tag
--   follows  follow, follow_approved
--
-- That was the right shape for two switches. It is the wrong shape for a settings
-- screen, because the two things people actually want to silence are not on either
-- side of that line. Reactions are the highest-volume, lowest-signal event in the
-- app; a comment is somebody talking to you. Bundling them means the only way to
-- stop the first is to stop the second, and `recommendation` was in **neither**
-- category -- the `case` returned null and the trigger's unmapped-type rule
-- delivered it unconditionally, so it could not be silenced at all.
--
-- So the vocabulary becomes eight, one per kind, and the screen groups them.
--
-- ===========================================================================
-- WHAT THIS DOES *NOT* CHANGE: WHAT A PREFERENCE GOVERNS
--
-- A preference governs **in-app row creation**, not delivery. The trigger drops the
-- row before it is written. There is no second channel: push is dark (AD-10),
-- `device_tokens` has no writer on any client, and nothing imports
-- `expo-notifications` beyond the config plugin. **This run does not build push**,
-- and when push arrives it must decide for itself whether these switches govern it
-- too or whether delivery needs its own axis -- a row that was never written cannot
-- be pushed, so the current contract is "off here means it never existed".
--
-- ===========================================================================
-- DEFAULTS ARE A PROPERTY OF THE CATEGORY, NOT OF ABSENCE
--
-- Since `20260813000900` absence has meant enabled, and that is why there is no row
-- per category per signup and no backfill when a category is added. Two of the eight
-- categories want to default **off**, and the cheap way to do that -- write explicit
-- `false` rows at signup -- throws all of that away and needs a backfill besides.
--
-- Instead the default moves into `_notification_default`, and absence means *the
-- category's default*. Six of eight still default true, so for them nothing at all
-- has changed. Nothing writes a row until somebody touches a switch.
--
-- WHY `reactions` DEFAULTS OFF
--   One tap, from anybody who can see the activity, on every event. It is deduped
--   per (reactor, event) for good, so it cannot be re-fired -- but it is still the
--   only event here where the median notification carries no information beyond
--   "somebody saw this".
--
-- WHY `awards` DEFAULTS OFF, AND WHY NOTHING WRITES ONE
--   The type and the category exist; the writer is deferred. Award tiers are
--   computed entirely on the client from raw table reads (`src/features/awards`),
--   and no server-side state records which tier an account has reached. Notifying
--   only on a crossing therefore needs a durable unlock ledger, which this run is
--   told not to build. See `.agent-workflow/continuation.md`.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The vocabulary, in one place
--
-- A function rather than an enum or a check constraint, for the reason
-- `set_notification_preference` already gives: the useful failure is "that is not a
-- category", and a 23514 says only "a check failed". Having it in one place is what
-- lets the single-row writer, the bulk writer and the reader agree by construction
-- rather than by three lists kept in step.
-- ---------------------------------------------------------------------------

create or replace function _notification_categories()
returns text[]
language sql immutable
set search_path = public
as $$
  select array[
    'follows',          -- somebody started following you
    'follow_accepted',  -- somebody approved your request
    'comments',         -- somebody commented on your activity
    'reactions',        -- somebody reacted to your activity
    'watch_tags',       -- somebody tagged you as having watched with them
    'recommendations',  -- somebody recommended you a title
    'invites',          -- somebody you invited joined
    'awards'            -- you crossed an award tier
  ]::text[];
$$;

comment on function _notification_categories() is
  'The eight notification categories, in one place so the two writers and the reader cannot disagree. Internal.';

create or replace function _notification_default(p_category text)
returns boolean
language sql immutable
set search_path = public
as $$
  -- Absence means *this*, rather than meaning true. Only two are false, and both are
  -- named here rather than inferred, so adding a category defaults it on by omission
  -- -- which is the safe direction: a notification that arrives unwanted is a setting
  -- somebody turns off, and one that never arrives is a bug nobody can see.
  select case p_category
    when 'reactions' then false
    when 'awards'    then false
    else true
  end;
$$;

comment on function _notification_default(text) is
  'What a category means when the account has no row for it. Six of eight are true, which is what absence has meant since 20260813000900; reactions and awards are false. Internal.';

-- ---------------------------------------------------------------------------
-- 2. Carrying the old two categories forward
--
-- Only `enabled = false` rows are expanded, and the reasoning matters.
--
-- Under the old semantics absence *also* meant enabled, so an `enabled = true` row
-- was indistinguishable from no row at all: it carried no information and is not
-- evidence that anybody chose anything. Expanding it would manufacture a deliberate
-- `reactions = true` out of silence, and then a pre-existing account would keep
-- reactions on while a new one defaults off -- a difference with no cause behind it.
--
-- A `false` row is unambiguous: under the old semantics that could only have been
-- written on purpose. Those are expanded to every child of their old category, so
-- nobody who switched something off has it switched back on by this migration.
--
-- In practice this moves nothing. No client has ever called
-- `set_notification_preference` -- the settings screen this migration exists to
-- support is the first caller -- so the table is empty. It is written to be correct
-- rather than to be exercised.
-- ---------------------------------------------------------------------------

insert into notification_preferences (user_id, category, enabled)
select np.user_id, c.category, false
  from notification_preferences np
  cross join lateral (values ('comments'), ('reactions'), ('watch_tags')) as c(category)
 where np.category = 'social'
   and np.enabled = false
on conflict (user_id, category) do nothing;

insert into notification_preferences (user_id, category, enabled)
select np.user_id, 'follow_accepted', false
  from notification_preferences np
 where np.category = 'follows'
   and np.enabled = false
on conflict (user_id, category) do nothing;

-- `follows` survives under its own name and keeps its meaning (somebody followed
-- you), so only `social` is retired. Uninformative `true` rows go with it.
delete from notification_preferences
 where category = 'social'
    or (category = 'follows' and enabled = true);

-- ---------------------------------------------------------------------------
-- 3. Reading a preference
--
-- Same signature, same callers, one changed rule: absence resolves to the category
-- default instead of to true. `not exists (... enabled = false)` cannot express
-- that, so this is now a `coalesce` over the row's own value.
-- ---------------------------------------------------------------------------

create or replace function _notifies(p_recipient uuid, p_category text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select np.enabled
       from notification_preferences np
      where np.user_id = p_recipient
        and np.category = p_category),
    _notification_default(p_category)
  );
$$;

comment on function _notifies(uuid, text) is
  'Whether a recipient still wants notifications of one category. Absence resolves to the category default (_notification_default) rather than to true, which is how reactions and awards default off without a row per account. Internal: it answers a question about a named third party''s settings.';

-- ---------------------------------------------------------------------------
-- 4. The trigger learns the new map
--
-- Still a trigger rather than a condition in each writer, for the reason
-- `20260817000800` records at length: reproducing seven function bodies from four
-- earlier migrations by hand is how a `create or replace` loses something invisibly,
-- and it already cost that migration a rate-limit config key and a reaction
-- vocabulary on the first attempt.
--
-- Two changes beyond the renames:
--
--   `recommendation`   was unmapped, and therefore unsilenceable by accident rather
--                      than by decision. It now has a category.
--   `invite_activated` and `award_earned` are mapped ahead of their writers, so the
--                      switch is already honoured on the day one lands rather than
--                      being a thing somebody must remember to come back for.
--
-- `follow_request` stays exempt, stated as its own condition so it cannot be lost by
-- somebody editing the map. It is a task, not news: an account that could silence it
-- would receive requests it can never see and never answer, and the requester would
-- wait for ever.
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
  -- A request is always delivered. See above.
  if new.type = 'follow_request' then
    return new;
  end if;

  v_category := case new.type
    when 'follow'           then 'follows'
    when 'follow_approved'  then 'follow_accepted'
    when 'comment'          then 'comments'
    when 'reaction'         then 'reactions'
    when 'watch_tag'        then 'watch_tags'
    when 'recommendation'   then 'recommendations'
    when 'invite_activated' then 'invites'
    when 'award_earned'     then 'awards'
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
  'Drops an inbox row whose recipient has switched its category off. Eight categories since 20260819000300, one per notification kind. Delivers follow_request always -- a task rather than news -- and any unmapped type always.';

-- ---------------------------------------------------------------------------
-- 5. Writing preferences
--
-- Two writers. The bulk one is not a convenience.
--
-- The settings screen has a master switch per section, and turning a section off has
-- to mean every child in it is off -- deterministically, and after a lost reply as
-- much as after a clean one. Five sequential single-category calls are five chances
-- to end up in a state nobody asked for: three commit, the fourth's response is
-- lost, the reader sees a master that is neither on nor off and children that
-- disagree with it. One statement in one transaction has two outcomes instead of
-- thirty-two, and a retry of it is the same write again (`lib/write-outcome.ts`).
-- ---------------------------------------------------------------------------

create or replace function set_notification_preference(p_category text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not (p_category = any (_notification_categories())) then
    raise exception 'unknown notification category: %', p_category using errcode = '22023';
  end if;

  if p_enabled is null then
    raise exception 'enabled is required' using errcode = '22023';
  end if;

  insert into notification_preferences (user_id, category, enabled)
  values (auth.uid(), p_category, p_enabled)
  on conflict (user_id, category) do update set enabled = excluded.enabled;

  return jsonb_build_object('status', 'ok', 'category', p_category, 'enabled', p_enabled);
end;
$$;

comment on function set_notification_preference(text, boolean) is
  'Turns one notification category on or off for the caller. Eight categories (_notification_categories). Deliberately cannot silence follow_request, which is a task rather than news -- a private account that could would receive requests it could never answer.';

create or replace function set_notification_preferences(p_categories text[], p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unknown text;
begin
  perform assert_can_write();

  if p_categories is null or array_length(p_categories, 1) is null then
    raise exception 'at least one category is required' using errcode = '22023';
  end if;

  if p_enabled is null then
    raise exception 'enabled is required' using errcode = '22023';
  end if;

  -- A null element is rejected first, and separately, because `not (null = any (...))`
  -- is **null rather than true** -- so a null would pass straight through the unknown
  -- check below and fail later on the table's own not-null constraint. That rolls back
  -- and writes nothing, so it was never a correctness hole, but it answers 23502
  -- instead of 22023: an incidental database error where this function promised a
  -- statement about the input. Independent review 23 found it.
  if exists (select 1 from unnest(p_categories) as c where c is null) then
    raise exception 'a category may not be null' using errcode = '22023';
  end if;

  -- Every category is checked before any row is written. A partially applied master
  -- switch is exactly the state this function exists to make impossible, and
  -- validating inside the insert would apply the valid prefix before raising.
  select c into v_unknown
    from unnest(p_categories) as c
   where not (c = any (_notification_categories()))
   limit 1;

  if v_unknown is not null then
    raise exception 'unknown notification category: %', v_unknown using errcode = '22023';
  end if;

  -- `distinct`, because `on conflict do update` cannot touch one row twice in a single
  -- statement -- a repeated category would raise 21000 "cannot affect row a second
  -- time". A master switch sending its own section twice is a caller bug and not
  -- something to fail on: every copy asks for the same value, so collapsing them is
  -- the same write. Also review 23.
  insert into notification_preferences (user_id, category, enabled)
  select distinct auth.uid(), c, p_enabled
    from unnest(p_categories) as c
  on conflict (user_id, category) do update set enabled = excluded.enabled;

  return jsonb_build_object(
    'status', 'ok',
    'categories', to_jsonb(p_categories),
    'enabled', p_enabled
  );
end;
$$;

comment on function set_notification_preferences(text[], boolean) is
  'Sets several notification categories to the same value in one transaction, which is what a section master switch is. All-or-nothing: an unknown category raises before any row is written, so a master switch cannot apply to half its section. Idempotent -- the same call twice is the same state.';

-- ---------------------------------------------------------------------------
-- 6. Reading your own
--
-- Same signature and same return type, so `create or replace` rather than a drop:
-- what changes is that it returns eight rows instead of two, each defaulted by its
-- own category rather than by a literal `true`. The screen still renders from this
-- rather than assembling defaults itself, which is the point -- a default written
-- twice is a default that disagrees with itself.
-- ---------------------------------------------------------------------------

create or replace function my_notification_preferences()
returns table (category text, enabled boolean)
language sql stable security definer
set search_path = public
as $$
  select c.category,
         coalesce(np.enabled, _notification_default(c.category))
    from unnest(_notification_categories()) as c(category)
    left join notification_preferences np
           on np.user_id = auth.uid()
          and np.category = c.category;
$$;

comment on function my_notification_preferences() is
  'The caller''s own eight notification switches, each defaulted by _notification_default for a category with no row. Returns every category always, so the screen renders from this rather than assembling defaults itself and getting the absent case wrong.';

-- ---------------------------------------------------------------------------
-- 7. The inbox stops naming somebody who has since been blocked
--
-- Independent review 23b. Every writer that files a notification checks that the actor
-- may reach the recipient *before* it inserts -- `add_comment` through
-- `can_view_profile`, `set_reaction` likewise -- and **none of them holds a pair lock
-- across the gap**. So this interleaving is available:
--
--   1. the actor's transaction passes the visibility check;
--   2. the recipient blocks them; `block()` deletes the notifications that exist
--      (20260817000200) and commits;
--   3. the actor's transaction inserts its notification and commits.
--
-- The delete ran before the row existed, so the row survives, and `my_notifications`
-- required only that the actor still be `active`. The recipient's inbox then names a
-- person they have just blocked, with their handle and avatar, and the routing added
-- this run sends a tap to their profile.
--
-- WHY THIS IS FIXED ON THE READ SIDE
--
-- The write-side fix is a pair lock in every writer that files a notification, which
-- means reproducing five function bodies from four earlier migrations — the precise
-- hazard `20260817000800`'s header records, and the one that cost it a rate-limit
-- config key and a reaction vocabulary on its first attempt. It would also have to be
-- repeated by whoever adds the next writer.
--
-- One predicate on the read covers every writer, including the ones not written yet,
-- and it closes the window rather than narrowing it: however the row got there, it
-- stops being shown the moment the block exists.
--
-- WHY `can_discover_profile` AND NOT `can_view_profile`
--
-- This is the distinction `20260819000100` exists to draw. `can_view_profile` would
-- hide a **private account's follow request** — a private account asking to follow a
-- private account fails it, which is the stated reason this function is definer at all
-- — and the request would sit pending for ever with both parties waiting on the other.
-- `can_discover_profile` is false only for a block in either direction and for
-- suspension, which is exactly the set that should vanish, and it leaves every private
-- requester reachable.
--
-- An actorless row is untouched: it has nobody to be blocked.
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
  series_title       text
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
         parent.title
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
  'The caller''s own inbox, with the actor named and the subject title resolved. Definer for the same reason my_blocks is: a private account requesting to follow another private account fails can_view_profile, so an invoker query could not draw the one row whose whole purpose is to be answered. Takes no recipient and cannot be asked about anybody else. Filters actors through can_discover_profile since 20260819000300, which closes the check-then-insert race between a writer and a block -- and deliberately not through can_view_profile, which would hide a private account''s follow request and strand it for ever.';

-- The function was re-created rather than altered, and a dropped or replaced function
-- keeps its privileges only because this is `create or replace` on the same signature.
-- Restated anyway, following the convention: the allow-list is the artefact reviewed.
revoke execute on function my_notifications(integer) from public, anon;
grant  execute on function my_notifications(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. `my_notifications` becomes the only way to read an inbox
--
-- Independent review 23c. §7 put the discoverability predicate inside the function,
-- and `notifications_own` still let a client `select` the table itself:
--
--   create policy notifications_own on notifications for select
--     using (recipient_id = auth.uid());
--
-- So the raced-in row was still reachable over PostgREST — `actor_id`, `type`,
-- `subject_id`, `payload`, `created_at` — and a realtime subscription would have
-- carried it too. A predicate in one read path is not a predicate.
--
-- Rather than restate the rule in the policy, the table stops being a client surface.
-- The policy **cannot** call `can_discover_profile`: a policy expression is evaluated
-- with the querying role's privileges, and that function's execute is revoked from
-- `authenticated` because `20260813001900` and review 22 established that a definer
-- helper taking a viewer as an argument is an oracle. Granting it back to satisfy a
-- policy would reopen the hole this migration is closing.
--
-- The precedent is `device_tokens`, which has had no read policy since
-- `20260813000900` on the same reasoning: a client having no reason to read a table is
-- better expressed by not letting it than by describing what it may see.
--
-- `my_notifications` and `mark_notifications_read` are both definer and run as the
-- owner, so neither is affected. Nothing in the app reads this table directly — the
-- inbox has always gone through the RPC — so this removes an access path rather than
-- a feature.
--
-- `notifications_own` is deliberately **kept**. It is unreachable while the grant is
-- gone, and it is the backstop if a later migration re-grants select: the failure then
-- is a cross-account read that is still refused, rather than an open table.
-- ---------------------------------------------------------------------------

revoke select on notifications from anon, authenticated;

comment on table notifications is
  'One person''s inbox. Not a client-readable table since 20260819000300: read it through my_notifications(), which is definer and applies can_discover_profile so a blocked actor cannot be named by a row that raced a block. Written only by definer functions, and gated on insert by _apply_notification_preference.';

-- ---------------------------------------------------------------------------
-- 9. Privileges
--
-- `_notification_categories` and `_notification_default` join `_notifies` and
-- `_apply_notification_preference` on the internal side. The first two are pure and
-- disclose nothing, but the allow-list is the artefact that gets reviewed and an
-- entry there should follow a surface -- no client calls these, so no client may.
-- ---------------------------------------------------------------------------

revoke execute on function _notification_categories()                    from public, anon, authenticated;
revoke execute on function _notification_default(text)                   from public, anon, authenticated;
revoke execute on function _notifies(uuid, text)                         from public, anon, authenticated;
revoke execute on function _apply_notification_preference()              from public, anon, authenticated;

revoke execute on function set_notification_preference(text, boolean)    from public, anon, authenticated;
revoke execute on function set_notification_preferences(text[], boolean)  from public, anon, authenticated;
revoke execute on function my_notification_preferences()                 from public, anon, authenticated;

grant execute on function set_notification_preference(text, boolean)     to authenticated;
grant execute on function set_notification_preferences(text[], boolean)   to authenticated;
grant execute on function my_notification_preferences()                  to authenticated;
