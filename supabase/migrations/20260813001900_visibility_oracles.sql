-- Close two social-graph oracles created by policy-helper signatures.
-- Specification: docs/architecture/data-model.md §3, AD-5
-- Found by: independent review 2026-08-13 (blocked_between), and by generalising
-- that finding to can_view_profile, which turned out to be the worse of the two.

-- ---------------------------------------------------------------------------
-- The shape of the problem
--
-- A row level security policy is evaluated as the *querying* role. So any helper
-- a policy calls must be executable by client roles — that part is unavoidable,
-- and 20260813001800 grants it deliberately.
--
-- What is avoidable is the helper's *signature*. These helpers are SECURITY
-- DEFINER precisely so they can see tables the caller cannot: `blocked_between`
-- exists because `blocks_read` hides a block from the person it was made against,
-- and an inline subquery would therefore return false for exactly the caller who
-- should be denied. Correct reasoning. But combining "bypasses RLS" with "accepts
-- the identity to check as an argument" produces an endpoint that answers
-- questions about other people:
--
--     select blocked_between('<carol>', '<alice>');   -- true
--     select can_view_profile('<alice>', '<bob>');    -- true
--
-- Both callable by `anon`. Profile ids are readable from `public_profiles`, so
-- the pairs are enumerable, and the answers reconstruct private structure:
--
--   blocked_between   discloses the block graph outright — the one thing
--                     blocks_read exists to keep private.
--
--   can_view_profile  is worse, and was not in the review's findings. Its answer
--                     folds together suspension, blocks, public visibility and
--                     *approved follows*. Ask it about a private subject and a
--                     `true` means the named viewer is an approved follower. That
--                     is a private relationship between two other people,
--                     readable by a stranger with only the anon key.
--
-- Neither is exploitable for writes and neither exposes content. They leak who
-- is connected to whom, which for this product is among the more sensitive
-- things in the database.
--
-- The fix is not to revoke — policies genuinely need these. It is to stop the
-- signature accepting an identity, so the only question a caller can pose is
-- about themselves. `auth.uid()` cannot be forged; an argument can.
-- ---------------------------------------------------------------------------

-- The client-reachable form of AD-5's single visibility rule. Same logic, no
-- viewer parameter: the perspective is always the caller's own. The two-argument
-- version stays for server-side use, where a definer function running as the
-- owner legitimately asks about arbitrary pairs.
create or replace function can_i_view(subject uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select can_view_profile(auth.uid(), subject);
$$;

comment on function can_i_view is
  'AD-5 visibility from the caller''s own perspective. Policies must call this rather than can_view_profile(auth.uid(), x): a definer helper that accepts a viewer lets any caller substitute someone else and read approved-follow and block relationships between third parties.';

-- Tag visibility, resolved from the row's identifier rather than from its columns.
--
-- Passing tagger_id and tagged_id as arguments would not have helped: a caller
-- could hold `removed_by_tagged` false, choose a tagger with a public profile,
-- and isolate the block bit from the result. Taking the primary key instead means
-- the caller can only ask about tags that exist, and the single boolean folds the
-- block, removal and visibility conditions together — which is exactly what the
-- policy already reveals by returning the row or not.
--
-- No recursion: this is SECURITY DEFINER, so the inner read of watch_tags runs as
-- the table owner and the policy below is not re-evaluated. That would stop being
-- true under `force row level security`, which is a reason not to set it here.
create or replace function watch_tag_visible(tag_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((
    select not blocked_between(t.tagger_id, t.tagged_id)
       and (
         t.tagger_id = auth.uid()
         or t.tagged_id = auth.uid()
         or (not t.removed_by_tagged and can_view_profile(auth.uid(), t.tagger_id))
       )
      from watch_tags t
     where t.id = tag_id
  ), false);
$$;

comment on function watch_tag_visible is
  'Whether the caller may see one watch tag. Takes the row id, not the parties, so it cannot be used to test a block between two chosen users — which is what granting blocked_between to clients allowed.';

-- ---------------------------------------------------------------------------
-- Every policy that named the two-argument form
--
-- Ten policies across six migrations. Each is recreated with identical logic and
-- the viewer-less helper. A missed one does not degrade quietly: revoking EXECUTE
-- below makes it raise `permission denied for function`, failing the whole query
-- rather than filtering it, which the tests in oracles.test.mjs check for.
-- ---------------------------------------------------------------------------

-- 20260813000300 — identity and social graph
drop policy profiles_read on profiles;
create policy profiles_read on profiles for select
  using (can_i_view(id));

drop policy username_history_read on username_history;
create policy username_history_read on username_history for select
  using (can_i_view(profile_id));

drop policy follows_read on follows;
create policy follows_read on follows for select
  using (
    follower_id = auth.uid()
    or followee_id = auth.uid()
    or (state = 'approved'
        and can_i_view(follower_id)
        and can_i_view(followee_id))
  );

-- 20260813000500 — collection
drop policy rankings_read on rankings;
create policy rankings_read on rankings for select
  using (can_i_view(user_id));

-- 20260813000600 — feed
drop policy feed_events_read on feed_events;
create policy feed_events_read on feed_events for select
  using (can_i_view(actor_id));

drop policy reactions_read on reactions;
create policy reactions_read on reactions for select
  using (
    can_i_view(user_id)
    and exists (
      select 1 from feed_events e
       where e.id = feed_event_id
         and can_i_view(e.actor_id)
    )
  );

-- 20260813001100 — match scores
drop policy match_scores_read on match_scores;
create policy match_scores_read on match_scores for select
  using (
    (user_a = auth.uid() and can_i_view(user_b))
    or (user_b = auth.uid() and can_i_view(user_a))
  );

-- 20260813001400 — lists, list items, watch tags
drop policy lists_read on lists;
create policy lists_read on lists for select
  using (
    owner_id = auth.uid()
    or (visibility = 'public' and can_i_view(owner_id))
  );

drop policy list_items_read on list_items;
create policy list_items_read on list_items for select
  using (exists (
    select 1 from lists l
     where l.id = list_id
       and (
         l.owner_id = auth.uid()
         or (l.visibility = 'public' and can_i_view(l.owner_id))
       )
  ));

drop policy watch_tags_read on watch_tags;
create policy watch_tags_read on watch_tags for select
  using (watch_tag_visible(id));

-- ---------------------------------------------------------------------------
-- Withdraw the argument-taking forms from clients
--
-- Both remain in use server-side, called from inside SECURITY DEFINER functions
-- (can_i_view, watch_tag_visible, list_by_id, list_items_by_list), which execute
-- as the owner and need no grant. Nothing that legitimately depends on them
-- breaks; only the ability to ask about someone else goes away.
-- ---------------------------------------------------------------------------

revoke execute on function can_view_profile(uuid, uuid) from public, anon, authenticated;
revoke execute on function blocked_between(uuid, uuid)  from public, anon, authenticated;

grant execute on function can_i_view(uuid)         to anon, authenticated;
grant execute on function watch_tag_visible(uuid)  to anon, authenticated;

comment on function can_view_profile(uuid, uuid) is
  'AD-5''s single visibility rule. Server-side only: it takes a viewer, so exposing it to clients turns it into a follow-graph and block-graph oracle. Clients call can_i_view(subject).';

comment on function blocked_between(uuid, uuid) is
  'True when either party has blocked the other. Must be SECURITY DEFINER, because blocks_read hides a block from the person it was made against and an inline subquery in a policy would return false for precisely the caller who should be denied. Server-side only for the same reason can_view_profile is: it names both parties, so a client grant discloses the block graph. Reached from watch_tag_visible(tag_id).';
