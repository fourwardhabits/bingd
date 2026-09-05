-- ===========================================================================
-- A NAME YOU COULD ALREADY LOOK UP
--
-- `20260830000100` made a mention answer to two populations: people the author
-- follows, and people already in the conversation. `20260908000100` then made
-- the *body* the source of who is named, which turned that narrowness into
-- something a reader can trip over -- you type a handle you know is real,
-- because you searched for it five minutes ago, and nothing happens. No error,
-- no suggestion, no notification. The founder has widened the rule.
--
-- ===========================================================================
-- THE RULE IS THE ONE THAT ALREADY EXISTS
--
-- The new contract is "anybody the author is legitimately allowed to discover",
-- and the important word is *allowed*, not *anybody*. bingd already has exactly
-- one predicate for that question and it is not new here:
--
--     can_discover_profile(viewer, subject)   -- 20260819000100
--
-- It is what People search filters on, and it was written for precisely this
-- distinction. `20260819000100`'s header states it: **private means "my activity
-- is private", not "nobody can find me"**. A private account is findable by name
-- so that somebody who knows them can ask to follow; everything they wrote stays
-- behind `can_view_profile`. Identity is reachable, content is not.
--
-- Reusing it rather than restating it is the whole of this migration's design.
-- A second copy of a privacy rule is a second thing to forget to update, and
-- `_can_mention` was already carrying three clauses -- self, blocks, suspension
-- -- that `can_discover_profile` decides in one place:
--
--   | Case                          | can_discover_profile |
--   |-------------------------------|----------------------|
--   | yourself                      | false                |
--   | blocked, either direction     | false                |
--   | suspended or deleted          | false                |
--   | private, no relationship      | **true** -- findable |
--   | anybody else active           | true                 |
--
-- So the three exclusions the founder asked to keep are kept by *deleting* their
-- open-coded copies, not by leaving them beside a predicate that repeats them.
--
-- ===========================================================================
-- WHAT STOPS THIS BEING "EVERYBODY, EVERYWHERE"
--
-- `can_discover_profile` alone would make every active unblocked account
-- nameable on every activity, and that is not what is being shipped. The second
-- clause of `_can_mention` is untouched and is what bounds it:
--
--     the mentioned person must be able to see the activity themselves
--     -- can_view_profile(p_mentioned, e.actor_id), from *their* side
--
-- That is the condition about the third party rather than the author, and it is
-- the one it is easiest to drop. Without it a mention is a way to tell somebody
-- that a private account ranked a particular title: the notification names the
-- actor and the title and would arrive for a person entitled to read neither.
--
-- The practical shape of the two clauses together:
--
--   - on a **public** activity, anybody the author could find in People search;
--   - on a **private** actor's activity, only that actor's own followers --
--     which is the same set that can see the post being commented on.
--
-- The ceiling of ten per comment (`mentions.max_per_comment`) does more work now
-- than it did and is deliberately unchanged. It was an anti-enumeration bound
-- when the population was a follow list; it is the anti-abuse bound now.
--
-- ===========================================================================
-- THREE FUNCTIONS, AND WHY THE OTHER TWO CANNOT BE LEFT BEHIND
--
-- 1. `_can_mention` -- the rule itself.
--
-- 2. `mention_candidates` -- the autocomplete. Its population was *constructed*
--    from follows and participants rather than filtered down to them, on
--    `20260830000100`'s argument that "a stranger is not a low-ranked row here,
--    they are not a row". That argument was correct for a rule whose answer was
--    the follow graph and is wrong for this one: it would leave somebody
--    server-mentionable but unfindable by typing their exact handle, which is
--    the worst of both -- the feature works and the composer says it does not.
--
--    The fix keeps the restraint where it mattered. **An empty fragment still
--    offers only follows and participants**, because the list that appears the
--    instant you type `@` should be the people you are likely to mean, not a
--    slice of the user table. A non-empty fragment additionally searches
--    discoverable profiles by prefix, on the same columns and with the same
--    `can_discover_profile` filter `search_users` uses. You have to type a name
--    to be shown a stranger, which is what typing a name means.
--
-- 3. `activity_comments` -- the read. Its `mentioned` CTE filtered identities
--    through `can_view_profile`, which was invisible while every mention was a
--    follow or a participant and is a regression the moment one is not: a valid
--    mention of a discoverable-but-private account would fire a notification and
--    then render as plain text. It moves to `can_discover_profile`, which is the
--    same identity-versus-content line `20260819000100` drew.
--
-- ===========================================================================
-- WHAT IS NOT TOUCHED
--
-- `can_discover_profile`, `can_view_profile`, `search_users`, every RLS policy,
-- `comment_mentions` and its `active`/`handle`/`notified_at` columns, the
-- once-ever claim, `_apply_comment_mentions`, `_resolve_comment_mentions`,
-- `_mentioned_handles`, `_add_comment`, `_edit_comment`, `my_notifications`,
-- `claim_push_batch`, the push copy and the routing. No privacy rule is
-- rewritten here; one is reused in a third place.
--
-- **Self is still excluded from the ledger.** `can_discover_profile` answers
-- false for yourself, so a self-mention files no row and notifies nobody, which
-- is the requirement. It therefore also does not render as a link. Naming
-- yourself is the one case where the composer and the reader disagree, and
-- letting a self-row into the ledger to fix the cosmetics would put a row whose
-- whole purpose is to notify into a table that exists to record who was
-- notified. Left as it is, deliberately.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The rule
-- ---------------------------------------------------------------------------

/**
 * Whether the caller may name this person in a comment on this activity.
 *
 * Two conditions, and they are about different people:
 *
 *   a. **the author may discover them** -- `can_discover_profile`, the same oracle
 *      People search runs on. This replaces `20260830000100`'s followed-or-participant
 *      union, and it absorbs that function's separate self, block and suspension tests:
 *      all three are cases `can_discover_profile` already answers false for. A follow
 *      and a participant both still pass, because an active unblocked account is
 *      discoverable whether or not there is a relationship.
 *
 *   b. **they may see the activity** -- `can_view_profile(p_mentioned, e.actor_id)`,
 *      from their side rather than the caller's, and unchanged since 20260830000100.
 *      This is what stops a mention being a way to tell somebody what a private account
 *      watched, and it is what keeps (a) from meaning "everybody".
 *
 * The block check that used to be written here read through `blocked_between` rather
 * than `blocks`, because `blocks_read` hides a block from the person it was made
 * against and an inline subquery would answer false for exactly the caller who must be
 * refused. That reasoning is preserved rather than lost: `can_discover_profile` is
 * `security definer`, so its own read of `blocks` is not filtered by that policy
 * either.
 */
create or replace function _can_mention(p_feed_event_id uuid, p_mentioned uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_mentioned is not null
     -- Self, blocks in either direction, and any account that is not active. One call,
     -- one definition, and the same one the People tab answers to.
     and can_discover_profile(auth.uid(), p_mentioned)
     -- The mentioned person can see the activity. Their view, not the caller's:
     -- a mention must never be a way to tell somebody what a private account did.
     and exists (
       select 1 from feed_events e
        where e.id = p_feed_event_id
          and can_view_profile(p_mentioned, e.actor_id)
     );
$$;

comment on function _can_mention(uuid, uuid) is
  'Whether the caller may name this person in a comment on this activity: somebody the caller may discover (can_discover_profile -- so not themselves, not blocked either way, not suspended, and private accounts included, exactly as People search treats them) who can also see the activity from their own side. Widened from the followed-or-participant union on 20260909000100; the second clause is unchanged and is what stops the first meaning everybody, since only an actor''s followers can see a private actor''s post. Internal: it answers questions about what a named third party can see.';

-- ---------------------------------------------------------------------------
-- 2. The autocomplete, so the composer and the server agree
--
-- Rebuilt from 20260830000100. The select list, the participant flag, the sort,
-- the limit, the definer-and-silent-to-a-stranger behaviour and the prefix-only
-- matching are all its, verbatim. What changes is the population.
-- ---------------------------------------------------------------------------

/**
 * Who the composer may offer, for one activity and one typed fragment.
 *
 * Three sources now, and the third is gated on the reader having typed something:
 *
 *   - **participants** -- the actor and anybody who has commented. Sorted first,
 *     because in a conversation the person you are most likely to be answering is
 *     already in it.
 *   - **followed** -- approved, one direction.
 *   - **discoverable** -- anybody else whose handle or display name starts with the
 *     fragment, filtered through `can_discover_profile`, which is `search_users`'
 *     own predicate. **Only when the fragment is non-empty.**
 *
 * That last restriction is the founder's restraint clause surviving the widening.
 * Bare `@` still means "the people I am likely to mean" rather than a slice of the
 * user table; a stranger appears once you have typed enough of their name to have
 * meant them. Combined with prefix-only matching -- an infix match is a way to
 * enumerate accounts with a two-letter probe -- and the limit of ten, this is the same
 * exposure People search already has, reached through a different box.
 *
 * Every row still passes `_can_mention`, so the list and the write cannot disagree:
 * a name offered here is a name the server will accept, and a name the server would
 * accept is findable here by typing it.
 */
create or replace function mention_candidates(
  p_feed_event_id uuid,
  p_query         text default '',
  p_limit         integer default 8
)
returns table (
  id           uuid,
  username     text,
  display_name text,
  avatar_path  text,
  participant  boolean
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  event as (
    select e.id, e.actor_id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
  ),
  fragment as (
    -- Capped the way `search_users` caps its own query, and for its reason: nothing
    -- good comes of a 4kB search box.
    select btrim(left(coalesce(p_query, ''), 100)) as q
  ),
  participants as (
    select ev.actor_id as uid from event ev
    union
    select c.author_id from comments c, event ev where c.feed_event_id = ev.id
  ),
  followed as (
    select f.followee_id as uid
      from follows f, me
     where f.follower_id = me.id and f.state = 'approved'
  ),
  /**
   * The widening, and the `f.q <> ''` is the whole of the restraint.
   *
   * Bounded before `_can_mention` runs rather than after: the oracle is a function
   * call per row, and this is the one source that could otherwise offer it the whole
   * profiles table. The limit is generous against the outer one so that ranking by
   * participant-first still has something to choose from.
   */
  discoverable as (
    select p.id as uid
      from profiles p, fragment f, event ev
     where f.q <> ''
       and (
         p.username::text ilike f.q || '%'
         or coalesce(p.display_name, '') ilike f.q || '%'
         -- Any word of the display name, so "Abi Sola" answers to `@sola`.
         or coalesce(p.display_name, '') ilike '% ' || f.q || '%'
       )
       and can_discover_profile((select id from me), p.id)
     order by p.username
     limit 50
  ),
  candidates as (
    select uid, true as participant from participants
    union all
    select uid, false from followed where uid not in (select uid from participants)
    union all
    select uid, false from discoverable
     where uid not in (select uid from participants)
       and uid not in (select uid from followed)
  )
  select p.id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         bool_or(c.participant)
    from candidates c
    join profiles p on p.id = c.uid
    cross join fragment f
   where _can_mention(p_feed_event_id, p.id)
     and (
       f.q = ''
       or p.username::text ilike f.q || '%'
       or coalesce(p.display_name, '') ilike f.q || '%'
       or coalesce(p.display_name, '') ilike '% ' || f.q || '%'
     )
   group by p.id, p.username, p.display_name, p.avatar_path
   order by bool_or(c.participant) desc, p.username
   limit least(greatest(coalesce(p_limit, 8), 1), 10);
$$;

comment on function mention_candidates(uuid, text, integer) is
  'Who the comment composer may offer for one activity and one typed fragment: the conversation''s participants, the people the caller follows, and -- since 20260909000100, and only once a fragment has been typed -- anybody else the caller could find in People search, each passed through _can_mention. A bare @ still offers only participants and follows, so the list that appears mid-word is people you are likely to mean rather than a slice of the user table. Prefix matching only, on the handle or on any word of the display name, because an infix match is a way to enumerate accounts with a two-letter probe. Returns nothing at all to a caller who cannot see the activity.';

-- ---------------------------------------------------------------------------
-- 3. The read, so a valid mention is drawn as one
--
-- Rebuilt in full from 20260830000100 -- every line below is that migration's
-- except the one predicate marked in place, which is the discipline
-- 20260817000200 and 20260826000600 both record: a `create or replace`
-- assembled from the wrong ancestor is how hardening disappears without showing
-- in a diff.
-- ---------------------------------------------------------------------------

create or replace function activity_comments(p_feed_event_id uuid)
returns table (
  id             uuid,
  parent_id      uuid,
  author_id      uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  body           text,
  has_spoilers   boolean,
  created_at     timestamptz,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  reaction_count integer,
  reacted_by_me  boolean,
  reaction_kinds text[],
  my_reaction    text,
  /**
   * Who this comment currently names:
   * `[{"id": ..., "username": ..., "handle": ...}, ...]`.
   *
   * `username` is what they are called now; `handle` is what this comment's body spells,
   * frozen when the mention was applied. They differ exactly when somebody has renamed
   * since, and the composer needs both — see `comment_mentions.handle`.
   *
   * Filtered through the same `can_view_profile` every other identity here is,
   * so a mention of somebody this reader has blocked is absent rather than
   * rendered as a name they should not be shown. Empty array, never null, so the
   * client has one shape to read.
   *
   * A retracted comment reports none. Its text has gone; the row survives only
   * to hold replies, and a tombstone that still listed the people it named would
   * be leaking half of what was retracted.
   */
  mentions       jsonb
)
language sql stable security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  event as (
    select e.id
      from feed_events e, me
     where e.id = p_feed_event_id
       and can_view_profile(me.id, e.actor_id)
  ),
  rows as (
    select c.* from comments c, event where c.feed_event_id = event.id
  ),
  authors as (
    select p.id, p.username::text as username, p.display_name, p.avatar_path
      from profiles p, me
     where p.id in (select distinct r.author_id from rows r)
       and can_view_profile(me.id, p.id)
  ),
  reactors as (
    select p.id
      from profiles p, me
     where p.id in (
             select distinct cr.user_id
               from comment_reactions cr
               join rows r on r.id = cr.comment_id
           )
       and can_view_profile(me.id, p.id)
  ),
  visible as (
    select cr.comment_id, cr.user_id, cr.kind
      from comment_reactions cr
      join rows r on r.id = cr.comment_id
      join reactors rv on rv.id = cr.user_id
  ),
  -- Each mentioned person once, at the same arity as the authors and reactors
  -- above and for the same reason: one oracle call per distinct person, not one
  -- per mention row.
  mentioned as (
    select p.id, p.username::text as username
      from profiles p, me
     where p.id in (
             select distinct m.mentioned_id
               from comment_mentions m
               join rows r on r.id = m.comment_id
              where m.active
           )
       -- **Identity, not content, and that is why this one line differs from the two
       -- above.** `authors` and `reactors` stay on `can_view_profile` because a name
       -- attached to somebody's writing on a private account is a fact about that
       -- account. A mention is the reader being told who a comment *names*, and the
       -- three fields carried are the id, the handle and the frozen spelling — exactly
       -- the set `20260819000100` established is reachable for any discoverable
       -- account, and exactly what People search already returns.
       --
       -- Left on `can_view_profile` this would have been a visible regression from
       -- `20260909000100` rather than a theoretical one: a mention of a private
       -- account the reader does not follow is now a *valid* mention that fires a
       -- notification, and it would have rendered as plain text in the one place the
       -- comment is read.
       --
       -- `me.id = p.id` first because `can_discover_profile` answers false for
       -- yourself — correctly, since finding yourself is not discovery — and a reader
       -- must see their own name light up in a comment that names them.
       and (me.id = p.id or can_discover_profile(me.id, p.id))
  ),

  live_roots as (
    select r.id
      from rows r
     where r.deleted_at is null
        or exists (
             select 1
               from rows reply
               join authors a on a.id = reply.author_id
              where reply.parent_id = r.id
                and reply.deleted_at is null
           )
  )
  select r.id,
         r.parent_id,
         r.author_id,
         a.username,
         a.display_name,
         a.avatar_path,
         case when r.deleted_at is null then r.body end,
         r.has_spoilers,
         r.created_at,
         r.edited_at,
         r.deleted_at,
         (select count(*)::integer from visible v where v.comment_id = r.id),
         exists (
           select 1 from visible v, me where v.comment_id = r.id and v.user_id = me.id
         ),
         (select coalesce(array_agg(k.kind order by k.n desc, k.kind), '{}'::text[])
            from (
              select v.kind, count(*) as n
                from visible v
               where v.comment_id = r.id
               group by v.kind
            ) k),
         (select v.kind from visible v, me where v.comment_id = r.id and v.user_id = me.id),
         case
           when r.deleted_at is not null then '[]'::jsonb
           else coalesce(
             (select jsonb_agg(jsonb_build_object(
                                 'id', mp.id,
                                 'username', mp.username,
                                 -- What the body spells, which is not always what the
                                 -- person is called now. See the column's own comment.
                                 'handle', m.handle)
                               order by mp.username)
                from comment_mentions m
                join mentioned mp on mp.id = m.mentioned_id
               where m.comment_id = r.id and m.active),
             '[]'::jsonb)
         end
    from rows r
    join authors a on a.id = r.author_id
    join live_roots lr on lr.id = coalesce(r.parent_id, r.id)
   order by coalesce(r.parent_id, r.id), (r.parent_id is not null), r.created_at, r.id;
$$;

comment on function activity_comments(uuid) is
  'One activity''s whole conversation, in one call. Definer, and answers nothing at all to a caller who cannot see the activity. Author and reactor identities are filtered through can_view_profile; the mention array is filtered through can_discover_profile since 20260909000100, because a mention carries identity rather than content and a valid mention of a discoverable private account must still render as a link. A retracted comment reports an empty mention array and a null body. Mentions carry both the current username and the frozen handle the body spells (20260830000100).';

-- ---------------------------------------------------------------------------
-- 4. Grants
--
-- `_can_mention` stays internal. `mention_candidates` and `activity_comments`
-- stay granted to `authenticated` and nobody else -- restated rather than
-- assumed, because `create or replace` on a definer is exactly where an ACL has
-- silently gone missing in this repo before (20260830000100, section 8, and the
-- `drop function` that took its grants with it).
-- ---------------------------------------------------------------------------

revoke execute on function _can_mention(uuid, uuid) from public, anon, authenticated;

grant execute on function mention_candidates(uuid, text, integer) to authenticated;
grant execute on function activity_comments(uuid)                 to authenticated;
