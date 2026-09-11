-- The welcome email's send ledger and its two switches.
--
-- *** THIS FILE IS NOT IN supabase/migrations/ AND HAS NOT BEEN APPLIED ANYWHERE. ***
--
-- It sits here so that nothing can pick it up: `supabase db push` walks
-- `supabase/migrations/`, and a file outside it is inert. Move it there in the commit
-- that turns the automation on, not before. See README.md step 3.
--
-- Applying it changes no behaviour on its own. It creates one table and inserts two
-- configuration rows at values that mean "send nothing to nobody".
--
-- Specification: emails/welcome/automation/README.md

-- ---------------------------------------------------------------------------
-- The ledger
--
-- One row per account that has been considered, ever. `user_id` is the primary key and
-- that is the whole idempotency story: the worker's first act is an
-- `insert ... on conflict do nothing returning user_id`, and no row back means somebody
-- else already has this person.
--
-- A primary key is at-most-once rather than at-least-once. It cannot promise the email
-- was delivered; it promises a second one cannot start. That is the right way round,
-- because mailing somebody twice cannot be undone and mailing them zero times is fixed
-- by the retry.
--
-- `on delete cascade` rather than `set null`: a deleted account's row is not evidence of
-- anything and keeping it would leave a user id pointing at nobody in a table that exists
-- to name people. The account deletion inventory in 20260817000600_account.sql is the
-- contract this follows.
-- ---------------------------------------------------------------------------

create table welcome_emails (
  user_id       uuid primary key references profiles(id) on delete cascade,

  -- claimed    taken by a run, outcome not yet known
  -- sent       Resend accepted it
  -- failed     Resend refused it, or the request never completed
  -- no_address the account has no email address to send to
  -- excluded   a human decided this person should not get it
  status        text not null default 'claimed'
                check (status in ('claimed', 'sent', 'failed', 'no_address', 'excluded')),

  -- Resend's message id, which is the only handle on a delivered message afterwards.
  resend_id     text,

  attempts      integer not null default 0,
  failed_reason text,

  claimed_at    timestamptz not null default now(),
  sent_at       timestamptz
);

comment on table welcome_emails is
  'One row per account the welcome email has been considered for. The primary key is the idempotency guarantee: a claim that exists means no second send can begin. Pre-inserting a row with status excluded is how a person is kept out by hand, and needs no support in the worker, which skips anybody who has a row at all.';

-- The retry pass and nothing else reads this shape.
create index welcome_emails_retryable
  on welcome_emails (claimed_at)
  where status = 'failed';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Nobody reads this from a client. It is written by the service role, which bypasses
-- RLS, and read by whoever is looking at the dashboard. RLS is enabled with no policy at
-- all, which is the deny-everything state: `anon` and `authenticated` see zero rows.
--
-- Enabled rather than left off, because a table with RLS off is readable by anybody
-- holding the anon key the moment somebody grants select on it for an unrelated reason.
-- This one holds a list of every account's email status, which is a membership list.
-- ---------------------------------------------------------------------------

alter table welcome_emails enable row level security;

revoke all on welcome_emails from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The two switches
--
-- Both are inserted at values that mean nothing happens, and both are `on conflict do
-- nothing` so that re-applying this file never re-arms a switch somebody turned off.
--
-- THE LITERALS BELOW ARE THE SAFE DEFAULTS AND ARE NOT A DEPLOYMENT DECISION. Turning
-- the job on is two `update`s, made deliberately, after the workflow has been run by
-- hand at least once. See README.md step 5.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values

  -- The emergency stop. Read once at the top of every run, before anything is claimed,
  -- so a disabled run consumes nothing and every eligible account is still eligible when
  -- it is turned back on.
  --
  -- Gate at claim time and hold rather than drop. That rule is not a preference: it is
  -- what `push.delivery_enabled` got wrong, where a flag existed for two weeks and was
  -- never actually read by the code it was meant to gate.
  ('welcome.delivery_enabled', 'false'::jsonb),

  -- Only accounts created at or after this are ever selected.
  --
  -- 2099 rather than null, because null would have meant "no lower bound" and the first
  -- run would have mailed everybody who has ever signed up. This is the reason turning
  -- the automation on cannot reach the existing user base: every account that exists
  -- today predates any real value this will be set to.
  ('welcome.start_after', '"2099-01-01T00:00:00Z"'::jsonb),

  -- How long after signup. Hours rather than days so the evening-after timing is
  -- adjustable without a code change.
  ('welcome.delay_hours', '36'::jsonb),

  -- Per run, so a first real run cannot become a hundred messages while somebody is
  -- watching the wrong tab.
  ('welcome.max_per_run', '25'::jsonb)

on conflict (key) do nothing;
