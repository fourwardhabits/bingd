-- Third review round, 2026-08-13.
-- Specification: docs/architecture/ranking.md §5, docs/architecture/data-model.md §2

-- ---------------------------------------------------------------------------
-- 1. The default-privileges retraction was itself wrong
--
-- 20260813002000 §5 concluded that ALTER DEFAULT PRIVILEGES "did not take" and
-- drew a lesson about trusting mechanisms. The observation was right and the
-- diagnosis was wrong, which a review caught by reading the manual instead of
-- the ACL dump.
--
-- 20260813001800 wrote the per-schema form:
--
--     alter default privileges in schema public revoke execute on functions from public;
--
-- The PostgreSQL documentation uses that exact statement as its example of a
-- command that does nothing: per-schema default privileges can only *add* to the
-- global setting, never subtract from it, and PUBLIC's EXECUTE comes from the
-- built-in global default. The global form — no IN SCHEMA clause — does work.
-- Verified by execution: with the per-schema revoke in place a new function still
-- carries `=X`; after the global revoke it does not.
--
-- That also explains the half-effect that looked so strange. The anon and
-- authenticated revokes worked because they were undoing Supabase's *per-schema*
-- default grants, which is exactly the "undoing a matching GRANT" case the manual
-- carves out.
--
-- So the correct statement is issued below. One caveat survives, and it is why the
-- allow-list test remains the real guard rather than this line: default privileges
-- attach to the role that set them, so this covers objects created by the role
-- running this migration and nothing else. A future extension, or an object created
-- by supabase_admin, is outside it. A CI check that sweeps the whole schema has no
-- such boundary.
-- ---------------------------------------------------------------------------

alter default privileges revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 2. `select coalesce(...) into` is not a default
--
-- This pattern appears three times in the schema and is wrong every time:
--
--     select coalesce((value)::integer, 90) into v_days
--       from app_config where key = 'username.redirect_days';
--
-- With no matching row the query returns *no rows*, so the coalesce is never
-- evaluated and the variable is left NULL. The fallback reads as a guarantee and
-- provides nothing — the same defect this pair of migrations was written to correct,
-- committed while correcting it.
--
-- Consequences, all reproduced by review:
--
--   username.redirect_days   a rename fails outright, because redirect_until is
--                            NOT NULL and receives NULL.
--   ranking.max_skips        `skips + 1 >= NULL` is never true, so the skip cap
--                            silently stops existing and a session can skip forever.
--   report.max_per_day       likewise: the daily report cap silently disappears.
--
-- All three rows are seeded and clients cannot write app_config, so this needs an
-- operator to delete a row. That is a thin defence for a failure mode where two of
-- the three outcomes are a limit quietly ceasing to apply.
--
-- A scalar subquery evaluates the coalesce whether or not a row matched.
-- ---------------------------------------------------------------------------

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

  v_days := coalesce(
    (select (value)::integer from app_config where key = 'username.redirect_days'),
    90
  );

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

-- ---------------------------------------------------------------------------
-- 3. Skipping after answering finalized early
--
-- 20260813002000 §3 fixed consecutive skips by walking outward from the midpoint
-- and taking the (skips + 1)-th candidate inside the band. `skips` is
-- session-global, though, and rank_answer does not reset it — nor should it, since
-- the max_skips cap is meant to count the whole session.
--
-- So once an answer intervened, the counter kept advancing while the band moved
-- underneath it. The walk then skipped past candidates it had never actually
-- offered, ran out, and finalized at the midpoint. Reproduced by review on a band
-- of three: skip, answer, skip placed the title immediately while a valid unoffered
-- pivot existed and only two of three permitted skips had been used.
--
-- That is a regression against the code this replaced, which always offered a fresh
-- mid + 1. The fix keeps both properties by counting skips *within the current
-- band* separately from skips overall.
--
-- The band change is detected here rather than signalled by rank_answer. Recording
-- the bounds a skip was offered against and comparing on entry keeps the whole
-- mechanism inside this one function: rank_answer, rank_back and rank_reorder all
-- move the bounds, and any of them forgetting to reset a counter would reintroduce
-- exactly this defect. Nothing to forget is better than three call sites to
-- remember.
-- ---------------------------------------------------------------------------

alter table ranking_sessions
  add column band_skips smallint not null default 0,
  add column skip_lo    integer,
  add column skip_hi    integer;

comment on column ranking_sessions.band_skips is
  'Comparisons already offered by rank_skip against the bounds in skip_lo/skip_hi. Distinct from skips, which counts the whole session and drives the max_skips cap. Reset implicitly whenever the band moves, so no other function has to remember to clear it.';

create or replace function _rank_skip_unguarded(p_session_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
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
  select * into v_s from _rank_session_state(p_session_id, v_user);

  v_max_skips := coalesce(
    (select (value)::integer from app_config where key = 'ranking.max_skips'),
    3
  );

  v_mid := (v_s.lo + v_s.hi) / 2;

  if v_s.skips + 1 >= v_max_skips then
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    );
  end if;

  select rs.band_skips, rs.skip_lo, rs.skip_hi
    into v_band_skips, v_skip_lo, v_skip_hi
    from ranking_sessions rs where rs.id = v_s.session_id;

  -- A different band means a different set of candidates, so nothing offered
  -- before counts against this one.
  if v_skip_lo is distinct from v_s.lo or v_skip_hi is distinct from v_s.hi then
    v_band_skips := 0;
  end if;

  -- mid+1, mid-1, mid+2, mid-2, ... skipping candidates outside [lo, hi), and
  -- stopping on the one after however many have been offered against this band.
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
    return _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true
    );
  end if;

  update ranking_sessions
     set skips      = skips + 1,
         band_skips = v_band_skips + 1,
         skip_lo    = v_s.lo,
         skip_hi    = v_s.hi,
         pivot      = v_pivot,
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
-- 4. report(), rebuilt so its body stops contradicting its own comment
--
-- 20260813002000 §4 corrected `comment on function report`, on the reasoning that
-- the behaviour was right and only the description was wrong. It left the *inline*
-- comment in the function body untouched, and that comment is stored in prosrc —
-- so `pg_get_functiondef` and the dashboard both still displayed a promise of a
-- visibility check directly above code that performs none. Correcting the label on
-- the outside of the box and leaving the wrong text inside it is not much of a
-- correction.
--
-- Recreated here, which also carries the config-default fix from §2. Behaviour is
-- otherwise unchanged.
-- ---------------------------------------------------------------------------

create or replace function report(
  p_subject_type report_subject,
  p_subject_id   uuid,
  p_reason       text,
  p_note         text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_owner uuid;
  v_today integer;
  v_cap   integer;
begin
  perform assert_can_write();

  v_cap := coalesce(
    (select (value)::integer from app_config where key = 'report.max_per_day'),
    20
  );

  select count(*) into v_today from reports
   where reporter_id = v_user and created_at > now() - interval '1 day';

  -- Advisory, not enforced: the count is taken before the insert and without a
  -- lock, so simultaneous calls from one reporter can both pass it. Idempotency is
  -- the guarantee that does hold, and it holds because the database holds it —
  -- reports_one_open_per_reporter, not this arithmetic.
  if v_today >= v_cap then
    raise exception 'report limit reached for today' using errcode = '53400';
  end if;

  -- Resolve the owner from the subject rather than trusting the caller, which is
  -- what stops a report being attributed to an account of the reporter's choosing.
  --
  -- Existence is checked; visibility deliberately is not. Requiring the caller to
  -- be able to see the subject would make an abuser unreportable the moment they
  -- blocked the person they abused, turning the block into a way to suppress the
  -- complaint. The cost is that a caller can confirm a UUID names a real row.
  v_owner := case p_subject_type
    when 'profile'      then p_subject_id
    when 'display_name' then p_subject_id
    when 'username'     then p_subject_id
    when 'list'         then (select owner_id  from lists      where id = p_subject_id)
    when 'list_title'   then (select owner_id  from lists      where id = p_subject_id)
    when 'watch_tag'    then (select tagger_id from watch_tags where id = p_subject_id)
  end;

  if v_owner is null then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if p_subject_type in ('profile', 'display_name', 'username')
     and not exists (select 1 from profiles where id = p_subject_id) then
    raise exception 'no such subject' using errcode = 'P0002';
  end if;

  if v_owner = v_user then
    raise exception 'cannot report your own content' using errcode = '22023';
  end if;

  insert into reports (reporter_id, subject_type, subject_id, subject_owner, reason, note)
  values (v_user, p_subject_type, p_subject_id, v_owner, p_reason, p_note)
  on conflict (reporter_id, subject_type, subject_id) where state = 'open'
    do nothing;

  -- Reported twice is reported. Saying so would tell the reporter which of their
  -- earlier complaints is still open, which is not their business.
  return jsonb_build_object('done', true, 'received', true);
end;
$$;

-- create or replace preserves the ACL, so the allow-list from 20260813002000 §5
-- still applies. Restated because a reader should not have to know that.
grant execute on function report(report_subject, uuid, text, text) to authenticated;
