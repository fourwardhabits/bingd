-- Social graph: follows, blocks, and the single visibility rule.
-- Specification: docs/architecture/data-model.md §3 · PRD §22

-- One table rather than a separate requests table. A follow of a public account
-- is inserted as 'approved'; a follow of a private account as 'pending'. The
-- state transition is the whole difference, and splitting it would double every
-- follower query.
create table follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid not null references profiles(id) on delete cascade,
  state       follow_state not null,
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

create index follows_followee_state on follows (followee_id, state);
create index follows_follower_state on follows (follower_id, state);

create table blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create index blocks_blocked on blocks (blocked_id);

-- ---------------------------------------------------------------------------
-- The visibility helper
--
-- PRD §22 requires blocking to affect feed, leaderboard, discovery, match,
-- tagging, and public pages at once. That rule exists exactly once, here, and
-- every read policy on user-visible content calls it.
--
-- The block test precedes the public test, so a block overrides public
-- visibility. That ordering is the behaviour PRD §22 requires and the easiest
-- thing in the whole schema to get backwards.
-- ---------------------------------------------------------------------------

create or replace function can_view_profile(viewer uuid, subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when viewer is null then
      -- Unauthenticated: public profiles only. Blocks are irrelevant with no
      -- viewer identity, and private content must never be exposed.
      (select visibility from profiles where id = subject) = 'public'
    when viewer = subject then true
    when exists (
      select 1 from blocks
       where (blocker_id = viewer  and blocked_id = subject)
          or (blocker_id = subject and blocked_id = viewer)
    ) then false
    when (select visibility from profiles where id = subject) = 'public' then true
    else exists (
      select 1 from follows
       where follower_id = viewer and followee_id = subject and state = 'approved'
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table follows enable row level security;
alter table blocks  enable row level security;

-- Now that the helper exists, profile reads use it. This replaces the
-- owner-only floor set in the identity migration.
drop policy profiles_read_own on profiles;

create policy profiles_read on profiles for select
  using (can_view_profile(auth.uid(), id));

create policy username_history_read on username_history for select
  using (can_view_profile(auth.uid(), profile_id));

-- A user sees follow edges they are part of, plus edges involving profiles they
-- can already see. Pending requests are visible to both parties only.
create policy follows_read on follows for select
  using (
    follower_id = auth.uid()
    or followee_id = auth.uid()
    or (state = 'approved'
        and can_view_profile(auth.uid(), follower_id)
        and can_view_profile(auth.uid(), followee_id))
  );

-- A block is visible only to the person who made it. The blocked party is never
-- told, which is the standard and safer behaviour.
create policy blocks_read on blocks for select
  using (blocker_id = auth.uid());
