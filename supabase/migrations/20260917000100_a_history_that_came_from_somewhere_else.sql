-- A history that came from somewhere else.
--
-- The foundations an importer needs, and none of the importer. Nothing in this migration
-- has a caller: no RPC stages a row, no worker applies one, and `user_media.source` still
-- reads `'in_app'` for every row in the database. That is deliberate and it is the
-- acceptance criterion — **every predicate added here is a provable no-op until an
-- imported row exists**, which is what makes it safe to apply ahead of any client that can
-- produce one.
--
-- Specification: docs/product Letterboxd Import Contract V3 §2, §8, §11.
--
-- ===========================================================================
-- WHY THIS SHIPS FIRST, AND ALONE
--
-- A migration reaches the database in one instant; a binary reaches phones over days. If
-- the safety layer and the importer shipped together and either half slipped, an importer
-- would be writing rows into a database whose leaderboard counted them — and in this repo
-- an applied migration is history, so the correction would be another migration rather
-- than a revert. Shipping the fence first makes the only safe ordering, database ahead of
-- client, structural instead of procedural.
--
-- ===========================================================================
-- THE FOUR THINGS THIS ADDS
--
--   1. Somewhere to put the provenance          `imported_titles`, `imported_watches`
--   2. A shared match cache                     `letterboxd_matches`
--   3. A way to be quiet during a bulk write    `bingd.import_running` + two gate triggers
--   4. The leaderboard predicates               `_leaderboard_counts`
--
-- Plus `collection_counts()`, which is not a safety property but is the other half of the
-- Collection scale work and belongs in the same window.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Provenance
--
-- Two tables rather than columns on `user_media`, and the reason is load-bearing rather
-- than tidy. `user_media` is the hottest table in the schema: every collection read, every
-- award metric, both leaderboard counts and the For You exclusion set all select from it.
-- Import provenance is a fact about an import, not a fact about a collection row, and
-- widening the core table for the minority of accounts that ever import would make every
-- account pay for it.
--
-- `user_media.source` stays where it is and finally gets a writer. It is the one native
-- flag, because it is what the predicates below test and it has to be cheap to read.
-- ---------------------------------------------------------------------------

create table imported_titles (
  user_id        uuid not null,
  media_item_id  uuid not null,

  -- The canonical **film** short link, e.g. https://boxd.it/iEEq. External provenance and
  -- the key `letterboxd_matches` caches against. Never a bingd identity: that is
  -- `media_items.id`, and it is the column beside this one.
  letterboxd_uri text,

  -- The exported `Name` and `Year`, verbatim. Kept so an unmatched or mismatched row can
  -- be shown back to its owner and repaired, and so a later re-match has the original
  -- input rather than whatever the catalogue happened to resolve to first.
  source_name    text not null,
  source_year    integer,

  -- 0.5 to 5.0 in half steps. **The raw star, not the bucket.** The bucket is a policy
  -- applied to this number (>= 3.5 is "I liked it"), and that policy is explicitly
  -- reversible -- which it can only be if the input survives. Storing only the bucket
  -- would make re-tuning the boundary mean asking every importer to upload again.
  rating         numeric(2,1),

  first_imported_at timestamptz not null default now(),
  last_imported_at  timestamptz not null default now(),

  primary key (user_id, media_item_id),

  -- Composite, to `user_media`'s own primary key. So "remove imported titles" and account
  -- deletion both clean this up with no sweep to write and no sweep to forget, and a
  -- provenance row can never outlive the collection row it describes.
  constraint imported_titles_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade,

  constraint imported_titles_rating_is_a_letterboxd_star
    check (rating is null or (rating >= 0.5 and rating <= 5.0 and (rating * 2) = floor(rating * 2)))
);

comment on table imported_titles is
  'Per-title provenance for a Letterboxd import: the film URI, the exported name and year, and the raw star rating. One row per collection row, cascading from it. The rating is kept raw because the star-to-bucket boundary is a reversible policy and cannot be re-tuned from a bucket. Owner-readable; written only by the import apply path.';

comment on column imported_titles.letterboxd_uri is
  'The FILM short link. Not the diary-entry link, which addresses a viewing and lives on imported_watches -- the two differ for the same film and conflating them attaches watch dates to titles that do not exist.';


create table imported_watches (
  user_id       uuid not null,
  media_item_id uuid not null,

  -- The **diary entry** short link, e.g. https://boxd.it/ggWgth. Letterboxd issues one per
  -- logged viewing, which is what makes it a per-viewing identity -- and what makes a
  -- re-import of the same diary a no-op with no diffing logic anywhere.
  --
  -- In the founder's real export the same film is boxd.it/iEEq in watched.csv and
  -- boxd.it/ggWgth here. They are different objects and this column is the one that says so.
  diary_uri     text not null,

  -- The genuine `Watched Date`. Never the `Date` column from any file: that is when the row
  -- was created on Letterboxd, it is stamped in Letterboxd's own timezone, and in the real
  -- export it reads 2026-09-11 on an archive taken on 2026-09-10.
  watched_on    date not null,
  is_rewatch    boolean not null default false,
  imported_at   timestamptz not null default now(),

  primary key (user_id, diary_uri),

  -- The client bounds this at `today + 1` while parsing, and the client is precisely the
  -- party this table exists to distrust — `imported_titles.rating` gets a CHECK for the
  -- same reason and this column was originally left without one.
  --
  -- A static upper bound rather than `current_date + 1`, because a CHECK must be immutable.
  -- The real bound is the apply RPC's, which can compare against today; this one only has
  -- to make `9999-12-31` impossible to store.
  constraint imported_watches_plausible_date
    check (watched_on between date '1870-01-01' and date '2100-01-01'),

  constraint imported_watches_collection_fk
    foreign key (user_id, media_item_id)
    references user_media (user_id, media_item_id) on delete cascade
);

create index imported_watches_title on imported_watches (user_id, media_item_id);

comment on table imported_watches is
  'IMPORT PROVENANCE, NOT A WATCH HISTORY. One row per Letterboxd diary entry, so that repeated viewings survive an import losslessly and a future repeat-viewing model has something to backfill from. Nothing in the product reads this table and nothing may start: the deferred rewatch design owns that concept, and its migration is expected to consume this table and may drop it. Keyed on the diary-entry URI, which Letterboxd issues per viewing -- so the key gives at-most-once storage, and the apply path chooses whether a re-import that re-matches a film to a different media item updates media_item_id or leaves the old one.';

comment on column imported_watches.watched_on is
  'The diary Watched Date, which is the only genuine viewing date a Letterboxd export contains. The Date column in every file is an activity stamp in Letterboxd''s own timezone and is never read.';


-- The shared match cache. Global rather than per-account, and that is the whole value:
-- the seed catalogue is 382 films and `media_items` otherwise holds only what somebody has
-- already searched for, so early imports resolve almost everything against the provider.
-- Every confirmed match here resolves that film for every later importer for free.
create table letterboxd_matches (
  letterboxd_uri text primary key,
  media_item_id  uuid not null references media_items(id) on delete cascade,
  confirmed_at   timestamptz not null default now()
);

create index letterboxd_matches_media on letterboxd_matches (media_item_id);

comment on table letterboxd_matches is
  'Film URI to media item, shared across every account. Holds no user data -- which account contributed a match is deliberately not recorded. No RLS policy, so clients cannot read it at all; the matching worker runs as service_role and bypasses row security.';


-- ---------------------------------------------------------------------------
-- 2. Row level security
--
-- The two provenance tables mirror `user_media_own` exactly: owner-only SELECT, and no
-- write policy at all, because every writer is a SECURITY DEFINER function. That is the
-- schema's standing convention (20260813000500) and there is no reason for the import path
-- to become the exception.
--
-- `letterboxd_matches` gets RLS with **no policy**, which denies every client including
-- the owner -- the same construction `processed_operations` and `tmdb_request_log` use.
-- ---------------------------------------------------------------------------

alter table imported_titles    enable row level security;
alter table imported_watches   enable row level security;
alter table letterboxd_matches enable row level security;

create policy imported_titles_own on imported_titles for select
  using (user_id = auth.uid());

create policy imported_watches_own on imported_watches for select
  using (user_id = auth.uid());


-- For the removal sweep, and deliberately **not** for the leaderboards.
--
-- A partial index is usable only when the query's qualifier implies the index predicate,
-- and the leaderboards test `source <> 'imported'`, which implies this index's negation.
-- The planner will never choose it for `_leaderboard_counts` and nothing here pretends
-- otherwise.
--
-- What it does serve is the one query that asks for imported rows positively:
-- `where user_id = ? and source = 'imported'`, which is Phase 2's "remove imported titles"
-- and the job's own end-of-run reconciliation. Partial, because on any account that never
-- imports it indexes nothing at all.
create index user_media_imported on user_media (user_id) where source = 'imported';


-- ---------------------------------------------------------------------------
-- 3. Being quiet during a bulk write
--
-- ===========================================================================
-- WHY A GATE ON THE TWO TABLES RATHER THAN A GUARD IN EVERY FUNCTION
--
-- An import inserts thousands of `user_media` rows in one job. Every one of them fires
-- `_award_touch_user_media`, which evaluates thirteen award tracks, and any tier crossed
-- by a social track inserts a `feed_events` row -- which the notification machinery then
-- turns into a notice. Left alone, importing a library announces a trophy case to
-- everybody who follows you, one post at a time. A goal crossed by genuine diary dates
-- does the same thing once more.
--
-- The obvious fix is a guard inside `_maybe_award_unlocks` and another inside
-- `_maybe_goal_completion`. It was rejected for two reasons.
--
-- **It is incomplete by construction.** It suppresses the two paths somebody thought of.
-- The requirement is that an import emits *no* feed activity and *no* notification, and a
-- list of guarded functions can only ever be evidence about the functions on the list.
--
-- **It is a large transcription of live code.** `create or replace` needs the entire body,
-- so adding three lines to those two functions means re-emitting roughly three hundred
-- lines of production award and goal logic. The risk of a transcription error there is not
-- theoretical and it is not worth taking to add a guard.
--
-- So the gate sits on the two tables instead. A `BEFORE INSERT` trigger returning NULL
-- cancels the insert, and a transaction that has declared itself an import writes no feed
-- event and no notification **whatever produced it** -- including whatever somebody adds
-- next year without reading this file.
--
-- ===========================================================================
-- AND THE MARKER IS TRANSACTION-LOCAL BY CONSTRUCTION, NOT BY CONVENTION
--
-- The obvious marker is the string `'on'`, set with `set_config(..., true)` so it dies
-- with the transaction. That is correct *if every setter remembers the third argument*,
-- and the failure mode if one ever does not is the worst shape in this schema: a `SET`
-- left on a pooled connection means **every feed event and every notification for every
-- account sharing that connection disappears** — no error, no log, and no bound in time.
--
-- So the marker is not a constant. It is the current transaction id, and `_importing()`
-- compares against `txid_current()`. A value that escapes its transaction — leaked to the
-- session, left on a pooled connection, set by a future caller who forgets `is_local` —
-- matches nothing in any later transaction and is inert. The guarantee stops depending on
-- anybody's discipline.
--
-- Phase 2's apply path therefore declares itself with:
--
--     perform set_config('bingd.import_running', txid_current()::text, true);
--
-- There is deliberately no setter function here. One would be a second thing to keep
-- correct, and the line above is shorter than a call to it.
-- ===========================================================================

create or replace function _importing()
returns boolean
language sql
stable
set search_path = public
as $$
  -- `true` as the second argument to current_setting is missing_ok: an unset custom GUC
  -- returns NULL rather than raising, which is the state every ordinary transaction is in.
  --
  -- `txid_current()` assigns a real transaction id on first call, which is why this is
  -- only ever reached after the apply path has already written something.
  select coalesce(current_setting('bingd.import_running', true), '') = txid_current()::text;
$$;

comment on function _importing() is
  'Whether THIS transaction has declared itself a bulk import. The marker is the transaction id rather than a constant, so a value that escapes its transaction -- a session-level SET, a pooled connection, a caller who forgets set_config''s is_local argument -- matches nothing later and is inert. That is what keeps "an import is silent" from depending on every future setter being careful. Stable, not immutable: it reads session state.';

revoke execute on function _importing() from public, anon, authenticated;


create or replace function _no_activity_while_importing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- NULL from a BEFORE row trigger cancels the insert. The row is not written, nothing
  -- downstream of it runs, and the statement that attempted it carries on.
  if _importing() then return null; end if;
  return new;
end;
$$;

comment on function _no_activity_while_importing() is
  'Cancels a feed event or a notification when the transaction is a bulk import. The structural form of "an import produces no feed storm and no notification storm": it holds for every producer, including ones written after it.';

revoke execute on function _no_activity_while_importing() from public, anon, authenticated;

-- Postgres fires BEFORE row triggers in name order, so `notifications_respect_preference`
-- runs ahead of `notifications_silent_during_import`. That costs a preference lookup for a
-- row that is about to be discarded and is otherwise harmless: NULL from **any** BEFORE
-- trigger cancels the insert, so the outcome is the same whichever runs first. Not renamed
-- to win the race, because a name chosen to sort early is a fact about the ordering that
-- nothing states, and the ordering does not matter.
create trigger feed_events_silent_during_import
  before insert on feed_events
  for each row execute function _no_activity_while_importing();

create trigger notifications_silent_during_import
  before insert on notifications
  for each row execute function _no_activity_while_importing();


-- ---------------------------------------------------------------------------
-- 4. And the per-row award work is skipped, not merely silenced
--
-- The gate above makes an import quiet. It does not make it cheap: the triggers still
-- fire per row, and each one counts thirteen tracks across the whole collection, which is
-- quadratic in the size of the import.
--
-- These two are safe to re-emit because they are four lines of body each -- thin wrappers
-- over `_maybe_award_unlocks` and `_award_revoke_unsupported`, unchanged since
-- 20260902000100 and 20260904000100 respectively apart from the guard. The award logic
-- itself is untouched.
--
-- Correctness does not depend on this: the apply path evaluates the same thirteen tracks
-- once at the end of the job, and `_maybe_award_unlocks` is idempotent through
-- `award_unlocks`' primary key. What this buys is that importing 2,500 films costs one
-- evaluation rather than 2,500.
--
-- ===========================================================================
-- `_award_touch_watchlist` IS DELIBERATELY NOT GUARDED, AND THE ASYMMETRY IS THE POINT
--
-- Two of the three award triggers are guarded here and the third is not, which is exactly
-- the shape that gets "fixed" later by somebody who reads it as an omission.
--
-- It is not one. The guard exists to stop quadratic per-row work, and the watchlist is not
-- quadratic: `_award_touch_watchlist` evaluates a single track with a single count, and an
-- imported watchlist is hundreds of rows where a collection is thousands. Guarding it would
-- buy almost nothing and would add a third thing the apply path has to remember to settle.
--
-- What the watchlist *does* need is silence, and it already has it: the gate above sits on
-- `feed_events` and `notifications`, so a `queue-dragon` tier crossed mid-import writes its
-- ledger row and announces nothing. That is the requirement; skipping the work is only an
-- optimisation, and it is not worth taking here.
--
-- Consequence for Phase 2, stated so it is not discovered: the apply path settles the
-- thirteen collection tracks explicitly, and does **not** need to settle `queue-dragon`,
-- because that one was never skipped.
-- ===========================================================================
-- ---------------------------------------------------------------------------

create or replace function _award_touch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Skipped wholesale during an import; the job evaluates these same tracks once when it
  -- finishes, with the gate above keeping that evaluation silent.
  if _importing() then return null; end if;

  perform _maybe_award_unlocks(new.user_id,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life'],
    new.media_item_id);
  return null;
end;
$$;

revoke execute on function _award_touch_user_media() from public, anon, authenticated;


create or replace function _award_untouch_user_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The mirror image, and the reason it matters: "remove imported titles" deletes every
  -- imported row in one statement, and each delete would otherwise run a full revocation
  -- pass over thirteen tracks.
  if _importing() then return null; end if;

  -- The same thirteen tracks `_award_touch_user_media` counts up.
  perform _award_revoke_unsupported(old.user_id,
    array['movie-muncher','season-snacker','scream-snack','lol-mode',
          'softie-hours','space-brain','boom-club','toon-bloom',
          'truth-worm','passport-mode','time-hopper','genre-gremlin',
          'two-screen-life']);
  return null;
end;
$$;

revoke execute on function _award_untouch_user_media() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. The leaderboards stop counting somebody else's history
--
-- Two predicates, one per watched CTE. Everything else in this function is transcribed
-- unchanged from 20260903000100 and is held to that by leaderboard.test.mjs, which passes
-- against both versions on an account with no imported rows.
--
-- **The monthly case is the one that is easy to miss.** A row from `watched.csv` carries no
-- watch date at all -- the only genuine dates a Letterboxd export contains are in the
-- diary, and most films are not in the diary. So `coalesce(um.watched_on, created_at)`
-- falls through to the day the import ran, and without this predicate an entire library
-- would land on the *current* month's board rather than on no board at all.
--
-- The two review CTEs need no predicate: they count public notes, and an import writes
-- none. Left untouched rather than defensively guarded, so the diff says what changed.
-- ---------------------------------------------------------------------------

create or replace function _leaderboard_counts(p_metric text, p_timeframe text)
returns table (user_id uuid, metric_count integer)
language sql stable security definer
set search_path = public
as $$
  with bounds as (
    select _leaderboard_month_start() as from_day,
           (_leaderboard_month_start() + interval '1 month')::date as to_day
  ),
  -- Everyone the caller may read, plus everyone the caller may find (20260902000100).
  -- `can_discover_profile` refuses a block in either direction, a non-active account
  -- and the caller themselves; the caller is admitted by the first branch.
  eligible as (
    select p.id
      from profiles p
     where auth.uid() is not null
       and (can_view_profile(auth.uid(), p.id) or can_discover_profile(auth.uid(), p.id))
  ),
  watched_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric in ('titles', 'movies', 'tv')
       -- A leaderboard is a record of what somebody did here. An import is a record of
       -- what they did somewhere else, and a dateless imported row would otherwise be
       -- attributed to the month the import ran (20260917000100).
       and um.source <> 'imported'
       -- **The month this watch belongs to** (20260903000100). The watch date where the
       -- reader gave one, and otherwise the day the row entered their collection --
       -- a fact about them, recorded by the writer, that no later edit moves.
       --
       -- A `date` and a `timestamptz` are being reconciled, so the conversion names UTC
       -- for the reason `_leaderboard_month_start` does: `::date` on a `timestamptz`
       -- reads the session's TimeZone, which PostgREST does not pin, and a fallback that
       -- drifted with the connection would put one row in different months for two
       -- readers of the same board.
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) >= b.from_day
       and coalesce(um.watched_on, (um.created_at at time zone 'UTC')::date) <  b.to_day
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  watched_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      join media_items m on m.id = um.media_item_id
     where p_timeframe = 'all_time'
       and p_metric in ('titles', 'movies', 'tv')
       -- The same rule, and the sharper case: all-time is the board a new account could
       -- otherwise top on its first day (20260917000100).
       and um.source <> 'imported'
       -- No date test. `user_media` is keyed (user, title), so this is already a count
       -- of distinct titles.
       and m.kind in ('movie', 'season')
       and (p_metric <> 'movies' or m.kind = 'movie')
       and (p_metric <> 'tv'     or m.kind = 'season')
     group by um.user_id
  ),
  reviews_month as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
      cross join bounds b
     where p_timeframe = 'month'
       and p_metric = 'reviews'
       and um.note_first_published_at is not null
       and um.note_first_published_at >= (b.from_day::timestamp at time zone 'UTC')
       and um.note_first_published_at <  (b.to_day::timestamp   at time zone 'UTC')
     group by um.user_id
  ),
  reviews_all as (
    select um.user_id, count(*)::integer as n
      from user_media um
      join eligible v on v.id = um.user_id
     where p_timeframe = 'all_time'
       and p_metric = 'reviews'
       -- A state, not an event: the titles this account has a public review on right
       -- now. Un-sharing lowers it and re-sharing restores it.
       and um.note is not null
       and um.note_visibility = 'public'
     group by um.user_id
  )
  select * from watched_month
   union all
  select * from watched_all
   union all
  select * from reviews_month
   union all
  select * from reviews_all;
$$;

-- ===========================================================================
-- TWO OBLIGATIONS THIS PREDICATE CREATES, WRITTEN DOWN SO THEY ARE NOT DISCOVERED
--
-- **1. Nothing ever resets `source`, so an imported row is excluded for ever.**
--
-- Every `insert into user_media` in this schema is an `on conflict do update` that sets
-- `bucket`, `watched_on` or `note` and leaves `source` alone — `log_watched` and
-- `_rank_finalize` included. So a person who imports two thousand films and then genuinely
-- watches one of them here in October still has `source = 'imported'` on that row, and the
-- predicate above keeps it off both boards forever. They watched it in bingd; the board
-- says they did not.
--
-- That is not reachable today — no row is imported — but it is the missing half of
-- "a native action wins", and unlike the feed gate this predicate has no structural
-- backstop. **Phase 2 owes a `before update` trigger on `user_media` that returns
-- `source = 'in_app'` when a native writer touches a watch signal outside an import**, so
-- the rule holds for every writer rather than for the ones somebody remembered to edit.
--
-- **2. Goals are the third achievement surface and this file does not decide them.**
--
-- `_goal_after_insert` and `_goal_qualifying_count` have no `source` predicate, so an
-- import carrying genuine diary dates in a year the reader already has a goal for will
-- increment that goal and write a `goal_completions` row — which `20260829000200` calls
-- "at most once, ever" and which nothing revokes. The gate above then cancels the
-- announcement, so it happens **silently and permanently**.
--
-- That matches the locked contract as written — genuine diary dates may count toward
-- current-year goals, and an import emits no celebration — so it is left alone here rather
-- than quietly given a predicate. But the consequence is a founder-visible one and it is
-- stated rather than left to be found: a 2026 goal can complete from viewings that happened
-- on Letterboxd, and the reader is never told it did.
-- ===========================================================================

comment on function _leaderboard_counts(text, text) is
  'One person, one number, for one metric and one timeframe, over exactly the accounts the caller may read OR may find -- can_view_profile or can_discover_profile, which since 20260902000100 admits an unapproved private account while still refusing a block in either direction, a suspended account and a deleted one. Since 20260917000100 the two watched metrics exclude user_media.source = ''imported'': a leaderboard records what somebody did in bingd, and a dateless imported row would otherwise be attributed to the month the import ran. Since 20260903000100 the monthly watched metrics attribute a row to coalesce(watched_on, created_at at UTC). All-time watched has no date test. Monthly reviews reads note_first_published_at, an event an edit cannot move; all-time reviews counts titles currently carrying a public note -- neither needs the import predicate, because an import writes no notes. Never returns which titles. Internal: leaderboard and my_leaderboard_standing are the callers, and both validate their arguments first.';


-- ---------------------------------------------------------------------------
-- 6. The Collection header stops waiting for the whole collection
--
-- Not a safety property, but the other half of the same problem and it belongs in the same
-- window.
--
-- `useLoggedCollection` states the split -- "142 ranked, 380 logged" -- by materialising
-- every row of `user_media` and every row of `rankings` and measuring the arrays. That
-- traversal is keyset-paged at a thousand rows and it is *serial*, because each page needs
-- the previous page's last key, and the query settles all-or-nothing. On a collection of
-- any size the header is therefore blank until the last page lands.
--
-- Two integers the database can answer in one round trip fix the header. They do not fix
-- the payload, and nothing here pretends otherwise: the full read is still the full read,
-- and what the measured scale gate decides about it is a separate question.
--
-- SECURITY INVOKER, deliberately. `user_media_own` is owner-only and `rankings_read` is
-- `can_i_view(user_id)` since 20260813001900, which admits the owner unconditionally — so
-- running as the caller means RLS answers "whose collection" and this function never has
-- to. There is no argument for the same reason: another account's logged count is not
-- readable by design, so offering to count it would be offering to break that.
-- ---------------------------------------------------------------------------

create or replace function collection_counts()
returns table (ranked integer, logged integer)
language sql stable security invoker
set search_path = public
as $$
  select
    (select count(*)::integer from rankings   r where r.user_id = auth.uid()),
    (select count(*)::integer from user_media m where m.user_id = auth.uid());
$$;

comment on function collection_counts() is
  'The caller''s own collection split: how many titles have a position, and how many are logged at all. Exists so the Collection header is correct on the first frame rather than after a serial keyset traversal of the whole collection has settled. SECURITY INVOKER and argument-free: RLS decides whose rows these are, and another account''s logged count is owner-only by design.';

grant execute on function collection_counts() to authenticated;
