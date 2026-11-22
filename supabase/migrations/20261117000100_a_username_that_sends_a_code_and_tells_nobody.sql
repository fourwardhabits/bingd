-- Username-or-email sign-in, server half. Groundwork: shipped dark.
-- Specification: docs/architecture/username-sign-in.md. Founder decision AUTH-DIAGNOSIS §8
-- (2026-11-12): an existing account may sign in with its verified email *or* its username.
--
-- ===========================================================================
-- WHAT THIS IS FOR
--
-- The client only ever knows a username. The email that a code is sent to lives in
-- `auth.users` and must never reach a client — not in a response, not in a log, not in an
-- error. So the `username-sign-in` Edge Function resolves the name **here**, server-side,
-- and the client is handed an opaque challenge id instead of an address.
--
-- Usernames are public, so *whether a name exists* is not a secret worth defending; what
-- is defended is:
--
--   * email disclosure  — nothing here returns an address to anyone but the service role;
--   * account takeover  — a challenge allows five guesses at one six-digit code, then dies;
--   * mail-bombing      — three sends per name per hour, ten per IP, one per account per
--                         minute, on top of GoTrue's own limits.
--
-- Rate-limit refusals and misses look exactly like a send from the outside (the Edge
-- Function always answers the same 200 body); this file decides which one it was.
--
-- ===========================================================================
-- WHO CAN TOUCH IT
--
-- Nobody but the four definer functions below, and those only from the service role. Both
-- tables have RLS on and no policy, and every table privilege is revoked from every API
-- role, service_role included: a debugging session in the SQL editor runs as `postgres`
-- and still works; nothing reaching PostgREST can read a row directly.
--
-- Hashes, never values. The Edge Function sends:
--   * the challenge id's SHA-256 (the id itself is 256 random bits and lives only on the
--     device that asked);
--   * a keyed HMAC of the typed identifier and of the caller's IP (USERNAME_SIGN_IN_HASH_KEY
--     is a function secret, so this table is useless for reversing either);
--   * the normalised username in plain text, because it has to be looked up. It is not
--     stored.
--
-- Retention is 24 hours. Every send and verify purges what is older first, so no cron is
-- required; `username_sign_in_purge()` is exposed to the service role for one anyway.
-- ===========================================================================

create table auth_username_challenges (
  id_hash     text primary key,
  -- Null is a decoy: what a miss, an unconfirmed address or a banned account is handed so
  -- that its response is indistinguishable from a hit. A decoy can never verify.
  user_id     uuid references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- When a code was last actually requested from GoTrue for this account. Inherited by a
  -- challenge minted inside the cooldown, which shares the code already in the inbox.
  sent_at     timestamptz,
  expires_at  timestamptz not null,
  attempts    smallint not null default 0,
  -- Used *or* superseded. Either way the challenge is dead.
  consumed_at timestamptz,

  constraint auth_username_challenges_id_hash check (id_hash ~ '^[0-9a-f]{64}$'),
  constraint auth_username_challenges_attempts check (attempts between 0 and 5),
  constraint auth_username_challenges_decoy_unsent check (user_id is not null or sent_at is null)
);

create index auth_username_challenges_open
  on auth_username_challenges (user_id, created_at desc)
  where user_id is not null and consumed_at is null;

create index auth_username_challenges_created on auth_username_challenges (created_at);

comment on table auth_username_challenges is
  'Opaque username sign-in challenges (username-sign-in Edge Function). Stores only the SHA-256 of the client-held id. user_id null = decoy that can never verify. 10-minute expiry, 5 attempts, single use, purged after 24 h. Service role only, via username_sign_in_* functions.';

create table auth_username_attempts (
  id              bigint generated always as identity primary key,
  kind            text not null,
  -- HMAC of the normalised identifier; null for verify, which counts per IP only.
  identifier_hash text,
  ip_hash         text not null,
  at              timestamptz not null default now(),

  constraint auth_username_attempts_kind check (kind in ('send', 'verify')),
  constraint auth_username_attempts_identifier check (
    (kind = 'send' and identifier_hash ~ '^[0-9a-f]{64}$')
    or (kind = 'verify' and identifier_hash is null)
  ),
  constraint auth_username_attempts_ip check (ip_hash ~ '^[0-9a-f]{64}$')
);

create index auth_username_attempts_identifier
  on auth_username_attempts (identifier_hash, at) where kind = 'send';
create index auth_username_attempts_ip on auth_username_attempts (ip_hash, kind, at);
create index auth_username_attempts_at on auth_username_attempts (at);

comment on table auth_username_attempts is
  'Admitted username sign-in sends and verifies, for the sliding one-hour limits. Keyed HMACs only, never an identifier or an address. Refused attempts are not recorded, so a flood cannot grow the table. Purged after 24 h.';

alter table auth_username_challenges enable row level security;
alter table auth_username_attempts enable row level security;

revoke all on table auth_username_challenges from public, anon, authenticated, service_role;
revoke all on table auth_username_attempts from public, anon, authenticated, service_role;
revoke all on sequence auth_username_attempts_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

create or replace function username_sign_in_purge()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from auth_username_attempts where at < now() - interval '24 hours';
  delete from auth_username_challenges where created_at < now() - interval '24 hours';
$$;

comment on function username_sign_in_purge() is
  'Deletes username sign-in rows older than 24 h. Called by every send and verify; service role only.';

-- ---------------------------------------------------------------------------
-- The one account a name can resolve to, or none
--
-- **Current usernames only.** `username_history` is never read: a released name — even
-- inside its `redirect_until` window, where the web profile still redirects — signs
-- nobody in. A redirect is a courtesy to a link; a sign-in is a credential.
--
-- Eligible only if GoTrue would let the address sign in by code and the account is
-- ordinary: a confirmed, non-empty email; not banned; not soft-deleted; not anonymous;
-- profile active (a suspended account keeps the email path, but the username door is not
-- opened for it). Apple private-relay addresses are ordinary emails here and resolve.
-- ---------------------------------------------------------------------------

create or replace function _username_sign_in_account(p_user uuid, p_username text)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, u.email::text
    from profiles p
    join auth.users u on u.id = p.id
   where (p_user is null or p.id = p_user)
     and (p_username is null or p.username = p_username::citext)
     and (p_user is not null or p_username is not null)
     and p.status = 'active'
     and u.email is not null
     and btrim(u.email) <> ''
     and u.email_confirmed_at is not null
     and (u.banned_until is null or u.banned_until <= now())
     and u.deleted_at is null
     and not coalesce(u.is_anonymous, false)
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- send
--
-- Returns one of, to the service role only:
--   {"outcome":"limited"}                 — over a limit; nothing recorded, nothing sent
--   {"outcome":"miss"}                    — decoy challenge stored
--   {"outcome":"cooldown"}                — a code went out < 60 s ago; this challenge
--                                           shares it, its attempts and its expiry
--   {"outcome":"send","email":"..."}      — fresh challenge; the function asks GoTrue for
--                                           a code with shouldCreateUser: false
--
-- The caller turns all four into the same 200 body.
-- ---------------------------------------------------------------------------

create or replace function username_sign_in_send(
  p_username        text,
  p_identifier_hash text,
  p_ip_hash         text,
  p_challenge_hash  text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  -- The limits. docs/architecture/username-sign-in.md §5 and the function's limits.ts
  -- state the same numbers; supabase/tests/username-sign-in.test.mjs pins them.
  c_ttl            constant interval := interval '10 minutes';
  c_window         constant interval := interval '1 hour';
  c_cooldown       constant interval := interval '60 seconds';
  c_per_identifier constant integer  := 3;
  c_per_ip         constant integer  := 10;

  v_name    text := lower(btrim(coalesce(p_username, '')));
  v_user    uuid;
  v_email   text;
  v_open    auth_username_challenges%rowtype;
begin
  if coalesce(p_identifier_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_challenge_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'username_sign_in_send: malformed hash' using errcode = '22023';
  end if;

  perform username_sign_in_purge();

  -- Count-then-insert has to be serialised or two parallel requests both pass. Always in
  -- this order (identifier, ip, then account), so no two sends can deadlock.
  perform pg_advisory_xact_lock(hashtextextended('username-sign-in:id:' || p_identifier_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('username-sign-in:ip:' || p_ip_hash, 0));

  if (select count(*) from auth_username_attempts a
       where a.kind = 'send' and a.identifier_hash = p_identifier_hash
         and a.at > now() - c_window) >= c_per_identifier
     or (select count(*) from auth_username_attempts a
          where a.kind = 'send' and a.ip_hash = p_ip_hash
            and a.at > now() - c_window) >= c_per_ip then
    -- Not recorded: the limit is "N admitted per hour", and a refused flood must not be
    -- able to grow this table.
    return jsonb_build_object('outcome', 'limited');
  end if;

  insert into auth_username_attempts (kind, identifier_hash, ip_hash)
  values ('send', p_identifier_hash, p_ip_hash);

  -- Same rule as profiles.username_format and create_profile; anything else is a miss.
  if v_name ~ '^[a-z0-9_]{3,24}$' then
    select a.user_id, a.email into v_user, v_email
      from _username_sign_in_account(null, v_name) a;
  end if;

  if v_user is null then
    insert into auth_username_challenges (id_hash, user_id, expires_at)
    values (p_challenge_hash, null, now() + c_ttl);
    return jsonb_build_object('outcome', 'miss');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('username-sign-in:user:' || v_user::text, 0));

  select c.* into v_open
    from auth_username_challenges c
   where c.user_id = v_user and c.consumed_at is null and c.expires_at > now()
   order by c.created_at desc
   limit 1;

  -- Every earlier challenge for this account dies here, whichever branch follows: there is
  -- only ever one live challenge per account, so repeated sends cannot multiply the number
  -- of guesses available against one code.
  update auth_username_challenges c
     set consumed_at = now()
   where c.user_id = v_user and c.consumed_at is null;

  if v_open.id_hash is not null and v_open.sent_at > now() - c_cooldown then
    -- A double tap, or a resend inside GoTrue's own per-address minute. No email; the
    -- code already sent stays the code, and the guesses already spent stay spent.
    insert into auth_username_challenges (id_hash, user_id, sent_at, expires_at, attempts)
    values (p_challenge_hash, v_user, v_open.sent_at, v_open.expires_at, v_open.attempts);
    return jsonb_build_object('outcome', 'cooldown');
  end if;

  insert into auth_username_challenges (id_hash, user_id, sent_at, expires_at)
  values (p_challenge_hash, v_user, now(), now() + c_ttl);

  return jsonb_build_object('outcome', 'send', 'email', v_email);
end;
$$;

comment on function username_sign_in_send(text, text, text, text) is
  'Username sign-in, send half. Resolves a CURRENT username (never username_history) to an eligible account, applies the per-identifier (3/h), per-IP (10/h) and per-account (60 s) limits, and stores a challenge or a decoy. Returns the address only to the service role. See docs/architecture/username-sign-in.md.';

-- ---------------------------------------------------------------------------
-- verify, in two halves around the GoTrue call
--
-- `begin` spends an attempt **before** the code is checked, so N parallel guesses cost N
-- attempts and the fifth is the last whatever the timing. It answers:
--   {"outcome":"limited"}                          — per-IP verify limit; nothing recorded
--   {"outcome":"invalid"}                          — unknown, decoy, expired, used,
--                                                    superseded, locked or ineligible
--   {"outcome":"check","email":"...","user_id":"..."}
--
-- Eligibility is re-read rather than trusted from send time, so a ban or a deletion in the
-- ten minutes between them is honoured.
-- ---------------------------------------------------------------------------

create or replace function username_sign_in_verify_begin(p_challenge_hash text, p_ip_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  c_window       constant interval := interval '1 hour';
  c_per_ip       constant integer  := 30;
  c_max_attempts constant integer  := 5;

  v_found   boolean;
  v_user    uuid;
  v_email   text;
begin
  if coalesce(p_challenge_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'username_sign_in_verify_begin: malformed hash' using errcode = '22023';
  end if;

  perform username_sign_in_purge();

  perform pg_advisory_xact_lock(hashtextextended('username-sign-in:ip:' || p_ip_hash, 0));

  if (select count(*) from auth_username_attempts a
       where a.kind = 'verify' and a.ip_hash = p_ip_hash
         and a.at > now() - c_window) >= c_per_ip then
    return jsonb_build_object('outcome', 'limited');
  end if;

  insert into auth_username_attempts (kind, identifier_hash, ip_hash)
  values ('verify', null, p_ip_hash);

  -- Decoys are spent like real challenges, so the two cost the same.
  update auth_username_challenges c
     set attempts = c.attempts + 1
   where c.id_hash = p_challenge_hash
     and c.consumed_at is null
     and c.expires_at > now()
     and c.attempts < c_max_attempts
  returning true, c.user_id into v_found, v_user;

  if not coalesce(v_found, false) or v_user is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select a.email into v_email from _username_sign_in_account(v_user, null) a;

  if v_email is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  return jsonb_build_object('outcome', 'check', 'email', v_email, 'user_id', v_user);
end;
$$;

comment on function username_sign_in_verify_begin(text, text) is
  'Username sign-in, verify half one. Spends one of five attempts on a live, non-decoy challenge before the code is checked, applies the per-IP verify limit (30/h), and returns the address to the service role only.';

-- `finish` is single use: true exactly once per challenge, and only for the account the
-- challenge was minted for. A false here means the Edge Function revokes the session it
-- was just given rather than returning it.
create or replace function username_sign_in_verify_finish(p_challenge_hash text, p_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_done boolean;
begin
  update auth_username_challenges c
     set consumed_at = now()
   where c.id_hash = p_challenge_hash
     and c.user_id = p_user_id
     and c.consumed_at is null
     and c.expires_at > now()
  returning true into v_done;

  return coalesce(v_done, false);
end;
$$;

comment on function username_sign_in_verify_finish(text, uuid) is
  'Username sign-in, verify half two. Marks the challenge used; true exactly once, and only for the account it was minted for.';

-- ---------------------------------------------------------------------------
-- Privileges: the service role, and nobody else
-- ---------------------------------------------------------------------------

revoke execute on function username_sign_in_purge() from public, anon, authenticated;
revoke execute on function _username_sign_in_account(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function username_sign_in_send(text, text, text, text) from public, anon, authenticated;
revoke execute on function username_sign_in_verify_begin(text, text) from public, anon, authenticated;
revoke execute on function username_sign_in_verify_finish(text, uuid) from public, anon, authenticated;

grant execute on function username_sign_in_purge() to service_role;
grant execute on function username_sign_in_send(text, text, text, text) to service_role;
grant execute on function username_sign_in_verify_begin(text, text) to service_role;
grant execute on function username_sign_in_verify_finish(text, uuid) to service_role;
