-- A ranking that cannot split.
-- Specification: docs/architecture/ranking.md · api.md §2 · offline-sync.md §3
--
-- The production data contract for the one object this app is about: a title in one
-- person's collection, with an opinion attached. Four things were true of it before
-- this migration and are not true after.
--
-- **1. Nothing serialised two writes to the same title.** Every advisory lock in the
-- ranking family is keyed on `(user_id, category)`. That grain protects the band
-- arithmetic — the shifts that keep positions 1..n — and protects nothing else. Two
-- writers naming the *same title* hash to the same key only by coincidence of
-- category, and `set_bucket` and `unlog` take no advisory lock at all. So
-- `set_bucket`'s `_assert_unranked` and its upsert are two statements with a
-- committing `rank_start` free to land between them, which is `user_media.bucket`
-- disagreeing with `rankings.bucket` — invariant I3, broken by two devices doing
-- ordinary things. `20260813002300`'s own header says so; this is the migration it
-- said would be needed.
--
-- **2. No ranking RPC could recognise a replay.** Every other write in this schema
-- carries `p_operation_id` and claims it through `_claim_operation`. Ranking was the
-- one family left out, and it is the family where a lost reply costs the most: a
-- `rank_answer` that finalises and loses its HTTP response is a title that *is*
-- placed, reported to the reader as a failure, over a control they will press again.
-- The client's honest "Not sure that landed" copy was the whole protection.
--
-- **3. Rank Again was two calls with a gap in the middle.** `rank_unrank` then
-- `rank_start`, from the client, with no transaction around them. The gap is a real
-- state — logged, unranked — so it was never corruption, but it was the client doing
-- atomicity by apology.
--
-- **4. A brand-new note with no stated visibility was published.** Both note writers
-- read a null `p_note_visibility` on a note that has never existed as *public*, while
-- the column default, the product contract and every screen in the app say private.
-- Open question NR-1.
--
-- ---------------------------------------------------------------------------
-- The lock hierarchy, stated once
-- ---------------------------------------------------------------------------
--
-- Three transaction-scoped locks now guard one title, and every function that takes
-- more than one takes them in this order:
--
--   1. the operation ledger row  — `_claim_operation` / `_claim_operation_result`
--   2. the media lock            — `_lock_media(user, media_item)`      NEW
--   3. the category lock         — `(user, category)`, inside the ranking arithmetic
--
-- The order is not arbitrary and it is not free to change. The ledger claim is first
-- because it is what makes a replay cheap: a replayed operation must be recognised
-- before it acquires anything else, and two transactions carrying the same id block
-- on the ledger row while holding nothing else, so there is no cycle to close. The
-- media lock is second because every writer that touches one title takes exactly one
-- of them, and a writer that then needs the category lock always takes it *after*.
-- Nothing in this schema acquires a category lock and then asks for a media lock,
-- which is the only shape that could deadlock the pair.
--
-- Two transactions ranking two *different* titles in the *same* category therefore
-- hold different media locks and queue on the same category lock. That is contention,
-- not deadlock: neither holds what the other wants first.
--
-- `_lock_pair` (20260817000200) is not in this hierarchy and cannot interleave with
-- it: it keys on two *accounts*, and the only ranking path that reaches it is
-- `_maybe_activate_invite`, called at the very end of `_rank_finalize` when both
-- ranking locks are already held. It is therefore strictly fourth, and nothing that
-- holds it ever asks for a ranking lock.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The media lock
--
-- Deterministic, transaction-scoped, and shaped exactly like `_lock_pair` so the two
-- read alike. The `media:` prefix and the `:` separator are load-bearing in the same
-- small way `_lock_pair`'s are: concatenating two uuids without a separator lets
-- distinct pairs collide on the same text, and sharing a key space with the
-- `(user, category)` lock — which hashes `user || category` with no prefix at all —
-- would make a media lock and a category lock contend for no reason, and would make
-- the deadlock argument above rest on a hash collision not happening.
--
-- SQL rather than plpgsql, because it is one expression and the planner should be
-- free to inline it. Same choice `_lock_pair` made.
-- ---------------------------------------------------------------------------

create or replace function _lock_media(p_user uuid, p_media_item_id uuid)
returns void
language sql
set search_path = public
as $$
  select pg_advisory_xact_lock(
    hashtextextended(
      'media:' || coalesce(p_user::text, '') || ':' || coalesce(p_media_item_id::text, ''),
      0
    )
  );
$$;

comment on function _lock_media(uuid, uuid) is
  'Transaction-scoped advisory lock over one account and one media item, so that every writer able to change whether a title is logged, bucketed or ranked serialises against every other writer naming the same title. Second in the lock hierarchy: after the operation ledger claim, before the (user, category) ranking lock. Internal.';

revoke execute on function _lock_media(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. An operation that remembers its answer
--
-- `_claim_operation` returns a boolean, and every caller turns a false into
-- `{"status": "already_applied"}`. That works for the collection writers because
-- their answer carries nothing the client cannot get by reading its own row.
--
-- It does not work for ranking. `rank_answer` answers with a position, a score, a
-- category and the once-in-an-account-lifetime `activated` flag, and a replay that
-- said only "already applied" would teach the client less than the call whose reply
-- was lost. The sheet reads a body with no `done` and no `session_id` as a session
-- that ended, so the reader would be told their title is still unranked over a
-- ranking that exists — the precise mis-statement this tranche is here to remove.
--
-- So the ledger stores the answer, and a replay returns it verbatim. That is what
-- makes "exactly once" a property of the *observable* and not only of the rows.
--
-- **Why a replay cannot see a claim without its answer.** `insert … on conflict do
-- nothing` against a key another transaction has inserted and not yet committed does
-- not skip immediately: the speculative insertion waits on that transaction and only
-- then decides. So by the time a replay reads `result`, the transaction that claimed
-- the id has either committed — and written it in the same transaction — or aborted
-- and released the id entirely.
--
-- **A raised exception un-claims the operation**, because the ledger insert rolls back
-- with everything else. Same behaviour the collection writers already have, and the
-- correct one: a refusal is not an outcome to replay.
-- ---------------------------------------------------------------------------

alter table processed_operations
  add column result jsonb;

comment on column processed_operations.result is
  'The answer the operation gave, for the RPCs whose answer carries something a replay cannot re-derive — the ranking family, whose result holds a position, a score and the single-shot invite activation flag. Null for every writer that answers only {"status":"ok"}. Written in the same transaction as the claim, so a replay never observes a claim without its answer.';

create or replace function _claim_operation_result(
  p_operation_id uuid,
  p_kind         text,
  out claimed    boolean,
  out prior      jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  -- A null id is the compatibility path of §9, not an error. Here it means only
  -- "there is no ledger entry to keep; run it".
  if p_operation_id is null then
    claimed := true;
    prior   := null;
    return;
  end if;

  insert into processed_operations (user_id, operation_id, kind)
  values (auth.uid(), p_operation_id, p_kind)
  on conflict (user_id, operation_id) do nothing;

  if found then
    claimed := true;
    prior   := null;
    return;
  end if;

  claimed := false;

  select po.kind, po.result into v_kind, prior
    from processed_operations po
   where po.user_id = auth.uid() and po.operation_id = p_operation_id;

  -- One id, one intent. A client reusing an id across two different RPCs would
  -- otherwise be handed the other function's answer, which is worse than a refusal
  -- because it looks like success. Only a broken client reaches this.
  if v_kind is distinct from p_kind then
    raise exception 'operation id already used for a different operation'
      using errcode = '22023';
  end if;
end;
$$;

comment on function _claim_operation_result(uuid, text) is
  'Idempotency guard for the RPCs whose answer must survive a replay. Returns claimed=true for a fresh id, and claimed=false with the stored answer for one already applied. A null id claims nothing and runs, which is the old-client compatibility path. Raises 22023 if the id was spent on a different kind of operation. Internal.';

revoke execute on function _claim_operation_result(uuid, text) from public, anon, authenticated;

create or replace function _record_operation_result(p_operation_id uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_operation_id is not null then
    update processed_operations
       set result = p_result
     where user_id = auth.uid() and operation_id = p_operation_id;
  end if;

  -- Returns its argument, so an entry point can end `return _record_operation_result(
  -- p_operation_id, x)` rather than a temporary and two statements. Every ranking
  -- entry point below ends that way, which keeps "the answer returned is the answer
  -- stored" true by construction rather than by review.
  return p_result;
end;
$$;

comment on function _record_operation_result(uuid, jsonb) is
  'Stores an operation''s answer against its ledger row and returns it unchanged, so a replay is answered with exactly what the first call said. A no-op for a null id. Internal.';

revoke execute on function _record_operation_result(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2b. The same guard on the original claim
--
-- `_claim_operation` has never looked at `kind`. `20260813002300` added the column
-- explicitly as diagnostics — "not used for control flow; it is what makes a stuck
-- queue diagnosable" — and that was right for a ledger nobody read back.
--
-- It is not right now, and the reason showed up while writing the client half of this
-- tranche. `removeFromCollection` is one intent — *take this off my shelf* — made of two
-- RPCs, `rank_unrank` then `unlog`. Passing its single operation id to both is the
-- obvious thing to write, and it would be a silent data-loss bug: the first call claims
-- the id, the second finds it taken, and `_claim_operation` answers false — so `unlog`
-- reports `already_applied` and **deletes nothing**. The person is told their title was
-- removed and it is still there.
--
-- With the guard, that mistake raises 22023 the first time it is run instead of losing
-- a write quietly. It can only fire on a client that has spent one id on two different
-- operations, which is a bug in every case; no current caller does it, and the one that
-- nearly did is documented at its own site in `collection/writes.ts`.
--
-- Rebuilt in full from `20260813002300` §2 rather than patched. Everything above the
-- new check is that function unchanged.
-- ---------------------------------------------------------------------------

create or replace function _claim_operation(p_operation_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  if p_operation_id is null then
    raise exception 'operation_id is required' using errcode = '22023';
  end if;

  insert into processed_operations (user_id, operation_id, kind)
  values (auth.uid(), p_operation_id, p_kind)
  on conflict (user_id, operation_id) do nothing;

  if found then
    return true;
  end if;

  select po.kind into v_kind
    from processed_operations po
   where po.user_id = auth.uid() and po.operation_id = p_operation_id;

  -- One id, one intent. See above: without this, a composite writer that reuses an id
  -- turns its second RPC into a no-op that reports success.
  if v_kind is distinct from p_kind then
    raise exception 'operation id already used for a different operation'
      using errcode = '22023';
  end if;

  return false;
end;
$$;

comment on function _claim_operation(uuid, text) is
  'Idempotency guard for outbox-eligible RPCs. Returns false when the operation was already applied, which the caller reports as success (offline-sync.md §3). Raises 22023 when the id was already spent on a different kind of operation, because a composite writer reusing one id would otherwise turn its second call into a no-op that reports success.';


-- ---------------------------------------------------------------------------
-- 3. `_rank_finalize` re-asserts the collection row
--
-- Rebuilt in full from its definition in `20260819000500`, not patched, for the
-- reason that migration records about its own rebuild: a `create or replace`
-- assembled from the wrong ancestor is how `_assert_operation_rate` silently lost its
-- advisory lock, and it is invisible in a diff. Every line below is carried across
-- unchanged except the upsert marked as new.
--
-- **What is new, and why it belongs here rather than in a lock.** A ranking session
-- spans several transactions, and no lock held inside one of them can reach across
-- the gap between two. So between `rank_start` and the `rank_answer` that finalises,
-- a `set_bucket` on another device can legitimately change `user_media.bucket`, and
-- an `unlog` can legitimately delete the row outright. Both take the media lock and
-- both are correct in isolation; the damage is at the finalise, which writes a
-- `rankings` row carrying the session's bucket against a `user_media` row that has
-- moved or gone. That is invariant I3, and an orphaned ranking, respectively.
--
-- The insertion of a `rankings` row is the one moment in the schema where the app can
-- state the whole truth about a title, so it states it: the row exists, and its bucket
-- is the one just ranked. `rankings` is the stronger claim of the two — a position is
-- a bucket plus an ordinal — so reconciling towards it is not a guess.
--
-- `assert_ranking_valid` has checked exactly this since `20260813000700` and had no
-- writer maintaining it. Now it does, and the check becomes a backstop rather than
-- the only thing that would ever notice.
-- ---------------------------------------------------------------------------

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_band      record;
  v_size      integer;
  v_rank      integer;
  v_score     numeric;
  v_activated boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Recomputed inside the lock, so it reflects the ranking this insert is about
  -- to happen against rather than the one the caller saw.
  select * into v_band from band_bounds(target, cat, b);

  -- Valid insertion points run from the top of the band to one past its end. An
  -- empty band yields hi = lo - 1, so the only valid point is lo, which is what
  -- this reduces to.
  if pos < v_band.lo or pos > v_band.hi + 1 then
    raise exception
      'refusing to place a % title at position %, outside the % band (% to %)',
      b, pos, b, v_band.lo, v_band.hi + 1
      using errcode = '22023';
  end if;

  update rankings
     set position = position + 1
   where user_id = target and category = cat and position >= pos;

  insert into rankings (user_id, media_item_id, category, bucket, position)
  values (target, item, cat, b, pos);

  -- NEW. The collection row this ranking is a claim about, re-asserted from the
  -- ranking itself. See the header above: it closes I1 and I3 against anything that
  -- committed in the gap between the session opening and this transaction, and it is
  -- a no-op for the ordinary case where `rank_start` already wrote exactly this.
  insert into user_media (user_id, media_item_id, bucket)
  values (target, item, b)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket, updated_at = now()
   where user_media.bucket is distinct from excluded.bucket;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  v_size  := v_band.size + 1;
  v_rank  := pos - v_band.lo + 1;
  v_score := score_for(b, v_rank, v_size);

  insert into feed_events (actor_id, type, media_item_id, payload)
  values (
    target,
    'title_ranked',
    item,
    jsonb_build_object(
      'position', pos,
      'bucket',   b,
      'category', cat,
      'score',    v_score
    )
  );

  -- PRD §28's activation, from the one place a ranking is created.
  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated
  );
end;
$$;

revoke all on function
  _rank_finalize(uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. The two ranking bodies that more than one entry point needs
--
-- `rank_rebucket` used to call the *public* `rank_unrank` and `rank_start`, and
-- `rank_again` below needs the same two steps. With an operation claim on each public
-- entry point that composition stops working: the outer call claims the id, the inner
-- call finds it already claimed, and returns a replay of an operation that has not
-- finished. The bodies therefore move down here, and the entry points become what
-- they should always have been — authentication, a claim, a lock, and a body.
--
-- **Neither impl takes a lock.** Both assume `_lock_media(p_user, p_media_item_id)` is
-- already held by the caller, which every caller below does as its second act. Stated
-- rather than defensively re-taken, because a lock taken in two places is a lock whose
-- ordering has two answers, and the hierarchy at the top of this file only works if
-- there is one.
-- ---------------------------------------------------------------------------

create or replace function _rank_unrank_impl(p_user uuid, p_media_item_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_r record;
begin
  select * into v_r from rankings
   where user_id = p_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || v_r.category::text, 0));

  delete from rankings
   where user_id = p_user and media_item_id = p_media_item_id;

  update rankings
     set position = position - 1
   where user_id = p_user and category = v_r.category and position > v_r.position;

  return jsonb_build_object('done', true, 'unranked', true);
end;
$$;

comment on function _rank_unrank_impl(uuid, uuid) is
  'Removes a ranking and closes the gap behind it, leaving user_media intact. The body of rank_unrank, shared with rank_rebucket and rank_again. Assumes the caller holds _lock_media for the same (user, media item). Internal.';

revoke execute on function _rank_unrank_impl(uuid, uuid) from public, anon, authenticated;

create or replace function _rank_start_impl(
  p_user uuid, p_media_item_id uuid, p_bucket taste_bucket
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_kind     media_kind;
  v_cat      ranking_category;
  v_band     record;
  v_existing record;
  v_state    record;
  v_session  uuid;
  v_pivot    integer;
begin
  select kind into v_kind from media_items where id = p_media_item_id;
  if v_kind is null then
    raise exception 'unknown media item' using errcode = 'P0002';
  end if;

  v_cat := rankable_category(v_kind);
  if v_cat is null then
    raise exception 'a series cannot be ranked; rank its seasons'
      using errcode = '22023';
  end if;

  -- PRD §11: bucketing and ranking are separate acts and abandoning the second does
  -- not undo the first. The title is Logged from here on, whatever happens next.
  --
  -- **TV-1, decided 2026-08-24.** There is no completion prerequisite and there never
  -- was one in this function. Ranking a season *is* the watch claim — the "How was
  -- it?" that opens the flow already says the reader watched it — so `progress` is not
  -- read here and is not written. See open-questions.md §TV-1.
  insert into user_media (user_id, media_item_id, bucket)
  values (p_user, p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id)
    do update set bucket = excluded.bucket, updated_at = now();

  if exists (select 1 from rankings
              where user_id = p_user and media_item_id = p_media_item_id) then
    raise exception 'title is already ranked; use rank_rebucket to move it'
      using errcode = '23505';
  end if;

  select * into v_existing
    from ranking_sessions
   where user_id = p_user and media_item_id = p_media_item_id;

  if v_existing.id is not null then
    if v_existing.bucket = p_bucket then
      select * into v_state from _rank_session_state(v_existing.id, p_user);
      return jsonb_build_object(
        'done', false,
        'session_id', v_state.session_id,
        'pivot', _rank_pivot_at(p_user, v_cat, v_state.band_lo + v_state.pivot),
        'resumed', true
      );
    end if;

    -- The bucket changed. Nothing answered in the old band transfers.
    delete from ranking_sessions where id = v_existing.id;
  end if;

  select * into v_band from band_bounds(p_user, v_cat, p_bucket);

  if v_band.size = 0 then
    return _rank_finalize(p_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null);
  end if;

  v_pivot := v_band.size / 2;

  insert into ranking_sessions (user_id, media_item_id, category, bucket, lo, hi, pivot)
  values (p_user, p_media_item_id, v_cat, p_bucket, 0, v_band.size, v_pivot)
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', _rank_pivot_at(p_user, v_cat, v_band.lo + v_pivot),
    'resumed', false
  );
end;
$$;

comment on function _rank_start_impl(uuid, uuid, taste_bucket) is
  'Logs the title with its bucket and opens a comparison session, or places it outright when the band is empty. The body of rank_start, shared with rank_rebucket and rank_again. Assumes the caller holds _lock_media for the same (user, media item). Internal.';

revoke execute on function _rank_start_impl(uuid, uuid, taste_bucket) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The entry points
--
-- Every one of them now reads the same way:
--
--     authenticate → claim the operation → lock the media item → do the work
--                  → store the answer
--
-- **The operation id is last in the signature and defaults to null**, which is a
-- deliberate departure from `p_operation_id` first in the collection writers. §9 has
-- the full argument; the short version is that a friend-beta client is installed on
-- real devices today and calls these functions with the arguments they have now. A
-- trailing optional parameter is the one shape that lets the old client keep working
-- against the new database without leaving a second overload for PostgREST to resolve
-- ambiguously — and without faking an idempotency the old client cannot have.
--
-- **Dropping before creating is mandatory, not tidiness.** `create or replace` cannot
-- add a parameter, and leaving the old arity standing would leave a public signature
-- that skips the claim. `drop function` also drops the grants, so every one is
-- restated in §8.
--
-- **The `_unguarded` layer goes with them, and this is the part to read twice.**
-- `20260813001700` did not rewrite the ranking RPCs to add the suspension check. It
-- *renamed* each one to `_rank_x_unguarded` and created a two-line wrapper under the
-- original name that called `assert_can_write()` and then the implementation — so
-- that the ranking logic stayed in one migration instead of being copied into the
-- moderation one, where the two copies would have begun to drift.
--
-- That decision was right and it has a sharp edge, which this migration hit before it
-- was finished: **the public name is a wrapper, so replacing the public name replaces
-- the wrapper and not the logic.** A `rank_start` written from `20260813001600`'s body
-- looks complete, passes most of the suite, and has quietly dropped the suspension
-- guard — and a `rank_skip` written that way loses the band-relative skip walk
-- `20260813002100` put into `_rank_skip_unguarded`, which is two migrations further on
-- than the file its name appears in. Both happened here and both were caught by tests
-- rather than by reading.
--
-- The wrapper layer cannot survive this tranche anyway: each entry point now has real
-- work to do before the body — a claim, a lock — so a two-line pass-through has
-- nothing left to be. Each one is therefore collapsed into a single function that
-- calls `assert_can_write()` itself, and the seven orphaned implementations are
-- dropped rather than left as dead code with divergent behaviour under a name that
-- looks live. `_rank_start_impl` and `_rank_unrank_impl` in §4 are their replacements
-- and carry the same bodies, `_rank_skip_unguarded`'s walk is carried into `rank_skip`
-- below, and the rest are inlined at their single call site.
-- ---------------------------------------------------------------------------

drop function if exists rank_start(uuid, taste_bucket);
drop function if exists rank_answer(uuid, uuid);
drop function if exists rank_skip(uuid);
drop function if exists rank_back(uuid);
drop function if exists rank_unrank(uuid);
drop function if exists rank_reorder(uuid, integer);
drop function if exists rank_rebucket(uuid, taste_bucket);

drop function if exists _rank_start_unguarded(uuid, taste_bucket);
drop function if exists _rank_answer_unguarded(uuid, uuid);
drop function if exists _rank_skip_unguarded(uuid);
drop function if exists _rank_back_unguarded(uuid);
drop function if exists _rank_unrank_unguarded(uuid);
drop function if exists _rank_reorder_unguarded(uuid, integer);
drop function if exists _rank_rebucket_unguarded(uuid, taste_bucket);

-- rank_start ----------------------------------------------------------------

create or replace function rank_start(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_start');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  return _record_operation_result(
    p_operation_id, _rank_start_impl(v_user, p_media_item_id, p_bucket)
  );
end;
$$;

comment on function rank_start(uuid, taste_bucket, uuid) is
  'Logs a title with its bucket and opens a comparison session, or places it outright when its band is empty. Takes the media lock, so it cannot interleave with set_bucket, unlog or clear_watch_date on the same title. With an operation id, a replay returns the first call''s answer rather than resuming or refusing; without one — the pre-2026-08-25 client — it behaves as it always did.';

-- rank_answer ---------------------------------------------------------------

create or replace function rank_answer(
  p_session_id   uuid,
  p_winner       uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_item  uuid;
  v_s     record;
  v_pivot_item uuid;
  v_new_lo integer;
  v_new_hi integer;
  v_next   integer;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_answer');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  -- The media item is read before the lock because the lock needs it, and a session's
  -- media_item_id never changes once written — so this is a stable key rather than a
  -- value that could be stale by the time it is used. The session is then re-read
  -- through `_rank_session_state` *inside* the lock, which is where the bounds that
  -- matter are clamped to the live band.
  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  select * into v_s from _rank_session_state(p_session_id, v_user);

  -- The band can collapse under an open session if its other members are unranked.
  -- There is then nothing left to compare against.
  if v_s.lo >= v_s.hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.lo, v_s.session_id
    ));
  end if;

  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot);

  if p_winner <> v_s.media_item_id and p_winner <> v_pivot_item then
    raise exception 'winner must be one of the two titles being compared'
      using errcode = '22023';
  end if;

  if p_winner = v_s.media_item_id then
    v_new_lo := v_s.lo;
    v_new_hi := v_s.pivot;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_s.media_item_id, v_pivot_item);
  else
    v_new_lo := v_s.pivot + 1;
    v_new_hi := v_s.hi;
    insert into comparisons (user_id, winner_id, loser_id)
    values (v_user, v_pivot_item, v_s.media_item_id);
  end if;

  if v_new_lo >= v_new_hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_new_lo, v_s.session_id
    ));
  end if;

  v_next := (v_new_lo + v_new_hi) / 2;

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_next,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot
         ),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_next)
  ));
end;
$$;

comment on function rank_answer(uuid, uuid, uuid) is
  'Records one comparison and either narrows the search or finalises the placement. The one RPC where a lost reply cost the most: with an operation id, a replay returns the stored answer — the same position, score and activation flag — so a retry cannot record a second comparison, move the title twice, or emit a second feed event.';

-- rank_skip -----------------------------------------------------------------

create or replace function rank_skip(
  p_session_id   uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_claim      record;
  v_item       uuid;
  v_s          record;
  v_max_skips  integer;
  v_mid        integer;
  v_offset     integer := 1;
  v_seen       integer := 0;
  v_candidate  integer;
  v_pivot      integer := null;
  v_band_skips integer;
  v_skip_lo    integer;
  v_skip_hi    integer;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_skip');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  select * into v_s from _rank_session_state(p_session_id, v_user);

  -- The subquery form, not `select coalesce(...) into … from app_config where …`.
  -- 20260813002100 §2: with no matching row the second form assigns null and the
  -- default never applies, so a missing config key disabled the skip cap entirely.
  v_max_skips := coalesce(
    (select (value)::integer from app_config where key = 'ranking.max_skips'),
    3
  );

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    ));
  end if;

  select rs.band_skips, rs.skip_lo, rs.skip_hi
    into v_band_skips, v_skip_lo, v_skip_hi
    from ranking_sessions rs where rs.id = v_s.session_id;

  -- A different band means a different set of candidates, so nothing offered
  -- before counts against this one.
  if v_skip_lo is distinct from v_s.lo or v_skip_hi is distinct from v_s.hi then
    v_band_skips := 0;
  end if;

  -- mid+1, mid-1, mid+2, mid-2, … skipping candidates outside [lo, hi), and stopping
  -- on the one after however many have been offered against this band. Carried from
  -- `_rank_skip_unguarded` (20260813002100 §3) unchanged: counting against `skips`
  -- instead, which is session-global and which `rank_answer` correctly does not reset,
  -- makes a skip after an answer walk past candidates it never offered and finalise
  -- early.
  while v_offset <= (v_s.hi - v_s.lo) loop
    v_candidate := v_mid + v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_band_skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_candidate := v_mid - v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_band_skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_offset := v_offset + 1;
  end loop;

  -- Genuinely out of distinct comparisons for this band. Placing at the midpoint is
  -- the same resolution as running out of patience, and is reported as adjustable.
  if v_pivot is null then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    ));
  end if;

  -- Persisting the pivot is 20260813001600's fix. Without it the answer path
  -- recomputed the midpoint and refused the title it had just displayed.
  update ranking_sessions
     set skips      = skips + 1,
         band_skips = v_band_skips + 1,
         skip_lo    = v_s.lo,
         skip_hi    = v_s.hi,
         pivot      = v_pivot,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_pivot),
    'skipped', true
  ));
end;
$$;

comment on function rank_skip(uuid, uuid) is
  'Re-anchors to a different opponent without narrowing the range; the configured skip limit places the title at the midpoint instead. Carries an operation id because a skip mutates — a replay without one spends a second skip against the limit and shows a third title.';

-- rank_back -----------------------------------------------------------------

create or replace function rank_back(
  p_session_id   uuid,
  p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_item  uuid;
  v_s     record;
  v_prev  jsonb;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_back');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  perform _lock_media(v_user, v_item);

  select * into v_s from _rank_session_state(p_session_id, v_user);

  if jsonb_array_length(v_s.history) = 0 then
    delete from ranking_sessions where id = v_s.session_id;
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', false, 'cancelled', true)
    );
  end if;

  v_prev := v_s.history -> -1;

  update ranking_sessions
     set lo = (v_prev ->> 'lo')::integer,
         hi = (v_prev ->> 'hi')::integer,
         pivot = (v_prev ->> 'pivot')::integer,
         history = v_s.history - (jsonb_array_length(v_s.history) - 1),
         skips = greatest(skips - 1, 0),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(
      v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer
    )
  ));
end;
$$;

comment on function rank_back(uuid, uuid) is
  'One comparison back, restoring the pivot along with the range. At the first comparison the session is deleted and the title stays Logged. Carries an operation id because a replay would pop a second frame off the history.';

-- rank_unrank ---------------------------------------------------------------

create or replace function rank_unrank(
  p_media_item_id uuid,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_unrank');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', true, 'unranked', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  return _record_operation_result(p_operation_id, _rank_unrank_impl(v_user, p_media_item_id));
end;
$$;

comment on function rank_unrank(uuid, uuid) is
  'Deletes the ranking and closes the gap, leaving user_media intact: the title reverts to Logged with its bucket, which is the canonical Collection → Unranked state. PRD §10 requires that reranking never deletes viewing history.';

-- rank_reorder --------------------------------------------------------------

create or replace function rank_reorder(
  p_media_item_id uuid,
  p_new_position  integer,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_r     record;
  v_band  record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_reorder');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', true, 'position', p_new_position));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  -- The category lock is taken *before* the band is read, which is a change from the
  -- previous version and is the same correction `_rank_finalize` already carries: a
  -- band read outside the lock describes a ranking that another transaction may be
  -- renumbering, so the bounds this refusal is measured against could be stale by the
  -- time the shifts run. Order is media then category, per the hierarchy at the top.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_r.category::text, 0));

  select * into v_band from band_bounds(v_user, v_r.category, v_r.bucket);

  -- A drag that would cross a band boundary is refused, because crossing means the
  -- bucket changed and that path re-runs comparisons instead of guessing.
  if p_new_position < v_band.lo or p_new_position > v_band.hi then
    raise exception 'position % is outside the % band (% to %)',
      p_new_position, v_r.bucket, v_band.lo, v_band.hi
      using errcode = '22023';
  end if;

  if p_new_position = v_r.position then
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', true, 'position', v_r.position)
    );
  end if;

  if p_new_position < v_r.position then
    update rankings set position = position + 1
     where user_id = v_user and category = v_r.category
       and position >= p_new_position and position < v_r.position;
  else
    update rankings set position = position - 1
     where user_id = v_user and category = v_r.category
       and position > v_r.position and position <= p_new_position;
  end if;

  update rankings set position = p_new_position
   where user_id = v_user and media_item_id = p_media_item_id;

  return _record_operation_result(
    p_operation_id, jsonb_build_object('done', true, 'position', p_new_position)
  );
end;
$$;

comment on function rank_reorder(uuid, integer, uuid) is
  'Moves a ranked title within its own band. A drag across a band boundary is refused, because crossing means the bucket changed and that path re-runs comparisons. The band bounds are now read inside the category lock rather than before it.';

-- rank_rebucket -------------------------------------------------------------

create or replace function rank_rebucket(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
  v_r     record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_rebucket');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  select * into v_r from rankings
   where user_id = v_user and media_item_id = p_media_item_id;

  if v_r.media_item_id is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  if v_r.bucket = p_bucket then
    raise exception 'title is already in that bucket' using errcode = '22023';
  end if;

  -- Removal followed by a fresh insertion session in the new band. PRD §10 requires
  -- that changing a bucket re-runs comparisons, so the title genuinely re-enters
  -- comparison rather than being dropped at an estimated position. Band bounds are
  -- recomputed after the removal, inside `_rank_start_impl`.
  perform _rank_unrank_impl(v_user, p_media_item_id);

  update user_media set bucket = p_bucket, updated_at = now()
   where user_id = v_user and media_item_id = p_media_item_id;

  return _record_operation_result(
    p_operation_id, _rank_start_impl(v_user, p_media_item_id, p_bucket)
  );
end;
$$;

comment on function rank_rebucket(uuid, taste_bucket, uuid) is
  'Moves an already-ranked title into a different band and opens the session that places it there. One transaction: if the new session cannot be opened, the old position is still there. Refuses 22023 for a bucket that is not moving — rank_again is the same-band case.';

-- rank_again ----------------------------------------------------------------
--
-- New. It replaces a client-side pair of calls with a server-side transaction.
--
-- **What it is for.** A reader who re-opens a rating they have already given, and
-- chooses the same bucket, is saying the *position* is wrong. `rank_rebucket` refuses
-- that by design — it raises 22023 on a bucket that is not moving, because it exists
-- to change a band. So the client composed `rank_unrank` then `rank_start` itself,
-- and named the honest cost in a comment: a rebucket is atomic and that pair is not.
--
-- **Why the pair was not good enough.** The gap between the two calls is a committed
-- state — logged, in the same bucket, without a position. The app has a name and a
-- queue for it, so nobody's data was ever wrong; but the reader who pressed one
-- button and lost their network in the middle got half of what they asked for, and
-- the only repair was to notice and press it again. Client compensation is not
-- atomicity, and PRD §10's "reranking never deletes viewing history" is easier to
-- keep when there is no moment at which the history is gone and nothing has replaced
-- it.
--
-- **It also serves the band change**, because `_rank_start_impl` upserts the bucket
-- and recomputes the band. `rank_rebucket` is kept rather than folded into this: it
-- is the signature the installed client calls, and its 22023 on a bucket that is not
-- moving is a refusal some callers rely on.
--
-- **An unranked title is not an error.** The title losing its position between the
-- screen reading it and this call is the state this call was trying to reach, so it
-- proceeds to the session — the same reading the client's version took of a P0002
-- from its unrank.
-- ---------------------------------------------------------------------------

create or replace function rank_again(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_claim record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  if p_bucket is null then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_again');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  if exists (select 1 from rankings
              where user_id = v_user and media_item_id = p_media_item_id) then
    perform _rank_unrank_impl(v_user, p_media_item_id);
  end if;

  return _record_operation_result(
    p_operation_id, _rank_start_impl(v_user, p_media_item_id, p_bucket)
  );
end;
$$;

-- rank_cancel -----------------------------------------------------------------
--
-- Also found by independent review 39, and the more interesting of its two findings
-- because the right fix is only half of what it proposed.
--
-- **The media lock: yes.** `rank_cancel` deletes a session, and `rank_answer`,
-- `rank_skip` and `rank_back` all read one, act on it, and write it back. Unserialised,
-- a cancel landing inside that window lets the answer record its comparison and then
-- update zero session rows — and answer with a `session_id` and a pivot for a session
-- that no longer exists. The reader's next tap is refused with "that session ended",
-- over a judgement that was recorded. Not corruption, and not a state anybody can see
-- wrongly, but it is one comparison charged for a question that led nowhere, and the
-- lock is two lines.
--
-- **The operation id: no, and deliberately.** A replayed cancel deletes by session id.
-- The second attempt finds that id gone — because the first deleted it, or because the
-- session finalised — and raises P0002, which `session.ts` has always read as the
-- outcome the caller wanted. A later session for the same title has a different id and
-- cannot be hit. So there is no observable a replay changes twice, which is the test
-- `lib/operation-intent.ts` sets, and the honest thing is to say so here rather than
-- add a signature change that buys nothing and widens the deployment surface.
--
-- The signature is therefore unchanged and there is no grant to restate.
-- ---------------------------------------------------------------------------

create or replace function rank_cancel(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_item    uuid;
  v_deleted integer;
begin
  perform assert_can_write();

  -- Read before the lock because the lock needs the title, and re-checked by the delete
  -- below: a session's media_item_id never changes, so this is a stable key rather than
  -- a value that could be stale by the time it is used.
  select rs.media_item_id into v_item
    from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = v_user;

  if v_item is not null then
    perform _lock_media(v_user, v_item);
  end if;

  delete from ranking_sessions
   where id = p_session_id and user_id = v_user;

  get diagnostics v_deleted = row_count;

  -- Scoped by user_id as well as by id, so this cannot be used to delete someone else's
  -- session by guessing a uuid — and a session that is not the caller's is reported as
  -- absent rather than as forbidden, for the same reason api.md §8 collapses the two.
  if v_deleted = 0 then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  return jsonb_build_object('done', true, 'cancelled', true);
end;
$$;

comment on function rank_cancel(uuid) is
  'Abandons a comparison session. The bucket survives in user_media and the title stays Logged; answers already given stay in comparisons, because they were real judgements. Takes the media lock, so it cannot delete a session out from under an answer that is mid-flight. Carries no operation id: a replay names a session id that is already gone and raises P0002, which the client reads as the outcome it wanted, so there is no observable a second attempt changes.';

comment on function rank_again(uuid, taste_bucket, uuid) is
  'Drops a title''s position and opens a fresh comparison session for it, in one transaction. The same-band case rank_rebucket refuses, and it handles a band change too. A title that is not ranked is not an error: that is the state this call was reaching for. If the session cannot be opened the old position is still there, which is what the client-side unrank-then-start could not promise.';


-- ---------------------------------------------------------------------------
-- 6. The collection writers take the same lock
--
-- Three of them can change whether a title is logged or what bucket it carries, and
-- all three ran with nothing serialising them against a ranking on the same title.
-- Rebuilt in full from their current definitions — `set_bucket` and `unlog` from
-- `20260813002300`, `clear_watch_date` from `20260824000100`, `log_watched` from
-- `20260816000000` — with the lock added and, for `unlog` and the note writers, the
-- changes noted at each site.
--
-- The claim comes before the lock in every one, which is the hierarchy at the top of
-- this file and is also what they already did.
-- ---------------------------------------------------------------------------

create or replace function set_bucket(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_bucket        taste_bucket
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_bucket') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_bucket is null then
    raise exception 'bucket is required' using errcode = '22023';
  end if;

  perform _assert_loggable(p_media_item_id);

  -- The lock this function's own header asked for in 20260813002300. Without it
  -- `_assert_unranked` and the upsert are two statements with a committing
  -- `rank_start` free to land between them, and the result is `user_media.bucket`
  -- disagreeing with `rankings.bucket` — I3, from one account on two devices.
  perform _lock_media(auth.uid(), p_media_item_id);

  perform _assert_unranked(p_media_item_id);

  insert into user_media (user_id, media_item_id, bucket)
  values (auth.uid(), p_media_item_id, p_bucket)
  on conflict (user_id, media_item_id) do update
    set bucket = excluded.bucket;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function set_bucket(uuid, uuid, taste_bucket) is
  'Sets the bucket without starting comparisons, creating the collection row if absent. Refuses a ranked title with 55000: for a ranked title this is a band move, which PRD §18 forbids queuing. Takes the media lock before that check, so a concurrent rank_start is either wholly before it or wholly after it.';

create or replace function unlog(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'unlog') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _lock_media(auth.uid(), p_media_item_id);

  perform _assert_unranked(p_media_item_id);

  -- **New: an open comparison session goes with the collection row.**
  --
  -- A session is not covered by `_assert_unranked` — it has no `rankings` row yet —
  -- so before this, unlogging a title mid-ranking left the session standing over a
  -- collection row that no longer existed. Finalising it would then have written a
  -- `rankings` row for a title the reader had just removed, which is the orphan this
  -- tranche exists to make impossible.
  --
  -- Deleting the session is the honest reading of the act rather than a repair:
  -- removing a title from the collection withdraws the claim the comparisons were
  -- placing. The answers already given stay in `comparisons`, exactly as
  -- `rank_cancel` leaves them, because they were real judgements.
  delete from ranking_sessions
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  delete from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  get diagnostics v_deleted = row_count;

  -- offline-sync.md §5: an operation targeting something already gone fails and
  -- leaves the queue, rather than retrying against a row that will never return.
  if v_deleted = 0 then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  -- The caller's own activity about this exact title, and nobody else's. Carried from
  -- 20260818000100 unchanged.
  --
  -- One statement, because the second half needs the ids the first half removed:
  -- `notifications.subject_id` is a bare uuid with no foreign key, so nothing
  -- cascades to it and a survivor renders through `my_notifications`' left join as a
  -- notice about a null title. `reactions` and `comments` do have the key and do
  -- cascade, which is where the reactions and comments on that activity go.
  with removed as (
    delete from feed_events
     where actor_id = auth.uid()
       and media_item_id = p_media_item_id
       and type in ('title_ranked', 'title_logged', 'season_completed')
    returning id
  )
  delete from notifications n
   using removed r
   where n.subject_type = 'feed_event'
     and n.subject_id = r.id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function unlog(uuid, uuid) is
  'Removes a title from the collection: the user_media row, any open comparison session for it, and the caller''s own title_ranked, title_logged and season_completed events for that exact title, whose reactions and comments cascade. Refuses a ranked title with 55000, since queuing it would discard ranking work silently on reconnect. Takes the media lock, so a session cannot outlive the collection row it was placing. Does not touch the watchlist: removal is not a decision to watch it again.';

-- `set_season_progress` is the fourth, and it was missed on the first pass of this
-- migration — found by independent review 39, which read "every writer that can change
-- whether a title is logged" against the schema rather than against the list in the
-- brief.
--
-- It belongs here for exactly that reason. `progress` is dormant (TV-1: nothing writes
-- it and ranking does not read it) and it is easy to file this function under "a column
-- nobody uses" — but the **upsert creates the `user_media` row**, and a row with a
-- progress on it is a Logged title. So a `set_season_progress` running unserialised can
-- re-create the row an `unlog` has just deleted, and a removal the reader watched
-- complete leaves the season in their collection.
--
-- A dormant column with a live writer is still a live writer.
create or replace function set_season_progress(
  p_operation_id  uuid,
  p_media_item_id uuid,
  p_progress      season_progress
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'set_season_progress') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  if p_progress is null then
    raise exception 'progress is required' using errcode = '22023';
  end if;

  if _media_kind(p_media_item_id) <> 'season' then
    raise exception 'progress applies to seasons only' using errcode = '22023';
  end if;

  perform _lock_media(auth.uid(), p_media_item_id);

  insert into user_media (user_id, media_item_id, progress)
  values (auth.uid(), p_media_item_id, p_progress)
  on conflict (user_id, media_item_id) do update
    set progress = excluded.progress;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function set_season_progress(uuid, uuid, season_progress) is
  'Marks a season watching or completed. Outbox-eligible. Takes the media lock, because the upsert creates the collection row: a title with a progress on it is a Logged title, so this cannot be allowed to re-create a row an unlog has just removed. TV-1: progress is not a prerequisite for ranking and nothing reads it today.';

create or replace function clear_watch_date(
  p_operation_id  uuid,
  p_media_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'clear_watch_date') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _lock_media(auth.uid(), p_media_item_id);

  select * into v_row
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id
     for update;

  -- No row, or a row with no date on it. Both are the state the caller asked for, so
  -- both are success.
  if v_row.media_item_id is null or v_row.watched_on is null then
    return jsonb_build_object('status', 'ok');
  end if;

  -- I8. The date is the only thing on this row saying the title was watched, so
  -- clearing it would un-log the title rather than forget a date. A bucket is a watch
  -- signal in its own right (20260815040000), and so is a completed season.
  if v_row.bucket is null and v_row.progress is distinct from 'completed' then
    raise exception 'the watch date is the only record that this was watched'
      using errcode = '22023';
  end if;

  update user_media
     set watched_on = null
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  return jsonb_build_object('status', 'ok');
end;
$$;

comment on function clear_watch_date(uuid, uuid) is
  'Sets user_media.watched_on to null for the caller''s own row, leaving the bucket, the note and every other signal alone. The title stays Logged: a bucket is a watch signal in its own right (20260815040000). Refuses with 22023 when the date is the only watch signal on the row. Takes the media lock, so it cannot interleave with a ranking on the same title. Idempotent through _claim_operation.';


-- ---------------------------------------------------------------------------
-- 7. NR-1 — a new note with no stated visibility is private
--
-- The founder's decision, 2026-08-24. `user_media.note_visibility` is `not null
-- default 'private'`, PRD §22 says a note is private until its author publishes it,
-- and every screen in the app has sent an explicit value since 2026-08-23 — but both
-- writers read a *null* on a note that has never existed as `public`. The safe-looking
-- call was the publishing call.
--
-- **Only that branch moves.** The rules this keeps, unchanged:
--
--   new text + explicit public   → public. A Review is a deliberate act.
--   new text + explicit private  → private.
--   new text + no visibility     → PRIVATE.  ← the only line that changes
--   existing public Review, ordinary edit with no visibility named → stays public.
--   existing private note, ordinary edit → stays private.
--
-- The fourth line is why this is not a one-character change to a default. "A note that
-- has never existed" is `note_updated_at is null`, maintained by `touch_note_version`
-- since `20260813002300`: it advances only when the text changes. A null there means
-- no note has ever been stored on the row, which is exactly the test for new content —
-- and it is what keeps an existing Review public through an edit that omits the field.
-- Reinterpreting a published review as private because a caller left out a redundant
-- argument would be the same defect pointed the other way.
--
-- **No stored row changes.** Both branches fire only for a note that does not yet
-- exist. `update user_media set …` appears nowhere in this section.
--
-- Rebuilt in full from `20260816000000`, which holds the current definitions. The
-- signatures do not change, so there is nothing to drop and no grant to restate.
-- ---------------------------------------------------------------------------

create or replace function log_watched(
  p_operation_id    uuid,
  p_media_item_id   uuid,
  p_watched_on      date default null,
  p_note            text default null,
  p_note_visibility note_visibility default null,
  p_note_spoilers   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_version timestamptz;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'log_watched') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_loggable(p_media_item_id);
  perform _assert_note_length(v_note);

  -- current_date + 1, not current_date. The server is UTC and the client sends a local
  -- date, so for the first hours of the day everywhere east of UTC the local date is
  -- already tomorrow in server terms. Comparing against today refuses a correct
  -- "I watched this tonight" for a large part of every day, depending on longitude.
  if p_watched_on is not null and p_watched_on > current_date + 1 then
    raise exception 'watch date is in the future' using errcode = '22023';
  end if;

  -- The media lock, for the same reason set_bucket takes it: this is the other writer
  -- that can create the collection row, and it must not interleave with an unlog or a
  -- finalise on the same title.
  perform _lock_media(auth.uid(), p_media_item_id);

  insert into user_media (
    user_id, media_item_id, watched_on, note, note_visibility, note_has_spoilers
  )
  values (
    auth.uid(),
    p_media_item_id,
    p_watched_on,
    v_note,
    -- NR-1. An insert always creates the note, so there is no stored visibility to
    -- preserve — and a note whose author has not said otherwise is private.
    case when v_note is null then 'private'::note_visibility
         else coalesce(p_note_visibility, 'private'::note_visibility) end,
    coalesce(p_note_spoilers, false)
  )
  on conflict (user_id, media_item_id) do update
    set watched_on = coalesce(excluded.watched_on, user_media.watched_on),
        note       = coalesce(excluded.note,       user_media.note),
        -- Only moves when the caller named a value, or when this call is what brings
        -- the row its first note — and that case is now private too. An existing note
        -- keeps the visibility it already had, which is what protects a published
        -- Review from an edit that omits the field.
        note_visibility = case
          when p_note_visibility is not null then p_note_visibility
          when v_note is not null and user_media.note_updated_at is null
            then 'private'::note_visibility
          else user_media.note_visibility
        end,
        note_has_spoilers = case
          when p_note_spoilers is not null then p_note_spoilers
          when v_note is not null and user_media.note_updated_at is null then false
          else user_media.note_has_spoilers
        end
  returning note_updated_at into v_version;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

comment on function log_watched(uuid, uuid, date, text, note_visibility, boolean) is
  'Marks a title watched, optionally with a note. Outbox-eligible. Upserts, so a repeat with a corrected date is not a conflict. A note written here is private unless the caller explicitly says public; an existing note keeps the visibility it already had. Accepts a watch date up to tomorrow, because the server is UTC and a client east of it sends a local date a day ahead for the first hours of its day.';

create or replace function save_note(
  p_operation_id     uuid,
  p_media_item_id    uuid,
  p_note             text,
  p_base_updated_at  timestamptz default null,
  p_note_visibility  note_visibility default null,
  p_note_spoilers    boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_current user_media;
  v_version timestamptz;
  v_new     boolean;
begin
  perform assert_can_write();

  if not _claim_operation(p_operation_id, 'save_note') then
    return jsonb_build_object('status', 'already_applied');
  end if;

  perform _assert_note_length(v_note);

  -- **No media lock here, deliberately.** This function writes `note`,
  -- `note_visibility` and `note_has_spoilers` and reads nothing about a ranking. I7 —
  -- editing text never moves a title's placement — is therefore structural: there is
  -- no statement in this body that could. Taking the lock would serialise every note
  -- edit behind every ranking on the same title and buy nothing, and a lock taken
  -- where it is not needed is a lock whose purpose the next reader has to guess.
  select * into v_current
    from user_media
   where user_id = auth.uid() and media_item_id = p_media_item_id;

  if not found then
    raise exception 'not in your collection' using errcode = 'P0002';
  end if;

  -- A null stored version means no note has ever been written here, so there is
  -- nothing a stale edit could destroy and nothing to ask the user about.
  if p_base_updated_at is not null
     and v_current.note_updated_at is not null
     and date_trunc('milliseconds', v_current.note_updated_at)
      <> date_trunc('milliseconds', p_base_updated_at) then
    raise exception 'the note changed elsewhere'
      using errcode = '55000',
            detail  = jsonb_build_object(
              'conflict',       'note',
              'server_version', v_current.note_updated_at
            )::text;
  end if;

  v_new := v_current.note_updated_at is null and v_note is not null;

  update user_media
     set note = v_note,
         note_visibility = case
           when p_note_visibility is not null then p_note_visibility
           -- NR-1. A note nobody has published is a private note.
           when v_new then 'private'::note_visibility
           else v_current.note_visibility
         end,
         note_has_spoilers = case
           -- Clearing the note clears the claim about it. Leaving the flag set on
           -- an empty note would mean the next note written through log_watched's
           -- coalescing path inherits a spoiler tag its author never chose.
           when v_note is null then false
           when p_note_spoilers is not null then p_note_spoilers
           when v_new then false
           else v_current.note_has_spoilers
         end
   where user_id = auth.uid() and media_item_id = p_media_item_id
  returning note_updated_at into v_version;

  return jsonb_build_object('status', 'ok', 'note_version', v_version);
end;
$$;

comment on function save_note(uuid, uuid, text, timestamptz, note_visibility, boolean) is
  'Writes or clears a note, and the two claims attached to it: who may read it, and whether it spoils the title. A brand-new note with no stated visibility is private (NR-1); an existing one keeps what it had, so an edit that omits the field never republishes or unpublishes. Assigns rather than coalescing, which is what lets a note be deleted. Refuses with 55000 when the base version no longer matches (offline-sync.md §5).';


-- ---------------------------------------------------------------------------
-- 8. Grants
--
-- `drop function` takes the grants with it, so every dropped signature is restated
-- here rather than assumed. `20260813001800` made EXECUTE default-deny with an
-- explicit allow-list and `20260813002100` issued the global form, so a new function
-- arrives with no PUBLIC grant; the revokes are belt-and-braces and the grants are
-- the statement of intent. `function-grants.test.mjs` asserts this exact set.
--
-- Nothing here is granted to `anon`. The helpers in §1, §2 and §4 are granted to
-- nobody: `_lock_media` would let a client take a lock on a title it does not own,
-- `_claim_operation_result` called directly would let one burn an operation id so a
-- later genuine write returns success without happening, and the two `_rank_*_impl`
-- bodies skip both the claim and the lock by construction.
-- ---------------------------------------------------------------------------

revoke execute on function rank_start(uuid, taste_bucket, uuid)   from public, anon;
revoke execute on function rank_answer(uuid, uuid, uuid)          from public, anon;
revoke execute on function rank_skip(uuid, uuid)                  from public, anon;
revoke execute on function rank_back(uuid, uuid)                  from public, anon;
revoke execute on function rank_unrank(uuid, uuid)                from public, anon;
revoke execute on function rank_reorder(uuid, integer, uuid)      from public, anon;
revoke execute on function rank_rebucket(uuid, taste_bucket, uuid) from public, anon;
revoke execute on function rank_again(uuid, taste_bucket, uuid)   from public, anon;

grant execute on function rank_start(uuid, taste_bucket, uuid)    to authenticated;
grant execute on function rank_answer(uuid, uuid, uuid)           to authenticated;
grant execute on function rank_skip(uuid, uuid)                   to authenticated;
grant execute on function rank_back(uuid, uuid)                   to authenticated;
grant execute on function rank_unrank(uuid, uuid)                 to authenticated;
grant execute on function rank_reorder(uuid, integer, uuid)       to authenticated;
grant execute on function rank_rebucket(uuid, taste_bucket, uuid) to authenticated;
grant execute on function rank_again(uuid, taste_bucket, uuid)    to authenticated;


-- ---------------------------------------------------------------------------
-- 9. The deployment window, written down
--
-- A friend Beta is installed on real devices. It calls `rank_start(p_media_item_id,
-- p_bucket)` and six more by the names and arguments they have today, and it will go
-- on doing so until every one of those devices takes an OTA update. So the question
-- this section answers is not "is the new signature better" but "what happens to the
-- phone in somebody's pocket during the hours between the backend deploy and the
-- update they have not opened the app to receive".
--
--   OLD client + OLD db   works, and is what is live now.
--   OLD client + NEW db   **works.** Every added parameter is trailing and defaults to
--                         null, so PostgREST resolves the two-key body to the one
--                         function that exists. The old client gets the media lock,
--                         the finalise reconciliation and the NR-1 default — every
--                         correctness fix in this migration — and does not get replay
--                         protection, because it sends no id. That is honest: an id it
--                         does not have cannot be invented server-side without faking
--                         idempotency, since a generated id is fresh on every retry.
--   NEW client + OLD db   **fails**, on the ranking RPCs only: a three-key body against
--                         a two-parameter function is PGRST202. So the backend must be
--                         deployed *before* the OTA, which is the ordinary direction.
--   NEW client + NEW db   works, with replay protection.
--
-- **There is no second overload.** Each old signature is dropped and replaced by one
-- function with optional trailing arguments, rather than left standing beside the new
-- one. Two candidates whose argument sets nest resolve ambiguously in PostgREST —
-- `20260816000000` records the same finding about `log_watched` — and, more to the
-- point, an old public signature that still worked would be a public route around the
-- claim. There is exactly one route in, and it is the protected one.
-- ---------------------------------------------------------------------------
