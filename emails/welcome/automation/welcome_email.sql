-- The welcome email's send ledger, its suppression list, its switches, and the functions
-- the worker calls.
--
-- *** THIS FILE IS NOT IN supabase/migrations/ AND HAS NOT BEEN APPLIED ANYWHERE. ***
--
-- It has no timestamp on purpose. The first version was named 20260916000100, and by the
-- time anybody came to apply it main had taken that exact timestamp for something else
-- (`20260916000100_a_bar_the_first_five_already_clears.sql`). A timestamp chosen weeks
-- before a file is applied is a collision waiting for its date. It gets one in the commit
-- that moves it into `supabase/migrations/`, newer than every file there at that moment.
-- See README.md, "Turning it on".
--
-- Applying it changes no behaviour on its own: it creates two empty tables, inserts six
-- configuration rows at values that mean "send nothing to nobody", and defines functions
-- that only the service role can call, all installed in one statement.
--
-- Proven against every real migration by supabase/tests/welcome-email.test.mjs (PGlite)
-- and supabase/tests/concurrency/races/welcome-email.mjs (a real PostgreSQL, two
-- connections).
--
-- Specification: emails/welcome/automation/README.md

-- ---------------------------------------------------------------------------
-- The ledger
--
-- One row per account the welcome email has been considered for, ever. `user_id` is the
-- primary key and that is the whole idempotency story: a claim is an
-- `insert ... on conflict do nothing`, and no row back means somebody else already has
-- this person.
--
-- A primary key is at-most-once, not at-least-once. It guarantees a second send cannot
-- start; it guarantees nothing about the first one finishing. That is the right way
-- round, because mailing somebody twice cannot be undone and mailing them zero times is a
-- row somebody can look at.
--
-- `on delete cascade`: account deletion is `delete from auth.users`, which cascades to
-- `profiles` and from there to this row. A deleted account leaves nothing here.
-- ---------------------------------------------------------------------------

create table welcome_emails (
  user_id          uuid primary key references profiles(id) on delete cascade,

  -- claimed     taken by a run, outcome not yet recorded. A row that stays here was
  --             either mid-send when a run died or sent and never recorded, and it is
  --             NEVER retried automatically, because which of the two it was is unknown.
  -- sent        Resend accepted it.
  -- failed      Resend refused it or the request did not complete. Retried, bounded.
  -- suppressed  the address was on email_suppressions when the account came up.
  -- excluded    a person decided this account should not get it.
  status           text not null default 'claimed'
                   check (status in ('claimed', 'sent', 'failed', 'suppressed', 'excluded')),

  -- Resend's message id, the only handle on a delivered message afterwards.
  resend_id        text,

  attempts         integer not null default 0 check (attempts >= 0),
  failed_reason    text,

  -- True when the row was claimed by `--canary`, so a canary is distinguishable from the
  -- real cohort forever after.
  canary           boolean not null default false,

  first_claimed_at timestamptz not null default now(),
  claimed_at       timestamptz not null default now(),
  sent_at          timestamptz
);

comment on table welcome_emails is
  'One row per account the welcome email has been considered for. The primary key is the idempotency guarantee. Pre-inserting a row with status excluded keeps a person out by hand: the claim skips anybody who has a row at all.';

create index welcome_emails_retryable on welcome_emails (first_claimed_at) where status = 'failed';

-- ---------------------------------------------------------------------------
-- The suppression list
--
-- The unsubscribe link is a `mailto:` to the founder. What turns that email into "this
-- person does not get mailed" is a row here, written by hand (README.md, "Somebody asked
-- not to be emailed"). Keyed by address rather than by account, because the request
-- arrives as an email address and may arrive before, or without, an account.
--
-- Deliberately NOT Resend's suppression list. That list is account-wide, and the same
-- Resend account sends every sign-in code: suppressing somebody there to stop a welcome
-- email would also stop them being able to sign in.
--
-- Lower-cased by constraint rather than typed citext, so the comparison is explicit and
-- behaves the same in the PGlite suite, where citext is a plain text domain.
-- ---------------------------------------------------------------------------

create table email_suppressions (
  email      text primary key check (email = lower(email) and email like '%_@_%'),
  reason     text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'requested')),
  note       text,
  created_at timestamptz not null default now()
);

comment on table email_suppressions is
  'Addresses that must not receive lifecycle email. Separate from Resend''s account-wide suppression list, which would also block sign-in codes.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Nobody reads either table from a client. Enabled with no policy, which is
-- deny-everything for anon and authenticated, and the grants are revoked as well:
-- together these are a list of accounts and addresses.
-- ---------------------------------------------------------------------------

alter table welcome_emails enable row level security;
alter table email_suppressions enable row level security;

revoke all on welcome_emails from anon, authenticated;
revoke all on email_suppressions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The switches
--
-- All `on conflict do nothing`, so re-applying this file never re-arms a switch somebody
-- turned off. None of the keys starts with `public.`, so app_config_read hides them from
-- clients.
--
-- THE LITERALS BELOW ARE THE SAFE DEFAULTS AND ARE NOT A DEPLOYMENT DECISION.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values

  -- The emergency stop. Read inside the claim, before anything is claimed, so a disabled
  -- run consumes nothing: hold, do not drop. (`push.delivery_enabled` existed for two
  -- weeks without being read by the code it was meant to gate; PR #119.)
  ('welcome.delivery_enabled', 'false'::jsonb),

  -- Only accounts created at or after this are ever selected. 2099 rather than null,
  -- because null would read as "no lower bound". This is why turning the job on cannot
  -- reach the existing user base: activation sets it to the moment of activation.
  ('welcome.start_after', '"2099-01-01T00:00:00Z"'::jsonb),

  -- How long after signup. The note assumes the reader has used the app.
  ('welcome.delay_hours', '36'::jsonb),

  -- A welcome that arrives a week late is not a welcome. If the job is paused and
  -- resumed, accounts older than this are simply never selected.
  ('welcome.max_age_hours', '168'::jsonb),

  -- A ceiling on any one run, whatever the caller asks for.
  ('welcome.max_per_run', '25'::jsonb),

  -- The only addresses a canary may ever mail: a JSON array of lower-case test inboxes
  -- the founder controls. Empty, so a canary claims nobody until somebody writes one in.
  -- Without this a canary would be "mail any real account whose id and address you
  -- know, with every other switch off", which is a hole, not a test.
  ('welcome.canary_addresses', '[]'::jsonb)

on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The functions
--
-- All of them, with their grants, in ONE `do` block, which is one statement. The
-- Supabase CLI applies a migration statement by statement outside a transaction, and a
-- new function is executable by PUBLIC until a later `revoke` runs; installed separately,
-- each would be callable by any client for the moment between its `create` and its
-- `revoke`. Inside the block, nothing exists to anybody until all of it does.
--
-- Function bodies are quoted `$fn$` because the block itself is `$install$`.
-- ---------------------------------------------------------------------------

do $install$
begin

-- ---------------------------------------------------------------------------
-- Can this account receive mail at all
--
-- An active profile; an auth user with an address that has been confirmed; not banned,
-- not soft-deleted, not anonymous. The claim and the retry both ask this one question,
-- so a check cannot be present in one and missing from the other.
-- ---------------------------------------------------------------------------

create function _welcome_email_can_receive(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from profiles p
      join auth.users u on u.id = p.id
     where p.id = p_user
       and p.status = 'active'
       and u.email is not null
       and u.email like '%_@_%'
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
       and not coalesce(u.is_anonymous, false)
  );
$fn$;

revoke all on function _welcome_email_can_receive(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Is this account in the scope of this run
--
-- Two modes and nothing else:
--
--   cohort   p_canary_user is null. Created at or after start_after, at least delay_hours
--            and less than max_age_hours ago.
--   canary   p_canary_user and p_canary_email both given. Exactly that account, only if
--            its address is the address given, and only if that address is on
--            welcome.canary_addresses. The signup window does not apply, because a canary
--            is a test account made for the purpose.
--
-- The claim and the retry both ask this too, so a retry cannot reach an account the claim
-- would not, and a canary's failed row cannot be picked up by a cohort run or the reverse.
-- ---------------------------------------------------------------------------

create function _welcome_email_in_scope(p_user uuid, p_canary_user uuid, p_canary_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when p_canary_user is null then exists (
      select 1 from profiles p
       where p.id = p_user
         and p.created_at >= coalesce((select c.value #>> '{}' from app_config c where c.key = 'welcome.start_after'), '2099-01-01T00:00:00Z')::timestamptz
         and p.created_at <= now() - make_interval(hours => coalesce((select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.delay_hours'), 36))
         and p.created_at >  now() - make_interval(hours => coalesce((select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.max_age_hours'), 168))
    )
    else exists (
      select 1 from auth.users u
       where u.id = p_user
         and p_user = p_canary_user
         and lower(u.email) = lower(p_canary_email)
         and lower(u.email) in (
           select lower(a)
             from jsonb_array_elements_text(
                    coalesce((select c.value from app_config c where c.key = 'welcome.canary_addresses'), '[]'::jsonb)
                  ) a
         )
    )
  end;
$fn$;

revoke all on function _welcome_email_in_scope(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Who is eligible for a first claim
--
-- In scope, able to receive, and no ledger row. One definition, used by the dry run and
-- by the claim, so the preview cannot describe a different set of people from the one the
-- claim takes. Suppressed addresses ARE returned, flagged, so the claim can record them.
-- ---------------------------------------------------------------------------

create function _welcome_email_candidates(
  p_limit        integer,
  p_canary_user  uuid default null,
  p_canary_email text default null
)
returns table (
  recipient_id    uuid,
  recipient_email text,
  display_name    text,
  username        text,
  signed_up_at    timestamptz,
  suppressed      boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cap integer;
begin
  if (p_canary_user is null) <> (p_canary_email is null) then
    raise exception 'a canary needs both an account id and its address'
      using errcode = '22023';
  end if;

  -- Read before selecting anybody: a malformed switch raises here, and the run fails
  -- before anything is claimed.
  perform coalesce((select c.value #>> '{}' from app_config c where c.key = 'welcome.start_after'), '2099-01-01T00:00:00Z')::timestamptz;
  v_cap := coalesce((select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.max_per_run'), 25);

  return query
    select p.id,
           lower(u.email)::text,
           p.display_name::text,
           p.username::text,
           p.created_at,
           exists (select 1 from email_suppressions s where s.email = lower(u.email))
      from profiles p
      join auth.users u on u.id = p.id
     where _welcome_email_in_scope(p.id, p_canary_user, p_canary_email)
       and _welcome_email_can_receive(p.id)
       and not exists (select 1 from welcome_emails w where w.user_id = p.id)
     order by p.created_at, p.id
     limit greatest(0, least(coalesce(p_limit, v_cap), v_cap));
end;
$fn$;

revoke all on function _welcome_email_candidates(integer, uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The dry run
--
-- Who a claim would take right now, taking nobody, plus the switches. It ignores
-- delivery_enabled on purpose, because "who would this mail if I turned it on" is the
-- question a dry run exists to answer. Handles, never addresses: it is printed to logs.
-- ---------------------------------------------------------------------------

create function welcome_email_preview(
  p_limit        integer default null,
  p_canary_user  uuid default null,
  p_canary_email text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'delivery_enabled', coalesce((select c.value from app_config c where c.key = 'welcome.delivery_enabled') = 'true'::jsonb, false),
    'start_after',      (select c.value #>> '{}' from app_config c where c.key = 'welcome.start_after'),
    'delay_hours',      (select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.delay_hours'),
    'max_age_hours',    (select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.max_age_hours'),
    'max_per_run',      (select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.max_per_run'),
    'canary_addresses', coalesce(jsonb_array_length((select c.value from app_config c where c.key = 'welcome.canary_addresses')), 0),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.recipient_id,
               'username', x.username,
               'signed_up_at', x.signed_up_at,
               'suppressed', x.suppressed
             ) order by x.signed_up_at)
        from _welcome_email_candidates(p_limit, p_canary_user, p_canary_email) x
    ), '[]'::jsonb)
  );
$fn$;

revoke all on function welcome_email_preview(integer, uuid, text) from public, anon, authenticated;
grant execute on function welcome_email_preview(integer, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The claim
--
-- Returns the people this run now owns and must send to, each with the attempt number the
-- outcome has to be recorded against.
--
-- The order of the gates is the design:
--
--   1. Delivery disabled and not a canary: return nothing, write nothing.
--   2. Suppressed candidates: record `suppressed`, return nothing for them.
--   3. New candidates: insert `claimed` with on conflict do nothing. A concurrent claim of
--      the same person blocks on the primary key until the other commits, then does
--      nothing. Only a row this call inserted is returned.
--   4. Retries: a `failed` row of this run's mode (cohort or canary), with attempts < 3,
--      first claimed under 20 hours ago, still in scope, still able to receive, and not
--      suppressed, moves back to `claimed` with a compare-and-set on its status. Two runs
--      retrying the same row serialise on the row lock and the second finds it `claimed`.
--
-- The 20 hours is Resend's half of the guarantee. The worker sends with
-- `Idempotency-Key: welcome-v1-<user_id>` and Resend honours a key for 24 hours, so a
-- retry inside that window of a request that did go through returns the original
-- response rather than a second email.
-- ---------------------------------------------------------------------------

create function welcome_email_claim(
  p_limit        integer default null,
  p_canary_user  uuid default null,
  p_canary_email text default null
)
returns table (
  recipient_id    uuid,
  recipient_email text,
  display_name    text,
  username        text,
  attempt         integer
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_enabled boolean;
  v_canary  boolean := p_canary_user is not null;
  v_cap     integer;
  v_limit   integer;
  v_taken   integer := 0;
  v_row     record;
  v_id      uuid;
  v_attempt integer;
begin
  v_enabled := coalesce((select c.value from app_config c where c.key = 'welcome.delivery_enabled') = 'true'::jsonb, false);

  -- Gate 1. Read before anything is written.
  if not v_enabled and not v_canary then
    return;
  end if;

  v_cap   := coalesce((select (c.value #>> '{}')::integer from app_config c where c.key = 'welcome.max_per_run'), 25);
  v_limit := greatest(0, least(coalesce(p_limit, v_cap), v_cap));

  -- Gates 2 and 3.
  for v_row in select * from _welcome_email_candidates(v_limit, p_canary_user, p_canary_email) loop
    if v_row.suppressed then
      insert into welcome_emails as w (user_id, status, canary)
      values (v_row.recipient_id, 'suppressed', v_canary)
      on conflict on constraint welcome_emails_pkey do nothing;
      continue;
    end if;

    v_id := null;
    insert into welcome_emails as w (user_id, status, attempts, canary)
    values (v_row.recipient_id, 'claimed', 1, v_canary)
    on conflict on constraint welcome_emails_pkey do nothing
    returning w.user_id into v_id;

    if v_id is not null then
      recipient_id    := v_row.recipient_id;
      recipient_email := v_row.recipient_email;
      display_name    := v_row.display_name;
      username        := v_row.username;
      attempt         := 1;
      v_taken         := v_taken + 1;
      return next;
    end if;
  end loop;

  -- Gate 4.
  for v_row in
    select w.user_id              as rid,
           lower(u.email)::text   as remail,
           p.display_name::text   as rname,
           p.username::text       as rhandle
      from welcome_emails w
      join profiles p on p.id = w.user_id
      join auth.users u on u.id = w.user_id
     where w.status = 'failed'
       and w.attempts < 3
       and w.first_claimed_at > now() - interval '20 hours'
       and w.canary = v_canary
       and _welcome_email_in_scope(w.user_id, p_canary_user, p_canary_email)
       and _welcome_email_can_receive(w.user_id)
       and not exists (select 1 from email_suppressions s where s.email = lower(u.email))
     order by w.first_claimed_at
     limit greatest(0, v_limit - v_taken)
  loop
    v_attempt := null;
    update welcome_emails as w
       set status = 'claimed', attempts = w.attempts + 1, claimed_at = now(), failed_reason = null
     where w.user_id = v_row.rid
       and w.status = 'failed'
       and w.attempts < 3
    returning w.attempts into v_attempt;

    if v_attempt is not null then
      recipient_id    := v_row.rid;
      recipient_email := v_row.remail;
      display_name    := v_row.rname;
      username        := v_row.rhandle;
      attempt         := v_attempt;
      return next;
    end if;
  end loop;
end;
$fn$;

revoke all on function welcome_email_claim(integer, uuid, text) from public, anon, authenticated;
grant execute on function welcome_email_claim(integer, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The outcome
--
-- Moves a row out of `claimed`, and only the row this worker claimed at this attempt. A
-- stale worker recording late cannot overwrite a newer attempt, and nothing turns a
-- `sent` row back into anything else. Returns whether it recorded.
-- ---------------------------------------------------------------------------

create function welcome_email_record(
  p_user      uuid,
  p_attempt   integer,
  p_outcome   text,
  p_resend_id text default null,
  p_reason    text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed') then
    raise exception 'outcome must be sent or failed, not %', p_outcome using errcode = '22023';
  end if;

  update welcome_emails as w
     set status        = p_outcome,
         resend_id     = case when p_outcome = 'sent' then p_resend_id end,
         sent_at       = case when p_outcome = 'sent' then now() end,
         failed_reason = case when p_outcome = 'failed' then left(p_reason, 500) end
   where w.user_id  = p_user
     and w.status   = 'claimed'
     and w.attempts = p_attempt;

  return found;
end;
$fn$;

revoke all on function welcome_email_record(uuid, integer, text, text, text) from public, anon, authenticated;
grant execute on function welcome_email_record(uuid, integer, text, text, text) to service_role;

end;
$install$;
