-- H-2: a password set before the address was proven does not survive its proof.
--
-- ---------------------------------------------------------------------------
-- THE FINDING, CONFIRMED ON STAGING (2026-11-15, Supabase Auth v2.197.0)
-- ---------------------------------------------------------------------------
--
-- Password sign-up stays open at the Auth API (the store-review account signs in with a
-- password, so the email provider cannot be switched off), and an address is not checked
-- until somebody confirms it. So anybody can call `signUp` with somebody else's address and
-- a password of their own. The account is unconfirmed and that password cannot sign in yet.
--
-- When the real owner later signs in to bingd with an emailed code, `verifyOtp` confirms
-- that same row, and the stranger's password was still on it. A controlled staging test with
-- disposable accounts showed the original password then opened a session on the owner's
-- account, whether the owner used a fresh sign-in code or the code from the sign-up email.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
--
-- At the moment an address is first confirmed by a code or link that Auth emailed to it,
-- any password already on the row was set by somebody who had not proven the address, so
-- it is replaced with a random one nobody knows. That is exactly the state an honest
-- code sign-up is in: Auth gives every code-created account a random password of its own.
-- Nothing in bingd sets a password after that, so nothing a person chose is lost.
--
-- "Emailed" is read from the row: confirming a code needs `confirmation_sent_at` (a sign-up
-- confirmation) or `recovery_sent_at` (a magic-link code), because Auth checks a code's
-- age against them. An account an operator creates already confirmed (the dashboard's
-- Auto Confirm User, or `admin.createUser({ email_confirm: true })`, which is how the
-- store-review account and the QA fixtures are made) was sent nothing, so its password is
-- left exactly as the operator set it.
--
-- Not a change to sign-in or sign-up: the same calls work, the same accounts exist, and an
-- address already confirmed never meets this trigger again.

create or replace function public.retire_unproven_password()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.confirmation_sent_at is not null or old.recovery_sent_at is not null)
     and coalesce(new.encrypted_password, '') <> '' then
    -- A bcrypt hash of 32 random bytes: the same shape Auth stores, matching no input.
    new.encrypted_password := extensions.crypt(
      encode(extensions.gen_random_bytes(32), 'base64'),
      extensions.gen_salt('bf', 10)
    );
  end if;
  return new;
end;
$$;

comment on function public.retire_unproven_password() is
  'H-2: replaces a password set before the address was proven, when an emailed code or link first confirms it. See migration 20261124000100.';

-- A trigger function, never an RPC: nobody calls it directly.
revoke all on function public.retire_unproven_password() from public, anon, authenticated, service_role;

drop trigger if exists retire_unproven_password on auth.users;
create trigger retire_unproven_password
  before update on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.retire_unproven_password();
