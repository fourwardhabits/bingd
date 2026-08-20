-- ---------------------------------------------------------------------------
-- The watchlist invariant: a watchlist entry means "I intend to watch this".
--
-- Founder decision, 2026-08-15. Watching or ranking a title ends the intention, so
-- the entry goes. Until now nothing removed it: `set_watchlist` was the only writer
-- of the table and acted solely on its own `p_present` argument, so a film ranked
-- straight off the watchlist stayed on it forever. That is visible in the 2026-08-14
-- device screenshots, where one title reads `#2 in Movies` and `In watchlist` on the
-- same screen.
--
-- Why a trigger rather than a line in each writer
--
-- Five functions establish a watch signal today — `log_watched`, `set_bucket`,
-- `set_season_progress`, `rank_start` (which upserts a bucket) and `_rank_finalize` —
-- and the Letterboxd import in PRD §12 will be the sixth, writing more rows than all
-- the others combined. A rule copied into six places is a rule that holds until
-- someone adds a seventh writer and does not know it exists. Attaching it to the
-- tables makes it a property of the data instead of a property of the call sites, and
-- the import path then inherits it without having to remember.
--
-- The cost is that the deletion is no longer visible when reading `set_bucket`. That
-- is what the `comment on` below and this header are for.
--
-- Two requirements are satisfied by construction rather than by logic, which is the
-- main reason this shape was chosen:
--
--   * **The exact object, and only that object.** The trigger names
--     `new.media_item_id` and nothing else. A season and its parent series are
--     separate rows in `media_items` with separate watchlist entries, so watching
--     season 2 cannot reach the series entry — there is no code path from one to the
--     other to get wrong. "I want to watch this show" stays true after one season,
--     and with first-class seasons that is the common case, not an edge case.
--
--   * **No re-add on unlog.** The rule is one-directional because there is no delete
--     trigger. Unlogging a title does not restore its watchlist entry; the user
--     re-adds it by hand. Considered and rejected: a write that silently resurrects a
--     row the user removed minutes earlier is harder to reason about than a row that
--     stays gone, and `unlog` cannot tell "that was a mistake" from "I no longer want
--     to see it".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The trigger function
--
-- `security definer`, deliberately. `watchlist` has a select-only policy and no
-- delete policy at all — writes go through SECURITY DEFINER RPCs (AD-4) — so a
-- trigger running with invoker rights would match zero rows and delete nothing
-- whenever it fired outside a definer context. It would not raise; the invariant
-- would simply stop holding, silently, which is the worst available failure. Running
-- as the owner makes the outcome the same no matter who wrote the row.
--
-- It is not an authorization hole: the only rows it can reach are those whose
-- `user_id` is on the row being written, and the caller already had to be authorized
-- to write that row.
--
-- **The relation is schema-qualified and `pg_temp` is pinned last.** Postgres searches
-- the temporary schema *first* for relation names whenever `pg_temp` is not listed in
-- `search_path` explicitly — so `set search_path = public` alone does not stop a
-- session-local `pg_temp.watchlist` from capturing an unqualified reference inside a
-- definer function. Verified rather than assumed: with a decoy temp table present, an
-- unqualified `watchlist` resolved to `pg_temp_0` and this trigger deleted from the
-- decoy, leaving the real row in place and the invariant quietly broken. Naming
-- `public.watchlist` settles it, and listing `pg_temp` last closes the same door for
-- anything added here later (CVE-2018-1058 is the general form).
--
-- Note for whoever reads this next: the rest of the definer functions in this schema
-- still use `set search_path = public` with unqualified relations and are open to the
-- same substitution. There is no route to it through PostgREST, which cannot issue
-- `CREATE TEMP TABLE`, so it is hygiene rather than a live hole — but it is a
-- worthwhile sweep and it is deliberately not bundled into this migration.
-- ---------------------------------------------------------------------------

create or replace function _leave_watchlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.watchlist
   where user_id = new.user_id
     and media_item_id = new.media_item_id;

  -- An AFTER ... FOR EACH ROW trigger's return value is ignored.
  return null;
end;
$$;

comment on function _leave_watchlist() is
  'Removes the exact (user, media item) from watchlist once it is watched or ranked. '
  'Attached to user_media and rankings by 20260815040000. Never touches a parent '
  'series when a season is written, and has no delete counterpart, so unlog does not '
  'restore an entry.';

revoke execute on function _leave_watchlist() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. What counts as a watch signal
--
-- `bucket` and `watched_on` are the two direct statements that a title has been
-- seen. `progress` counts only at `completed`: a season marked *watching* is one the
-- user still intends to finish, which is exactly what a watchlist entry says, so
-- removing it there would delete the entry at the moment it is most true.
-- decision-log §2 draws the same line — a season becomes rankable only when it is
-- completed.
--
-- **An insert and an update are not the same question, and conflating them was a
-- bug.** The first version of this migration used one trigger whose WHEN clause
-- tested the resulting row — `new.bucket is not null or …`. On an insert that is
-- right, because a row appearing with a watch signal on it *is* the transition. On
-- an update it is wrong, because it re-reads state that was already there and treats
-- it as though it had just happened. Independent review caught it and both failures
-- reproduce:
--
--   * a season already bucketed, deliberately put back on the watchlist, then marked
--     `watching` — the update touches `progress`, the clause sees the old `bucket`,
--     and the entry the user had just re-added is deleted;
--
--   * a film already watched, deliberately put back on the watchlist, then given a
--     note — `log_watched` names `watched_on` in its upsert's SET list even when the
--     value does not change, so the clause sees the old date and deletes the entry.
--
-- Both are the same mistake: a user's *later* explicit "I want to watch this again"
-- was being overruled by an *older* watch signal that no write had touched. Re-adding
-- something you have already seen is a rewatch, and it is a deliberate act.
--
-- So the two cases are now two triggers. The update one fires only on a genuine
-- transition, using `is distinct from` so that null-to-null and value-to-same-value
-- both count as no change. Editing a note, correcting a date to the value it already
-- had, or re-selecting the bucket that is already set all leave the watchlist alone.
--
-- The predicate stays in the WHEN clause rather than inside the function so ordinary
-- updates never call it at all, and so the rule is readable in one place.
-- ---------------------------------------------------------------------------

drop trigger if exists user_media_leaves_watchlist on user_media;
drop trigger if exists user_media_insert_leaves_watchlist on user_media;
drop trigger if exists user_media_update_leaves_watchlist on user_media;

-- A new row that already carries a watch signal.
create trigger user_media_insert_leaves_watchlist
  after insert on user_media
  for each row
  when (
    new.bucket is not null
    or new.watched_on is not null
    or new.progress = 'completed'
  )
  execute function _leave_watchlist();

-- An existing row *becoming* watched. OLD is available here and INSERT triggers may
-- not reference it, which is the mechanical reason these cannot be one trigger.
create trigger user_media_update_leaves_watchlist
  after update of bucket, watched_on, progress on user_media
  for each row
  when (
    (new.bucket is distinct from old.bucket and new.bucket is not null)
    or (new.watched_on is distinct from old.watched_on and new.watched_on is not null)
    or (new.progress is distinct from old.progress and new.progress = 'completed')
  )
  execute function _leave_watchlist();

-- Ranking is the stronger signal and gets its own trigger rather than relying on
-- `rank_start` having upserted a bucket first. That upsert is real, so this is
-- currently redundant — but the redundancy is the point: it makes the invariant a
-- property of the `rankings` table, true of any future writer, instead of a
-- consequence of the order of statements inside one function.
drop trigger if exists rankings_leaves_watchlist on rankings;

create trigger rankings_leaves_watchlist
  after insert on rankings
  for each row
  execute function _leave_watchlist();

-- ---------------------------------------------------------------------------
-- 3. Backfill
--
-- Everything already watched or ranked while the rule did not exist. Scoped exactly
-- as the triggers are — matched on (user_id, media_item_id), so a series entry
-- survives a watched season here too.
--
-- One-directional and not reversible. At alpha scale this is a handful of rows for a
-- handful of accounts, and what it removes is a row the product now considers wrong
-- to have kept.
-- ---------------------------------------------------------------------------

do $$
declare
  v_removed integer;
begin
  delete from watchlist w
   where exists (
           select 1 from rankings r
            where r.user_id = w.user_id
              and r.media_item_id = w.media_item_id
         )
      or exists (
           select 1 from user_media um
            where um.user_id = w.user_id
              and um.media_item_id = w.media_item_id
              and (
                um.bucket is not null
                or um.watched_on is not null
                or um.progress = 'completed'
              )
         );

  get diagnostics v_removed = row_count;
  raise notice 'watchlist invariant backfill: removed % row(s)', v_removed;
end;
$$;
