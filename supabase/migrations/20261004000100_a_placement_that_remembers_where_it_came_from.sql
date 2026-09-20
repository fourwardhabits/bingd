-- ---------------------------------------------------------------------------
-- T2 — the placement ledger, and re-ranking from the position you already hold.
--
-- `watch-history-and-ranking-calibration.md` §E, §F, §M.2 row 2.
--
-- ===========================================================================
-- TWO THINGS, AND THEY MUST LAND TOGETHER (§M.2)
--
--   1. **`ranking_placements`** — an append-only record of every completed placement,
--      holding the ordinal it came from, the ordinal it landed at, and a score snapshot.
--      `rankings.position` stays the single current ordinal. History is never averaged,
--      weighted, decayed or replayed into it.
--
--   2. **A prior-anchored search** for re-placing an already-ranked title. It checks both
--      neighbours first, gallops outward only if an answer shows a move, then bisects.
--      Unchanged costs 2 comparisons instead of 6–9.
--
-- They share the session, so they share a migration: a ledger row has to record the
-- strategy that produced it, and the strategy has to be resumable, which is a session
-- column either way.
--
-- ===========================================================================
-- WHAT A USER SEES
--
-- Nothing, and that is the tranche's whole risk profile. *Update your rating* gets
-- cheaper; nothing moves that would not have moved; no new surface appears. The ledger
-- is written and read by nobody until T3b's Watch History screen.
--
-- The kill switch is `ranking.prior_search_enabled`. Set it false and every session
-- opens `bisect`, which is exactly today's behaviour — including for sessions already
-- open, because the strategy is re-read on every step rather than trusted from the row.
--
-- ===========================================================================
-- THE SQL REBUILD TRAP, PAID ONCE MORE
--
-- Every function below is rebuilt from its TRUE latest body, which is not always the
-- file its name suggests:
--
--   `_rank_finalize`     20261001000100  (T0, the correction marker)
--   `_rank_start_impl`   20260926000100
--   `rank_answer`        20260926000100
--   `rank_skip`          20260926000100
--   `rank_back`          20260926000100
--   `rank_again`         20260826000500
--   `rank_rebucket`      20260826000500
--
-- `_rank_offer`, `_rank_session_state`, `_rank_session_sync`, `_rank_band_members`,
-- `_rank_pivot_at`, `_rank_pivot_card` and `_rank_current_comparison` are NOT touched.
-- Narrowing is untouched. The only arithmetic that changes is which index is offered
-- next, and it is changed in one new function so the TypeScript twin can be fuzzed
-- against it (§O.2's policy equivalence).
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create type placement_kind as enum
  ('first', 'rewatch', 'correction', 'refine', 'import', 'manual', 'backfill');

comment on type placement_kind is
  'What act produced a placement. first: the title had no position. rewatch: an explicit '
  'second viewing. correction: Update your rating, same band or another. refine: T5''s '
  'calibration. import: T6''s queue. manual: rank_reorder, which has no caller. backfill: '
  'reconstructed by 20261004000100 from the ranking that already existed, and the kind '
  'says the category_size on it is an estimate.';

create table ranking_placements (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  media_item_id  uuid not null,
  category       ranking_category not null,
  kind           placement_kind not null,

  -- `placed`  the title had no prior position
  -- `moved`   the bucket or the position differs
  -- `unchanged` both neighbour checks passed
  -- `kept`    resolved at the prior by skips or the dry walk
  outcome        text not null
                 check (outcome in ('placed', 'moved', 'unchanged', 'kept')),

  bucket         taste_bucket not null,
  position       integer not null check (position > 0),   -- category ordinal (the "#7")
  band_rank      integer not null check (band_rank > 0),
  band_size      integer not null check (band_size >= band_rank),
  category_size  integer not null check (category_size >= position),
  score          numeric(3,1) not null,                   -- the one-decimal score shown then

  -- **The live state immediately before, read inside the category lock.** §E.2 decided
  -- this against the alternative -- the ordinal recorded on the previous ledger row --
  -- and the reason is arithmetic rather than taste: after twelve films were ranked above
  -- Heat it sits at #30, not the #18 its last placement recorded. Printing "moved 11"
  -- when it really moved 23 is a false statement about the reader's own list.
  --
  -- The previous row's `position` is still there and still true about *then*, which is
  -- what Watch History prints as "Placed #18 of 34 · Mar 2025". Both are stored; §E.2's
  -- form B is what the movement line uses.
  from_bucket    taste_bucket,
  from_position  integer,
  from_score     numeric(3,1),

  strategy       text check (strategy in ('bisect', 'prior')),
  tolerance      smallint not null default 0,
  comparisons    smallint,
  skips          smallint,
  adjustable     boolean not null default false,
  watch_event_id uuid references watch_events (id) on delete set null,
  session_id     uuid,
  operation_id   uuid,

  -- A RECORDING time (§L.2). Never a watch time, and never read as one.
  created_at     timestamptz not null default now(),

  constraint ranking_placements_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

create index ranking_placements_title
  on ranking_placements (user_id, media_item_id, created_at desc);
create index ranking_placements_category
  on ranking_placements (user_id, category, created_at desc);

alter table ranking_placements enable row level security;

-- Owner-only, and it stays owner-only: §Q lists "another user's placement history" as an
-- explicit non-goal, and §K puts no movement in the feed payload at all, so there is
-- nothing a future client could render from history it was never sent. The privacy rule
-- is in the data rather than in a template.
create policy ranking_placements_own on ranking_placements for select
  using (user_id = auth.uid());

comment on table ranking_placements is
  'Append-only. One row per completed placement. rankings.position remains the single '
  'current ordinal (§L.1) -- nothing here is averaged, weighted, decayed or replayed into '
  'it, and no snapshot ever feeds the current score. Written by _rank_finalize and by '
  'nothing else.';


-- ---------------------------------------------------------------------------
-- 2. Clean comparison evidence (§A.3)
--
-- Three additive columns. `withdrawn_at` is the one that matters: an Undo currently
-- leaves the undone comparison row in place, so the evidence record contains answers the
-- reader took back. T5's confidence model (§G) reads this table and would be reading
-- withdrawn answers as evidence.
-- ---------------------------------------------------------------------------

alter table comparisons
  add column session_id   uuid,
  add column placement_id uuid references ranking_placements (id) on delete set null,
  add column withdrawn_at timestamptz;

create index comparisons_session on comparisons (session_id) where session_id is not null;

comment on column comparisons.withdrawn_at is
  'Set by rank_back. The answer was taken back, so it is not evidence -- §G''s support '
  'model and every later reader must exclude it. The row is kept rather than deleted '
  'because "they answered and undid it" is itself a fact about the session, and a delete '
  'would make an undo indistinguishable from never having been asked.';

comment on column comparisons.placement_id is
  'The placement this answer contributed to, linked at finalize. Null for a legacy row '
  'and for an answer whose session was abandoned.';


-- ---------------------------------------------------------------------------
-- 3. The session learns what act it is, and how it is searching
-- ---------------------------------------------------------------------------

alter table ranking_sessions
  add column kind           placement_kind,
  add column strategy       text check (strategy in ('bisect', 'prior')),
  add column prior_offset   integer,
  add column tolerance      smallint not null default 0,
  add column watch_event_id uuid references watch_events (id) on delete set null;

comment on column ranking_sessions.kind is
  'The act this session is. Null on a session opened before 20261004000100, which is '
  'therefore treated as a legacy bisect session and, per §F.4, RESTARTS rather than '
  'resumes if the caller asks for a different kind.';

comment on column ranking_sessions.strategy is
  'bisect: the plain binary insertion, and what every first ranking uses. prior: the '
  '§F.2 policy, which checks both neighbours of the position the title already holds '
  'before it searches anywhere else. Null is read as bisect.';

comment on column ranking_sessions.prior_offset is
  'The insertion point the subject already occupies, as an index into the band with the '
  'subject excluded -- so it is in the same coordinates as lo, hi and pivot, and '
  '_rank_session_sync''s rebase does not have to know about it. Null for a bisect '
  'session.';

comment on column ranking_sessions.tolerance is
  'w in §F.2. The half-width of the window around the prior that counts as "still in the '
  'right place". Zero for every path this migration ships; T5''s Refine is the only '
  'caller that sets it, by rank (§H.5).';


-- ---------------------------------------------------------------------------
-- 4. The flags (§M.6)
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('ranking.prior_search_enabled',   'true'::jsonb),
  ('ranking.prior_gallop_doublings', '3'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 5. `next_pivot` — the one piece of new arithmetic in the tranche
--
-- ===========================================================================
-- IT IS A PURE FUNCTION, AND THAT IS THE DESIGN (§F.1)
--
-- `next_pivot(lo, hi, p, w, n, g)` and nothing else. Narrowing is untouched -- WIN sets
-- `hi := i`, LOSS sets `lo := i + 1`, exactly as today -- so a history frame still
-- restores the whole state and **Undo needs no new field**. Recomputing the next offer
-- from the restored bounds is what makes that true.
--
-- Being pure is also what lets §O.2 fuzz the TypeScript twin against this over random
-- `(lo, hi, p, w, n)`, and what lets the simulator in `scripts/sim/rerank.mjs` tune `g`
-- without a database.
--
-- ===========================================================================
-- THE POLICY, IN WORDS
--
-- Items 0..n-1, subject excluded. Insertion points 0..n. `p` is where the subject
-- already sits. The window `[a, b] = [p-w, p+w]` is what counts as unchanged.
--
--   Both neighbours of the window are tested first, and BOTH are tested -- nothing is
--   assumed from one answer. The item just above the window, then the item just below.
--
--   An answer that proves a move opens a gallop on that side: probes at 1, 2, 4, 8 out,
--   capped at 2^g. The cap is what stops a title that moved to the far end of a 500-band
--   costing a linear walk.
--
--   Everything else bisects, which is the behaviour this whole function degrades to.
--
-- The gallop only runs while the OTHER bound is still at the end of the range -- `lo = 0`
-- going up, `hi = n` going down. Once both bounds have moved the range is bounded on
-- both sides and bisection is strictly better than guessing.
--
-- §F.3's table is the expected cost, and `scripts/sim/rerank.mjs` reproduces it.
-- ---------------------------------------------------------------------------

create or replace function next_pivot(
  p_lo integer, p_hi integer, p_prior integer, p_tolerance integer,
  p_n integer, p_gallop integer
)
returns integer
language sql
immutable
set search_path = public
as $$
  with w as (
    select greatest(coalesce(p_tolerance, 0), 0) as t
  ),
  bounds as (
    select greatest(p_prior - w.t, 0) as a,
           least(p_prior + w.t, p_n)  as b,
           (1 << greatest(coalesce(p_gallop, 3), 0)) as cap
      from w
  )
  select case
    -- The item just above the window. First, always, and it is why a downward move
    -- costs one comparison more than an upward one (§F.3).
    when p_lo < bounds.a and bounds.a <= p_hi then bounds.a - 1
    -- The item just below the window.
    when p_lo <= bounds.b and bounds.b < p_hi then bounds.b
    -- An answer proved it moved UP. Probe 1, 2, 4, 8 above the window while the top of
    -- the range is still open.
    when p_hi < bounds.a then
      case when p_lo = 0 and (bounds.a - p_hi) < bounds.cap
           then greatest(0, p_hi - (bounds.a - p_hi))
           else (p_lo + p_hi) / 2 end
    -- An answer proved it moved DOWN.
    when p_lo > bounds.b then
      case when p_hi = p_n and (p_lo - bounds.b) < bounds.cap
           then least(p_n - 1, bounds.b + 2 * (p_lo - bounds.b) - 1)
           else (p_lo + p_hi) / 2 end
    else (p_lo + p_hi) / 2
  end
  from bounds;
$$;

comment on function next_pivot(integer, integer, integer, integer, integer, integer) is
  'The §F.2 search policy as a pure function of (lo, hi, prior, tolerance, n, gallop '
  'doublings). Neighbour check, then a capped gallop on the side an answer opened, then '
  'bisection. Narrowing is unchanged, so an Undo still restores the whole state by '
  'restoring lo, hi and pivot and letting this recompute. Fuzzed against its TypeScript '
  'twin in src/features/ranking/prior-search.ts (§O.2).';

-- Not granted to any client role. The TypeScript twin is fuzzed against this from the
-- node --test harness, which runs as the owner; a client has no reason to ask the server
-- what it would offer next, and every grant is a surface (20260813001800).
revoke execute on function next_pivot(integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;


/** Whether the prior search is on at all. The kill switch, read on every step. */
create or replace function _prior_search_enabled()
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce((select (value)::boolean from app_config
                    where key = 'ranking.prior_search_enabled'), true);
$$;

revoke execute on function _prior_search_enabled() from public, anon, authenticated;

create or replace function _prior_gallop()
returns integer
language sql stable
set search_path = public
as $$
  select coalesce((select (value)::integer from app_config
                    where key = 'ranking.prior_gallop_doublings'), 3);
$$;

revoke execute on function _prior_gallop() from public, anon, authenticated;


/**
 * The next index to offer, for a session, and the one place the two strategies meet.
 *
 * A `bisect` session gets the midpoint, which is what `rank_answer` computed inline
 * before. A `prior` session gets `next_pivot`. Both then go through `_rank_offer`'s walk
 * past `seen_items`, unchanged, so the no-repeat invariant holds for both.
 *
 * Reading the strategy through `_prior_search_enabled()` rather than trusting the
 * session's own column is what makes the kill switch work on sessions that are ALREADY
 * OPEN. Flipping a flag that only affects sessions opened afterwards is not a kill
 * switch; it is a preference.
 */
create or replace function _rank_next_index(
  p_lo integer, p_hi integer, p_strategy text, p_prior integer, p_tolerance integer,
  p_n integer
)
returns integer
language sql stable
set search_path = public
as $$
  select case
    when p_strategy = 'prior' and p_prior is not null and _prior_search_enabled()
      then next_pivot(p_lo, p_hi, p_prior, coalesce(p_tolerance, 0), p_n, _prior_gallop())
    else (p_lo + p_hi) / 2
  end;
$$;

revoke execute on function _rank_next_index(integer, integer, text, integer, integer, integer)
  from public, anon, authenticated;


/**
 * Where a prior session settles when the answers stop narrowing, per §F.2's finalize
 * table. Returns the insertion point, and it is a pure function of the same state.
 *
 *   `lo >= hi`                     the answers pinned it exactly
 *   `a <= lo and hi <= b` (w > 0)  the window was confirmed; it is unchanged
 *   `hi - lo <= w`                 the point in [lo, hi] nearest the prior
 *   otherwise                      the midpoint, which is the bisect behaviour
 *
 * "Only answers move a title" (§B.2) is this function: with no informative answers
 * `lo = 0`, `hi = n`, and the nearest point in [0, n] to `p` is `p`.
 */
create or replace function _rank_settle_at(
  p_lo integer, p_hi integer, p_strategy text, p_prior integer, p_tolerance integer
)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when p_lo >= p_hi then p_lo
    when p_strategy is distinct from 'prior' or p_prior is null then (p_lo + p_hi) / 2
    -- The point in [lo, hi] nearest the prior. Where the range still contains the prior
    -- that IS the prior, which is what "where it already was" means.
    else greatest(p_lo, least(p_prior, p_hi))
  end;
$$;

revoke execute on function _rank_settle_at(integer, integer, text, integer, integer)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5b. `_rank_session_state` carries the new columns
--
-- Rebuilt from 20260826000500. Three columns are APPENDED -- `strategy`,
-- `prior_offset`, `tolerance` -- and nothing else changes: the clamping of `hi` into the
-- live band, the clamping of `pivot` back inside `[lo, hi)`, and the band-excluding-self
-- read are all transcribed.
--
-- **Appended, deliberately.** Every caller reads this into a plpgsql `record`, which
-- adapts to a wider row; inserting a column in the middle would too, but a caller that
-- ever reads positionally would not, and appending costs nothing.
--
-- `drop` before `create`, because `create or replace` cannot change a function's return
-- type -- "cannot change return type of existing function" -- and a `returns table` row
-- type is the return type. Nothing depends on it in the catalogue sense: plpgsql bodies
-- are not checked until they run.
-- ---------------------------------------------------------------------------

drop function if exists _rank_session_state(uuid, uuid);

create or replace function _rank_session_state(p_session_id uuid, p_user uuid)
returns table (
  session_id    uuid,
  media_item_id uuid,
  category      ranking_category,
  bucket        taste_bucket,
  band_lo       integer,
  band_size     integer,
  lo            integer,
  hi            integer,
  pivot         integer,
  skips         smallint,
  history       jsonb,
  provisional   boolean,
  new_watch     boolean,
  -- 20261004000100
  strategy      text,
  prior_offset  integer,
  tolerance     smallint
)
language plpgsql stable
set search_path = public
as $$
declare
  s record;
  b record;
  v_hi integer;
  v_lo integer;
begin
  select * into s from ranking_sessions rs
   where rs.id = p_session_id and rs.user_id = p_user;

  if s.id is null then
    raise exception 'no such ranking session' using errcode = 'P0002';
  end if;

  -- The subject is excluded from its own band exactly when it is still sitting in it,
  -- which is what `provisional` means.
  select * into b from band_bounds_excluding(
    p_user, s.category, s.bucket,
    case when s.provisional then s.media_item_id end
  );

  -- The band may have shrunk since the session opened, if titles were unranked
  -- or rebucketed away. Clamping is what keeps a stale upper bound from pointing
  -- past the end of the band and into the next one.
  v_hi := least(s.hi, b.size);
  v_lo := least(s.lo, v_hi);

  return query select
    s.id,
    s.media_item_id,
    s.category,
    s.bucket,
    b.lo,
    b.size,
    v_lo,
    v_hi,
    -- Carried verbatim from 20260813001600: a stored pivot that a shrunken band has
    -- put out of range is clamped back inside it rather than left to address a title
    -- that is no longer there.
    greatest(v_lo, least(coalesce(s.pivot, (v_lo + v_hi) / 2), greatest(v_hi - 1, v_lo))),
    s.skips,
    s.history,
    s.provisional,
    s.new_watch,
    -- Null on a session opened before this migration, which `_rank_next_index` reads as
    -- `bisect` -- so a session open across the deploy finishes the way it started
    -- (§M.4). The prior is NOT clamped here: it is a fixed property of where the title
    -- was when the session opened, and clamping it to a band that has since shrunk
    -- would silently move the anchor.
    coalesce(s.strategy, 'bisect'),
    s.prior_offset,
    coalesce(s.tolerance, 0::smallint);
end;
$$;

revoke execute on function _rank_session_state(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. `_rank_finalize`, rebuilt from 20261001000100
--
-- The parameter list grows, so the old one is dropped rather than overloaded: two
-- functions of this name, one with nine parameters and one with eleven, are ambiguous
-- from a nine-argument call and the resolution would be by declaration order.
--
-- Four changes, and everything else is transcribed:
--
--   1. `from_*` is read AFTER the category lock and BEFORE the unrank, so it is the live
--      state and not the state the caller saw.
--   2. **The no-op finalize.** If the resolved point equals the prior and the bucket is
--      unchanged, `rankings` is left entirely alone -- no delete, no insert, no trigger
--      churn, no `created_at` change. T0 preserved `created_at` through a correction;
--      this removes the delete-and-insert that made preserving it necessary.
--   3. The ledger row, and the comparison links.
--   4. `placement_id` and `movement` in the response. Old clients ignore both.
-- ---------------------------------------------------------------------------

drop function if exists _rank_finalize(
  uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean
);

create or replace function _rank_finalize(
  target uuid,
  item uuid,
  cat ranking_category,
  b taste_bucket,
  pos integer,
  session uuid,
  was_adjusted boolean default false,
  p_replaces boolean default false,
  p_new_watch boolean default false,
  p_kind placement_kind default null,
  p_operation_id uuid default null
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
  v_replaced  boolean := false;
  v_event_id  uuid;
  v_causal_at timestamptz;
  v_kept_at   timestamptz;
  -- 20261004000100.
  v_prior       record;
  v_from_band   record;
  v_from_score  numeric;
  v_kind        placement_kind;
  v_outcome     text;
  v_noop        boolean := false;
  v_placement   uuid;
  v_cat_size    integer;
  v_session_row record;
  v_comparisons integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(target::text || cat::text, 0));

  -- Unconditional, and it must be: plpgsql raises "record is not assigned yet" on the
  -- first field access of a record no statement has written, so a null session would
  -- fail at `v_session_row.kind` rather than reading null from it. A `select into` that
  -- matches nothing assigns a row of nulls, which is exactly what the coalesces below
  -- expect. Caught by correction-is-not-a-ranking.test.mjs.
  select * into v_session_row from ranking_sessions where id = session;

  -- The act this placement is. The session knows since this migration; a caller that
  -- names one wins; and a session opened before this migration falls back to the same
  -- rule the feed has used since 20260826000500 -- a replacement is a correction unless
  -- it declared a new watch.
  v_kind := coalesce(
    p_kind,
    v_session_row.kind,
    case when not p_replaces then 'first'::placement_kind
         when p_new_watch   then 'rewatch'::placement_kind
         else 'correction'::placement_kind end
  );

  -- ---------------------------------------------------------------------------
  -- **The live state immediately before** (§E.2 form B), read inside the lock. Every
  -- number here is about to be invalidated by the statements below, which is precisely
  -- why it is read here and not by the caller.
  -- ---------------------------------------------------------------------------
  select r.bucket, r.position, r.created_at into v_prior
    from rankings r
   where r.user_id = target and r.media_item_id = item;

  if v_prior.position is not null then
    select * into v_from_band from band_bounds(target, cat, v_prior.bucket);
    v_from_score := score_for(
      v_prior.bucket, v_prior.position - v_from_band.lo + 1, v_from_band.size
    );
  end if;

  -- ---------------------------------------------------------------------------
  -- **The no-op finalize** (§E.3.2).
  --
  -- The resolved point is where the title already is, in the band it is already in. The
  -- old code deleted the row and re-inserted it at the same ordinal, which fired the
  -- unrank triggers, the insert triggers, the deferred award revocation and the
  -- watchlist rule, and reset `created_at` -- T0 had to carry `created_at` across that
  -- gap by hand precisely because the gap existed. Not opening it is better than
  -- carrying things across it.
  --
  -- `p_replaces` is checked too: without it a first placement into an empty band at
  -- position 1 with no prior row would match `v_prior.position is null` and skip its own
  -- insert.
  -- ---------------------------------------------------------------------------
  if p_replaces and v_prior.position is not null
     and v_prior.bucket = b and v_prior.position = pos then
    v_noop := true;
  end if;

  if not v_noop then
    -- The old position, dropped at the last possible moment rather than at the
    -- first (20260826000500). Everything above this line in the reader's session --
    -- opening the sheet, every comparison, every skip, closing it and coming back --
    -- left the ranking they already had exactly where it was.
    if p_replaces and v_prior.position is not null then
      -- 20261001000100. Read before the drop deletes it.
      v_kept_at := v_prior.created_at;
      perform _rank_unrank_impl(target, item);
      v_replaced := true;
    end if;

    -- Recomputed inside the lock, so it reflects the ranking this insert is about
    -- to happen against rather than the one the caller saw. With the drop above, that
    -- is now also the numbering the session's offsets were computed in.
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

    -- 20261001000100. `created_at` is the instant of the ranking act this row stands
    -- for: a first placement, or an explicit rewatch (`p_new_watch`), is now; a
    -- correction -- *Update your rating*, in the same band or another -- is not an act of
    -- its own and keeps the instant the ranking already had. The weekly streak, *Recently
    -- ranked* and the watchlist rule below all read this column, and every one of them
    -- was hearing a correction as a new ranking.
    --
    -- 20261004000100 widens it by exactly the set §E.3.3 names: `refine` and `manual`
    -- join `correction` as acts that preserve the instant. Refining a ranking is not
    -- ranking it again -- §L.2 excludes it from the weekly streak in as many words -- and
    -- `rankings.created_at` is the streak's clock.
    insert into rankings (user_id, media_item_id, category, bucket, position, created_at)
    values (
      target, item, cat, b, pos,
      case
        when v_replaced and v_kind in ('correction', 'refine', 'manual')
          then coalesce(v_kept_at, now())
        when v_replaced and not p_new_watch and v_kind not in ('first', 'rewatch', 'import')
          then coalesce(v_kept_at, now())
        else now()
      end
    );

    -- The collection row this ranking is a claim about, re-asserted from the ranking
    -- itself (20260825000200 §3). It closes I1 and I3 against anything that committed in
    -- the gap between the session opening and this transaction -- and it is the *only*
    -- writer of a provisional band change: `rank_rebucket` does not move
    -- `user_media.bucket` up front (20260826000500).
    insert into user_media (user_id, media_item_id, bucket)
    values (target, item, b)
    on conflict (user_id, media_item_id) do update
      set bucket = excluded.bucket, updated_at = now()
     where user_media.bucket is distinct from excluded.bucket;

    select * into v_band from band_bounds(target, cat, b);
    v_size := v_band.size;
    v_rank := pos - v_band.lo + 1;
  else
    -- Nothing moved, so the band is the one that was already there.
    v_replaced := true;
    select * into v_band from band_bounds(target, cat, b);
    v_size := v_band.size;
    v_rank := pos - v_band.lo + 1;
  end if;

  v_score := score_for(b, v_rank, v_size);

  -- ---------------------------------------------------------------------------
  -- The ledger row (§E.1), and the answers that produced it.
  -- ---------------------------------------------------------------------------
  select count(*)::integer into v_comparisons
    from comparisons c
   where c.session_id = session and c.withdrawn_at is null;

  select count(*)::integer into v_cat_size
    from rankings r where r.user_id = target and r.category = cat;

  v_outcome := case
    when v_prior.position is null then 'placed'
    when v_prior.bucket <> b or v_prior.position <> pos then 'moved'
    when was_adjusted then 'kept'
    else 'unchanged'
  end;

  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    from_bucket, from_position, from_score,
    strategy, tolerance, comparisons, skips, adjustable,
    watch_event_id, session_id, operation_id
  )
  values (
    target, item, cat, v_kind, v_outcome,
    b, pos, v_rank, v_size, v_cat_size, v_score,
    v_prior.bucket, v_prior.position, v_from_score,
    coalesce(v_session_row.strategy, 'bisect'), coalesce(v_session_row.tolerance, 0),
    v_comparisons, coalesce(v_session_row.skips, 0), was_adjusted,
    v_session_row.watch_event_id, session, p_operation_id
  )
  returning id into v_placement;

  -- The answers this placement rests on. Withdrawn ones are deliberately not linked:
  -- they are not evidence, and §G's support model reads this link.
  if session is not null then
    update comparisons c
       set placement_id = v_placement
     where c.session_id = session and c.withdrawn_at is null;
  end if;

  if session is not null then
    delete from ranking_sessions where id = session;
  end if;

  -- The founder's four War Dogs (20260826000500). A correction to an opinion already
  -- recorded is not a thing that happened to anybody else, so it does not become an
  -- activity. A first ranking always is one; another watch always is one.
  --
  -- 20261004000100: `import` joins the silent set (§I.5 -- the queue posts nothing per
  -- title), and so does `refine` (§H.1 -- Refine never appears in the feed). Both are
  -- `p_replaces = false` for `import`, which is why the kind is asked rather than
  -- `v_replaced` alone.
  if (p_new_watch or not v_replaced) and v_kind not in ('import', 'refine', 'manual') then
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
    )
    returning id, causal_at into v_event_id, v_causal_at;

    /**
     * **The award that was announced before its own activity existed**
     * (20260902000100). Transcribed unchanged; the reasoning is in that migration and
     * in 20261001000100, and nothing in this tranche touches it.
     */
    update feed_events fe
       set causal_at = v_causal_at
     where fe.actor_id = target
       and fe.type in ('award_earned', 'goal_completed')
       and fe.causal_at < v_causal_at
       and exists (
         select 1 from feed_event_causes fc
          where fc.feed_event_id = fe.id
            and fc.user_id = target
            and fc.media_item_id = item
       )
       and not exists (
         select 1
           from feed_events act
          where act.actor_id = target
            and act.type in ('title_ranked', 'season_completed', 'watchlist_added')
            and act.id <> v_event_id
            and act.causal_at >= fe.causal_at
            and act.causal_at <  v_causal_at
       );
  end if;

  -- NEW (20260827000600). A first ranking settles the recommendations that asked
  -- for it.
  --
  -- 20261004000100: `and v_kind <> 'import'` is §E.3.5 -- "Fulfilment happens for `first`
  -- only, never `import`". A queue placement of a title somebody recommended two years
  -- ago is not the reader answering the recommendation, and notifying the sender that it
  -- was would be the app speaking for them.
  if not v_replaced and v_kind <> 'import' then
    with fulfilled as (
      update title_recommendations tr
         set fulfilled_at = now()
       where tr.recipient_id = target
         and tr.media_item_id = item
         and tr.state = 'delivered'
         and tr.fulfilled_at is null
      returning tr.id, tr.sender_id
    )
    insert into notifications (recipient_id, type, actor_id, subject_type, subject_id, payload)
    select f.sender_id,
           'recommendation_ranked',
           target,
           'feed_event',
           v_event_id,
           jsonb_build_object('recommendation_id', f.id)
      from fulfilled f
      join profiles sp
        on sp.id = f.sender_id
       and sp.status = 'active'
     where can_view_profile(f.sender_id, target)
    on conflict (((payload ->> 'recommendation_id')::uuid))
      where type = 'recommendation_ranked'
      do nothing;
  end if;

  -- PRD §28's activation, from the one place a ranking is created.
  v_activated := _maybe_activate_invite(target);

  return jsonb_build_object(
    'done', true,
    'position', pos,
    'category', cat,
    'bucket', b,
    'score', v_score,
    'adjustable', was_adjusted,
    'activated', v_activated,
    -- 20261004000100. Old clients ignore both; T3b's reveal and Watch History read them.
    -- **No `from_*` reaches the feed** (§K): this is the response to the reader's own
    -- call, which is the only place movement is allowed to appear in v1.
    'placement_id', v_placement,
    'movement', jsonb_build_object(
      'outcome', v_outcome,
      'from_position', v_prior.position,
      'from_score', v_from_score,
      'kind', v_kind
    )
  );
end;
$$;

revoke execute on function _rank_finalize(
  uuid, uuid, ranking_category, taste_bucket, integer, uuid, boolean, boolean, boolean,
  placement_kind, uuid
) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. The session entry points, rebuilt
-- ---------------------------------------------------------------------------

/**
 * `_rank_start_impl`, rebuilt from 20260926000100.
 *
 * Two parameters are added -- the kind and the watch event this session belongs to --
 * and one rule changes: **a resume must match `(bucket, provisional, kind, strategy)` or
 * it restarts** (§F.4). The old rule matched bucket and provisional only, so abandoning
 * *Log another watch* and then opening *Update your rating* resumed the rewatch's
 * session and finished as a rewatch, posting an activity for a viewing that never
 * happened. `new_watch` was refreshed in place for exactly that case, and a refreshed
 * flag on a half-answered search is not the same act.
 *
 * The prior offset is computed here, once, from the live ranking: it is the subject's
 * index in its band with itself excluded, which is the same coordinate system `lo`, `hi`
 * and `pivot` use -- so `_rank_session_sync`'s rebase needs no knowledge of it.
 */
-- Dropped, not overloaded, for the reason `_rank_finalize` above is: a five-parameter
-- and an eight-parameter function of this name are both candidates for a five-argument
-- call, and PostgreSQL refuses it as ambiguous rather than picking one. Caught by
-- `correction-is-not-a-ranking.test.mjs` with `function _rank_start_impl(...) is not
-- unique` — which is the good failure, because the alternative is a resolution by
-- declaration order that works until somebody re-creates one of them.
drop function if exists _rank_start_impl(uuid, uuid, taste_bucket, boolean, boolean);

create or replace function _rank_start_impl(
  p_user uuid, p_media_item_id uuid, p_bucket taste_bucket,
  p_provisional boolean default false,
  p_new_watch boolean default false,
  p_kind placement_kind default null,
  p_watch_event_id uuid default null,
  p_tolerance integer default 0
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
  v_pivot_item uuid;
  v_exclude  uuid;
  v_members  uuid[];
  -- 20261004000100
  v_act      placement_kind;
  v_strategy text;
  v_prior    integer;
  v_position integer;
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

  if not p_provisional then
    -- PRD §11: bucketing and ranking are separate acts and abandoning the second does
    -- not undo the first. The title is Logged from here on, whatever happens next.
    --
    -- **TV-1, decided 2026-08-24.** There is no completion prerequisite and there never
    -- was one in this function.
    --
    -- **And it writes no watch event and no date** (§D.6 paths 3, 10 and 12). The
    -- deferred trigger from 20261003000100 gives a row this creates its undated event at
    -- commit, which is the honest record: ranking a title says it was seen, not when.
    insert into user_media (user_id, media_item_id, bucket)
    values (p_user, p_media_item_id, p_bucket)
    on conflict (user_id, media_item_id)
      do update set bucket = excluded.bucket, updated_at = now();

    if exists (select 1 from rankings
                where user_id = p_user and media_item_id = p_media_item_id) then
      raise exception 'title is already ranked; use rank_rebucket to move it'
        using errcode = '23505';
    end if;
  end if;

  -- Null unless the subject is genuinely still holding a position. A provisional call
  -- against a title that lost its ranking in the meantime is an ordinary first
  -- ranking, and excluding an absent row from the band would be arithmetic about
  -- nothing.
  if p_provisional and exists (select 1 from rankings
                                where user_id = p_user and media_item_id = p_media_item_id) then
    v_exclude := p_media_item_id;
  end if;

  v_act := coalesce(
    p_kind,
    case when v_exclude is null then 'first'::placement_kind
         when p_new_watch       then 'rewatch'::placement_kind
         else 'correction'::placement_kind end
  );

  select * into v_existing
    from ranking_sessions
   where user_id = p_user and media_item_id = p_media_item_id;

  -- The strategy this act wants. A first placement has no prior to anchor to, so it
  -- bisects however the flag is set; everything provisional anchors.
  v_strategy := case
    when v_exclude is null then 'bisect'
    when v_act = 'import'  then 'bisect'   -- §F's table: bisect in v1 (§I.4)
    else 'prior'
  end;

  if v_existing.id is not null then
    -- **§F.4's resume matrix.** Kind X resumed as kind Y restarts. `new_watch` is no
    -- longer refreshed in place: the act, not just its flag, has to be the same one.
    if v_existing.bucket = p_bucket
       and v_existing.provisional = (v_exclude is not null)
       and coalesce(v_existing.kind, 'correction'::placement_kind) = v_act
       and coalesce(v_existing.strategy, 'bisect'::text) = v_strategy
    then
      -- **A resume is where a stale search comes back** (20260926000100). The band may
      -- have moved while the session sat open; rebase it from its answers before the
      -- comparison is read back.
      perform _rank_session_sync(v_existing.id, p_user);

      select * into v_state from _rank_session_state(v_existing.id, p_user);
      v_pivot_item := _rank_pivot_at(
        p_user, v_cat, v_state.band_lo + v_state.pivot, v_exclude
      );

      -- **A resume records what it re-offers.** It is the same comparison the
      -- reader was already looking at, so showing it again is not a repeat -- but
      -- the session has to remember having shown it, or that pair walks back in
      -- later through a skip.
      if v_pivot_item is not null
         and not (v_pivot_item = any (coalesce(v_existing.seen_items, '{}'::uuid[]))) then
        update ranking_sessions
           set seen_items = seen_items || v_pivot_item
         where id = v_existing.id;
      end if;

      return jsonb_build_object(
        'done', false,
        'session_id', v_state.session_id,
        'pivot', v_pivot_item,
        'resumed', true
      );
    end if;

    -- The bucket changed, the session was opened in the other numbering, or this is a
    -- different act. Nothing answered under the old one transfers.
    delete from ranking_sessions where id = v_existing.id;
  end if;

  select * into v_band from band_bounds_excluding(p_user, v_cat, p_bucket, v_exclude);

  if v_band.size = 0 then
    return _rank_finalize(
      p_user, p_media_item_id, v_cat, p_bucket, v_band.lo, null,
      false, v_exclude is not null, p_new_watch, v_act, null
    );
  end if;

  -- **The session is born from ONE read of its band** (20260926000100).
  v_members := _rank_band_members(p_user, v_cat, p_bucket, v_exclude);

  -- ---------------------------------------------------------------------------
  -- The prior, in the session's own coordinates.
  --
  -- The subject sits at `position`; the band it is in starts at `v_band.lo`; the members
  -- above it inside that band number `position - band.lo`. That count IS its insertion
  -- point in the subject-excluded list, so it is directly comparable with `lo`, `hi` and
  -- `pivot` and needs no translation anywhere else.
  --
  -- A band change (`rank_rebucket`) has a prior in the OLD band, which is meaningless as
  -- an index into the new one -- so it is null, the strategy is `prior` but
  -- `_rank_next_index` falls through to the midpoint, and the search is the bisection
  -- PRD §10 requires for a band change.
  -- ---------------------------------------------------------------------------
  if v_exclude is not null then
    select r.position into v_position
      from rankings r
     where r.user_id = p_user and r.media_item_id = p_media_item_id and r.bucket = p_bucket;
    if v_position is not null then
      v_prior := greatest(0, least(v_position - v_band.lo, cardinality(v_members)));
    end if;
  end if;

  v_pivot := _rank_next_index(
    0, cardinality(v_members), v_strategy, v_prior, p_tolerance, cardinality(v_members)
  );
  v_pivot_item := v_members[v_pivot + 1];

  insert into ranking_sessions (
    user_id, media_item_id, category, bucket, lo, hi, pivot, provisional, new_watch,
    seen_items, pivot_item, band_digest,
    kind, strategy, prior_offset, tolerance, watch_event_id
  )
  values (
    p_user, p_media_item_id, v_cat, p_bucket, 0, cardinality(v_members), v_pivot,
    v_exclude is not null, p_new_watch,
    case when v_pivot_item is null then '{}'::uuid[] else array[v_pivot_item] end,
    v_pivot_item,
    md5(array_to_string(v_members, ',')),
    v_act, v_strategy, v_prior, coalesce(p_tolerance, 0), p_watch_event_id
  )
  returning id into v_session;

  return jsonb_build_object(
    'done', false,
    'session_id', v_session,
    'pivot', v_pivot_item,
    'resumed', false
  );
end;
$$;

revoke execute on function _rank_start_impl(
  uuid, uuid, taste_bucket, boolean, boolean, placement_kind, uuid, integer
) from public, anon, authenticated;


/**
 * `rank_answer`, rebuilt from 20260926000100.
 *
 * **Narrowing is untouched.** The two lines that move `lo` and `hi` are transcribed
 * character for character, because every invariant in the system rests on them and the
 * whole point of §F.1 is that only the *choice of pivot* changes.
 *
 * Three edits: the comparison row records its session; the next index comes from
 * `_rank_next_index`; and the finalize point comes from `_rank_settle_at`, which is the
 * midpoint for a bisect session and the nearest-to-prior point for a prior one.
 */
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
  v_exclude uuid;
  v_new_lo integer;
  v_new_hi integer;
  v_next   integer;
  v_offer  record;
  v_moved  boolean;
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_answer');
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

  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

  -- The band can collapse under an open session if its other members are unranked.
  if v_s.lo >= v_s.hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.lo, v_s.session_id, false, v_s.provisional, v_s.new_watch,
      null, p_operation_id
    ));
  end if;

  -- **An answer about a comparison that is no longer on the session is not applied**
  -- (20260926000100).
  if v_moved then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot, v_exclude);

  if v_pivot_item is null then
    raise exception 'the title being compared against is no longer ranked'
      using errcode = 'P0002';
  end if;

  if p_winner <> v_s.media_item_id and p_winner <> v_pivot_item then
    raise exception 'winner must be one of the two titles being compared'
      using errcode = '22023';
  end if;

  -- Transcribed. WIN ⇒ hi := i. LOSS ⇒ lo := i + 1.
  if p_winner = v_s.media_item_id then
    v_new_lo := v_s.lo;
    v_new_hi := v_s.pivot;
    insert into comparisons (user_id, winner_id, loser_id, session_id)
    values (v_user, v_s.media_item_id, v_pivot_item, v_s.session_id);
  else
    v_new_lo := v_s.pivot + 1;
    v_new_hi := v_s.hi;
    insert into comparisons (user_id, winner_id, loser_id, session_id)
    values (v_user, v_pivot_item, v_s.media_item_id, v_s.session_id);
  end if;

  if v_new_lo >= v_new_hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_new_lo, v_s.session_id, false, v_s.provisional, v_s.new_watch,
      null, p_operation_id
    ));
  end if;

  -- ---------------------------------------------------------------------------
  -- **The window is confirmed, so it is unchanged** (§F.2's second finalize rule).
  --
  -- With `w = 0`, which is every path this migration ships, this is the two-answer
  -- unchanged case: `lo = hi = p` is already caught above. It exists for `w > 0`, which
  -- is T5's Refine, and it is written now because writing it later means writing it
  -- against a `rank_answer` that has moved on.
  -- ---------------------------------------------------------------------------
  if v_s.strategy = 'prior' and v_s.prior_offset is not null and v_s.tolerance > 0
     and _prior_search_enabled()
     and v_s.prior_offset - v_s.tolerance <= v_new_lo
     and v_new_hi <= v_s.prior_offset + v_s.tolerance then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.prior_offset, v_s.session_id, false, v_s.provisional, v_s.new_watch,
      null, p_operation_id
    ));
  end if;

  v_next := _rank_next_index(
    v_new_lo, v_new_hi, v_s.strategy, v_s.prior_offset, v_s.tolerance, v_s.band_size
  );

  -- **The preferred index is a preference, not a demand** (20260901000100). Unchanged:
  -- `_rank_offer` walks outward from whatever this policy asked for and refuses every
  -- title this session has already shown.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_new_lo, v_new_hi, v_next, v_exclude);

  if v_offer.item is null then
    -- Every remaining opponent has already been put to this reader and declined. No
    -- comparison row is written: a skipped pair is an absence of evidence.
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + _rank_settle_at(v_new_lo, v_new_hi, v_s.strategy, v_s.prior_offset,
                                    v_s.tolerance),
      v_s.session_id, true, v_s.provisional, v_s.new_watch, null, p_operation_id
    ));
  end if;

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_offer.idx,
         pivot_item = v_offer.item,
         seen_items = seen_items || v_offer.item,
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot,
           'seen', cardinality(seen_items), 'skips', v_s.skips,
           'pivot_item', v_pivot_item, 'won', p_winner = v_s.media_item_id
         ),
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item,
    'pivot_card', _rank_pivot_card(v_offer.item)
  ));
end;
$$;


/**
 * `rank_skip`, rebuilt from 20260926000100.
 *
 * The skip cap (3) and the dry walk are untouched. The resolution point changes for
 * prior sessions only: `clamp(p, lo, hi)` rather than the midpoint, which is §F.2's
 * "kept, or moved if answers moved it". A reader who could not call three comparisons
 * has not told us the title should move, so it does not.
 */
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
  v_exclude    uuid;
  v_max_skips  integer;
  v_mid        integer;
  v_offer      record;
  v_moved      boolean;
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

  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

  -- Too tough was pressed on a comparison the rebase replaced. The reader has not seen
  -- the new one, so they cannot have declined it; no skip is spent.
  if v_moved and v_s.lo < v_s.hi then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  -- The subquery form, not `select coalesce(...) into … from app_config where …`.
  -- 20260813002100 §2: with no matching row the second form assigns null and the
  -- default never applies, so a missing config key disabled the skip cap entirely.
  v_max_skips := coalesce(
    (select (value)::integer from app_config where key = 'ranking.max_skips'),
    3
  );

  -- The point this session settles at when the reader runs out of patience. For a
  -- bisect session that is the midpoint, exactly as before.
  v_mid := _rank_settle_at(v_s.lo, v_s.hi, v_s.strategy, v_s.prior_offset, v_s.tolerance);
  if v_s.strategy is distinct from 'prior' or v_s.prior_offset is null then
    v_mid := (v_s.lo + v_s.hi) / 2;
  end if;

  if v_s.skips + 1 >= v_max_skips then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch,
      null, p_operation_id
    ));
  end if;

  -- **The candidate walk is the seen-set walk** (20260901000100), unchanged. The
  -- preferred index for a skip is still the middle of the live range: a skip re-anchors
  -- without narrowing, and re-offering the neighbour the reader has just declined is
  -- the repeat that walk exists to prevent.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_s.lo, v_s.hi, (v_s.lo + v_s.hi) / 2, v_exclude);

  if v_offer.item is null then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch,
      null, p_operation_id
    ));
  end if;

  update ranking_sessions
     set skips      = skips + 1,
         pivot      = v_offer.idx,
         pivot_item = v_offer.item,
         seen_items = seen_items || v_offer.item,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_offer.item,
    'pivot_card', _rank_pivot_card(v_offer.item),
    'skipped', true
  ));
end;
$$;


/**
 * `rank_back`, rebuilt from 20260926000100.
 *
 * One change: **the undone comparison is withdrawn** (§A.3, §F.4). The row stays -- "they
 * answered and took it back" is a fact, and deleting it would make an undo
 * indistinguishable from never having been asked -- but it is marked, and every reader
 * of the evidence excludes it. It is what §O.2 asserts as "a withdrawn comparison is
 * never linked".
 *
 * The restore is otherwise transcribed, including the two rules 20260922000100 got
 * right and that are easy to lose in a rebuild: a skip is never refunded, and titles
 * declined by a skip taken after the restored frame stay declined.
 */
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
  v_pivot_item uuid;
  v_moved boolean;
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

  v_moved := _rank_session_sync(p_session_id, v_user);

  select * into v_s from _rank_session_state(p_session_id, v_user);

  if v_moved and v_s.lo < v_s.hi then
    return _record_operation_result(p_operation_id, _rank_current_comparison(p_session_id));
  end if;

  if jsonb_array_length(v_s.history) = 0 then
    -- The session is about to go. Its answers go with it as evidence: there is exactly
    -- one, it was just withdrawn, and an abandoned session's comparisons link to no
    -- placement.
    update comparisons
       set withdrawn_at = now()
     where session_id = v_s.session_id and withdrawn_at is null;
    delete from ranking_sessions where id = v_s.session_id;
    return _record_operation_result(
      p_operation_id, jsonb_build_object('done', false, 'cancelled', true)
    );
  end if;

  v_prev := v_s.history -> -1;

  v_pivot_item := coalesce(
    (v_prev ->> 'pivot_item')::uuid,
    _rank_pivot_at(
      v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer,
      case when v_s.provisional then v_s.media_item_id end
    )
  );

  -- **The undone answer, withdrawn** (20261004000100). The newest live comparison this
  -- session recorded is the one the frame being popped was about: `rank_skip` writes
  -- none, and every answer writes exactly one, so "newest not-yet-withdrawn" is that
  -- answer and nothing else.
  update comparisons c
     set withdrawn_at = now()
   where c.id = (
     select c2.id from comparisons c2
      where c2.session_id = v_s.session_id and c2.withdrawn_at is null
      order by c2.created_at desc, c2.id desc
      limit 1
   );

  update ranking_sessions
     set lo = (v_prev ->> 'lo')::integer,
         hi = (v_prev ->> 'hi')::integer,
         pivot = (v_prev ->> 'pivot')::integer,
         pivot_item = v_pivot_item,
         history = v_s.history - (jsonb_array_length(v_s.history) - 1),
         -- **Undo withdraws what the undone step offered** (20260922000100), except
         -- what the reader declined. Transcribed.
         seen_items = case
           when not (v_prev ? 'seen') then seen_items
           when v_s.skips > (v_prev ->> 'skips')::integer
             then seen_items[1:cardinality(seen_items) - 1]
           else seen_items[1:(v_prev ->> 'seen')::integer]
         end,
         -- **Undo never refunds a skip.** Transcribed.
         skips = case
           when v_prev ? 'skips' then skips
           else greatest(skips - 1, 0)
         end,
         updated_at = now()
   where id = v_s.session_id;

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_pivot_item,
    'pivot_card', _rank_pivot_card(v_pivot_item)
  ));
end;
$$;


/**
 * `rank_again`, rebuilt from 20260826000500.
 *
 * **An old client calling this with `p_new_watch = true` is a rewatch that records no
 * date**, and T3 gives it its undated event (§D.5, §D.6 path 15). Here it names the kind
 * so the ledger and the strategy are right; T3 adds the event.
 */
create or replace function rank_again(
  p_media_item_id uuid,
  p_bucket        taste_bucket,
  p_operation_id  uuid default null,
  p_new_watch     boolean default false
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

  -- No unrank. `_rank_start_impl` opens the session over the ranking that is still
  -- there, and `_rank_finalize` replaces it only if and when the reader finishes.
  return _record_operation_result(
    p_operation_id,
    _rank_start_impl(
      v_user, p_media_item_id, p_bucket, true, coalesce(p_new_watch, false),
      case when coalesce(p_new_watch, false) then 'rewatch'::placement_kind
           else 'correction'::placement_kind end,
      null, 0
    )
  );
end;
$$;


/**
 * `rank_rebucket`, rebuilt from 20260826000500.
 *
 * A band change is a `correction` and it **bisects**: the prior is an index into the old
 * band and says nothing about the new one, so `_rank_start_impl` leaves `prior_offset`
 * null and the policy falls through to the midpoint. PRD §10 requires a band change to
 * re-run comparisons rather than estimate, and it still does.
 */
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

  return _record_operation_result(
    p_operation_id,
    _rank_start_impl(v_user, p_media_item_id, p_bucket, true, false, 'correction', null, 0)
  );
end;
$$;

-- `create or replace` keeps a grant, and these were granted before. Restated, because a
-- grant present for a reason nobody can see is a grant the next rebuild loses.
revoke execute on function rank_answer(uuid, uuid, uuid) from public, anon;
grant  execute on function rank_answer(uuid, uuid, uuid) to authenticated;
revoke execute on function rank_skip(uuid, uuid)         from public, anon;
grant  execute on function rank_skip(uuid, uuid)         to authenticated;
revoke execute on function rank_back(uuid, uuid)         from public, anon;
grant  execute on function rank_back(uuid, uuid)         to authenticated;
revoke execute on function rank_again(uuid, taste_bucket, uuid, boolean) from public, anon;
grant  execute on function rank_again(uuid, taste_bucket, uuid, boolean) to authenticated;
revoke execute on function rank_rebucket(uuid, taste_bucket, uuid)       from public, anon;
grant  execute on function rank_rebucket(uuid, taste_bucket, uuid)       to authenticated;


-- ---------------------------------------------------------------------------
-- 8. `rank_reorder` is revoked
--
-- §E.1: "Written only by `_rank_finalize`, and by `rank_reorder` (granted, no caller):
-- it must write `manual` rows or be revoked."
--
-- It is revoked. It has had no caller since it was written, a drag-to-reorder UI is an
-- explicit non-goal (§Q), and a granted writer that moves a ranking without producing a
-- ledger row is exactly the hole that makes the ledger untrustworthy -- "this title is
-- at #7 and nothing says how it got there". Granting it back means teaching it to write
-- a `manual` placement, which is the work its caller would have to do anyway.
--
-- The function is left in place. Dropping it is a separate decision from stopping
-- clients calling it, and only one of the two is needed now.
-- ---------------------------------------------------------------------------

revoke execute on function rank_reorder(uuid, integer, uuid) from public, anon, authenticated;

comment on function rank_reorder(uuid, integer, uuid) is
  'REVOKED 20261004000100. It moves a ranking without writing a ranking_placements row, '
  'so the ledger would have a gap nothing explains. It has never had a caller. To grant '
  'it back, teach it to write a manual placement first (§E.1).';


-- ---------------------------------------------------------------------------
-- 9. The backfill (§E.4)
--
-- One `backfill` row per existing ranking: the current snapshot, `created_at` taken from
-- the ranking itself, and `category_size` reconstructed as the count of the category's
-- rankings created at or before it.
--
-- **That figure is an estimate and the kind says so.** A title unranked since then is
-- not counted, and two rankings sharing a timestamp are both counted. It exists so that
-- §G's `growth` term has something to divide by on day one rather than nothing, and
-- `fragile` is set for every one of these rows precisely because the evidence behind
-- them is not in this table.
--
-- One statement, for the reason T1's backfill is one: the marker must survive whichever
-- applier runs the file. No feed event or notification is reachable from an insert into
-- this table -- it has no triggers -- but the marker costs nothing and states the intent.
-- ---------------------------------------------------------------------------

do $backfill$
begin
  perform set_config('bingd.import_running', txid_current()::text, true);

  insert into ranking_placements (
    user_id, media_item_id, category, kind, outcome,
    bucket, position, band_rank, band_size, category_size, score,
    strategy, tolerance, adjustable, created_at
  )
  select r.user_id, r.media_item_id, r.category, 'backfill', 'placed',
         r.bucket, r.position,
         r.position - bb.lo + 1,
         bb.size,
         greatest(
           (select count(*) from rankings r2
             where r2.user_id = r.user_id and r2.category = r.category
               and r2.created_at <= r.created_at)::integer,
           r.position
         ),
         score_for(r.bucket, r.position - bb.lo + 1, bb.size),
         null, 0,
         -- Every backfilled row is `fragile` by §G.2's own definition ("last placement
         -- adjustable, or thin on answers, or backfill"), and marking it here is what
         -- makes that readable without a special case in the support query.
         true,
         r.created_at
    from rankings r
    cross join lateral band_bounds(r.user_id, r.category, r.bucket) bb
   where not exists (
     select 1 from ranking_placements p
      where p.user_id = r.user_id and p.media_item_id = r.media_item_id
   );
end;
$backfill$;


-- ---------------------------------------------------------------------------
-- 10. The ledger's own invariant
-- ---------------------------------------------------------------------------

create or replace function assert_placements_valid(p_user uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bad integer;
  v_id  text;
begin
  -- P1. Every current ranking has at least one placement explaining it. The backfill
  -- establishes it; `_rank_finalize` maintains it; a granted writer that moves a
  -- ranking without a ledger row breaks it, which is why `rank_reorder` is revoked.
  select count(*), min(r.media_item_id::text) into v_bad, v_id
    from rankings r
   where (p_user is null or r.user_id = p_user)
     and not exists (
       select 1 from ranking_placements p
        where p.user_id = r.user_id and p.media_item_id = r.media_item_id
     );
  if v_bad > 0 then
    raise exception 'P1 violated: % rankings have no placement (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- P2. A withdrawn comparison is never linked to a placement (§O.2). An answer the
  -- reader took back is not evidence for where the title landed.
  select count(*), min(c.id::text) into v_bad, v_id
    from comparisons c
   where (p_user is null or c.user_id = p_user)
     and c.withdrawn_at is not null and c.placement_id is not null;
  if v_bad > 0 then
    raise exception 'P2 violated: % withdrawn comparisons are linked (e.g. %)', v_bad, v_id
      using errcode = 'P0001';
  end if;

  -- P3. `unchanged` and `kept` mean the title did not move; `moved` means it did. The
  -- outcome is derived, so this catches a rebuild that derives it from the wrong pair.
  select count(*), min(p.id::text) into v_bad, v_id
    from ranking_placements p
   where (p_user is null or p.user_id = p_user)
     and p.from_position is not null
     and (
       (p.outcome in ('unchanged', 'kept')
         and (p.position <> p.from_position or p.bucket is distinct from p.from_bucket))
       or (p.outcome = 'moved'
         and p.position = p.from_position and p.bucket is not distinct from p.from_bucket)
     );
  if v_bad > 0 then
    raise exception 'P3 violated: % placements disagree with their own outcome (e.g. %)',
      v_bad, v_id using errcode = 'P0001';
  end if;

  -- P4. `placed` is the only outcome without a prior, and every other outcome has one.
  select count(*), min(p.id::text) into v_bad, v_id
    from ranking_placements p
   where (p_user is null or p.user_id = p_user)
     and (p.outcome = 'placed') <> (p.from_position is null);
  if v_bad > 0 then
    raise exception 'P4 violated: % placements disagree about having a prior (e.g. %)',
      v_bad, v_id using errcode = 'P0001';
  end if;
end;
$$;

comment on function assert_placements_valid(uuid) is
  'P1 every ranking has a placement; P2 a withdrawn comparison is never linked; P3 the '
  'outcome agrees with the from/to pair; P4 placed <=> no prior. Peer of '
  'assert_ranking_valid and assert_watch_history_valid.';

revoke execute on function assert_placements_valid(uuid) from public, anon, authenticated;
