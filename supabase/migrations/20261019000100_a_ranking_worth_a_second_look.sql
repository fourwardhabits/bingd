-- ---------------------------------------------------------------------------
-- T5 — Refine your rankings.
--
-- `watch-history-and-ranking-calibration.md` §G, §H. Built on T2 (20261004000100), whose
-- session already knows `kind = 'refine'`, carries a `tolerance`, confirms a window in
-- `rank_answer`, keeps `created_at` in `_rank_finalize` and posts nothing to the feed for
-- this kind. **No existing function is rebuilt here.** Everything below is new, and the
-- comparisons themselves run through `rank_answer` / `rank_skip` / `rank_back` /
-- `rank_cancel` exactly as a correction does. There is one ranking algorithm, not two.
--
-- ===========================================================================
-- WHAT REFINE IS, IN THE DATABASE'S TERMS
--
-- A finite calibration of titles that ALREADY hold a position. Its candidate set is
-- `rankings` and nothing else, so it can never offer an unranked title (§H.1.1). Each
-- target gets one provisional `refine` session, searched from where it already sits
-- (`strategy = 'prior'`) with the §H.5 tolerance. Only an answer can move it: with no
-- informative answer the session settles at the prior, and a skip-out is `kept`.
--
-- It writes, per target, exactly what a correction writes, minus the feed:
--   - `comparisons` rows (the answers),
--   - one `ranking_placements` row of kind `refine`,
--   - and, ONLY when an answer moved it, the `rankings` delete + insert of
--     `_rank_finalize` with `created_at` preserved (T0/T2).
-- No watch event, no feed event, no notification, no list change, no watchlist change,
-- no `user_media` change. `refine.test.mjs` asserts every one of those.
--
-- ===========================================================================
-- HOW A TARGET IS CHOSEN (§G, "placement support")
--
-- The stored order is exactly what the answers implied. What is uncertain is whether a
-- title's position is **directly evidenced by its neighbours** or only inferred through
-- a chain of answers given at different times (§G.1 B). So the signal is the reader's own
-- pairwise evidence, read once per call in one set-based query:
--
--   For each ranked title t, in its band, from the LATEST non-withdrawn answer per pair:
--     gap_above  titles between t and the nearest title above it that beat t
--                (all titles above it in the band when none did)
--     gap_below  titles between t and the nearest title below it that t beat
--     conflicts  pairs whose latest answer contradicts the current order, answered
--                after t was last confirmed
--
-- A fresh bisection leaves both gaps at 0: `lo` only moves on a LOSS to item lo-1 and
-- `hi` only on a WIN over item hi, so the final bracket is always two direct answers. A
-- gap opens when titles are later inserted around t without being compared with it, when
-- t was placed by skips or a dry walk, or when t has no answers at all (a first title in
-- a band, legacy/backfilled rows). That is exactly the population the brief names:
-- sparse evidence, growth, imports, early sessions.
--
-- **"Refined enough"** (per title) is operational and uses the same tolerance the session
-- confirms with (w = 0 for #1–25, 1 for 26–100, 3 for 101–300, 7 beyond):
--
--     gap_above <= w  and  gap_below <= w  and  no conflicts
--
-- An unchanged Refine leaves exactly that behind (it tests the item just above and just
-- below the ±w window), so a refined title stops being a candidate by construction, and
-- the pool only refills when the reader's own later rankings open new gaps.
--
-- Priority, for titles that are NOT refined enough (each term in [0, 1]):
--
--     excess   = max(gap_above - w, 0) + max(gap_below - w, 0)
--     span     = min(1, ln(1 + excess) / ln 32)
--     priority = rank_weight × (0.7·span + 0.3·[conflicts > 0])
--                            × (1 + 0.25·stale + 0.25·fragile)
--
--     rank_weight  1.0 for #1–25, 0.6 for #26–100, 0.3 below (§H.4)
--     stale        min(1, days since last confirmed / 365)
--     fragile      last placement was adjustable (skips, dry walk, backfill)
--
-- A title qualifies at priority >= `ranking.refine_min_priority` (0.08), which works out
-- as: any gap at all in the top 100, and at least three titles beyond the tolerance
-- below #100 — so a deep title that is one neighbour out is not worth a question.
--
-- Randomness only breaks ties: candidates are ordered by priority in 0.05 steps, then by
-- a hash of (title, seed) with a seed the client picks per session, so two sessions do not
-- open on the same title in the same order and a test can still pin the order.
--
-- ===========================================================================
-- HOW THE PAIRS ARE CHOSEN
--
-- By T2's `next_pivot`, unchanged: the item just above the tolerance window, then the item
-- just below, then a capped gallop on the side an answer opened, then bisection. So the
-- first questions are always neighbours; a distant title is only asked when an answer has
-- already shown the target moved (the search needs it).
--
-- One addition, `_refine_seed`: **a pair the reader answered in the last 90 days is not
-- asked again.** When the latest answer between the target and a band member is recent
-- and agrees with the current order, the session's bounds open where that answer already
-- puts them — exactly the `lo`/`hi` the same answer would have produced inside the
-- session. It never moves anything (the prior stays inside [lo, hi], and the settle point
-- is the nearest point to the prior), and it is skipped when it would confirm the window
-- on its own: a Refine always costs at least one fresh answer.
--
-- ===========================================================================
-- WHY IT STOPS
--
--   per round     5 targets, or 12 answers (checked when a target finishes) — client
--   per session   3 rounds; after the third the checkpoint offers Done only — client
--   per day       `ranking.refine_daily_targets` (30) refine placements in 24 hours —
--                 server, enforced in `refine_start`, reported as `rested`
--   per title     a refined title rests `ranking.refine_cooldown_days` (30), a `kept` one
--                 (skipped out) 90, an "I don't remember it" 180 (`ranking_snoozes`)
--   per library   no title above the threshold → `nothing_waiting`. That is the natural
--                 stop, and for most readers it is reached long before the caps.
--   too small     fewer than `ranking.refine_min_ranked` (20) ranked in the category →
--                 `too_small`. Below that every ranking already compared against a large
--                 share of the list, and Update your rating is the right tool.
--
-- ===========================================================================
-- GATING
--
-- `ranking.refine_enabled` starts FALSE. While it is false `refine_candidates` answers
-- `disabled` and `refine_start` refuses, and the client draws no entry. The prior-search
-- kill switch (`ranking.prior_search_enabled`) also disables Refine: without it a refine
-- session would be a full re-bisection, which is not the designed feature.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Configuration
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values
  ('ranking.refine_enabled',        'false'::jsonb),
  ('ranking.refine_min_ranked',     '20'::jsonb),
  ('ranking.refine_min_priority',   '0.08'::jsonb),
  ('ranking.refine_daily_targets',  '30'::jsonb),
  ('ranking.refine_cooldown_days',  '30'::jsonb)
on conflict (key) do nothing;


-- ---------------------------------------------------------------------------
-- 2. "I don't remember it well" (§H.6)
--
-- The one piece of Refine state that is not derivable from the ledger: a title the reader
-- said they cannot judge. It rests for 180 days and its ranking is untouched. Keyed to the
-- collection row, so removing the title from the collection removes the snooze.
-- ---------------------------------------------------------------------------

create table ranking_snoozes (
  user_id       uuid not null,
  media_item_id uuid not null,
  reason        text not null check (reason in ('dont_remember')),
  until         date not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, media_item_id),
  constraint ranking_snoozes_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

alter table ranking_snoozes enable row level security;

create policy ranking_snoozes_own on ranking_snoozes for select
  using (user_id = auth.uid());

comment on table ranking_snoozes is
  'Titles Refine will not offer until `until`, because the reader said they do not '
  'remember them well enough to compare (§H.6). Never read by anything that orders or '
  'scores a ranking. Written only by refine_snooze.';


-- ---------------------------------------------------------------------------
-- 3. Small pure helpers
-- ---------------------------------------------------------------------------

/** §H.5: the half-width of the "still in the right place" window, by category ordinal. */
create or replace function _refine_tolerance(p_position integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when p_position <= 25  then 0
    when p_position <= 100 then 1
    when p_position <= 300 then 3
    else 7
  end;
$$;

revoke execute on function _refine_tolerance(integer) from public, anon, authenticated;

/** §H.4: the top of the list matters more. An ordering weight, not a measurement. */
create or replace function _refine_rank_weight(p_position integer)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_position <= 25  then 1.0
    when p_position <= 100 then 0.6
    else 0.3
  end;
$$;

revoke execute on function _refine_rank_weight(integer) from public, anon, authenticated;

/** Refine is on only when its own flag AND the prior search it is built on are on. */
create or replace function _refine_enabled()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce((select (value)::boolean from app_config
                    where key = 'ranking.refine_enabled'), false)
     and _prior_search_enabled();
$$;

revoke execute on function _refine_enabled() from public, anon, authenticated;

/** An integer `app_config` value, with a default when the row is absent. */
create or replace function _refine_config_int(p_key text, p_default integer)
returns integer
language sql
stable
set search_path = public
as $$
  -- The subquery form: `select coalesce(x) into … where key = …` assigns null on a
  -- missing row and the default never applies (20260813002100 §2).
  select coalesce((select (value)::integer from app_config where key = p_key), p_default);
$$;

revoke execute on function _refine_config_int(text, integer) from public, anon, authenticated;

/** Refine placements in the last 24 hours, across both categories. */
create or replace function _refine_done_today(p_user uuid)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
    from ranking_placements p
   where p.user_id = p_user
     and p.kind = 'refine'
     and p.created_at > now() - interval '24 hours';
$$;

revoke execute on function _refine_done_today(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Placement support (§G.2) — the evidence record, derived, never persisted
--
-- One statement over the category: its rankings, the latest answer per pair inside a
-- band, and the ledger. Hash joins and three aggregates, so the cost is
-- O(rankings + comparisons + placements) for the category with no per-title query — the
-- §G.3 budget is < 50 ms at 2,500 ranked titles, and `perf/refine-scale.mjs` measures it.
--
-- Legacy comparisons (before 20261004000100 they had no session and an Undo left them in
-- place) count only through the "latest answer per pair" rule and only when they agree
-- with the current order — §G.2's rule for them — so an undone legacy answer can at worst
-- make one pair look evidenced; it can never move a title.
-- ---------------------------------------------------------------------------

create or replace function _refine_support(p_user uuid, p_category ranking_category)
returns table (
  media_item_id     uuid,
  bucket            taste_bucket,
  "position"        integer,
  band_rank         integer,
  band_size         integer,
  gap_above         integer,
  gap_below         integer,
  compared_above    boolean,
  compared_below    boolean,
  conflicts         integer,
  confirmed_at      timestamptz,
  confirmed_size    integer,
  last_adjustable   boolean,
  refined_at        timestamptz,
  refine_outcome    text,
  snoozed_until     date
)
language sql
stable
set search_path = public
as $$
  with r as (
    select rk.media_item_id, rk.bucket, rk.position,
           min(rk.position) over (partition by rk.bucket) as band_lo,
           count(*)       over (partition by rk.bucket) as band_size
      from rankings rk
     where rk.user_id = p_user and rk.category = p_category
  ),
  ledger as (
    select p.media_item_id,
           max(p.created_at) filter (where p.outcome in ('placed', 'moved', 'unchanged'))
             as confirmed_at,
           (array_agg(p.category_size order by p.created_at desc)
              filter (where p.outcome in ('placed', 'moved', 'unchanged')))[1]
             as confirmed_size,
           (array_agg(p.adjustable order by p.created_at desc))[1] as last_adjustable,
           max(p.created_at) filter (where p.kind = 'refine') as refined_at,
           (array_agg(p.outcome order by p.created_at desc)
              filter (where p.kind = 'refine'))[1] as refine_outcome
      from ranking_placements p
     where p.user_id = p_user and p.category = p_category
     group by p.media_item_id
  ),
  -- Every live answer between two titles ranked in the SAME band of this category. A
  -- cross-band answer is already settled by the bands themselves.
  --
  -- **Keyed by position, not by title.** A position is unique inside a category, so it
  -- names the title as well as its uuid does, and sorting and grouping 26,000 answers on
  -- two integers instead of two uuids halves the statement at 2,500 ranked titles
  -- (perf/refine-scale.mjs). Titles come back through `r` at the end.
  judged as (
    select c.id, c.created_at, w.position as w_pos, l.position as l_pos
      from comparisons c
      join r w on w.media_item_id = c.winner_id
      join r l on l.media_item_id = c.loser_id and l.bucket = w.bucket
     where c.user_id = p_user and c.withdrawn_at is null
  ),
  -- The latest answer per unordered pair wins: a reader who changed their mind about a
  -- pair has told us so, and the older answer is history, not evidence.
  latest as (
    select distinct on (least(j.w_pos, j.l_pos), greatest(j.w_pos, j.l_pos))
           j.w_pos, j.l_pos, j.created_at
      from judged j
     order by least(j.w_pos, j.l_pos), greatest(j.w_pos, j.l_pos), j.created_at desc, j.id desc
  ),
  -- One pass, one aggregate, and ONE join back to `r` below. Split into three aggregates
  -- joined separately, a planner without statistics (a fresh table; PGlite always) chose
  -- nested loops and the statement went quadratic — 18 s at 1,200 titles against 2.6 s.
  edges as (
    -- Agrees with the order: the loser's evidence above, the winner's evidence below.
    select l_pos as pos, 1 as side, l_pos - w_pos - 1 as gap, created_at
      from latest where w_pos < l_pos
    union all
    select w_pos, 2, l_pos - w_pos - 1, created_at
      from latest where w_pos < l_pos
    -- Contradicts the order: both titles carry it.
    union all
    select l_pos, 3, null, created_at from latest where w_pos > l_pos
    union all
    select w_pos, 3, null, created_at from latest where w_pos > l_pos
  ),
  per_item as (
    select e.pos,
           min(e.gap) filter (where e.side = 1) as gap_above,
           min(e.gap) filter (where e.side = 2) as gap_below,
           -- The latest contradiction only: every consumer asks "is there one newer than
           -- the last confirmation?", which one max() answers. An array_agg here gave each
           -- group a memory context and spilled the hash aggregate to disk at 2,500 dense
           -- titles (101 -> 70 ms median, identical output; refine-rankings-t5.md §5a).
           max(e.created_at) filter (where e.side = 3) as conflict_last
      from edges e
     group by e.pos
  )
  select r.media_item_id,
         r.bucket,
         r.position,
         (r.position - r.band_lo + 1)::integer,
         r.band_size::integer,
         -- No answer above it: every title above it in its band is unconfirmed. At the top
         -- of the band that is zero, which is right — the band edge is evidence.
         coalesce(pi.gap_above, r.position - r.band_lo)::integer,
         coalesce(pi.gap_below, r.band_lo + r.band_size - 1 - r.position)::integer,
         pi.gap_above is not null,
         pi.gap_below is not null,
         -- Only a contradiction newer than its last confirmation counts: an unchanged
         -- Refine after the contradicting answer is the reader settling it. 0 or 1 — a
         -- flag, not a count; every reader tests `conflicts > 0`.
         (case when pi.conflict_last is not null
                and (ld.confirmed_at is null or pi.conflict_last > ld.confirmed_at)
               then 1 else 0 end)::integer,
         ld.confirmed_at,
         ld.confirmed_size,
         coalesce(ld.last_adjustable, true),
         ld.refined_at,
         ld.refine_outcome,
         sn.until
    from r
    left join per_item pi on pi.pos = r.position
    left join ledger ld on ld.media_item_id = r.media_item_id
    left join ranking_snoozes sn
      on sn.user_id = p_user and sn.media_item_id = r.media_item_id;
$$;

comment on function _refine_support(uuid, ranking_category) is
  'Placement support (§G.2) for every ranked title in one category: the band, the '
  'distance to the nearest directly-evidenced neighbour above and below (from the latest '
  'non-withdrawn answer per pair, when it agrees with the current order), contradictions '
  'newer than the last confirmation, and the ledger facts Refine orders by. Derived, never '
  'persisted, never a number anybody sees. One set-based statement. Internal (T5).';

revoke execute on function _refine_support(uuid, ranking_category)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. `refine_candidates` — the next targets, or why there are none
-- ---------------------------------------------------------------------------

create or replace function refine_candidates(
  p_category ranking_category,
  p_limit    integer default 5,
  p_seed     integer default 0,
  p_recent   uuid[]  default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user        uuid := auth.uid();
  v_ranked      integer;
  v_min_ranked  integer;
  v_done_today  integer;
  v_daily       integer;
  v_cooldown    integer;
  v_min_prio    numeric;
  v_now_size    integer;
  v_list        jsonb;
  v_open        uuid[];
  v_recent_pos  integer[];
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  if not _refine_enabled() then
    return jsonb_build_object('status', 'disabled', 'candidates', '[]'::jsonb);
  end if;

  select count(*)::integer into v_ranked
    from rankings where user_id = v_user and category = p_category;
  v_min_ranked := _refine_config_int('ranking.refine_min_ranked', 20);

  if v_ranked < v_min_ranked then
    return jsonb_build_object(
      'status', 'too_small', 'candidates', '[]'::jsonb,
      'min_ranked', v_min_ranked
    );
  end if;

  v_done_today := _refine_done_today(v_user);
  v_daily := _refine_config_int('ranking.refine_daily_targets', 30);
  if v_done_today >= v_daily then
    return jsonb_build_object('status', 'rested', 'candidates', '[]'::jsonb);
  end if;

  v_cooldown := _refine_config_int('ranking.refine_cooldown_days', 30);
  v_min_prio := coalesce(
    (select (value)::numeric from app_config where key = 'ranking.refine_min_priority'),
    0.08
  );
  v_now_size := v_ranked;

  -- Both resolved ONCE, into arrays, before the statement below. As CTEs they were probed
  -- per row, and against a materialised 2,500-row support set that made the diversity
  -- check quadratic: 1.8 s for an imported library of 2,500 whose evidence statement alone
  -- takes 32 ms (perf/refine-scale.mjs, 2026-09-20).
  --
  -- A refine session the reader left open (the app died, the phone slept). It comes back
  -- first, whatever its priority, because the reader was in the middle of it.
  select coalesce(array_agg(rs.media_item_id), '{}'::uuid[]) into v_open
    from ranking_sessions rs
   where rs.user_id = v_user and rs.category = p_category and rs.kind = 'refine'
     and rs.provisional;

  -- Where this sitting's targets sit now (a handful at most).
  select coalesce(array_agg(r.position), '{}'::integer[]) into v_recent_pos
    from rankings r
   where r.user_id = v_user and r.category = p_category
     and r.media_item_id = any (coalesce(p_recent, '{}'::uuid[]));

  with support as (
    select s.*, _refine_tolerance(s.position) as w
      from _refine_support(v_user, p_category) s
  ),
  scored as (
    select s.*,
           greatest(s.gap_above - s.w, 0) + greatest(s.gap_below - s.w, 0) as excess,
           s.media_item_id = any (v_open) as resume
      from support s
  ),
  prioritised as (
    select sc.*,
           _refine_rank_weight(sc.position)
           * (0.7 * least(1.0, ln(1 + sc.excess) / ln(32))
              + 0.3 * (case when sc.conflicts > 0 then 1 else 0 end))
           * (1 + 0.25 * least(1.0, coalesce(extract(epoch from now() - sc.confirmed_at)
                                                / 86400.0 / 365.0, 1.0))
                + 0.25 * (case when sc.last_adjustable then 1 else 0 end))
           -- §H.4.3 diversity: the ±3 neighbours of a title refined in this session are
           -- discounted, so a round does not keep showing the same stretch of the list.
           * (case when exists (select 1 from unnest(v_recent_pos) rp(pos)
                                 where abs(rp.pos - sc.position) <= 3)
                   then 0.3 else 1.0 end)
             as priority
      from scored sc
  ),
  eligible as (
    select p.*
      from prioritised p
     where not (p.media_item_id = any (coalesce(p_recent, '{}')))
       and p.band_size >= 2
       and (p.snoozed_until is null or p.snoozed_until <= current_date)
       and (
         p.resume
         or (
           (p.excess > 0 or p.conflicts > 0)
           and p.priority >= v_min_prio
           and (p.refined_at is null
                or p.refined_at < now() - make_interval(days =>
                     case when p.refine_outcome = 'kept' then v_cooldown * 3 else v_cooldown end))
         )
       )
  ),
  chosen as (
    select e.*
      from eligible e
     order by e.resume desc,
              floor(e.priority * 20) desc,
              hashtextextended(e.media_item_id::text, coalesce(p_seed, 0)),
              e.position
     limit greatest(least(coalesce(p_limit, 5), 20), 1)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'media_item_id', c.media_item_id,
           'title', mi.title,
           'poster_path', mi.poster_path,
           'kind', mi.kind,
           'bucket', c.bucket,
           'position', c.position,
           'band_rank', c.band_rank,
           'band_size', c.band_size,
           'tolerance', c.w,
           'resume', c.resume,
           'last_confirmed_at', c.confirmed_at,
           'confirmed_size', c.confirmed_size,
           -- One reason, for one optional line on the target (§G.3: never a number).
           'reason', case
             when c.conflicts > 0 then 'contradicted'
             when not c.compared_above and not c.compared_below then 'never_compared'
             when c.confirmed_size is not null and c.confirmed_size > 0
                  and v_now_size >= c.confirmed_size * 3 / 2 then 'grown'
             when c.confirmed_at is not null
                  and c.confirmed_at < now() - interval '365 days' then 'placed_long_ago'
             else 'neighbours'
           end
         ) order by c.resume desc, floor(c.priority * 20) desc,
                    hashtextextended(c.media_item_id::text, coalesce(p_seed, 0)), c.position),
         '[]'::jsonb)
    into v_list
    from chosen c
    join media_items mi on mi.id = c.media_item_id;

  return jsonb_build_object(
    'status', case when jsonb_array_length(v_list) = 0 then 'nothing_waiting' else 'ready' end,
    'candidates', v_list
  );
end;
$$;

comment on function refine_candidates(ranking_category, integer, integer, uuid[]) is
  'T5: the next Refine targets for the caller in one category, most useful first, or the '
  'reason there are none: disabled | too_small | rested | nothing_waiting. An open refine '
  'session comes first (resume). p_recent is this session''s targets, excluded and their '
  'neighbours discounted; p_seed varies the order among equally useful titles. Reads only.';

revoke execute on function refine_candidates(ranking_category, integer, integer, uuid[])
  from public, anon;
grant execute on function refine_candidates(ranking_category, integer, integer, uuid[])
  to authenticated;


-- ---------------------------------------------------------------------------
-- 6. `_refine_seed` — do not ask again what was answered recently
-- ---------------------------------------------------------------------------

create or replace function _refine_seed(p_session uuid, p_user uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  s         record;
  v_members uuid[];
  v_n       integer;
  v_lo      integer;
  v_hi      integer;
  v_a       integer;
  v_b       integer;
  v_band_lo integer;
  v_next    integer;
  v_offer   record;
begin
  select * into s from ranking_sessions rs
   where rs.id = p_session and rs.user_id = p_user;

  -- Only a fresh prior session that nothing has been answered in.
  if s.id is null or s.prior_offset is null or s.strategy is distinct from 'prior'
     or jsonb_array_length(coalesce(s.history, '[]'::jsonb)) > 0 then
    return;
  end if;

  v_members := _rank_band_members(p_user, s.category, s.bucket, s.media_item_id);
  v_n := cardinality(v_members);

  -- The indices below address this band; if it is not the one the session was opened
  -- against, do nothing and let the session search from scratch.
  if md5(array_to_string(v_members, ',')) is distinct from s.band_digest then
    return;
  end if;

  with m as (
    select u.id, (u.ord - 1)::integer as idx
      from unnest(v_members) with ordinality as u(id, ord)
  ),
  latest as (
    select distinct on (x.other) x.other, x.won, x.created_at
      from (
        select case when c.winner_id = s.media_item_id then c.loser_id else c.winner_id end
                 as other,
               c.winner_id = s.media_item_id as won,
               c.created_at, c.id
          from comparisons c
         where c.user_id = p_user and c.withdrawn_at is null
           and (c.winner_id = s.media_item_id or c.loser_id = s.media_item_id)
      ) x
     order by x.other, x.created_at desc, x.id desc
  )
  select coalesce(max(m.idx + 1) filter (where not l.won and m.idx < s.prior_offset), 0),
         coalesce(min(m.idx)     filter (where l.won and m.idx >= s.prior_offset), v_n)
    into v_lo, v_hi
    from latest l
    join m on m.id = l.other
   where l.created_at > now() - interval '90 days';

  v_a := greatest(s.prior_offset - s.tolerance, 0);
  v_b := least(s.prior_offset + s.tolerance, v_n);

  -- Nothing recent; or the recent answers alone would confirm the window, which would
  -- make a Refine that asked the reader nothing. Both leave the session as it opened.
  if (v_lo = 0 and v_hi = v_n) or v_lo >= v_hi or (v_a <= v_lo and v_hi <= v_b) then
    return;
  end if;

  select b.lo into v_band_lo
    from band_bounds_excluding(p_user, s.category, s.bucket, s.media_item_id) b;

  v_next := _rank_next_index(v_lo, v_hi, s.strategy, s.prior_offset, s.tolerance, v_n);

  -- The pivot `_rank_start_impl` picked was never shown (this runs before the reply), so
  -- the seen set starts empty for the offer below rather than refusing that title.
  update ranking_sessions set seen_items = '{}'::uuid[] where id = s.id;

  select * into v_offer
    from _rank_offer(s.id, p_user, s.category, v_band_lo, v_lo, v_hi, v_next,
                     s.media_item_id);

  if v_offer.item is null then
    update ranking_sessions set seen_items = s.seen_items where id = s.id;
    return;
  end if;

  update ranking_sessions
     set lo         = v_lo,
         hi         = v_hi,
         pivot      = v_offer.idx,
         pivot_item = v_offer.item,
         seen_items = array[v_offer.item],
         updated_at = now()
   where id = s.id;
end;
$$;

comment on function _refine_seed(uuid, uuid) is
  'Opens a fresh refine session''s bounds where the reader''s own answers from the last 90 '
  'days already put them (the latest answer per pair, when it agrees with the current '
  'order), so a recently answered pair is not asked again. Never moves a title: the prior '
  'stays inside [lo, hi]. Skipped when it would confirm the window with no new answer. '
  'Internal (T5).';

revoke execute on function _refine_seed(uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. `refine_start` — open (or resume) one target
-- ---------------------------------------------------------------------------

create or replace function refine_start(
  p_media_item_id uuid,
  p_operation_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_claim   record;
  v_rank    record;
  v_band    record;
  v_open    boolean;
  v_w       integer;
  v_result  jsonb;
  v_session record;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();

  if not _refine_enabled() then
    raise exception 'refine is not available' using errcode = '0A000';
  end if;

  select * into v_claim from _claim_operation_result(p_operation_id, 'refine_start');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  perform _lock_media(v_user, p_media_item_id);

  select r.bucket, r.category, r.position into v_rank
    from rankings r
   where r.user_id = v_user and r.media_item_id = p_media_item_id;

  -- Refine is calibration of what is ALREADY ranked (§H.1.1). Anything else is a first
  -- ranking and belongs to rank_start.
  if v_rank.position is null then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  select * into v_band from band_bounds(v_user, v_rank.category, v_rank.bucket);
  if v_band.size < 2 then
    -- Alone in its band there is nothing to compare it with, and `_rank_start_impl`
    -- would finalize a placement no answer produced.
    raise exception 'nothing to compare it with' using errcode = '22023';
  end if;

  v_open := exists (
    select 1 from ranking_sessions rs
     where rs.user_id = v_user and rs.media_item_id = p_media_item_id
       and rs.kind = 'refine' and rs.provisional
  );

  -- The daily ceiling is the server's, so no client can make Refine endless. Resuming a
  -- target already open is not a new one.
  if not v_open
     and _refine_done_today(v_user)
         >= _refine_config_int('ranking.refine_daily_targets', 30) then
    raise exception 'refine has done enough for today' using errcode = '53400';
  end if;

  v_w := _refine_tolerance(v_rank.position);

  v_result := _rank_start_impl(
    v_user, p_media_item_id, v_rank.bucket, true, false, 'refine', null, v_w
  );

  -- A resumed session is not re-seeded: its bounds carry the reader's answers now.
  if not coalesce((v_result ->> 'done')::boolean, false)
     and not coalesce((v_result ->> 'resumed')::boolean, false) then
    perform _refine_seed((v_result ->> 'session_id')::uuid, v_user);
  end if;

  if not coalesce((v_result ->> 'done')::boolean, false) then
    select rs.id, rs.pivot_item into v_session
      from ranking_sessions rs
     where rs.id = (v_result ->> 'session_id')::uuid;

    v_result := jsonb_build_object(
      'done', false,
      'session_id', v_session.id,
      'pivot', v_session.pivot_item,
      'pivot_card', _rank_pivot_card(v_session.pivot_item),
      'resumed', coalesce((v_result ->> 'resumed')::boolean, false)
    );
  end if;

  return _record_operation_result(
    p_operation_id,
    v_result || jsonb_build_object(
      'target', jsonb_build_object(
        'position', v_rank.position,
        'category', v_rank.category,
        'bucket', v_rank.bucket,
        'tolerance', v_w
      )
    )
  );
end;
$$;

comment on function refine_start(uuid, uuid) is
  'T5: opens a provisional refine session for a ranked title (or resumes the one open), '
  'searched from where it already sits with the §H.5 tolerance, and answers with the first '
  'comparison and its card. The comparisons then run through rank_answer / rank_skip / '
  'rank_back / rank_cancel. Refuses when Refine is off (0A000), the title is unranked '
  '(P0002), alone in its band (22023) or the daily ceiling is reached (53400).';

revoke execute on function refine_start(uuid, uuid) from public, anon;
grant execute on function refine_start(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. `refine_snooze` — "I don't remember it well"
-- ---------------------------------------------------------------------------

create or replace function refine_snooze(p_media_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_until date := current_date + 180;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;

  perform assert_can_write();
  perform _lock_media(v_user, p_media_item_id);

  if not exists (select 1 from rankings
                  where user_id = v_user and media_item_id = p_media_item_id) then
    raise exception 'title is not ranked' using errcode = 'P0002';
  end if;

  insert into ranking_snoozes (user_id, media_item_id, reason, until)
  values (v_user, p_media_item_id, 'dont_remember', v_until)
  on conflict (user_id, media_item_id)
    do update set reason = excluded.reason, until = excluded.until, created_at = now();

  -- Its open refine session goes with it. The ranking is untouched; answers already given
  -- stay, as they do for rank_cancel, because they were real judgements.
  delete from ranking_sessions
   where user_id = v_user and media_item_id = p_media_item_id and kind = 'refine';

  return jsonb_build_object('snoozed_until', v_until);
end;
$$;

comment on function refine_snooze(uuid) is
  'T5: the reader does not remember a ranked title well enough to compare it. Refine will '
  'not offer it for 180 days, and its open refine session is closed. Its ranking is not '
  'touched. Idempotent: a repeat moves the date, nothing else.';

revoke execute on function refine_snooze(uuid) from public, anon;
grant execute on function refine_snooze(uuid) to authenticated;
