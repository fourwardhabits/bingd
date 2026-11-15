-- ===========================================================================
-- Recommendation V2: the real-history replay export.  READ-ONLY.  COORDINATOR-RUN.
--
-- One SELECT, and nothing else. It writes nothing, creates nothing and calls no function
-- that writes. It returns one row with one column, `replay`: the pseudonymous JSON document
-- `eval/rec-v2-replay/run.mjs` reads.
--
-- Run it by hand, under an approved, temporary, READ-ONLY credential, never from an agent
-- session and never with a service key. The steps are in README.md. In short: run it inside
-- `begin transaction read only; … rollback;`, save the result to a path OUTSIDE the
-- repository, point REC_V2_REPLAY_EXPORT at it, and delete it once the report is read.
-- Never commit an export.
--
-- WHAT IS IN IT (the minimum a V1 / V2-metadata replay needs):
--   users     one row per ACTIVE account with at least one ranking: a RANDOM per-run key
--             (1..n, shuffled every run), and its visibility (public / private), which
--             decides whether it could ever be a taste neighbour.
--   rankings  key, media id, category, bucket, position, the DAY it was ranked
--             (days since 1970-01-01, an integer) and its order among that account's
--             rankings (`seq`, 1..n by created_at). `seq` is an ordinal, not a time: it says
--             which of one account's rankings came first and nothing about when.
--   logged    each account's logged titles that are not ranked: key, media id, bucket (the
--             band of an import, or null). No watch date, no note, no source.
--   follows   approved follows between those accounts, as key pairs, with no time.
--   media     every catalogue title a wall could show (film or show with a poster and a
--             release date) plus every ranked or logged title and its show: media id, TMDB
--             id, kind, parent media id, season number, genres, original language, release
--             YEAR and TMDB popularity. No title, overview, poster path or IMDb id.
--   similar   the TMDB association list (media_cache facet `similar`) of every ranked
--             title and its show, as media ids.
--   trending  the trending lists (provider_list_cache `trending.*`), as media ids.
--
-- WHAT IS NOT IN IT: no user id, username, display name, email, avatar, bio, social link or
-- date of birth; no note, review, comment or reaction; no watch date; no timestamp finer
-- than a day; no title name. A user key is random for each run, so two exports cannot be
-- joined to each other or back to the database through it; `export.test.mjs` fails if an
-- identifying column is ever selected.
--
-- Pseudonymous is not anonymous: a small cohort's ranked titles are a fingerprint. Keep the
-- export outside the repository, share only the aggregate report, and delete the file.
-- ===========================================================================

with rankers as materialized (
  select p.id, p.visibility
    from profiles p
   where p.status = 'active'
     and exists (select 1 from rankings r where r.user_id = p.id)
),
-- A random key per account, per run: the order is shuffled by random(), so the same
-- account gets a different key every time this is run.
pseudo_user as materialized (
  select r.id, r.visibility, row_number() over (order by random()) as k
    from rankers r
),
ranked as (
  select r.user_id, r.media_item_id, r.category, r.bucket, r.position,
         (r.created_at at time zone 'UTC')::date - date '1970-01-01' as day,
         row_number() over (partition by r.user_id order by r.created_at, r.category, r.position) as seq
    from rankings r
    join pseudo_user pu on pu.id = r.user_id
),
logged as (
  select um.user_id, um.media_item_id, um.bucket
    from user_media um
    join pseudo_user pu on pu.id = um.user_id
   where not exists (
           select 1 from rankings r
            where r.user_id = um.user_id and r.media_item_id = um.media_item_id
         )
),
held as (
  select media_item_id as id from ranked
  union
  select media_item_id from logged
),
held_with_parents as (
  select id from held
  union
  select mi.parent_id from media_items mi join held h on h.id = mi.id where mi.parent_id is not null
),
catalogue as (
  select mi.id
    from media_items mi
   where mi.kind in ('movie', 'series')
     and mi.poster_path is not null
     and mi.release_date is not null
),
media_set as (
  select id from held_with_parents
  union
  select id from catalogue
)
select jsonb_build_object(
  'format', 'bingd-rec-v2-replay-export',
  'version', 1,
  'exported_day', current_date - date '1970-01-01',

  'users', (
    select coalesce(jsonb_agg(jsonb_build_object('u', pu.k, 'visibility', pu.visibility) order by pu.k), '[]'::jsonb)
      from pseudo_user pu
  ),

  'rankings', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'u', pu.k,
             'm', r.media_item_id,
             'c', r.category,
             'b', r.bucket,
             'p', r.position,
             'day', r.day,
             'seq', r.seq
           ) order by pu.k, r.seq), '[]'::jsonb)
      from ranked r
      join pseudo_user pu on pu.id = r.user_id
  ),

  'logged', (
    select coalesce(jsonb_agg(jsonb_build_object('u', pu.k, 'm', l.media_item_id, 'b', l.bucket)
                              order by pu.k, l.media_item_id), '[]'::jsonb)
      from logged l
      join pseudo_user pu on pu.id = l.user_id
  ),

  'follows', (
    select coalesce(jsonb_agg(jsonb_build_object('follower', a.k, 'followee', b.k) order by a.k, b.k), '[]'::jsonb)
      from follows f
      join pseudo_user a on a.id = f.follower_id
      join pseudo_user b on b.id = f.followee_id
     where f.state = 'approved'
  ),

  'media', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'm', mi.id,
             'tmdb', mi.tmdb_id,
             'kind', mi.kind,
             'parent', mi.parent_id,
             'season', mi.season_number,
             'genres', to_jsonb(coalesce(mi.genres, '{}'::text[])),
             'lang', mi.original_language,
             'year', extract(year from mi.release_date)::integer,
             'popularity', mi.popularity,
             'tile', (mi.poster_path is not null and mi.release_date is not null and mi.release_date <= current_date)
           ) order by mi.id), '[]'::jsonb)
      from media_set ms
      join media_items mi on mi.id = ms.id
  ),

  'similar', (
    select coalesce(jsonb_agg(jsonb_build_object('m', h.id, 'ids', ids.list) order by h.id), '[]'::jsonb)
      from held_with_parents h
      join media_cache mc on mc.media_item_id = h.id and mc.facet = 'similar'
      cross join lateral (
        -- Hardened the way group_picks reads this facet: a payload whose `ids` is not an
        -- array yields nothing, and a non-uuid entry is skipped.
        select coalesce(jsonb_agg(lower(x.value) order by x.ord), '[]'::jsonb) as list
          from jsonb_array_elements_text(
                 case when jsonb_typeof(mc.payload -> 'ids') = 'array'
                      then mc.payload -> 'ids' else '[]'::jsonb end
               ) with ordinality as x(value, ord)
         where x.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      ) ids
  ),

  'trending', (
    select coalesce(jsonb_agg(jsonb_build_object('list', plc.list_key, 'ids', ids.list) order by plc.list_key), '[]'::jsonb)
      from provider_list_cache plc
      cross join lateral (
        select coalesce(jsonb_agg(lower(x.value) order by x.ord), '[]'::jsonb) as list
          from jsonb_array_elements_text(
                 case when jsonb_typeof(plc.payload -> 'ids') = 'array'
                      then plc.payload -> 'ids' else '[]'::jsonb end
               ) with ordinality as x(value, ord)
         where x.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      ) ids
     where plc.list_key like 'trending.%'
  )
) as replay;
