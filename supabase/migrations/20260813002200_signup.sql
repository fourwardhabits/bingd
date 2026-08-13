-- Account creation: the one write a user makes before they have a profile.
-- Specification: PRD §8, §22 · docs/architecture/data-model.md §2
--
-- This was missing. Authentication was configured end to end — email codes,
-- Apple, Google, all three verified live — and a user who completed any of them
-- arrived at a session with no profile row and no way to make one. Every read
-- policy keys off `profiles`, so the account existed in `auth.users` and was
-- invisible to the entire application. Signing in worked and being a user did
-- not.
--
-- Writing it as an RPC rather than an insert policy is not a style preference.
-- Three tables have to agree — `profiles`, `profile_private`, and the username
-- reservation checked by the trigger from 20260813001500 — and the age gate has
-- to refuse *before* anything is stored. A client insert cannot be trusted with
-- that ordering, and an insert policy cannot express it at all (AD-4).

-- ---------------------------------------------------------------------------
-- Availability, so the signup form can answer before submitting
--
-- The rule is duplicated nowhere: this asks exactly what
-- assert_username_available() enforces, plus the format constraint, so a form
-- that says "available" cannot be contradicted by the insert. A test asserts
-- the two agree, because that divergence is the whole risk of having both.
--
-- The normalization has to happen here too, not only in create_profile. Checking
-- the raw input makes the two disagree on anything create_profile would have
-- normalized: 'MixedCase' fails the lowercase regex and reads as unavailable,
-- while create_profile lowercases it and accepts it. The direction is safe — the
-- form refuses a name that would have worked — but "these two agree" is the
-- property the pair exists to have, and it either holds or it does not.
-- ---------------------------------------------------------------------------

create or replace function username_available(p_username text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  with candidate as (
    select lower(btrim(coalesce(p_username, ''))) as name
  )
  select c.name ~ '^[a-z0-9_]{3,24}$'
     and not exists (
       select 1 from profiles p where p.username = c.name::citext
     )
     -- A name in history is taken unless it is the caller's own former name.
     -- profile_id null means the owning account was deleted, which is a
     -- permanent reservation against impersonation and never reclaimable.
     and not exists (
       select 1 from username_history h
        where h.username = c.name::citext
          and (h.profile_id is null or h.profile_id is distinct from auth.uid())
     )
    from candidate c;
$$;

comment on function username_available(text) is
  'Format, live uniqueness, and the reservation rule, in the same shape assert_username_available enforces. Authenticated only: it answers questions about which names exist, and there is no reason for a signed-out client to ask.';

-- ---------------------------------------------------------------------------
-- Account creation
-- ---------------------------------------------------------------------------

-- Returns jsonb rather than void, and this is the one interesting thing about the
-- signature. auth.md §4 requires that an under-13 refusal **delete the account** —
-- the profile attempt and the `auth.users` row — rather than leave it dormant,
-- because retaining a child's date of birth in order to have refused them is the
-- opposite of what PRD §22 is for.
--
-- A function that raises cannot do that. The exception rolls the transaction back,
-- including the delete, so the account survives every attempt to remove it. The
-- refusal therefore has to be a **returned value** and not an error, which is why
-- the age case answers `{"ok": false, ...}` while everything else still raises.
-- Errors are for conditions where rolling back is the correct outcome.
create or replace function create_profile(
  p_username      text,
  p_display_name  text default null,
  p_date_of_birth date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display  text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  perform assert_can_write();

  -- Distinct from a taken username on purpose. A retried request after a dropped
  -- response is the common cause, and the client should continue into the app
  -- rather than show the user an error about a name they already own.
  if exists (select 1 from profiles where id = v_user) then
    raise exception 'profile already exists' using errcode = '42710';
  end if;

  -- Format first, so a mistyped username is reported as a mistyped username. It
  -- is a pure input check and cannot be confused with eligibility.
  if v_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'username must be 3 to 24 characters, lowercase letters, numbers, or underscores'
      using errcode = '22023';
  end if;

  -- A display name renders on every social surface and is a named report subject,
  -- so it gets the same treatment reports.note and reactions.kind already get: an
  -- unbounded text column accepting anything *is* a free-text field pointed at
  -- whoever reads it, whatever a well-behaved client happens to send. The client
  -- caps this at 50; a modified client is the case the check exists for.
  if v_display is not null
     and (char_length(v_display) > 50 or v_display ~ '[[:cntrl:]]') then
    raise exception 'display name must be 50 characters or fewer, on one line'
      using errcode = '22023';
  end if;

  -- Absent or impossible dates are input errors, not eligibility decisions, and
  -- must not delete anything. A date in the future or before 1906 is a broken
  -- form, not a claim about a person.
  if p_date_of_birth is null
     or p_date_of_birth > current_date
     or p_date_of_birth < (current_date - interval '120 years') then
    raise exception 'missing or implausible date of birth' using errcode = '22023';
  end if;

  -- The gate. Nothing about this date is written down: not in profiles, not in
  -- profile_private, not in a log. The only trace it leaves is the absence of an
  -- account.
  --
  -- The delete has a precondition worth knowing before adding a feature that runs
  -- before profile creation: it succeeds because every table referencing
  -- auth.users(id) at this point cascades. A future foreign key without ON DELETE
  -- CASCADE blocks it — storage.objects.owner is the usual culprit — so an avatar
  -- uploaded during onboarding would break the age gate rather than the upload.
  --
  -- Which is why a failure here is raised rather than swallowed. Returning
  -- {"ok": false, "account_deleted": true} when the delete did not happen would
  -- tell a child we removed their details while keeping them, and that is the one
  -- statement this function must never make falsely. Failing loudly costs a
  -- confusing error message; failing quietly costs the guarantee.
  if p_date_of_birth > (current_date - interval '13 years') then
    begin
      delete from auth.users where id = v_user;
    exception when others then
      raise exception 'age refusal could not delete the account: %', sqlerrm
        using errcode = 'P0001';
    end;

    return jsonb_build_object('ok', false, 'reason', 'under_13', 'account_deleted', true);
  end if;

  -- Both raise 23505: the unique index for a live name, and the reservation
  -- trigger for a released one. One code, because the user's next action is the
  -- same either way — choose another name. Which of the two it was is not
  -- information the caller should get, since it distinguishes "in use" from
  -- "previously used by a deleted account".
  insert into profiles (id, username, display_name)
  values (v_user, v_username::citext, coalesce(v_display, v_username));

  insert into profile_private (profile_id, date_of_birth)
  values (v_user, p_date_of_birth);

  return jsonb_build_object('ok', true);
end;
$$;

-- The structural half of the display-name rule. create_profile is the only writer
-- today, so the check above is sufficient today; the constraint is what keeps it
-- true when update_profile and the import path arrive and nobody rereads this file.
alter table profiles
  add constraint display_name_shape
  check (char_length(display_name) between 1 and 50
         and display_name !~ '[[:cntrl:]]');

comment on function create_profile(text, text, date) is
  'Creates profiles and profile_private together. An under-13 date of birth returns {"ok":false,"reason":"under_13"} and deletes the auth.users row — returned rather than raised, because raising would roll the deletion back (auth.md §4). Raises 42710 if the caller already has a profile, 23505 if the username is unavailable, 22023 for a malformed username or an impossible date.';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Explicit despite the global default-privileges revoke in 20260813002100,
-- following the convention in data-model.md: the allow-list is the artefact that
-- gets reviewed, and a function whose grants are implicit is one nobody checks.
--
-- anon gets neither. A signed-out client has nothing to create an account with —
-- auth.uid() would be null and assert_can_write() raises — so a grant would only
-- widen the surface for username enumeration.
-- ---------------------------------------------------------------------------

revoke execute on function username_available(text) from public, anon, authenticated;
revoke execute on function create_profile(text, text, date) from public, anon, authenticated;

grant execute on function username_available(text)            to authenticated;
grant execute on function create_profile(text, text, date)     to authenticated;
