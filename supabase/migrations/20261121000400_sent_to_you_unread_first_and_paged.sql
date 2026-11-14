-- Sent to You, unread first and paged (#290 Codex P2 #5, server half; wave 2).
--
-- ===========================================================================
-- WHAT THIS IS FOR
--
-- `recommendations_to_me` (20261121000100 §4) orders by "opened or not", then
-- `recommended_at desc`, and returns at most 200 rows. Since 20261121000100 the client's
-- "unread" is `opened_at is null and seen_at is null`, but the server order still knows only
-- `opened_at`. A row the reader has *seen* but not opened therefore stays in the unopened
-- prefix for ever, and once the reader has seen 200 unopened rows, an unread row at position
-- 201+ never arrives at all: no amount of reading makes it reachable. #297 (f443eeb4) only
-- added a client "New" indicator for that state; it did not make the rows reachable.
--
-- This adds ONE new function, `recommendations_to_me_page`:
--
--   * order: unread (neither opened nor seen) first, then seen-but-unopened, then opened;
--     newest first within each group, `id desc` as the tie-break, so the order is total;
--   * the same columns as `recommendations_to_me`, in the same order, plus `read_rank`
--     (0 unread, 1 seen, 2 opened) last;
--   * at most 200 rows per call, and a keyset cursor (`p_after_rank`,
--     `p_after_recommended_at`, `p_after_id`) — all three or none — to page further.
--
-- Why a new function rather than reordering `recommendations_to_me` in place: shipped clients
-- read "the first 200 rows are unopened-first" to decide their "New"/"200+" indicator. Under a
-- different order that indicator would lie on every installed build. A new name lets a new
-- client opt in (and fall back to the old function where this one is not applied yet) while
-- every existing client keeps exactly the contract it was built against.
--
-- ===========================================================================
-- WHAT IT DOES NOT TOUCH
--
--   * `recommendations_to_me`: body, order, limit, security mode, comment and grants are
--     byte-identical to 20261121000100 §4. Not rebuilt here.
--   * `mark_recommendations_seen`, `mark_recommendation_opened`, `recommend_title`, the two
--     read-state helpers, every policy, and every column grant on `title_recommendations`.
--     O2 stands: the sender can read neither `opened_at` nor `seen_at`. This function is
--     `security invoker`, reads both columns only through the recipient-only definer helpers
--     (`recommendation_opened_at`, `recommendation_seen_at`), and grants nothing on the table.
--   * Visibility: no filter of its own beyond `recipient_id = auth.uid()`.
--     `title_recommendations_recipient` (delivered rows only) and `profiles_read` decide what
--     appears, exactly as for `recommendations_to_me`.
--
-- ===========================================================================
-- APPLYING IT
--
-- Additive and re-runnable: `create or replace`, an idempotent comment, revoke and grant. The
-- Supabase CLI applies a migration file as one transaction (no explicit begin/commit, per the
-- repo's convention). NOT applied anywhere at the time of writing: founder approval required
-- (D-UC1). Clients built against it fall back to `recommendations_to_me` while it is absent
-- (PGRST202 / 42883), so it can be applied at any time after the client ships, or before.
--
-- Rollback (in the PR body as well). Roll back 0400 before 0300/0100:
--
--   drop function if exists recommendations_to_me_page(integer, smallint, timestamptz, uuid);
--   delete from supabase_migrations.schema_migrations where version = '20261121000400';
-- ===========================================================================

create or replace function recommendations_to_me_page(
  p_limit                integer     default 100,
  p_after_rank           smallint    default null,
  p_after_recommended_at timestamptz default null,
  p_after_id             uuid        default null
)
returns table (
  id                  uuid,
  sender_id           uuid,
  sender_username     text,
  sender_display_name text,
  sender_avatar_path  text,
  media_item_id       uuid,
  media_kind          media_kind,
  media_title         text,
  series_title        text,
  poster_path         text,
  release_date        date,
  genres              text[],
  original_language   text,
  runtime_minutes     integer,
  recommended_at      timestamptz,
  opened_at           timestamptz,
  message             text,
  seen_at             timestamptz,
  read_rank           smallint
)
language plpgsql stable security invoker
set search_path = public
as $$
begin
  -- A cursor is all three keys or none: half a cursor has no defined position.
  if (p_after_rank is null) <> (p_after_recommended_at is null)
     or (p_after_rank is null) <> (p_after_id is null) then
    raise exception 'a page cursor needs p_after_rank, p_after_recommended_at and p_after_id together'
      using errcode = '22023';
  end if;

  return query
  with mine as (
    select r.id                              as r_id,
           r.sender_id                       as r_sender_id,
           p.username::text                  as r_sender_username,
           p.display_name                    as r_sender_display_name,
           p.avatar_path                     as r_sender_avatar_path,
           m.id                              as r_media_item_id,
           m.kind                            as r_media_kind,
           m.title                           as r_media_title,
           parent.title                      as r_series_title,
           m.poster_path                     as r_poster_path,
           m.release_date                    as r_release_date,
           m.genres                          as r_genres,
           m.original_language               as r_original_language,
           m.runtime_minutes                 as r_runtime_minutes,
           r.recommended_at                  as r_recommended_at,
           -- Read state only through the recipient-only helpers (20261121000100 §2): neither
           -- column is granted to authenticated.
           recommendation_opened_at(r.id)    as r_opened_at,
           r.message                         as r_message,
           recommendation_seen_at(r.id)      as r_seen_at
      from title_recommendations r
      join profiles p    on p.id = r.sender_id and p.status = 'active'
      join media_items m on m.id = r.media_item_id
      left join media_items parent on parent.id = m.parent_id
     -- Pending and dismissed rows are absent because `title_recommendations_recipient` does not
     -- admit them (security invoker), not because of anything written here.
     where r.recipient_id = auth.uid()
  ),
  ranked as (
    select mine.*,
           (case when r_opened_at is not null then 2
                 when r_seen_at   is not null then 1
                 else 0 end)::smallint as r_read_rank
      from mine
  )
  select r_id, r_sender_id, r_sender_username, r_sender_display_name, r_sender_avatar_path,
         r_media_item_id, r_media_kind, r_media_title, r_series_title, r_poster_path,
         r_release_date, r_genres, r_original_language, r_runtime_minutes, r_recommended_at,
         r_opened_at, r_message, r_seen_at, r_read_rank
    from ranked
   where p_after_rank is null
      or r_read_rank > p_after_rank
      or (r_read_rank = p_after_rank
          and (r_recommended_at < p_after_recommended_at
               or (r_recommended_at = p_after_recommended_at and r_id < p_after_id)))
   order by r_read_rank, r_recommended_at desc, r_id desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function recommendations_to_me_page(integer, smallint, timestamptz, uuid) is
  'The caller''s "Sent to you" list, unread first (neither opened nor seen), then seen-but-unopened, then opened; newest first within each, id desc as tie-break; at most 200 per call, with a keyset cursor (read_rank, recommended_at, id) to page further (20261121000400). Same columns as recommendations_to_me plus read_rank. security invoker: title_recommendations_recipient and profiles_read decide visibility, opened_at/seen_at are read only through the recipient-only definer helpers, and nothing is granted on the table. recommendations_to_me is unchanged. Cannot be asked about another account.';

revoke execute on function recommendations_to_me_page(integer, smallint, timestamptz, uuid) from public, anon;
grant execute on function recommendations_to_me_page(integer, smallint, timestamptz, uuid) to authenticated;
