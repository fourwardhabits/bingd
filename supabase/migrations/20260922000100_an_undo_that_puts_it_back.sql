-- An Undo that puts it back, and a comparison that arrives with its opponent.
--
-- Two real-user reports, one change to the same three functions (2026-09-16).
--
-- ---------------------------------------------------------------------------
-- 1. Undo, then the same answer, finalised the ranking
--
-- Comparison A, the reader picks the title on the right, comparison B appears, Undo
-- brings A back, the reader picks the right again -- and bingd sometimes placed the
-- title instead of showing B.
--
-- `rank_back` restored `lo`, `hi` and `pivot` from the history frame and nothing else.
-- `seen_items` (20260901000100) still held B, the title the undone answer had offered,
-- so the repeated answer computed the same midpoint, `_rank_offer` refused B as
-- already shown, and the walk went outward: to a neighbour of B on a wide range, which
-- quietly changed the rest of the search, or -- when B was the only title left -- to
-- nothing at all, and `rank_answer` placed the title at the midpoint as `adjustable`
-- without the comparison the search needed. "Sometimes" was the size of the range.
--
-- The skip count had the matching fault: every Undo took one off it, whatever had been
-- undone. `rank_skip` pushes no frame, so an Undo never undoes a skip by itself.
--
-- The rule now is that **a history frame is the whole state the reader was looking at**:
-- the bounds, the pivot, how many titles had been offered and how many skips had been
-- spent. `rank_answer` writes all five and `rank_back` restores them, so answer, Undo
-- and the same answer again is the same progression as the answer alone -- the same
-- next comparison, the same position, the same `adjustable`.
--
-- **Two things an Undo does not give back, both about Too tough.** A skip is never
-- refunded. And when a skip followed the answer being undone, the titles the reader
-- declined stay declined: only the comparison on screen is withdrawn. Without that,
-- answer, Too tough, Undo and the same answer re-offered the pair just skipped, and a
-- reader repeating it would never finish (independent review of this change).
--
-- **Re-offering B after an Undo is not a repeated pair.** ranking.md §2 already exempts
-- Back from the seen-set rule, because it is the reader asking rather than the app
-- choosing. Withdrawing the offers the undone step made is that exemption applied to
-- what comes after the Undo as well as to the Undo itself.
--
-- Frames written before this migration have neither key, and `rank_back` keeps the old
-- behaviour for them. Only a session left open across the deploy can hold one.
--
-- Not changed, on purpose: the `comparisons` row the undone answer wrote stays. Nothing
-- reads that table today, and removing evidence is a separate decision from restoring a
-- search.
--
-- ---------------------------------------------------------------------------
-- 2. A second round trip between comparisons
--
-- Measured before changing anything (supabase/tests/perf/ranking-latency.mjs, real
-- PostgreSQL 17): `rank_answer` takes 2-6ms of database time at every ranking size
-- from 50 to 1,000 titles, and does not grow with an imported, unranked library. The
-- 1-3 seconds a reader saw is not database work.
--
-- It is the client's sequence. Every comparison was two requests in series: the RPC,
-- which returns only the opponent's id, and then a read of `media_items` for that
-- opponent's title and poster before either card could be pressed -- each paying a
-- phone's round trip, then the poster download on top.
--
-- So the three steps that put a new opponent on screen now return its card with it:
-- `pivot_card` is `{id, kind, title, poster_path}` from `media_items`, the same four
-- columns the comparison card reads. The client seeds its cache from it and draws the
-- next comparison from one round trip. A client that predates this ignores the key; a
-- client running against a database that predates this finds no key and reads the
-- card as it always has. A replay returns the card it stored, like everything else in
-- the answer.
--
-- ---------------------------------------------------------------------------
-- Every function below is rebuilt from its latest definition -- `rank_answer` and
-- `rank_skip` from 20260901000100, `rank_back` from 20260826000500 -- and differs from
-- it only where the comments dated 20260922000100 say.
-- ---------------------------------------------------------------------------

create or replace function _rank_pivot_card(p_item uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
           'id', m.id,
           'kind', m.kind,
           'title', m.title,
           'poster_path', m.poster_path
         )
    from media_items m
   where m.id = p_item;
$$;

comment on function _rank_pivot_card(uuid) is
  'The four columns a comparison card draws for one opponent -- id, kind, title and poster path -- returned with the step that puts it on screen, so the client does not make a second request before the comparison can be answered. Null for a null or unknown id. Internal to the ranking family (20260922000100).';

revoke execute on function _rank_pivot_card(uuid) from public, anon, authenticated;


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
begin
  perform assert_can_write();

  select * into v_claim from _claim_operation_result(p_operation_id, 'rank_answer');
  if not v_claim.claimed then
    return coalesce(v_claim.prior, jsonb_build_object('done', false, 'already_applied', true));
  end if;

  -- The media item is read before the lock because the lock needs it, and a session's
  -- media_item_id never changes once written -- so this is a stable key rather than a
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
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

  -- The band can collapse under an open session if its other members are unranked.
  -- There is then nothing left to compare against.
  if v_s.lo >= v_s.hi then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_s.lo, v_s.session_id, false, v_s.provisional, v_s.new_watch
    ));
  end if;

  v_pivot_item := _rank_pivot_at(v_user, v_s.category, v_s.band_lo + v_s.pivot, v_exclude);

  -- An unresolvable pivot is refused before the winner is checked, rather than being
  -- allowed to fall through it.
  --
  -- It should not be reachable: `_rank_session_state` clamps `pivot` into `[lo, hi)` and
  -- `hi` into the live band, so `band_lo + pivot` addresses a member of the band that
  -- exists now. What made it worth stating is the *old* shape of this test --
  -- `p_winner <> v_pivot_item` against a null yields null, the whole condition yields
  -- null, and the function walked on to insert a comparison with a null loser against a
  -- not-null column. One refusal naming the real problem beats a constraint violation
  -- two statements later, and the client already reads P0002 as "that session is gone".
  if v_pivot_item is null then
    raise exception 'the title being compared against is no longer ranked'
      using errcode = 'P0002';
  end if;

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
      v_s.band_lo + v_new_lo, v_s.session_id, false, v_s.provisional, v_s.new_watch
    ));
  end if;

  v_next := (v_new_lo + v_new_hi) / 2;

  -- **The midpoint is a preference, not a demand** (20260901000100).
  --
  -- In a session with no skips it is always available and this is the binary
  -- search exactly as it was: the answered pivot is excluded from the new range by
  -- construction, so nothing in [new_lo, new_hi) has been offered before and the
  -- walk returns the midpoint on its first try. After a skip the midpoint can be a
  -- title the reader has already declined to call, and re-offering it is the
  -- founder's repeat.
  --
  -- Comparing against any index in [lo, hi) is as correct as comparing against the
  -- midpoint -- the narrowing above reads the STORED pivot rather than recomputing
  -- one -- so this costs a comparison or two on a skipped session and no
  -- correctness at all.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_new_lo, v_new_hi, v_next, v_exclude);

  if v_offer.item is null then
    -- Every remaining opponent has already been put to this reader and declined.
    -- There is no honest comparison left, so the title lands at the middle of the
    -- range the answers established, reported as adjustable -- the same resolution,
    -- and the same sentence on the reveal, as running out of skips.
    --
    -- **No comparison row is written here.** A skipped pair is an absence of
    -- evidence, and minting a win, a loss or a tie out of it is the fabrication the
    -- founder ruled out in as many words.
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_next, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  update ranking_sessions
     set lo = v_new_lo,
         hi = v_new_hi,
         pivot = v_offer.idx,
         seen_items = seen_items || v_offer.item,
         -- **The frame is the whole state the reader was looking at**
         -- (20260922000100). Bounds and pivot were all it held, so an Undo put the
         -- search back and left the offers and the skip count where the undone step
         -- had moved them. `seen` is how many titles had been offered when this
         -- comparison was on screen -- read from the row before this statement's own
         -- append -- and `skips` is how many had been spent.
         history = history || jsonb_build_object(
           'lo', v_s.lo, 'hi', v_s.hi, 'pivot', v_s.pivot,
           'seen', cardinality(seen_items), 'skips', v_s.skips
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

comment on function rank_answer(uuid, uuid, uuid) is
  'Records one comparison and either narrows the search or finalises the placement. With an operation id, a replay returns the stored answer -- the same position, score and activation flag -- so a retry cannot record a second comparison, move the title twice, or emit a second feed event. For a provisional session the opponents come from the band with the subject excluded, and the placement replaces the subject''s old position rather than filling a hole left behind at the start. Since 20260901000100 the next opponent is the nearest index to the midpoint that this session has not already shown; when every remaining one has been shown the title is placed at the midpoint and reported as adjustable, with no comparison recorded, because a skipped pair is an absence of evidence rather than a tie. Since 20260922000100 each history frame records the offer count and skip count as well as the bounds, so rank_back restores the whole state, and the next comparison carries its opponent''s card.';

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
  v_exclude := case when v_s.provisional then v_s.media_item_id end;

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
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- **The candidate walk is now the seen-set walk** (20260901000100), and this is
  -- the founder's repeat fixed at its cause.
  --
  -- It was mid+1, mid-1, mid+2, ... skipping the first band_skips candidates, with
  -- band_skips reset whenever [lo, hi) changed. That reset is the defect: the
  -- reader skips A-versus-B, is offered A-versus-C, answers it, the range narrows,
  -- the counter resets, and the new midpoint is B again -- a pair they have already
  -- said they cannot call.
  --
  -- _rank_offer walks the same outward path from the same midpoint and refuses any
  -- title this SESSION has offered, which no narrowing resets. It subsumes the old
  -- counter and closes the case the counter could not see. band_skips, skip_lo and
  -- skip_hi are left on the table and are no longer written; see the comment on
  -- those columns.
  select * into v_offer
    from _rank_offer(v_s.session_id, v_user, v_s.category,
                     v_s.band_lo, v_s.lo, v_s.hi, v_mid, v_exclude);

  -- Genuinely out of distinct comparisons for this band. Placing at the midpoint is
  -- the same resolution as running out of patience, and is reported as adjustable.
  if v_offer.item is null then
    return _record_operation_result(p_operation_id, _rank_finalize(
      v_user, v_s.media_item_id, v_s.category, v_s.bucket,
      v_s.band_lo + v_mid, v_s.session_id, true, v_s.provisional, v_s.new_watch
    ));
  end if;

  -- Persisting the pivot is 20260813001600's fix. Without it the answer path
  -- recomputed the midpoint and refused the title it had just displayed. Persisting
  -- the ITEM beside it is this migration's: a pivot is an index into a band that
  -- moves under it, and the invariant the founder asked for is about the pair.
  update ranking_sessions
     set skips      = skips + 1,
         pivot      = v_offer.idx,
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

comment on function rank_skip(uuid, uuid) is
  'Re-anchors to a different opponent without narrowing the range; the configured skip limit places the title at the midpoint instead. Carries an operation id because a skip mutates -- a replay without one spends a second skip against the limit and shows a third title. For a provisional session the candidates exclude the subject, which is still ranked inside the band. Since 20260901000100 the candidate walk refuses every title this session has already offered rather than counting offers against the current band, which is what stopped a skipped pair returning after the next answer narrowed the range. Since 20260922000100 the replacement comparison carries its opponent''s card.';

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
         -- **Undo withdraws what the undone step offered** (20260922000100).
         --
         -- Restoring the bounds and not the offers is the reported defect: the title
         -- the undone answer put on screen stayed in `seen_items`, so answering the
         -- restored comparison the same way again reached the same midpoint, found it
         -- "already shown", and walked past it -- to a neighbour on a wide range, and
         -- to an early, adjustable placement when it was the only title left. The
         -- offers are a stack in the order they were made, so truncating to the length
         -- the frame recorded removes exactly the ones made after it.
         --
         -- **Except what the reader declined.** `rank_skip` pushes no frame, so an Undo
         -- taken after Too tough pops the answer *before* the skip. The title that
         -- answer offered, and every one skipped past since, were put to the reader and
         -- refused: handing them back would re-offer a pair the reader has just said
         -- they cannot call, and a reader who kept skipping and undoing would never
         -- finish. A skip since the frame shows as a count higher than the frame
         -- recorded, and then only the comparison on screen -- the last offer, which
         -- nobody answered or declined -- is withdrawn.
         --
         -- A frame written before this migration has no `seen`; it keeps the old
         -- behaviour rather than guessing, and only a session that was open across the
         -- deploy can hold one.
         seen_items = case
           when not (v_prev ? 'seen') then seen_items
           when v_s.skips > (v_prev ->> 'skips')::integer
             then seen_items[1:cardinality(seen_items) - 1]
           else seen_items[1:(v_prev ->> 'seen')::integer]
         end,
         -- **Undo never refunds a skip.** It used to take one off on every Undo, whatever
         -- had been undone. Only `rank_skip` raises the count and no frame this
         -- migration writes lowers it, so the count stays: equal to the frame's when no
         -- skip followed the answer, and still spent when one did.
         skips = case
           when v_prev ? 'skips' then skips
           else greatest(skips - 1, 0)
         end,
         updated_at = now()
   where id = v_s.session_id;

  v_pivot_item := _rank_pivot_at(
    v_user, v_s.category, v_s.band_lo + (v_prev ->> 'pivot')::integer,
    case when v_s.provisional then v_s.media_item_id end
  );

  return _record_operation_result(p_operation_id, jsonb_build_object(
    'done', false,
    'session_id', v_s.session_id,
    'pivot', v_pivot_item,
    'pivot_card', _rank_pivot_card(v_pivot_item)
  ));
end;
$$;

comment on function rank_back(uuid, uuid) is
  'One comparison back. Restores the range, the pivot and the offers to what they were when that comparison was shown (20260922000100), so answering it the same way again is the same progression as the first time -- except that a skip is never refunded, and titles declined by a skip taken after that comparison stay declined. At the first comparison the session is deleted -- and for a provisional session that is the whole undo: the title still holds the position it always had. Carries an operation id because a replay would pop a second frame off the history. A frame written before 20260922000100 restores the range and pivot only.';

-- `create or replace` keeps a grant, and these were granted before. Restated, because a
-- grant present for a reason nobody can see is a grant the next rebuild loses.
revoke execute on function rank_answer(uuid, uuid, uuid) from public, anon;
grant  execute on function rank_answer(uuid, uuid, uuid) to authenticated;
revoke execute on function rank_skip(uuid, uuid)         from public, anon;
grant  execute on function rank_skip(uuid, uuid)         to authenticated;
revoke execute on function rank_back(uuid, uuid)         from public, anon;
grant  execute on function rank_back(uuid, uuid)         to authenticated;
