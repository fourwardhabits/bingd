-- A sort that answers for itself, including when it is asked nothing.
-- Independent review of PR #126, 2026-09-08.
--
-- ===========================================================================
-- WHAT WAS WRONG, AND WHY IT WAS WORSE THAN A COSMETIC DEFECT
--
-- `20260911000100`'s `title_reviews_v2` claimed in its own comment that an unrecognised
-- sort "falls through to `top_desc` rather than erroring". It did not. The value was
-- read in six separate places -- one filter and five `order by` cases -- and every one
-- of them tested it against an explicit list, so a value on none of those lists simply
-- matched nothing:
--
--   * an unknown non-null value, `'sideways'`, matched no ordering case and left the
--     list ordered by `um.user_id` alone. Deterministic, and meaningless.
--
--   * **`null` was the real defect.** The Following filter read
--
--         p_sort <> 'following' or exists (...)
--
--     and `null <> 'following'` is `null`, not `true`. So the whole disjunction fell to
--     whatever `exists` said, and a caller who passed no sort at all -- or a PostgREST
--     client that sent an explicit `null` -- silently got **the Following filter**:
--     everything by anybody they did not follow disappeared, with no error and nothing
--     to see it by. A filter that applies itself when nobody asked is the worst shape a
--     defect can have on a read: the page looks fine and is answering a different
--     question.
--
-- The test that was supposed to cover this asked only that an unknown sort returned
-- three rows, which it did -- in the wrong order, for the wrong reason.
--
-- ---------------------------------------------------------------------------
-- THE FIX IS TO DECIDE ONCE
--
-- `sort` is now resolved a single time in a CTE and every later reference reads the
-- resolved value, so there is one place where "what did the caller mean" is answered and
-- it cannot disagree with itself. `else 'top_desc'` catches the unknown value, the empty
-- string and `null` together, because a `case` with no matching `when` takes the `else`
-- branch for a null subject as readily as for any other.
--
-- **A new migration rather than an edit.** `20260911000100` is already applied to
-- staging, and a file whose text no longer matches what a database recorded applying is
-- the drift this project spent a day removing. `create or replace function` makes the
-- correction idempotent, so a database that never saw the first version and one that did
-- both end here.
--
-- Nothing else moves: same signature, same columns, same visibility predicate, same
-- grants. `title_reviews` -- the one the public build calls -- is untouched by both files.
-- ===========================================================================
create or replace function title_reviews_v2(
  p_media_item_id uuid,
  /**
   * `top_desc` | `top_asc` | `following` | `recent_desc` | `recent_asc`.
   *
   * `top` and `recent` are accepted as their descending senses. **Anything else --
   * including null -- is `top_desc`**, decided once below rather than six times.
   */
  p_sort          text default 'top_desc',
  p_limit         integer default 25
)
returns table (
  id             uuid,
  user_id        uuid,
  username       text,
  display_name   text,
  avatar_path    text,
  note           text,
  has_spoilers   boolean,
  updated_at     timestamptz,
  score          numeric,
  reaction_count integer,
  helpful_count  integer,
  viewer_helpful boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with resolved as (
    select case
             when p_sort in ('top_desc', 'top_asc', 'following', 'recent_desc', 'recent_asc')
               then p_sort
             when p_sort = 'top'    then 'top_desc'
             when p_sort = 'recent' then 'recent_desc'
             -- Unknown, empty, and null all land here.
             else 'top_desc'
           end as sort
  )
  select um.id,
         um.user_id,
         p.username::text,
         p.display_name,
         p.avatar_path,
         um.note,
         um.note_has_spoilers,
         um.note_updated_at,
         (select score_for(r.bucket, (r.position - bb.lo + 1)::integer, bb.size)
            from rankings r
            join lateral band_bounds(r.user_id, r.category, r.bucket) bb on true
           where r.user_id = um.user_id
             and r.media_item_id = um.media_item_id),
         reacted.n,
         helpful.n,
         helpful.mine
    from resolved s
    cross join user_media um
    join profiles p on p.id = um.user_id
    left join lateral (
      select fe.id
        from feed_events fe
       where fe.actor_id = um.user_id
         and fe.media_item_id = um.media_item_id
         and fe.type = 'title_ranked'
       order by fe.created_at desc, fe.id desc
       limit 1
    ) latest on true
    left join lateral (
      select count(*)::integer as n
        from reactions re
       where re.feed_event_id = latest.id
    ) reacted on true
    left join lateral (
      select count(*)::integer as n,
             bool_or(v.user_id = auth.uid()) as mine
        from review_helpful_votes v
       where v.review_id = um.id
    ) helpful on true
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     and can_view_profile(auth.uid(), um.user_id)
     -- `s.sort` is never null, so this disjunction can no longer collapse to null and
     -- filter the list nobody asked to filter.
     and (s.sort <> 'following' or exists (
           select 1 from follows f
            where f.follower_id = auth.uid()
              and f.followee_id = um.user_id
              and f.state = 'approved'))
   order by
     case when s.sort in ('top_desc', 'following') then coalesce(helpful.n, 0) end desc nulls last,
     case when s.sort = 'top_asc' then coalesce(helpful.n, 0) end asc nulls last,
     case when s.sort in ('top_desc', 'following', 'recent_desc') then um.note_updated_at end desc nulls last,
     case when s.sort in ('top_asc', 'recent_asc') then um.note_updated_at end asc nulls last,
     um.user_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

comment on function title_reviews_v2(uuid, text, integer) is
  'The Reviews tab, with the Helpful count and the caller''s own vote (20260911000100, sort resolution corrected in 20260911000200). Everything title_reviews returns, plus helpful_count and viewer_helpful, plus five sorts: top_desc (the default: Helpful then newest), top_asc, following (a FILTER over approved follows, ordered like top_desc), recent_desc and recent_asc. Legacy top/recent are the descending senses, and anything else -- including null -- resolves to top_desc, decided once so that an unrecognised value cannot silently apply the Following filter. A NEW function rather than a replacement or an overload because the return shape grew and the public build calls the old one: title_reviews is untouched, still granted, and must not be dropped while a build that calls it is installed. Same visibility predicate as title_reviews and public_notes: a private note is not reachable from here.';

revoke execute on function title_reviews_v2(uuid, text, integer) from public, anon;
grant  execute on function title_reviews_v2(uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- And the claim about replays, corrected in words rather than in behaviour.
--
-- Review also found that `set_review_helpful`'s comment overstated its idempotency. The
-- authorization checks run BEFORE `_claim_operation`, which is the right order --
-- reversing it would let a suspended or blocked caller consume an operation id -- but it
-- means a replay is only reported as a success while the target is *still* reachable. If
-- the author made the review private, blocked the caller, or deleted it between the lost
-- response and the retry, the retry is refused rather than confirmed.
--
-- That is a safe failure: it refuses, it never double-counts (the primary key sees to
-- that), and it cannot be used to learn anything, because the refusal is the same
-- indistinguishable one every unreachable target gets. The ledger stores only the
-- operation kind, so answering a replay before re-authorizing would mean trusting a row
-- that does not know which review it was about. The comment now says what the function
-- does instead of what would be convenient.
-- ---------------------------------------------------------------------------
comment on function set_review_helpful(uuid, uuid, boolean) is
  'Marks one public review Helpful, or takes it back (20260911000100). Positive only. Refuses with an identical "no such review" for a note that does not exist, is private, belongs to a blocked or suspended account, or belongs to a profile this caller may not read -- so the RPC cannot be used to detect a private note. Refuses a caller''s own review separately, which discloses nothing they do not already know. Authorization runs BEFORE the operation ledger, deliberately: a replayed operation id is reported as the success it already was only while the target is still reachable, and is refused rather than confirmed if the review has since been made private, blocked or deleted. It can never apply twice -- the primary key decides that, not the ledger. Returns the count and the caller''s own state, so the client never computes either.';
