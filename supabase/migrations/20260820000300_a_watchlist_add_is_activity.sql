-- Adding a title to the watchlist becomes activity, and stays activity.
-- Specification: founder Feed finalization 2026-08-20, items 2, 3, 4, 5, 6.
--
-- ===========================================================================
-- 1. WHY THE EVENT IS WRITTEN HERE AND NOWHERE ELSE
--
-- `20260820000200` made the watchlist profile content because the socially actionable
-- half of a person's taste is what they *want* to watch, not only what they have
-- already ranked. The shelf on a profile is the passive form of that. This is the
-- active one: "Suraj added Dune to their watchlist" arrives in a follower's feed and
-- is an opening for "I want to watch that too", which a shelf somebody has to go
-- looking for is not.
--
-- The event is inserted **inside `set_watchlist`**, in the same transaction as the
-- `watchlist` row, and that is the whole architectural decision. The alternative --
-- the client calling the mutation and then writing its own feed row -- was rejected
-- for three reasons, and only the first is about tidiness:
--
--   * **`feed_events` has no insert policy and never has.** Every event in this
--     schema is written by a `security definer` function that has already
--     authorised the caller (`_rank_finalize`, `_maybe_activate_invite`). Granting
--     the client a direct insert would mean any authenticated account could forge
--     activity attributed to itself about any title, at any rate, and the block and
--     privacy barriers would then be the *only* thing standing between that and a
--     follower's feed.
--
--   * **Two writes are two failure modes.** A committed watchlist row with no event
--     is an add that never reached anybody; an event with no row is a claim about a
--     watchlist that does not hold it. One transaction has neither state.
--
--   * **The ledger already solves the retry.** `_claim_operation` short-circuits a
--     replayed `p_operation_id` before any of this runs, so the lost-response case
--     that `mustReconcile` exists for (`lib/write-outcome.ts`) cannot produce a
--     second event. A best-effort client insert would have had to reinvent that,
--     and would have got it wrong on exactly the path where the reply was lost.
--
-- ===========================================================================
-- 2. ONE EVENT PER (PERSON, TITLE), ENFORCED BY AN INDEX
--
-- The ledger stops a *replay*. It does not stop a second genuine call with a fresh
-- operation id, which is what a remove-then-re-add is, and what a double tap on two
-- devices is. So the rule the founder asked for -- one durable feed event per user and
-- media pair for beta -- is a **partial unique index**, not a convention:
--
--     feed_events_watchlist_once on (actor_id, media_item_id) where type = 'watchlist_added'
--
-- Partial, so it constrains this type and touches no other. `title_ranked` must stay
-- free to repeat: `_rank_finalize` writes a new one on every rerank and rebucket, and
-- `20260817001100` depends on there being many. Scoping the index to one type is what
-- lets the two rules coexist without either being a comment somebody has to read.
--
-- The insert is `on conflict ... do nothing` against that exact index, predicate
-- repeated so Postgres can infer it -- the hazard `20260817000900` records. A re-add
-- therefore restores the watchlist row and does not manufacture a second activity,
-- which is the correct outcome: the reactions and comments on the first one are the
-- reason the first one is the durable one.
--
-- ===========================================================================
-- 3. REMOVE, WATCH, RE-ADD -- DECIDED RATHER THAN INHERITED
--
-- Three transitions can take the row away after the event exists, and each is
-- answered here rather than left to whichever query notices first.
--
-- **The user removes it.** `set_watchlist(present => false)` deletes the row and
-- leaves the event. The event says *added*, in the past tense, and that stays true;
-- it is not, like `title_ranked`, an assertion about current collection state that
-- becomes a false claim the moment the state moves (`20260818000100`). Deleting it
-- would take other people's reactions and comments with it through the cascade --
-- destroying a conversation because its subject changed their mind about a film.
--
-- **The user watches or ranks it.** `_leave_watchlist` (`20260815040000`) deletes the
-- row from under them. This is the case the founder named explicitly: the activity
-- must not disappear because the person did the thing the activity was about. It
-- does not, for the same reason -- and note that the *good* outcome here needed no
-- code, only that nothing was added to remove it.
--
-- **The user unlogs it.** `unlog` (`20260818000100`) deletes the caller's
-- `title_ranked`, `title_logged` and `season_completed` events for the title.
-- `watchlist_added` is deliberately **not** added to that list, and it is the same
-- line that migration already drew for `list_added`: those three types assert that a
-- title is in the collection, and removing it from the collection makes them false.
-- "Added it to their watchlist" is not a statement about the collection at all.
--
-- So the invariant is: **the event outlives the row, and there is only ever one.**
-- The only thing that removes it is the actor's profile going away, through the
-- `on delete cascade` every feed event already has.
--
-- ===========================================================================
-- 4. PRIVACY: NO NEW ORACLE, AND THE ONE ASYMMETRY NAMED
--
-- Nothing here is added to the read path, which is the point. `feed_events_read` is
-- `can_view_profile(auth.uid(), actor_id)` and applies to every row in the table by
-- type-independent construction, so this event is visible to exactly the accounts
-- that may already see that person's rankings -- and `20260820000200` set the
-- `watchlist` table's own select policy to `can_i_view(user_id)`, which resolves the
-- same visibility for the same viewer. A blocked, private-and-unapproved, suspended
-- or deleted actor discloses nothing through this that they did not already.
--
-- Reactions and comments inherit it rather than re-deriving it: `reactions_read`
-- re-checks the event's actor, and `add_comment`/`set_reaction` both resolve
-- existence and visibility in one query keyed on `feed_events.id` with no reference
-- to `type`. A new event type is generic to all three by construction.
--
-- **The asymmetry, stated:** after a remove or a watch the event outlives the
-- `watchlist` row, so a viewer can learn that somebody once added a title whose
-- watchlist entry is now gone. That is deliberate (§3) and it is bounded -- it is a
-- past-tense fact about an act, disclosed only to the audience already entitled to
-- that person's activity, and for the watched case that same audience is about to be
-- told they ranked it anyway.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The type
-- ---------------------------------------------------------------------------

alter table feed_events drop constraint feed_events_known_type;

alter table feed_events add constraint feed_events_known_type check (type in (
  'title_ranked',
  'title_logged',
  'season_completed',
  'list_created',
  'list_added',
  'milestone_reached',
  'joined_from_invitation',
  -- NEW (20260820000300).
  'watchlist_added'
));

-- One per (person, title), for this type only. See §2.
create unique index feed_events_watchlist_once
  on feed_events (actor_id, media_item_id)
  where type = 'watchlist_added';

comment on index feed_events_watchlist_once is
  'One durable watchlist_added event per (actor, media item). Partial so that title_ranked stays free to repeat, which 20260817001100 relies on. A re-add after a remove restores the watchlist row and does not create a second activity, because the reactions and comments on the first are why the first is the one that lasts.';

-- ---------------------------------------------------------------------------
-- The writer
--
-- Reproduced in full, and the diff against `20260813002300` is one statement: the
-- `insert into feed_events` inside the `if p_present` branch. Everything else is
-- that function verbatim, including the existence check on a removal and the
-- `on conflict do nothing` on `watchlist` itself.
--
-- Reproducing a definer function in full is the hazard `20260817000200` records --
-- `_assert_operation_rate` lost its advisory lock exactly this way -- so what must
-- survive is called out rather than left to be noticed:
--
--   `assert_can_write()` first, before the ledger claim, so a suspended account
--   cannot burn an operation id;
--   `_claim_operation`, which is the whole of the retry story (§1);
--   `_media_kind(p_media_item_id)`, which raises P0002 for a title that does not
--   exist and is checked on a *removal* too, so a call naming nothing is a clear
--   refusal rather than a silent success.
--
-- The feed insert is inside the branch and after the watchlist insert, so a title
-- that fails `_media_kind` produces neither, and a removal produces neither.
-- ---------------------------------------------------------------------------

create or replace function set_watchlist(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_present       boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_watchlist') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_present is null then
    raise exception 'present is required' using errcode = '22023';
  end if;

  -- Existence is checked even for a removal, so a call naming a title that does not
  -- exist is a clear P0002 rather than a silent success.
  perform _media_kind(p_media_item_id);

  if p_present then
    insert into watchlist (user_id, media_item_id)
    values (auth.uid(), p_media_item_id)
    on conflict (user_id, media_item_id) do nothing;

    -- NEW (20260820000300). Same transaction as the row above, so there is no state
    -- in which one exists without the other having been attempted.
    --
    -- The predicate is repeated on the conflict target so Postgres can infer the
    -- partial index. Drop it and this raises rather than choosing the wrong index.
    --
    -- Deliberately *not* conditional on the watchlist insert having found a gap. The
    -- durable-event rule lives in the index, and reading `row_count` here would put a
    -- second copy of it in a place that can disagree -- a title watched since the
    -- first add has no watchlist row to conflict with, so the row insert succeeds and
    -- a row_count test would then write the duplicate the index is there to refuse.
    insert into feed_events (actor_id, type, media_item_id)
    values (auth.uid(), 'watchlist_added', p_media_item_id)
    on conflict (actor_id, media_item_id) where type = 'watchlist_added'
    do nothing;
  else
    delete from watchlist
     where user_id = auth.uid() and media_item_id = p_media_item_id;
  end if;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function set_watchlist(uuid, uuid, boolean) is
  'Adds or removes one title on the caller''s watchlist. An add also writes the caller''s single durable watchlist_added feed event for that title, in the same transaction, guarded by feed_events_watchlist_once -- so a re-add restores the row without duplicating the activity. A removal deletes the row and leaves the event: "added" is a past-tense fact, and deleting it would cascade away other people''s reactions and comments. Idempotent by the operation ledger.';
