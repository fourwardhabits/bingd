-- ===========================================================================
-- Predicted score: the evaluation snapshot export.  READ-ONLY.  FOUNDER-RUN.
--
-- One SELECT, and nothing else. It writes nothing, creates nothing and calls no
-- function that writes. It returns one row with one column, `snapshot`: the
-- pseudonymised JSON document `eval/predicted-score/` reads.
--
-- Run it by hand, never from an agent. The steps are in README.md ("Running the
-- export"). In short: copy this file OUTSIDE the repository, set the salt below,
-- run it read-only, and save the result into `.agent-workflow/eval/`, which is
-- gitignored. Never commit a snapshot. Delete it once the report is read.
--
-- WHAT IS IN IT (the minimum the harness needs):
--   users     one row per account with at least one ranking: salted key,
--             visibility, status, and how many titles it imported (a count only)
--   follows   approved follows between those accounts, with the time approved
--   blocks    blocks between those accounts
--   rankings  category, bucket, position and created_at of every ranking, plus
--             three comparison COUNTS per ranking (never the comparison rows):
--               cmp_window   comparisons involving the title in the session
--                            window before created_at (placement evidence)
--               cmp_earlier  comparisons before that: the title was in the list
--                            earlier, so created_at was reset by a re-placement
--               cmp_later    comparisons after created_at: it was a pivot since
--               cmp_first    the time of the earliest comparison involving it,
--                            which dates a re-placed title's first presence
--             and whether the title also has an imported_titles row
--   media     kind, series (as a salted key), season number, genres, original
--             language, release YEAR and TMDB popularity of every ranked title
--             and its series
--   similar   the TMDB association list (media_cache facet `similar`) of each of
--             those titles, as salted keys
--   stars     ONLY IF include_letterboxd_stars is set: each account's OWN raw
--             Letterboxd star for titles it imported. The harness uses a star
--             only for that same account's predictions, never anyone else's
--             (PRD: an unranked title contributes nothing to anybody else's view).
--
-- WHAT IS NOT IN IT: no user id, username, name, email, avatar or date of birth;
-- no title id, title name, TMDB id or poster; no note, review, watch date or
-- comparison row. Every user and title is left(md5(salt || kind || id), 20), so
-- nobody holding the file without the salt can join it back to the database.
--
-- Pseudonymisation is not anonymisation. Anyone holding BOTH the file and the
-- salt could re-identify an account. Do not keep the salt after exporting.
-- ===========================================================================

with params as (
  select
    -- SET THIS. At least 24 random characters. Do not reuse it and do not keep it.
    'REPLACE_WITH_A_RANDOM_SALT_OF_24_OR_MORE_CHARACTERS'::text as salt_input,
    -- Set to true to include each account's own raw Letterboxd stars.
    false as include_letterboxd_stars,
    -- Matches SESSION_WINDOW_HOURS in config.ts.
    interval '24 hours' as session_window
),
salt as (
  select
    case
      -- Refuses to run until the salt is set: the cast of this sentence to an
      -- integer raises "invalid input syntax for type integer", with the
      -- instruction in the error text.
      when salt_input like 'REPLACE_WITH%' or length(salt_input) < 24
        then ('SALT NOT SET: edit params.salt_input in export.sql -- ' || salt_input)::integer::text
      else salt_input
    end as s,
    include_letterboxd_stars as stars,
    session_window
  from params
),
rankers as (
  select distinct user_id as id from rankings
),
pseudo_user as (
  select r.id, left(md5(salt.s || ':user:' || r.id::text), 20) as k
    from rankers r cross join salt
),
star_rows as (
  select it.user_id, it.media_item_id, it.rating, it.first_imported_at
    from imported_titles it
    cross join salt
   where salt.stars
     and it.rating is not null
     and exists (select 1 from rankers r where r.id = it.user_id)
),
media_set as (
  select media_item_id as id from rankings
  union
  select media_item_id from star_rows
),
media_with_parents as (
  select id from media_set
  union
  select mi.parent_id
    from media_items mi
    join media_set ms on ms.id = mi.id
   where mi.parent_id is not null
),
pseudo_media as (
  select m.id, left(md5(salt.s || ':media:' || m.id::text), 20) as k
    from media_with_parents m cross join salt
),
evidence as (
  select r.user_id, r.media_item_id,
         count(c.id) filter (where c.created_at >  r.created_at - salt.session_window
                               and c.created_at <= r.created_at)                  as cmp_window,
         count(c.id) filter (where c.created_at <= r.created_at - salt.session_window) as cmp_earlier,
         count(c.id) filter (where c.created_at >  r.created_at)                  as cmp_later,
         floor(extract(epoch from min(c.created_at)) * 1000000)::bigint           as cmp_first
    from rankings r
    cross join salt
    left join comparisons c
      on c.user_id = r.user_id
     and (c.winner_id = r.media_item_id or c.loser_id = r.media_item_id)
   group by r.user_id, r.media_item_id
)
select jsonb_build_object(
  'format', 'bingd-predicted-score-snapshot',
  'version', 1,
  'exported_at', floor(extract(epoch from now()) * 1000000)::bigint,
  'includes_letterboxd_stars', (select stars from salt),

  'users', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'u', pu.k,
             'visibility', p.visibility,
             'status', p.status,
             'imported_titles', (select count(*) from imported_titles it where it.user_id = p.id)
           ) order by pu.k), '[]'::jsonb)
      from pseudo_user pu
      join profiles p on p.id = pu.id
  ),

  'follows', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'follower', a.k,
             'followee', b.k,
             't', floor(extract(epoch from coalesce(f.approved_at, f.created_at)) * 1000000)::bigint
           ) order by a.k, b.k), '[]'::jsonb)
      from follows f
      join pseudo_user a on a.id = f.follower_id
      join pseudo_user b on b.id = f.followee_id
     where f.state = 'approved'
  ),

  'blocks', (
    select coalesce(jsonb_agg(jsonb_build_object('blocker', a.k, 'blocked', b.k) order by a.k, b.k), '[]'::jsonb)
      from blocks bl
      join pseudo_user a on a.id = bl.blocker_id
      join pseudo_user b on b.id = bl.blocked_id
  ),

  'rankings', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'u', pu.k,
             'm', pm.k,
             'c', r.category,
             'b', r.bucket,
             'p', r.position,
             't', floor(extract(epoch from r.created_at) * 1000000)::bigint,
             'cmp_window', e.cmp_window,
             'cmp_earlier', e.cmp_earlier,
             'cmp_later', e.cmp_later,
             'cmp_first', e.cmp_first,
             'imported', exists (
               select 1 from imported_titles it
                where it.user_id = r.user_id and it.media_item_id = r.media_item_id
             )
           ) order by pu.k, r.category, r.position), '[]'::jsonb)
      from rankings r
      join pseudo_user pu on pu.id = r.user_id
      join pseudo_media pm on pm.id = r.media_item_id
      join evidence e on e.user_id = r.user_id and e.media_item_id = r.media_item_id
  ),

  'media', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'm', pm.k,
             'kind', mi.kind,
             'parent', pp.k,
             'season', mi.season_number,
             'genres', to_jsonb(mi.genres),
             'lang', mi.original_language,
             'year', extract(year from mi.release_date)::integer,
             'popularity', mi.popularity
           ) order by pm.k), '[]'::jsonb)
      from pseudo_media pm
      join media_items mi on mi.id = pm.id
      left join pseudo_media pp on pp.id = mi.parent_id
  ),

  'similar', (
    select coalesce(jsonb_agg(jsonb_build_object('m', pm.k, 'ids', ids.list) order by pm.k), '[]'::jsonb)
      from pseudo_media pm
      join media_cache mc on mc.media_item_id = pm.id and mc.facet = 'similar'
      cross join salt
      cross join lateral (
        -- Hardened the way group_picks reads this facet: a payload whose `ids` is
        -- not an array yields nothing, and a non-uuid entry is skipped.
        select coalesce(jsonb_agg(left(md5(salt.s || ':media:' || lower(x.value)), 20) order by x.ord), '[]'::jsonb) as list
          from jsonb_array_elements_text(
                 case when jsonb_typeof(mc.payload -> 'ids') = 'array'
                      then mc.payload -> 'ids' else '[]'::jsonb end
               ) with ordinality as x(value, ord)
         where x.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      ) ids
  ),

  'stars', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'u', pu.k,
             'm', pm.k,
             'rating', sr.rating,
             't', floor(extract(epoch from sr.first_imported_at) * 1000000)::bigint
           ) order by pu.k, pm.k), '[]'::jsonb)
      from star_rows sr
      join pseudo_user pu on pu.id = sr.user_id
      join pseudo_media pm on pm.id = sr.media_item_id
  )
) as snapshot;
