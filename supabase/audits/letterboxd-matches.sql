-- Read-only audit of the shared Letterboxd film-URI cache.
-- Security audit 2026-11-01, M-1. See docs/ops/letterboxd-match-audit.md.
--
-- One SELECT and nothing else. It reads, it writes nothing, and it is safe to run against
-- production as it stands. It needs `20261024000200` applied, for
-- `_letterboxd_slug_agrees`.
--
-- Output, one row per finding. Handles are not selected, because the output is likely to
-- be pasted somewhere: `user_id` is enough to act on and nothing more.
--
--   slug_disagrees   the URI names a different film. Certainly wrong.
--   contested        accounts disagree about this URI. Read the claims before deciding.
--   name_disagrees   somebody's imported title is on this mapping's film under a name that
--                    is neither its title nor its original title. Honest alternate titles
--                    land here too, so this is the list to review, not a list of victims.

with mapped as (
  select m.letterboxd_uri, m.media_item_id, m.tier, m.claim_count, mi.title,
         extract(year from mi.release_date)::integer as year,
         mi.sort_key_squashed, media_squash(mi.original_title) as original_squashed
    from letterboxd_matches m
    join media_items mi on mi.id = m.media_item_id
)
select 'slug_disagrees' as finding,
       letterboxd_uri, media_item_id, title, year,
       claim_count, null::integer as rival_claims,
       null::uuid as user_id, null::text as imported_name, null::integer as imported_year
  from mapped
 where not _letterboxd_slug_agrees(letterboxd_uri, media_item_id)

union all

select 'contested',
       k.letterboxd_uri, k.media_item_id, k.title, k.year,
       k.claim_count, r.n,
       null, null, null
  from mapped k
  join lateral (
    select count(*)::integer as n
      from letterboxd_match_claims c
     where c.letterboxd_uri = k.letterboxd_uri
       and c.media_item_id <> k.media_item_id
  ) r on r.n > 0

union all

select 'name_disagrees',
       k.letterboxd_uri, k.media_item_id, k.title, k.year,
       k.claim_count, null,
       i.user_id, i.source_name, i.source_year
  from mapped k
  join imported_titles i
    on i.letterboxd_uri = k.letterboxd_uri
   and i.media_item_id = k.media_item_id
 where media_squash(i.source_name) <> k.sort_key_squashed
   and media_squash(i.source_name) is distinct from k.original_squashed

 order by 1, 2;
