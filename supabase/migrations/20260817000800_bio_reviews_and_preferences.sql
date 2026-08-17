-- A bio, a profile edit that is one operation, Bingd Reviews, and preferences that
-- actually do something.
-- Specification: founder acceptance corrections 2026-08-17, items 4, 8, 9, 10.
--
-- ===========================================================================
-- 1. A bio, which is the founder's subheading concept as real data
--
-- The profile has had a blank where a bio goes since the header was redesigned, and
-- before that it had a hardcoded "Movie and TV collector" — a phrase nobody wrote,
-- sitting in the place a phrase somebody wrote belongs. It was removed rather than
-- kept, and Phase F declined to add the column because a free-text field on a public
-- page is a moderation surface rather than a column.
--
-- It is a moderation surface, and Bingd already has the parts. `reports` takes a
-- `profile` subject; `assert_can_write` stops a suspended account editing anything;
-- `can_view_profile` decides who can read the row it sits on. Nothing new is needed
-- for it to be reportable and nothing new is needed for it to be hidden — which is
-- exactly the test the founder set, and it passes.
--
-- WHY 120 CHARACTERS
--
-- The founder's words are "a short line about you and your taste", and the display
-- position is one line under the handle on a profile header. A limit that permits a
-- paragraph would make the header a paragraph. It is enforced here as well as in the
-- client for the reason `display_name` is: the client's cap is a courtesy and this one
-- is the rule.
--
-- Control characters are refused for the same reason `display_name` refuses them: this
-- renders in a fixed-height header, and a newline turns one line into three.
-- ===========================================================================

alter table profiles add column bio text;

alter table profiles
  add constraint bio_shape
  check (bio is null
         or (char_length(bio) between 1 and 120 and bio !~ '[[:cntrl:]]'));

comment on column profiles.bio is
  'A short line the account wrote about itself, up to 120 characters on one line. Null rather than empty when unset -- the header renders nothing at all, and '''' would be a line of no height that still moves everything below it. Public in the same sense the display name is: readable wherever can_view_profile admits the row, and reportable as a `profile` subject.';

-- The projection in api.md §12. Recreated rather than altered because a view's column
-- list is fixed at creation; `security_invoker` must be carried over or the view starts
-- running as its owner and publishes every private account.
drop view if exists public_profiles;

create view public_profiles with (security_invoker = true) as
select id, username, display_name, bio, avatar_path, visibility, created_at
  from profiles
 where status = 'active';

-- ===========================================================================
-- 2. One profile edit rather than three
--
-- `update_profile` and `change_username` shipped in `20260817000600` as separate
-- writers, and the Edit Profile screen had a Save button for the name and another
-- control for the handle. The founder's correction is that this exposes the seam: a
-- reader thinks of "my profile" as one thing, and a screen with two saves can leave
-- the name written and the handle refused, which is a half-saved profile the user has
-- to reason about.
--
-- So one function, one transaction. Everything succeeds or nothing does — which
-- matters most for the case that actually fails: the handle is taken, and the name and
-- bio must not already be committed when the caller is told.
--
-- WHAT REPLACES WHAT
--
-- `update_profile(uuid, text)` and `change_username(uuid, text)` are **dropped**, not
-- left as overloads. PostgREST resolves an RPC by the argument names in the body, and
-- two candidates whose argument sets nest resolve ambiguously — the trap
-- `20260816000000` records for the note writers and `20260817000200` records for
-- `_assert_operation_rate`. Their grants go with them.
--
-- Null means "leave this alone", which is what lets a caller change one field without
-- restating the others. Clearing the bio is therefore not expressible as null and is
-- expressed as `''` — the only place in this schema where an empty string means
-- something, and it means it because the alternative is a fourth parameter whose only
-- job is to say "yes, really null".
--
-- The cooldown applies **only when the handle actually changes**, which is carried over
-- from `change_username` and matters more here: a caller saving a new bio must not be
-- refused because they renamed themselves a fortnight ago.
-- ===========================================================================

drop function if exists update_profile(uuid, text);
drop function if exists change_username(uuid, text);

create or replace function save_profile(
  p_operation_id  uuid,
  p_display_name  text default null,
  p_username      text default null,
  p_bio           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name    text;
  v_handle  text;
  v_bio     text;
  v_current citext;
  v_changed timestamptz;
  v_days    integer;
  v_renamed boolean := false;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'save_profile') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_operation_rate('save_profile', 'profile.max_edits_per_day', 20);

  -- The whole row, locked, before anything is read from it. Carried over from
  -- `change_username`, where independent review 14 found that reading the cooldown and
  -- writing the row in separate statements let two calls each perform a "first" rename.
  -- It now also serialises this against `set_profile_visibility`, which takes the same
  -- lock on the same row.
  select p.username, p.username_changed_at into v_current, v_changed
    from profiles p where p.id = auth.uid()
    for update;

  if v_current is null then
    raise exception 'no profile to update' using errcode = '42704';
  end if;

  -- ---- the display name -------------------------------------------------
  if p_display_name is not null then
    v_name := btrim(p_display_name);
    if char_length(v_name) < 1 or char_length(v_name) > 50 or v_name ~ '[[:cntrl:]]' then
      raise exception 'display name must be 1 to 50 characters, on one line'
        using errcode = '22023';
    end if;
  end if;

  -- ---- the bio ----------------------------------------------------------
  -- Trimmed first, so a line of spaces clears it rather than storing whitespace that
  -- the header would render as an empty row.
  if p_bio is not null then
    v_bio := btrim(p_bio);
    if v_bio = '' then
      v_bio := null;
    elsif char_length(v_bio) > 120 or v_bio ~ '[[:cntrl:]]' then
      raise exception 'bio must be 120 characters or fewer, on one line'
        using errcode = '22023';
    end if;
  end if;

  -- ---- the handle -------------------------------------------------------
  if p_username is not null then
    v_handle := lower(btrim(p_username));

    if v_handle !~ '^[a-z0-9_]{3,24}$' then
      raise exception 'username must be 3 to 24 characters, lowercase letters, numbers, or underscores'
        using errcode = '22023';
    end if;

    -- Not a rename. Somebody saving a new bio without touching their handle sends the
    -- handle they already have, and must not be charged a cooldown for it.
    if v_current = v_handle::citext then
      v_handle := null;
    else
      v_renamed := true;

      select coalesce((value)::integer, 30) into v_days
        from app_config where key = 'username.change_cooldown_days';
      v_days := coalesce(v_days, 30);

      if v_changed is not null and v_changed > now() - make_interval(days => v_days) then
        raise exception 'you can change your username again after %',
          to_char(v_changed + make_interval(days => v_days), 'DD Mon YYYY')
          using errcode = '53400';
      end if;
    end if;
  end if;

  -- One statement, so the transaction is the atomicity rather than an ordering
  -- somebody has to keep right. A handle that is taken raises here — from the unique
  -- index or from `assert_username_available`, both 23505 — and the name and bio go
  -- back with it, which is the entire reason this is one function.
  update profiles
     set display_name = coalesce(v_name, display_name),
         -- `p_bio is not null` rather than `v_bio is not null`: the caller sending ''
         -- means "clear it", and `coalesce` cannot express that.
         bio          = case when p_bio is null then bio else v_bio end,
         username     = coalesce(v_handle::citext, username)
   where id = auth.uid();

  return jsonb_build_object(
    'status', 'ok',
    'renamed', v_renamed,
    'username', coalesce(v_handle, v_current::text)
  );
end;
$$;

comment on function save_profile(uuid, text, text, text) is
  'The whole editable profile in one transaction: display name, handle and bio. Replaces update_profile and change_username, which are dropped rather than overloaded because PostgREST resolves by argument name and nesting argument sets resolve ambiguously. Null leaves a field alone; '''' clears the bio. The 30-day cooldown applies only when the handle actually changes, so saving a bio is never refused for a rename a fortnight ago. Takes the profile row for update, which serialises it against itself and against set_profile_visibility.';

-- ===========================================================================
-- 3. Bingd Reviews
--
-- The founder's correction: the Reviews tab on a title should be **Bingd's own social
-- surface**, not TMDB's. TMDB's review endpoint is user-generated content from another
-- site's members, and the one thing it must never be is relabelled as professional or
-- critic content — so rather than dress it up, it leaves the primary title UX and
-- Bingd's own public Notes take the tab.
--
-- **No second content model.** A review *is* a public Note on that exact canonical
-- movie or season, which is a thing Bingd users already write, already governed by
-- `note_visibility`, already spoiler-flagged, already reportable, and already the same
-- text the Feed shows. One source of truth, which is what the founder asked for
-- explicitly.
--
-- WHAT THIS ADDS OVER `public_notes`
--
-- `public_notes` returns note columns and nothing else, deliberately: widening it to
-- join `profiles` would put a second table's exposure decisions inside a function whose
-- justification is that it projects five columns of one table. The Reviews tab needs
-- three more facts, and none of them belongs in that function:
--
--   the author's identity     to draw a row and route to their profile
--   the author's Bingd score  because a review without the score is half the opinion
--   how many people reacted   because "Top" has to be sorted by something real
--
-- So this is its own function with its own justification, and it reuses `public_notes`'
-- visibility predicate verbatim — `can_view_profile(auth.uid(), author)` — rather than
-- inventing a second one. Getting that wrong is how a private account's writing leaks,
-- and there is exactly one correct expression of it in this schema.
--
-- WHERE THE SCORE COMES FROM
--
-- Live rankings, through `band_bounds` and `score_for`, which is what `community_score`
-- does. **Not** `feed_events.payload.score`, which is a snapshot taken when the ranking
-- happened and drifts every time the author ranks anything else — the same reason the
-- founder ruled snapshots out for Taste Match.
--
-- A note with no ranking behind it returns a null score rather than being dropped. The
-- two are separate actions: somebody can write a note on a title they logged without
-- ranking, and refusing to show their words because there is no number would be the
-- wrong way round.
--
-- WHERE THE REACTION COUNT COMES FROM
--
-- `reactions` on the author's own `title_ranked` feed event for that title. That is the
-- only interaction model in this schema that safely supports it — the founder's
-- wording — and it is a real signal rather than an invented one. It is **not** a
-- reaction to the note: a reader reacting to somebody's activity is reacting to the
-- ranking and whatever they wrote about it, which is the same object.
--
-- No reviewer reputation, no weighting by follower count, no decay curve. The founder
-- ruled reputation out and it would be unfalsifiable anyway.
--
-- SORTING
--
-- `top` is reactions descending, then recency, then a stable tiebreak on the media and
-- user ids so the same call twice returns the same order. `recent` is recency alone.
-- The tiebreak matters more than it looks: without it two notes with no reactions and
-- the same timestamp swap places between calls, and a list that reorders under a reader
-- who has not moved reads as broken.
-- ===========================================================================

create or replace function title_reviews(
  p_media_item_id uuid,
  p_sort          text default 'top',
  p_limit         integer default 25
)
returns table (
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  note           text,
  has_spoilers   boolean,
  updated_at     timestamptz,
  score          numeric,
  reaction_count integer
)
language sql stable security definer
set search_path = public
as $$
  select um.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         um.note,
         um.note_has_spoilers,
         um.note_updated_at,
         -- Null when they wrote a note without ranking it, which is a real state.
         (select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)
            from rankings r
            join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
           where r.user_id = um.user_id
             and r.media_item_id = um.media_item_id),
         coalesce((
           select count(*)::integer
             from feed_events fe
             join reactions re on re.feed_event_id = fe.id
            where fe.actor_id = um.user_id
              and fe.media_item_id = um.media_item_id
              and fe.type = 'title_ranked'
         ), 0)
    from user_media um
    join profiles p on p.id = um.user_id
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     -- The same predicate `public_notes` uses, and deliberately the same expression:
     -- suspension, blocks, private accounts and approved follows in one place.
     and can_view_profile(auth.uid(), um.user_id)
   order by
     case when p_sort = 'top' then coalesce((
       select count(*)
         from feed_events fe
         join reactions re on re.feed_event_id = fe.id
        where fe.actor_id = um.user_id
          and fe.media_item_id = um.media_item_id
          and fe.type = 'title_ranked'
     ), 0) end desc nulls last,
     um.note_updated_at desc nulls last,
     -- Stable, so two calls with the same data return the same order. Without it two
     -- unreacted notes with equal timestamps swap places and the list reorders under a
     -- reader who has not moved.
     um.user_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

comment on function title_reviews(uuid, text, integer) is
  'The Bingd Reviews tab for one title: every public Note on it the caller may read, with the author named, their live Bingd score, and how many people reacted to the activity it belongs to. Not a second content model -- a review is a public Note, which is the same text the Feed shows. Reuses public_notes'' visibility predicate verbatim. Sorted by reactions then recency for `top`, recency alone for `recent`, with a stable tiebreak either way. The score is derived from live rankings rather than from the feed event''s snapshot, which drifts.';

-- ===========================================================================
-- 4. Notification preferences that alter behaviour
--
-- `notification_preferences` has existed since `20260813000900` — a row per account per
-- category, absent meaning enabled — and **nothing has ever read it**. Phase F declined
-- to build a settings screen over it for exactly that reason: a switch that changes
-- nothing is worse than no switch.
--
-- The founder's correction is to make them real rather than to keep hiding them. So the
-- six writers consult a preference, and there are two categories because there are two
-- kinds of thing in this inbox:
--
--   social   a reaction, a comment, a companion tag. News about your activity.
--   follows  somebody followed you; somebody approved your request.
--
-- WHY `follow_request` IS NOT IN EITHER
--
-- It is not news, it is a **task**. A private account with follow notifications off
-- would receive requests it could never see and could never answer, and the request
-- would sit pending for ever with both parties believing the other had done something.
-- The one control this schema must not offer is the one that makes a person
-- unreachable by somebody they are deliberately keeping out. `follow_request` is
-- therefore always written, and the settings screen says so in as many words rather
-- than leaving a reader to discover the exception.
--
-- WHY A HELPER RATHER THAN A CHECK IN EACH WRITER
--
-- Six call sites, one rule, and the rule is easy to get backwards: **absent means
-- enabled**, so the test is `not exists(... and enabled = false)` and not
-- `exists(... and enabled = true)`. Written once, it can only be wrong once.
-- ===========================================================================

create or replace function _notifies(p_recipient uuid, p_category text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select not exists (
    select 1 from notification_preferences np
     where np.user_id = p_recipient
       and np.category = p_category
       and np.enabled = false
  );
$$;

comment on function _notifies(uuid, text) is
  'Whether a recipient still wants notifications of one category. Absent means enabled, which is what notification_preferences has meant since 20260813000900 and is why this is a `not exists` over a false row rather than an `exists` over a true one. Internal: it answers a question about a named third party''s settings.';

create or replace function set_notification_preference(p_category text, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  -- A closed set, checked here rather than by a constraint, because the useful failure
  -- is "that is not a category" and a 23514 says only "a check failed". The two values
  -- are the two the screen offers and the two the writers consult; a third would be a
  -- row nothing reads, which is the state this whole section exists to end.
  if p_category not in ('social', 'follows') then
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
  'Turns one notification category on or off for the caller. Two categories: `social` (reactions, comments, companion tags) and `follows` (somebody followed you, somebody approved your request). Deliberately cannot silence `follow_request`, which is a task rather than news -- a private account that could would receive requests it could never answer.';

create or replace function my_notification_preferences()
returns table (category text, enabled boolean)
language sql stable security definer
set search_path = public
as $$
  select c.category,
         coalesce(np.enabled, true)
    from (values ('social'), ('follows')) as c(category)
    left join notification_preferences np
           on np.user_id = auth.uid()
          and np.category = c.category;
$$;

comment on function my_notification_preferences() is
  'The caller''s own two notification switches, defaulted to on for a category with no row -- which is what absence has meant since 20260813000900. Returns both categories always, so the screen renders from this rather than assembling defaults itself and getting the absent case wrong.';

-- ---------------------------------------------------------------------------
-- Enforced at the table, not in five writers
--
-- The obvious implementation is a condition inside `set_reaction`, `add_comment`,
-- `set_watch_tags`, `follow` and `respond_follow_request`. It was written that way
-- first and abandoned, and the reason is worth recording because it is the same hazard
-- 20260817000200 names.
--
-- `create or replace` in a schema with a history means reproducing the whole function
-- body, and the body is not in the migration being edited -- it is two or three
-- migrations back. Reproducing five of them by hand introduced two errors in the very
-- first one: the rate-limit config key came out as `reaction.max_per_day` instead of
-- `reactions.max_per_day`, which silently falls back to a default, and the reaction
-- vocabulary came out as the wrong four values, which would have rejected three valid
-- kinds. Neither shows up in a diff against the previous migration. That is exactly how
-- `_assert_operation_rate` lost its advisory lock.
--
-- A trigger on the table needs none of that. One rule, one place, and it covers every
-- writer including ones not written yet -- which matters, because the next person to add
-- a notification type will not think to consult a preference.
--
-- WHY SILENTLY DROPPING THE ROW IS RIGHT HERE
--
-- A `before insert` trigger returning null is normally a thing to be suspicious of: it
-- makes a write vanish while the caller believes it succeeded. Here that *is* the
-- semantic. "Do not notify me about reactions" means the reaction still happens, the
-- reactor is still told their reaction landed, and no inbox row appears. Raising would
-- fail the reaction; returning the row would ignore the setting.
--
-- WHY follow_request IS EXEMPT AT THE TRIGGER
--
-- Stated as its own condition rather than left to the category map, so it cannot be
-- lost by somebody editing the map. A request is a task, not news: an account that
-- could silence it would receive requests it can never see and never answer, and the
-- requester would wait for ever. It is the one control this schema must not offer.
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
    when 'reaction'        then 'social'
    when 'comment'         then 'social'
    when 'watch_tag'       then 'social'
    when 'follow'          then 'follows'
    when 'follow_approved' then 'follows'
  end;

  -- An unmapped type is delivered rather than dropped. A notification kind added later
  -- and forgotten here should reach its recipient, not vanish -- the failure mode of the
  -- other default is silent and undetectable.
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
  'Drops an inbox row whose recipient has switched its category off. A before-insert trigger rather than a condition in each of the five writers, because reproducing five function bodies from three earlier migrations is how a create-or-replace loses something invisibly -- the first attempt at that got the rate-limit config key and the reaction vocabulary wrong. Delivers follow_request always, and any unmapped type always.';

drop trigger if exists notifications_respect_preference on notifications;

create trigger notifications_respect_preference
  before insert on notifications
  for each row execute function _apply_notification_preference();

-- ===========================================================================
-- 5. Privileges
--
-- Explicit, following the convention in data-model.md: the allow-list is the artefact
-- that gets reviewed. Postgres grants EXECUTE to PUBLIC on creation, so the revoke does
-- the work.
--
-- `_notifies` gets none. It answers a question about a named third party's settings,
-- which is 20260813001900's rule — knowing whether somebody has muted you is not a
-- thing to be able to ask.
--
-- `title_reviews` is not granted to anon, following the rule `public_notes` set: a
-- grant should follow a surface, and there is no signed-out title page.
-- ===========================================================================

revoke execute on function _notifies(uuid, text)                     from public, anon, authenticated;
revoke execute on function _apply_notification_preference()          from public, anon, authenticated;

revoke execute on function save_profile(uuid, text, text, text)      from public, anon, authenticated;
revoke execute on function title_reviews(uuid, text, integer)        from public, anon, authenticated;
revoke execute on function set_notification_preference(text, boolean) from public, anon, authenticated;
revoke execute on function my_notification_preferences()             from public, anon, authenticated;

grant execute on function save_profile(uuid, text, text, text)        to authenticated;
grant execute on function title_reviews(uuid, text, integer)          to authenticated;
grant execute on function set_notification_preference(text, boolean)  to authenticated;
grant execute on function my_notification_preferences()               to authenticated;
