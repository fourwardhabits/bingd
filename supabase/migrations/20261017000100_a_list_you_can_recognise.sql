-- ===========================================================================
-- A LIST YOU CAN RECOGNISE IN THE ADD-TO-LIST SHEET (founder delta QA, 2026-09-21)
--
-- The picker's rows were a name and a count, too bare to answer "which list did I mean?".
-- They now carry the same cover every other list card draws (the first four posters, in
-- list order, nulls dropped — `my_lists`' own expression) and the list's description, which
-- the client truncates to one line.
--
-- The return shape grows, so the function is dropped and recreated (Postgres will not
-- change a table-returning function's columns in place) and its grant restated. An
-- installed client reads the columns it knows and ignores the two new ones. Still the
-- caller's own lists only (`owner_id = auth.uid()`), newest-edited first, at most 100.
-- ===========================================================================

drop function if exists my_lists_for_title(uuid);

create function my_lists_for_title(p_media_item_id uuid)
returns table (
  id          uuid,
  title       text,
  item_count  integer,
  visibility  list_visibility,
  contains    boolean,
  updated_at  timestamptz,
  description text,
  posters     text[]
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select l.id,
         l.title,
         (select count(*) from list_items li where li.list_id = l.id)::integer,
         l.visibility,
         exists (select 1 from list_items li
                  where li.list_id = l.id and li.media_item_id = p_media_item_id),
         l.updated_at,
         l.description,
         (select coalesce(array_agg(p order by ord), '{}'::text[])
            from (
              select m.poster_path as p,
                     row_number() over (order by li."position") as ord
                from list_items li
                join media_items m on m.id = li.media_item_id
               where li.list_id = l.id and m.poster_path is not null
               order by li."position"
               limit 4
            ) covers)
    from lists l
   where l.owner_id = auth.uid()
   order by l.updated_at desc
   limit 100;
$$;

comment on function my_lists_for_title(uuid) is
  'The caller''s own lists with a contains flag for one title, newest-edited first, with each list''s description and first four posters for its cover. Backs the Add to list sheet, where a row toggles membership in both directions.';

revoke execute on function my_lists_for_title(uuid) from public, anon;
grant execute on function my_lists_for_title(uuid) to authenticated;

notify pgrst, 'reload schema';
