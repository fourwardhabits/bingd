-- Five optional links a profile may carry, and one save that writes them with
-- everything else.
--
-- ===========================================================================
-- 1. Why five columns rather than a list
--
-- The founder's scope is explicit and closed: Instagram, TikTok, YouTube, X, and a
-- website. Not an arbitrary link list, not a creator surface, not a directory of
-- networks that grows by a row at a time.
--
-- A closed set is a set of columns. `bio` is the precedent and it is the right one:
-- a nullable column on `profiles`, shaped by a CHECK constraint, published by
-- `public_profiles`, and writable only through `save_profile`. Everything that is
-- already true of a bio becomes true of these for free — the visibility rule, the
-- suspended-account filter, the absence of an update policy — and none of it has to
-- be restated or kept in step.
--
-- A `jsonb` bag would have been one column instead of five, and it would have cost
-- the thing the column form is bought for: a constraint per network that the
-- database itself enforces, so a value the client failed to normalise cannot be
-- stored. `20260817000800`'s rule for the bio applies unchanged — "the constraint is
-- the rule; the function's check is the message".
--
-- ===========================================================================
-- 2. What is stored
--
-- **A handle for the four networks, not a URL.** `images.ts` stores a poster path
-- rather than a poster URL and `videoUri` stores a YouTube key rather than a watch
-- link, for the same reason in every case: the origin belongs to the deployment or
-- to the provider rather than to the row, and a stored URL is a stored decision that
-- cannot be revised. `x.com` was `twitter.com` eighteen months ago. Rows that had
-- stored the URL would still be pointing at it.
--
-- It is also what keeps the client safe by construction. A handle that matches
-- `social_handle_shape` cannot carry a scheme, a slash, a space, a control character
-- or a host, so the app can build `https://x.com/<handle>` by concatenation and know
-- what it has built. Nothing here is ever handed to `Linking.openURL` as stored.
--
-- **A full URL for the website**, because there is no canonical origin to strip —
-- the origin is the whole of what the person is telling you. So the scheme is
-- constrained instead, and constrained to exactly one: `https://`. That is not a
-- style preference. It is the refusal of `javascript:`, `data:`, `file:` and
-- `intent:` written as a rule the database keeps rather than as a check the client
-- remembers to run.
--
-- ===========================================================================
-- 3. The shapes, and why they are looser than each network's own rule
--
-- Instagram allows 30 characters, X allows 15 and only underscores, TikTok allows a
-- period. The temptation is to encode all of that here. The reason not to is that a
-- constraint which is too tight is the one that breaks a real person: these rules
-- are the networks' to change, they have changed, and a profile save refused with
-- 23514 over a handle its owner is looking at on their own phone is a bug this
-- schema would have written for itself.
--
-- So the constraint is a **safety** shape, not a **validity** shape. It says: this
-- is one path segment, it begins with something real, and it can only ever appear
-- between two slashes in a URL we built. Whether Instagram has actually heard of it
-- is Instagram's business, and the friendlier per-network guidance lives in the form
-- (`features/profile/social-links.ts`), where it can be a hint instead of a refusal.
--
-- The leading-alphanumeric requirement is doing real work rather than tidiness: it
-- refuses `.`, `..` and `-`, which are path segments with meaning rather than names.
-- ===========================================================================

alter table profiles add column link_instagram text;
alter table profiles add column link_tiktok    text;
alter table profiles add column link_youtube   text;
alter table profiles add column link_x         text;
alter table profiles add column link_website   text;

-- One shape for the four handles. Forty characters is past every current limit —
-- the longest of the four is YouTube's thirty — which is the headroom §3 argues for.
alter table profiles
  add constraint social_handle_shape
  check (
    (link_instagram is null or link_instagram ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
    and (link_tiktok  is null or link_tiktok  ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
    and (link_youtube is null or link_youtube ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
    and (link_x       is null or link_x       ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$')
  );

-- `https://` and nothing else, then a host with a dot in it, then optionally
-- anything that is not whitespace or a control character — a port, a path, a query,
-- a fragment. The scheme is matched literally and in lower case because the value
-- arrives normalised; a form that lets `HTTPS://` through is a form that has not
-- normalised, and this is the assertion that says so.
alter table profiles
  add constraint social_website_shape
  check (
    link_website is null
    or (char_length(link_website) between 12 and 200
        and link_website ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}([:/?#][^[:cntrl:][:space:]]*)?$')
  );

comment on column profiles.link_instagram is
  'Instagram handle, no @ and no URL. The app builds https://www.instagram.com/<handle>/. Null until somebody sets one.';
comment on column profiles.link_tiktok is
  'TikTok handle, no @ and no URL. The app builds https://www.tiktok.com/@<handle>.';
comment on column profiles.link_youtube is
  'YouTube handle, no @ and no URL. The app builds https://www.youtube.com/@<handle>. A channel id (UC...) is not a handle and is refused by the form rather than stored here.';
comment on column profiles.link_x is
  'X handle, no @ and no URL. The app builds https://x.com/<handle>. Stored as a handle rather than a URL so the twitter.com -> x.com rename does not strand a row.';
comment on column profiles.link_website is
  'A full https:// URL. The scheme is constrained rather than conventional: this is the refusal of javascript:, data: and file: as a rule the database keeps.';

-- ===========================================================================
-- 4. Published exactly where the bio is published
--
-- Recreated rather than altered, which is what adding a column to a view costs. The
-- two properties that had to survive the last recreation have to survive this one
-- too, and both are asserted in `profile-social-links.test.mjs`: `security_invoker`,
-- so `profiles_read` decides and a private account this viewer may not read does not
-- come back; and the `status = 'active'` filter, so a suspended account is absent.
--
-- **Deliberately not added to `profile_identity`** (`20260819000100`). That function
-- is the locked shell drawn for an account the viewer may *not* read — handle, name,
-- avatar, visibility, so a private profile found in search leads somewhere a follow
-- request can be made from. Links are profile content. Putting them there would make
-- a private account's links readable by anybody who can type the handle, which is
-- exactly the public-data bypass this tranche is not allowed to create.
-- ===========================================================================

drop view if exists public_profiles;

create view public_profiles with (security_invoker = true) as
select id, username, display_name, bio, avatar_path, visibility, created_at,
       link_instagram, link_tiktok, link_youtube, link_x, link_website
  from profiles
 where status = 'active';

-- **The grant, because `drop view` took it.**
--
-- This is the trap `20260817001200_public_profiles_grant.sql` exists to record, and the
-- first draft of this migration walked straight into it. That file is a whole migration
-- written about one line: the view had been dropped and recreated twice without a
-- re-grant, so from 2026-08-15 nothing in the repository stated who could read it, and
-- what a deployed database allowed came down to its default privileges. It worked on
-- bingd-nonprod by luck.
--
-- It cannot be caught locally and that is structural rather than an oversight in the
-- suite: `harness.mjs` builds the schema from these files and runs as the table owner,
-- for whom a grant to `anon` is a question that never arises. Only a deployed probe sees
-- it, which is what `test:remote` is for — so this line is the guard, and the assertion
-- lives at the other end.
--
-- `service_role` is deliberately absent, matching `20260813001400` and `20260817001200`:
-- restoring what the drop took is the whole job, and widening the grant while restoring
-- it would be a change wearing a repair's clothes.
grant select on public_profiles to anon, authenticated;

comment on view public_profiles is
  'Every profile a caller may see -- bio and the five optional links included -- resolved through can_view_profile as a security_invoker view. Read by the public profile route and by user search. Recreated by 20260921000100 to add link_instagram, link_tiktok, link_youtube, link_x and link_website; the select grant is reissued in the same migration, because a drop takes it and 20260817001200 is the file that records what that costs. The links are deliberately NOT on profile_identity, which is what a viewer who may not read the account gets.';

-- ===========================================================================
-- 5. One save, still
--
-- `save_profile` gains five parameters and is **dropped and recreated** rather than
-- overloaded. `20260817000800` records the reason at length and it has not changed:
-- PostgREST resolves an RPC by the argument names in the body, and two candidates
-- whose argument sets nest resolve ambiguously. The old signature has to stop
-- existing for the new one to be reachable.
--
-- The null/'' convention carries over unchanged, because a second convention for
-- five fields sitting beside three that use the first one is how a form ends up
-- clearing a bio it meant to leave alone. Null leaves a field as it is; '' clears
-- it. That is the whole of it, and it is why the screen can go on sending only what
-- the person actually edited.
--
-- **The five are not rate-limit-distinct and not cooldown-distinct.** They ride the
-- same `profile.max_edits_per_day` budget and the same row lock as the name and the
-- bio, and none of them is a rename, so `v_renamed` is untouched: adding an
-- Instagram handle must not cost somebody the thirty days they were saving for a
-- handle change. That is the same rule `20260817000800` wrote for the bio.
-- ===========================================================================

-- The four handles' shared last mile.
--
-- Trims, drops a leading '@', turns '' into null, and refuses what the constraint
-- would refuse — with 22023 and a sentence, which is the distinction
-- `20260817000600` draws for `display_name`: a constraint violation reports as 23514
-- with no indication of which rule was broken, and this is a form field somebody is
-- typing into.
--
-- Deliberately *not* the forgiving normaliser. Turning `instagram.com/suraj` into
-- `suraj` needs to know which network the box was, and that is knowledge the form
-- has and this function does not (`features/profile/social-links.ts`). What this is
-- for is making the stored value canonical whichever client wrote it.
--
-- Revoked from every client role below. It is reachable only from inside
-- `save_profile`, which is `security definer` and therefore executes it as its owner
-- — the arrangement `assert_can_write` documents and `function-grants.test.mjs`
-- sweeps for. A `grant ... to authenticated` would not have removed the default
-- PUBLIC grant anyway (20260813001800), which is why the revoke names all three.
create or replace function _social_handle(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text;
begin
  if p_value is null then
    return null;
  end if;

  v := btrim(p_value);
  -- One leading '@' only. A value of '@@name' is not a handle somebody typed with an
  -- extra flourish, it is a value that did not come from the form.
  if left(v, 1) = '@' then
    v := substr(v, 2);
  end if;

  if v = '' then
    return null;
  end if;

  if v !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' then
    raise exception 'a handle is up to 40 letters, numbers, dots, dashes or underscores — not a link'
      using errcode = '22023';
  end if;

  return v;
end;
$$;

revoke execute on function _social_handle(text) from public, anon, authenticated;

drop function if exists save_profile(uuid, text, text, text);

create or replace function save_profile(
  p_operation_id  uuid,
  p_display_name  text default null,
  p_username      text default null,
  p_bio           text default null,
  p_instagram     text default null,
  p_tiktok        text default null,
  p_youtube       text default null,
  p_x             text default null,
  p_website       text default null
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
  v_links   text[];
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

  -- ---- the four handles -------------------------------------------------
  -- Checked as a group rather than one branch each, because the four rules are one
  -- rule. `_social_handle` trims, turns '' into null, and refuses anything the
  -- constraint would refuse — with 22023 and a sentence, rather than leaving a form
  -- field to report 23514 at somebody who is looking at their own handle.
  --
  -- A leading '@' is removed here as well as in the form. The form is where the
  -- forgiving normalisation lives (a pasted profile URL becomes a handle there, and
  -- has to, because only the form knows which network the box was); this is the last
  -- mile that makes the stored value canonical no matter which client wrote it.
  v_links := array[
    _social_handle(p_instagram),
    _social_handle(p_tiktok),
    _social_handle(p_youtube),
    _social_handle(p_x)
  ];

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

  -- ---- the website ------------------------------------------------------
  -- Validated but not repaired. `https://` is required rather than added, and the
  -- reason is that adding it is a guess about what somebody meant: the form turns
  -- `example.com` into `https://example.com` where it can see what was typed, and a
  -- value that arrives here without a scheme has been through a client that did not
  -- do that. Guessing on its behalf would make this the second place the rule lives.
  if p_website is not null and btrim(p_website) <> '' then
    if btrim(p_website) !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}([:/?#][^[:cntrl:][:space:]]*)?$'
       or char_length(btrim(p_website)) > 200 then
      raise exception 'a website must be a full https:// address'
        using errcode = '22023';
    end if;
  end if;

  -- One statement, so the transaction is the atomicity rather than an ordering
  -- somebody has to keep right. A handle that is taken raises here — from the unique
  -- index or from `assert_username_available`, both 23505 — and the name, bio and
  -- links go back with it, which is the entire reason this is one function.
  update profiles
     set display_name = coalesce(v_name, display_name),
         -- `p_bio is not null` rather than `v_bio is not null`: the caller sending ''
         -- means "clear it", and `coalesce` cannot express that. The same shape
         -- carries every link below, for the same reason.
         bio          = case when p_bio is null then bio else v_bio end,
         username     = coalesce(v_handle::citext, username),
         link_instagram = case when p_instagram is null then link_instagram else v_links[1] end,
         link_tiktok    = case when p_tiktok    is null then link_tiktok    else v_links[2] end,
         link_youtube   = case when p_youtube   is null then link_youtube   else v_links[3] end,
         link_x         = case when p_x         is null then link_x         else v_links[4] end,
         link_website   = case when p_website is null then link_website
                               when btrim(p_website) = '' then null
                               else btrim(p_website) end
   where id = auth.uid();

  return jsonb_build_object(
    'status', 'ok',
    'renamed', v_renamed,
    'username', coalesce(v_handle, v_current::text)
  );
end;
$$;

comment on function save_profile(uuid, text, text, text, text, text, text, text, text) is
  'The whole editable profile in one transaction: display name, handle, bio, and the five optional links. Null leaves a field alone; '''' clears one. Replaced the four-argument form on 2026-09-15 rather than overloading it, because PostgREST resolves by argument name and nesting argument sets resolve ambiguously. The 30-day cooldown still applies only when the handle actually changes, so adding an Instagram handle never costs somebody a rename.';

revoke execute on function save_profile(uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function save_profile(uuid, text, text, text, text, text, text, text, text)
  to authenticated;
