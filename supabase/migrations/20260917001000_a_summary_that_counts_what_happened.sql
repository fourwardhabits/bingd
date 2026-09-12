-- A summary that counts what happened, rather than what was attempted.
--
-- Independent review, 2026-09-11, finding 7. Re-emitted from `20260917000400`, which holds
-- the newest definition of this function.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Every staging row that the apply step finished with became `applied`, and the summary
-- counted `applied` rows. But `_import_apply_batch` has three outcomes for a watched row
-- and only one of them writes anything:
--
--   ranked here            nothing written -- the strongest native state there is
--   logged here (in_app)   bucket filled only if it was null; often nothing written
--   otherwise              inserted or updated, and the import owns it
--
-- All three are marked `applied`, deliberately, so the job knows it finished with them.
-- The screen then rendered that number as **"Added to your collection"**.
--
-- So somebody who imports their archive, ranks all 22 films in the app, and re-imports the
-- same archive a week later is told "Added to your collection: 22" while `user_media`,
-- `rankings` and `imported_watches` are provably unchanged. The existing idempotence test
-- asserts exactly that nothing changed, and never looks at the number the person reads.
--
-- Watchlist rows have the same shape: one is inserted only if the title is not already in
-- the collection, and the skip is still `applied`.
--
-- And `viewings` summed `jsonb_array_length(raw->'watches')` -- the diary entries the
-- *archive* contained -- regardless of how many `imported_watches` rows the
-- `on conflict do nothing` actually wrote. On a re-import that is the full count again.
--
-- ===========================================================================
-- THE RULE THIS SETTLES ON
--
-- **One number, one definition, and no two of them counting the same thing.**
--
-- | count        | unit            | means |
-- |--------------|-----------------|-------|
-- | `watched`    | films           | a watched row the import now owns (`source = 'imported'`) |
-- | `kept`       | films           | a watched row left alone because it was ranked or logged here |
-- | `already`    | films           | imported before, and unchanged by this run |
-- | `watchlist`  | films           | a watchlist row that exists because of this import |
-- | `viewings`   | diary entries   | per-viewing rows held for this job's films -- NOT a film count |
-- | `ambiguous`  | films           | two catalogue candidates, unresolved |
-- | `unmatched`  | films           | nothing in the catalogue, or the row could not be written |
-- | `stragglers` | films           | still pending or matched when the job settled |
--
-- `watched + kept + already + ambiguous + unmatched + stragglers` is every watched row in the
-- archive, which is the sum the screen can now show without it adding up to more than the
-- preview promised. `watchlist` is counted separately because a film can legitimately be
-- both, and `viewings` is in a different unit entirely -- a rewatch is several diary
-- entries and one film, by design.
--
-- ===========================================================================
-- AND WHY THIS NEEDS NO NEW COLUMN
--
-- The distinction is recoverable at settle from the collection itself, which is where it
-- actually lives: a watched row the import owns has `user_media.source = 'imported'`, and
-- one it left alone is either ranked or `in_app`. `_source_follows_the_watch` maintains
-- that, and it is the same fact the provenance rule is built on -- so reading it here
-- keeps one source of truth rather than adding a second that could disagree with it.
--
-- The alternative was a per-row outcome column written by `_import_apply_batch`, which
-- would mean re-emitting a hundred and fifty lines of worker to change four, with the
-- transcription risk that carries.
-- ===========================================================================

create or replace function _import_settle(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid;
  v_started timestamptz;
  v_counts  jsonb;
begin
  select user_id, created_at into v_user, v_started from import_jobs where id = p_job_id;
  if v_user is null then return '{}'::jsonb; end if;

  perform set_config('bingd.import_running', txid_current()::text, true);

  perform _maybe_award_unlocks(v_user,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);

  select jsonb_build_object(
           -- Kept, because the event and the dead-letter reporting read it and it is an
           -- honest number in its own right: how many rows the job finished with.
           'applied',    count(*) filter (where r.status = 'applied'),

           -- **Films this job actually put in the collection.**
           --
           -- Two conditions, and both are load-bearing. `source = 'imported'` says the
           -- import owns the row rather than the person — it is written by the apply path's
           -- upsert and maintained by `_source_follows_the_watch`. `created_at >= v_started`
           -- says *this* job created it: without that, re-importing an archive reported
           -- every film as added again, because the rows it added last week are still
           -- owned by the import.
           'watched',    count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source = 'imported' and um.created_at >= v_started),

           -- Left exactly as it was, because the person built it here: ranked, or logged.
           --
           -- **No `um.user_id is not null` test**, which the first version had and which
           -- silently lost the most important case: a ranked title need not have a
           -- `user_media` row at all, and the apply path writes nothing for one — so the
           -- clearest example of the import claiming credit it had not earned was counted
           -- in neither bucket. `null is distinct from 'imported'` is true, which is the
           -- answer wanted.
           'kept',       count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source is distinct from 'imported'),

           -- Already imported before, and unchanged by this run. Its own bucket rather than
           -- folded into `kept`, because "you ranked this yourself" and "you imported this
           -- last month" are different sentences to the person reading them, and only the
           -- first is about the provenance rule.
           'already',    count(*) filter (
                           where r.status = 'applied' and r.kind = 'watched'
                             and um.source = 'imported' and um.created_at < v_started),

           -- A watchlist row that exists because of this import. The apply step skips a
           -- title already in the collection -- watched beats wanting to watch -- and that
           -- skip was counted as an addition.
           'watchlist',  count(*) filter (
                           where r.status = 'applied' and r.kind = 'watchlist'
                             and wl.user_id is not null),

           'ambiguous',  count(*) filter (where r.status = 'ambiguous'),
           'unmatched',  count(*) filter (where r.status in ('unmatched', 'needs_provider')),
           'stragglers', count(*) filter (where r.status in ('pending', 'matched'))
         )
    into v_counts
    from import_rows r
    left join user_media um
           on um.user_id = v_user and um.media_item_id = r.media_item_id
    left join watchlist wl
           on wl.user_id = v_user and wl.media_item_id = r.media_item_id
   where r.job_id = p_job_id;

  -- ---------------------------------------------------------------------------
  -- Viewings, counted from the rows that exist rather than from the archive.
  --
  -- A separate statement because it is in a different unit and joins a different table: one
  -- film with three diary entries is one film and three viewings, and collapsing the two
  -- into one aggregate is how "500 films imported" came to mean 500 of something else.
  --
  -- Counted as **held**, not as inserted. A re-import inserts nothing and the number does
  -- not change, which is the truthful answer to "how much of my diary is here" -- whereas
  -- the archive's own `jsonb_array_length`, which this replaces, reported the full count
  -- every time as though it had all just arrived.
  -- ---------------------------------------------------------------------------
  v_counts := v_counts || jsonb_build_object('viewings', (
    select count(*)
      from imported_watches iw
     where iw.user_id = v_user
       and iw.media_item_id in (
             select r.media_item_id from import_rows r
              where r.job_id = p_job_id and r.kind = 'watched'
                and r.media_item_id is not null)
  ));

  delete from import_rows
   where job_id = p_job_id and status in ('applied', 'duplicate');

  -- The redaction, unchanged from `20260917000400`. Down to the two fields the repair
  -- surface renders; `candidates` is its own column and is left alone, because an ambiguous
  -- row without its candidates cannot be resolved by anybody.
  update import_rows
     set raw = jsonb_strip_nulls(jsonb_build_object(
                 'name', raw->>'name',
                 'year', raw->'year'))
   where job_id = p_job_id
     and status in ('ambiguous', 'unmatched', 'needs_provider')
     and (raw ?| array['filmUri', 'rating', 'bucket', 'watchedOn', 'watches']);

  update import_jobs
     set status = 'done',
         completed_at = now(),
         claimed_at = null,
         counts = counts || v_counts
   where id = p_job_id and completed_at is null;

  return v_counts;
end;
$$;

comment on function _import_settle(uuid) is
  'Ends a job: evaluates the thirteen collection award tracks once, silently, under the marker; writes the counts the summary screen reads; deletes every applied and duplicate staging row; and redacts what is left down to the name and year the repair surface renders. The counts distinguish what the import wrote from what it left alone -- watched counts films the import now owns (user_media.source = imported), kept counts films that were ranked or logged here and were deliberately untouched, and watchlist counts rows that exist because of this import rather than skips -- so a re-import of an already-ranked archive reports nothing added instead of everything. viewings is in diary entries rather than films and is counted from imported_watches, so a rewatch is several viewings and one film. Once only: the final update is guarded on completed_at is null.';

revoke execute on function _import_settle(uuid) from public, anon, authenticated;
