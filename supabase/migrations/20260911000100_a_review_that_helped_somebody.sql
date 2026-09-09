-- A review that helped somebody, and a way to say so.
-- Founder decision, 2026-09-08.
--
-- ===========================================================================
-- WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
--
-- `20260817001000` made the Reviews tab Bingd's own writing rather than TMDB's, and
-- `20260825000100` gave it `title_reviews`. What it has never had is a reason for one
-- review to appear above another. `p_sort = 'top'` orders by **reactions on the ranking
-- activity the note belongs to**, which is a signal about the *ranking* -- who hearted
-- somebody's 9.4 -- and not about the writing. A reader looking for the review worth
-- reading has been sorted by the wrong number since the tab existed.
--
-- So: one positive signal, attached to the review itself.
--
--   Helpful.
--
-- **There is no downvote and there will not be one.** A negative signal on somebody's
-- writing is a different product with a different moderation cost, and the founder's
-- brief rules it out by name. `report` already exists for writing that should not be
-- there; disagreement is what the comment thread is for.
--
-- ---------------------------------------------------------------------------
-- A REVIEW IS STILL A PUBLIC NOTE, WHICH IS THE WHOLE PRIVACY ARGUMENT
--
-- `user_media.note` holds both. `note_visibility` is the only thing separating a review
-- from a private note, and this migration does not add a second content model, a second
-- visibility model, or a second identity for a review. It adds votes on `user_media.id`
-- and then refuses to do anything with a row that is not public.
--
-- That refusal is stated once, in `_helpful_target`, and every path goes through it:
--
--     note is not null and note_visibility = 'public'
--       and can_view_profile(auth.uid(), author)
--
-- which is the predicate `title_reviews` and `public_notes` already share. Reusing the
-- expression rather than restating it is the point -- a private note is not "excluded
-- from Helpful" as a separate rule that could be forgotten, it is simply never a target.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW FUNCTION NAME RATHER THAN AN OVERLOAD OR A REPLACEMENT
--
-- There is a public App Store build (1.0.0 (7)) calling `title_reviews(uuid, text,
-- integer)` today and it must keep working exactly as it does. Three options, and only
-- one of them is safe:
--
--   - **Replace `title_reviews`.** Its return shape has to grow two columns, and a
--     `returns table` shape cannot be changed by `create or replace` -- it needs a drop,
--     and between the drop and the create the old client gets a 404. Worse, afterwards it
--     receives columns it does not know, and PostgREST hands the client whatever the
--     function returns.
--   - **Overload it.** `20260830000100` records what happens next: PostgREST resolves an
--     overload by argument names, and two candidates that differ only by a defaulted
--     parameter are ambiguous to it. `p_sort` and `p_limit` are already defaulted here,
--     so a fourth defaulted argument would make *both* signatures unresolvable and break
--     the old client and the new one together.
--   - **A second function.** `title_reviews_v2` exists alongside `title_reviews`, which
--     is untouched by this file -- not dropped, not redefined, not revoked. Build 7 keeps
--     calling the function it was compiled against, and it keeps getting the ten columns
--     it expects, in the order it expects them.
--
-- The old one is not deprecated here and must not be dropped while a build that calls it
-- is installed on somebody's phone.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The votes
--
-- `review_id` references `user_media(id)` -- the uuid `20260825000100` added and
-- `user_media_id_key` makes unique -- rather than the (user_id, media_item_id) primary
-- key, because that is the identity `title_reviews` already returns to the client. A
-- reader holding a review has its id and nothing else.
--
-- **The primary key is the uniqueness rule.** One person, one Helpful, per review: not a
-- constraint bolted onto a surrogate key but the key itself, so a duplicate is impossible
-- rather than merely rejected. It also indexes the count -- `where review_id = ?` is a
-- prefix scan -- which is the read this table exists to serve.
--
-- No `helpful_count` column anywhere. A denormalised count is a second source of truth
-- that a trigger has to keep in step, and at this scale counting the rows is cheaper than
-- being wrong. If the count ever needs caching it can be added behind these same
-- functions without a client knowing.
-- ---------------------------------------------------------------------------
create table review_helpful_votes (
  review_id  uuid not null references user_media(id) on delete cascade,
  user_id    uuid not null references profiles(id)   on delete cascade,
  created_at timestamptz not null default now(),
  primary key (review_id, user_id)
);

comment on table review_helpful_votes is
  'One reader saying one public review was useful (20260911000100). Positive only -- there is no downvote. Keyed (review_id, user_id) so a second Helpful from the same person is impossible rather than rejected, and so counting a review is a prefix scan. review_id is user_media.id, the identity title_reviews already hands the client. Cascades when the review row or either account goes. Never written by a client: the table is deny-all and set_review_helpful is the only writer.';

-- The FK on `user_id` has no index of its own -- the primary key leads with `review_id`
-- -- and an unindexed FK makes `delete from profiles` scan this table once per row.
create index review_helpful_votes_by_user on review_helpful_votes (user_id);

/**
 * Deny-all, like every other table whose reads belong to a function.
 *
 * RLS on with no policy is the pattern `push_outbox`, `comment_mentions`,
 * `feed_event_causes` and `award_tiers` already use: zero rows to any client role, and
 * the security-definer functions below are the only way in. That is what stops
 * `review_helpful_votes` from becoming an enumeration surface -- a reader who could
 * select from it could learn which `user_media.id`s exist, which is exactly the leak
 * `_helpful_target` is written to prevent one row at a time.
 */
alter table review_helpful_votes enable row level security;
revoke all on review_helpful_votes from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What may be voted on, decided once
-- ---------------------------------------------------------------------------
create or replace function _helpful_target(p_review_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select um.user_id
    from user_media um
   where um.id = p_review_id
     and um.note is not null
     and um.note_visibility = 'public'
     and can_view_profile(auth.uid(), um.user_id);
$$;

comment on function _helpful_target(uuid) is
  'The author of a public review the caller is allowed to read, or null for every other case (20260911000100). One expression answers "does it exist", "is it public", "may this caller see it" and "is the author blocked or suspended", and it is the predicate title_reviews and public_notes already share. Returning null rather than raising is deliberate: the caller learns nothing about WHICH of those failed, so a private note, a blocked author''s review and a uuid that was never a review are indistinguishable from outside. Internal.';

revoke execute on function _helpful_target(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The toggle
--
-- `p_operation_id` and `_claim_operation`, like every other outbox-eligible write since
-- `20260813002300`: a retry after a dropped response is the same Helpful, not a second
-- one. The primary key would make it idempotent anyway; the claim is what makes the
-- *reply* idempotent, which is what an offline client is actually reconciling against.
-- ---------------------------------------------------------------------------
create or replace function set_review_helpful(
  p_operation_id uuid,
  p_review_id    uuid,
  -- True marks it Helpful, false takes it back. One toggle, one grant, one operation
  -- kind -- the shape `set_reaction` established.
  p_helpful      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author  uuid;
  v_caller  uuid := auth.uid();
  v_count   integer;
  v_mine    boolean;
begin
  if v_caller is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- Suspension stops you saying things, not reading them (20260813001700), and marking
  -- a review Helpful is saying something. Before the target is even looked up, so a
  -- suspended account cannot use the refusals below as a probe either.
  perform assert_can_write();

  v_author := _helpful_target(p_review_id);

  /**
   * One refusal for every reason the target is not votable.
   *
   * Not found, not public, author blocked, author suspended, account private and the
   * caller not approved -- all of them arrive here as a null author and all of them leave
   * as the same sentence. Distinguishing them would turn this RPC into an oracle for
   * "is there a private note behind this id", which is the disclosure PRD 19 and
   * 20260828000400 exist to prevent.
   */
  if v_author is null then
    raise exception 'no such review' using errcode = 'P0002';
  end if;

  /**
   * Self-Helpful, refused separately and safely.
   *
   * This one CAN say what it means without leaking anything: the caller wrote the review,
   * so being told they cannot vote for it tells them only what they already know. The
   * check is on the author from `_helpful_target` rather than on a second read, so a row
   * that is not votable never reaches it.
   */
  if v_author = v_caller then
    raise exception 'you cannot mark your own review helpful' using errcode = '42501';
  end if;

  -- A replayed operation is reported as the success it already was, with the counts as
  -- they stand now rather than as they stood then.
  if _claim_operation(p_operation_id, 'set_review_helpful') then
    if coalesce(p_helpful, false) then
      insert into review_helpful_votes (review_id, user_id)
      values (p_review_id, v_caller)
      on conflict (review_id, user_id) do nothing;
    else
      delete from review_helpful_votes
       where review_id = p_review_id and user_id = v_caller;
    end if;
  end if;

  select count(*)::integer into v_count
    from review_helpful_votes where review_id = p_review_id;
  select exists(
    select 1 from review_helpful_votes
     where review_id = p_review_id and user_id = v_caller) into v_mine;

  return jsonb_build_object(
    'status', 'ok',
    'review_id', p_review_id,
    'helpful_count', v_count,
    'viewer_helpful', v_mine);
end;
$$;

comment on function set_review_helpful(uuid, uuid, boolean) is
  'Marks one public review Helpful, or takes it back (20260911000100). Positive only. Refuses with an identical "no such review" for a note that does not exist, is private, belongs to a blocked or suspended account, or belongs to a profile this caller may not read -- so the RPC cannot be used to detect a private note. Refuses a caller''s own review separately, which discloses nothing they do not already know. Idempotent on p_operation_id like every other outbox write, and idempotent again on the primary key. Returns the count and the caller''s own state, so the client never computes either.';

revoke execute on function set_review_helpful(uuid, uuid, boolean) from public, anon;
grant  execute on function set_review_helpful(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The tab's number
--
-- Separate from the list because the tab label needs it before the tab is opened, and
-- the alternative -- fetching 25 reviews to render the digit `4` -- is the N+1 shape one
-- level up. Same visibility predicate, so the count and the list can never disagree.
-- ---------------------------------------------------------------------------
create or replace function title_review_count(p_media_item_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from user_media um
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     and can_view_profile(auth.uid(), um.user_id);
$$;

comment on function title_review_count(uuid) is
  'How many public reviews of one title this caller may read (20260911000100), for the Reviews tab label. Exactly title_reviews_v2''s population and predicate, so the number on the tab and the rows behind it are the same question asked twice.';

revoke execute on function title_review_count(uuid) from public, anon;
grant  execute on function title_review_count(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The list, second version
--
-- `title_reviews` is NOT touched by this file. This is a second function with two more
-- columns and five sorts; see the header for why that is the only backward-compatible
-- shape.
-- ---------------------------------------------------------------------------
create or replace function title_reviews_v2(
  p_media_item_id uuid,
  /**
   * `top_desc` | `top_asc` | `following` | `recent_desc` | `recent_asc`.
   *
   * `top` and `recent` are accepted too and mean the descending sense, so the value an
   * older caller would send keeps its meaning if this function is ever reached by one.
   * An unrecognised value falls through to `top_desc` rather than erroring: a sort is a
   * presentation choice and returning the default list is a better answer than none.
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
    from user_media um
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
    -- Count and viewer state in one pass over the primary key rather than two
    -- correlated subqueries, so a wall of 25 reviews is 25 prefix scans and not 50.
    left join lateral (
      select count(*)::integer as n,
             bool_or(v.user_id = auth.uid()) as mine
        from review_helpful_votes v
       where v.review_id = um.id
    ) helpful on true
   where um.media_item_id = p_media_item_id
     and um.note is not null
     and um.note_visibility = 'public'
     -- Unchanged, and the reason a private note cannot be reached from here.
     and can_view_profile(auth.uid(), um.user_id)
     /**
      * Following is a FILTER, not a direction (founder, 2026-09-08).
      *
      * Approved follows only -- a pending request is not a following relationship, which
      * is the same reading `can_view_profile` takes of the same column. The viewer's own
      * review is not included: they do not follow themselves, and `no_self_follow` makes
      * that structural rather than incidental.
      */
     and (p_sort <> 'following' or exists (
           select 1 from follows f
            where f.follower_id = auth.uid()
              and f.followee_id = um.user_id
              and f.state = 'approved'))
   order by
     -- Helpful first, descending, for the default and for Following.
     case when p_sort in ('top_desc', 'top', 'following') then coalesce(helpful.n, 0) end desc nulls last,
     -- And ascending for the second tap on Top.
     case when p_sort = 'top_asc' then coalesce(helpful.n, 0) end asc nulls last,
     -- Recency carries the tiebreak in the matching direction, so the order is total
     -- rather than merely usually-stable.
     case when p_sort in ('top_desc', 'top', 'following', 'recent_desc', 'recent') then um.note_updated_at end desc nulls last,
     case when p_sort in ('top_asc', 'recent_asc') then um.note_updated_at end asc nulls last,
     -- The last resort, so two calls with the same data return the same order.
     um.user_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;

comment on function title_reviews_v2(uuid, text, integer) is
  'The Reviews tab, with the Helpful count and the caller''s own vote (20260911000100). Everything title_reviews returns, plus helpful_count and viewer_helpful, plus five sorts: top_desc (the default: Helpful then newest), top_asc, following (a FILTER over approved follows, ordered like top_desc), recent_desc and recent_asc. Legacy top/recent are accepted as the descending senses. A NEW function rather than a replacement or an overload because the return shape grew and the public build calls the old one -- title_reviews is untouched, still granted, and must not be dropped while a build that calls it is installed. Same visibility predicate as title_reviews and public_notes: a private note is not reachable from here.';

revoke execute on function title_reviews_v2(uuid, text, integer) from public, anon;
grant  execute on function title_reviews_v2(uuid, text, integer) to authenticated;
