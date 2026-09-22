-- ===========================================================================
-- AN IMPORT NEVER SPEAKS FOR YOU (founder correction, 2026-09-21 — canonical rule)
--
-- A Letterboxd star rating is NOT a bingd opinion. It must not become *I liked it*, *It was
-- fine*, *I didn't like it*, a position or a score. An imported title arrives watched or
-- logged, as the source supports, UNRANKED and with **no bucket** until the reader answers
-- "How was it?" inside bingd. The star stays as provenance (`imported_titles.rating`).
--
-- Until now the importer wrote a star-derived bucket (client `bucketFor`, server
-- `_import_apply_batch` reading `raw->>'bucket'`): onto a new or previously imported row,
-- and into an empty bucket on a row logged here. Both stop now.
--
-- 1. THE GUARD. A BEFORE INSERT OR UPDATE trigger on `user_media` that, inside an import
--    (`_importing()`), refuses to set or change `bucket`. Enforced at the row rather than in
--    the 400-line apply function, for the reason 20260917000200 gives for the source
--    ratchet: installed clients keep sending `bucket` in their payloads until they update,
--    and a future apply written by somebody who never read this still cannot do it.
--
-- 2. THE BACKFILL, and only of what the import provably wrote. A bucket is cleared only
--    when EVERY one of these holds:
--      · `source = 'imported'` — no native watch signal has touched the row. Choosing a
--        different bucket here, logging a date here or ranking it here flips `source` to
--        `in_app` permanently (20260917000200's ratchet), so an `imported` row's bucket was
--        written by an import;
--      · no `rankings` row, no `ranking_placements` row and no open `ranking_sessions` row
--        for the title — no comparison evidence of any kind;
--      · the bucket is exactly what the Letterboxd star maps to under the old policy
--        (>= 3.5 loved, >= 2.5 fine, else not for me), and a star exists.
--    Every `in_app` bucket is left alone, including one an old import filled into an empty
--    bucket on a row logged here: that cannot be told apart from a choice, and a genuine
--    bingd opinion is never cleared on a guess.
--
--    Nothing else moves: the row stays in the collection with its source, its date and its
--    watch events; `imported_titles` keeps the star. Clearing a bucket fires no watchlist,
--    award or goal side effect (those fire on a bucket being SET).
-- ===========================================================================

create or replace function _import_sets_no_bucket()
returns trigger
language plpgsql
-- Definer because `_importing()` is revoked from clients (20260917000200's reasoning).
security definer
set search_path = public
as $$
begin
  if not _importing() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.bucket := null;
  else
    new.bucket := old.bucket;
  end if;
  return new;
end;
$$;

comment on function _import_sets_no_bucket() is
  'Inside an import, user_media.bucket can neither be set nor changed: a Letterboxd star is provenance (imported_titles.rating), never a bingd opinion. Enforced at the row so an installed client''s payload bucket, or any future apply path, cannot write one.';

revoke execute on function _import_sets_no_bucket() from public, anon, authenticated;

drop trigger if exists user_media_import_sets_no_bucket on user_media;
create trigger user_media_import_sets_no_bucket
  before insert or update on user_media
  for each row execute function _import_sets_no_bucket();

/** The old star policy, kept only so the backfill can recognise what it wrote. */
create or replace function _legacy_star_bucket(p_rating numeric)
returns taste_bucket
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_rating is null then null
    when p_rating >= 3.5 then 'loved'::taste_bucket
    when p_rating >= 2.5 then 'fine'::taste_bucket
    else 'not_for_me'::taste_bucket
  end;
$$;

revoke execute on function _legacy_star_bucket(numeric) from public, anon, authenticated;

/**
 * Clears the buckets an import provably wrote, and nothing else. Returns how many.
 * A function rather than a bare statement so the criteria are tested directly.
 */
create or replace function _clear_import_derived_buckets()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_cleared integer;
begin
  update user_media um
     set bucket = null
   where um.source = 'imported'
     and um.bucket is not null
     and not exists (select 1 from rankings r
                      where r.user_id = um.user_id and r.media_item_id = um.media_item_id)
     and not exists (select 1 from ranking_placements p
                      where p.user_id = um.user_id and p.media_item_id = um.media_item_id)
     and not exists (select 1 from ranking_sessions s
                      where s.user_id = um.user_id and s.media_item_id = um.media_item_id)
     and exists (select 1 from imported_titles it
                  where it.user_id = um.user_id and it.media_item_id = um.media_item_id
                    and it.rating is not null
                    and _legacy_star_bucket(it.rating) = um.bucket);
  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;

revoke execute on function _clear_import_derived_buckets() from public, anon, authenticated;

select _clear_import_derived_buckets();
