-- Follow-ups from the two independent reviews of 2026-08-13.
-- Specification: docs/architecture/data-model.md §2, docs/architecture/ranking.md §5

-- ---------------------------------------------------------------------------
-- 1. profile_private relied on RLS alone
--
-- The table was created with row level security enabled and no read policy, which
-- does deny reads. But it kept Supabase's default SELECT grant to anon and
-- authenticated, so the guarantee rested entirely on RLS staying switched on.
-- 20260813001400 §1 claims something stronger than that — it argues the whole
-- point of a separate table is that the protection cannot be undone by a later
-- careless `grant`. Revoking makes the claim true, and gives the same two
-- independent layers the tables got in §3 of that migration.
-- ---------------------------------------------------------------------------

revoke select on profile_private from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A username was reserved on delete but released on rename
--
-- 20260813001500 §1 added reservation on account deletion and enforcement against
-- the history table, and the review confirmed both work. What neither covered is a
-- *rename*: nothing wrote to username_history when a username changed, so a
-- released name went straight back into the pool and could be claimed by anyone.
-- That is the INF-2 impersonation outcome — links to bingd.app/u/alice would
-- resolve to whoever took the name next.
--
-- Not reachable today: no rename RPC exists and clients hold no UPDATE grant on
-- profiles. It is fixed now rather than when that RPC is written, because the gap
-- only becomes visible at the moment it becomes exploitable, and the person adding
-- a change_username function has no reason to suspect this is missing.
--
-- This also gives profiles.username_changed_at and the 90-day redirect in
-- data-model.md §2 their first writer. Both were declared and never populated.
-- ---------------------------------------------------------------------------

insert into app_config (key, value) values ('username.redirect_days', '90'::jsonb)
  on conflict (key) do nothing;

create or replace function reserve_username_on_rename()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
begin
  if new.username = old.username then
    return new;
  end if;

  select coalesce((value)::integer, 90) into v_days
    from app_config where key = 'username.redirect_days';

  -- profile_id is retained, which is what makes this a redirect rather than a
  -- bare reservation: an old link can still resolve to the account that moved.
  -- After redirect_until the row stays as a permanent reservation, so the name is
  -- never returned to the pool even once redirecting stops.
  insert into username_history (username, profile_id, released_at, redirect_until)
  values (old.username, old.id, now(), now() + make_interval(days => v_days))
  on conflict (username) do update
     set profile_id     = old.id,
         released_at    = now(),
         redirect_until = now() + make_interval(days => v_days);

  new.username_changed_at := now();
  return new;
end;
$$;

-- Fires before profiles_username_not_reserved by name ordering, which is harmless:
-- that trigger tests the *new* name against the history table, and this one writes
-- a row for the *old* name. An account renaming back to a name it previously held
-- is still allowed, because the reservation it wrote names itself.
create trigger profiles_reserve_username_on_rename
  before update of username on profiles
  for each row execute function reserve_username_on_rename();

-- Corrects the claim in 20260813000200, which reasoned that retaining rows past
-- redirect_until meant "the primary key blocks reuse permanently". The primary key
-- stops two history rows sharing a name; it has no bearing on a new profile taking
-- the name, and it does nothing at all unless something writes the row in the first
-- place. Applied migrations are left as they were written, so the correction lives
-- here and on the object itself, which is what psql and the dashboard display.
comment on table username_history is
  'Reservations and 90-day redirects for released usernames (INF-2). Reuse is blocked by assert_username_available, not by this table''s primary key; the reservations it checks are written by reserve_username_on_profile_delete and reserve_username_on_rename. All three are required — with any one absent a released name returns to the pool.';

-- ---------------------------------------------------------------------------
-- 3. A second skip re-offered the same comparison
--
-- docs/architecture/ranking.md §5 says the replacement pivot steps outward:
-- mid + 1, then mid - 1, then mid + 2. The implementation reset the offset to 1 on
-- every call, and because lo and hi do not move when a comparison is skipped, every
-- skip picked mid + 1 again. Skipping therefore redisplayed the title the user had
-- just declined to judge.
--
-- No corruption — placement and the invariants were unaffected — but it is the one
-- finding from either review that a user would have noticed, and the fix is to
-- honour what the document already specified.
--
-- The offset now advances by the number of skips already recorded, by walking the
-- alternating sequence and taking the (skips + 1)-th candidate that falls inside
-- the band. Counting valid candidates rather than adding skips to the offset
-- matters at a band edge, where mid + 1 may be out of range and skipping ahead
-- blindly would leave a gap in the sequence or finalize early.
--
-- Replaces the unguarded implementation, since 20260813001700 renamed the original
-- and put the suspension guard in a wrapper around it.
-- ---------------------------------------------------------------------------

create or replace function _rank_skip_unguarded(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_s         record;
  v_max_skips integer;
  v_mid       integer;
  v_offset    integer := 1;
  v_seen      integer := 0;
  v_candidate integer;
  v_pivot     integer := null;
begin
  select * into v_s from _rank_session_state(p_session_id, v_user);

  select coalesce((value)::integer, 3) into v_max_skips
    from app_config where key = 'ranking.max_skips';

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    );
  end if;

  -- mid+1, mid-1, mid+2, mid-2, ... skipping candidates outside [lo, hi), and
  -- stopping on the one after however many this session has already offered.
  while v_offset <= (v_s.hi - v_s.lo) loop
    v_candidate := v_mid + v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_s.skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_candidate := v_mid - v_offset;
    if v_candidate >= v_s.lo and v_candidate < v_s.hi then
      v_seen := v_seen + 1;
      if v_seen > v_s.skips then
        v_pivot := v_candidate;
        exit;
      end if;
    end if;

    v_offset := v_offset + 1;
  end loop;

  -- Out of distinct comparisons to offer. Placing at the midpoint is the same
  -- resolution as running out of patience, and is reported as adjustable.
  if v_pivot is null then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    );
  end if;

  update ranking_sessions
     set skips = skips + 1,
         pivot = v_pivot,
         updated_at = now()
   where id = v_s.session_id;

  return jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_pivot),
    'skipped', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Two comments that described behaviour the code does not have
--
-- Both are corrected as comments rather than as code, because in each case the
-- behaviour is the one we want and the description was wrong.
-- ---------------------------------------------------------------------------

-- report() checks that a subject exists, never that the caller can see it. The
-- comment in 20260813001700 claimed a visibility gate.
--
-- Existence-only is deliberate, and the review surfaced the reason: the obvious
-- gate would make an abuser unreportable the moment they block the person they
-- abused, which inverts the protection. Being blocked after the fact must not
-- withdraw the ability to report. The cost is a weak existence oracle — a caller
-- can confirm a UUID names a real row — which is a fair trade against making
-- harassment unreportable by blocking the witness.
comment on function report(report_subject, uuid, text, text) is
  'Files a report. The subject''s owner is resolved server-side; a client-supplied owner would let anyone attribute a report to an account of their choosing. Checks that the subject exists but deliberately NOT that the caller can currently see it, so that blocking someone does not make them unable to report you. The per-day cap is advisory: it is counted before insert without a lock, so concurrent calls can exceed it slightly. Idempotency is not advisory — it rests on the reports_one_open_per_reporter index.';

-- 20260813001700 granted execute on assert_can_write to authenticated, which
-- 20260813001800 then swept away and deliberately did not restore. The net state
-- is correct; the grant statement left behind reads as though clients may call the
-- guard directly.
comment on function assert_can_write(uuid) is
  'Refuses writes from a suspended account, and from a caller with no account. Internal: called from inside SECURITY DEFINER functions, which execute as the owner and need no grant. The grant to authenticated in 20260813001700 is superseded by the allow-list below and is not in force.';

-- ---------------------------------------------------------------------------
-- 5. ALTER DEFAULT PRIVILEGES did not do what 20260813001800 claimed
--
-- That migration swept existing functions and then wrote:
--
--     alter default privileges in schema public revoke execute on functions from public;
--     alter default privileges in schema public revoke execute on functions from anon, authenticated;
--
-- and claimed on the strength of it that anything created afterwards "arrives with
-- no execute grant for a client role". Half true, which is the worst kind.
--
-- Inspecting pg_default_acl after the fact: the entry for functions is
-- `{service_role=X/postgres}`, so the `anon` and `authenticated` deltas were
-- recorded and applied. But every function created since still carries `=X` — the
-- implicit grant to PUBLIC — and **every role is a member of PUBLIC**, so `anon`
-- reaches it anyway. The revoke against PUBLIC did not take.
--
-- Demonstrated by this very migration: `reserve_username_on_rename` above was
-- immediately executable by `anon`, and the allow-list test caught it within
-- seconds of the function being written.
--
-- Which is the actual conclusion worth recording. The durable protection is not
-- the ALTER DEFAULT PRIVILEGES statement — that was a mechanism I assumed worked
-- and did not verify. It is `supabase/tests/function-grants.test.mjs`, which sweeps
-- the whole schema against an allow-list and fails on anything reachable that is
-- not named. A test that runs on every commit beats a setting nobody re-checks.
--
-- So the sweep and the allow-list are restated here, in full, as the single
-- authoritative account of which functions clients may call. A future migration
-- that adds a client-facing function must extend this list and the test's ALLOWED
-- map; anything it forgets is unreachable, and CI says so.
-- ---------------------------------------------------------------------------

-- Extension-owned functions stay excluded: citext lives in public and its equality
-- operator is backed by a function, so a blanket revoke would stop client roles
-- comparing a username to a string (20260813001800).
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid
            and d.classid = 'pg_proc'::regclass
            and d.deptype = 'e'
       )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn.signature);
  end loop;
end $$;

-- Helpers called from inside RLS policies. Neither accepts an identity to check,
-- which is what stops them being social-graph oracles (20260813001900).
grant execute on function can_i_view(uuid)        to anon, authenticated;
grant execute on function watch_tag_visible(uuid) to anon, authenticated;

-- Retrieval by identifier, so a shared link resolves without an account.
grant execute on function list_by_id(uuid)         to anon, authenticated;
grant execute on function list_items_by_list(uuid) to anon, authenticated;

-- Signed-in reads.
grant execute on function my_capabilities()       to authenticated;
grant execute on function unranked_queue(integer) to authenticated;

-- Signed-in writes. Each calls assert_can_write() first.
grant execute on function rank_start(uuid, taste_bucket)    to authenticated;
grant execute on function rank_answer(uuid, uuid)           to authenticated;
grant execute on function rank_skip(uuid)                   to authenticated;
grant execute on function rank_back(uuid)                   to authenticated;
grant execute on function rank_unrank(uuid)                 to authenticated;
grant execute on function rank_reorder(uuid, integer)       to authenticated;
grant execute on function rank_rebucket(uuid, taste_bucket) to authenticated;
grant execute on function report(report_subject, uuid, text, text) to authenticated;
