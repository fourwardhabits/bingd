-- Room for trailers, and a way to look a person up.
-- Specification: founder tranche 2026-08-16 (title detail: Cast · Videos · Details,
-- cast imagery, cast is clickable) · docs/reference/tmdb-integration.md.
--
-- ---------------------------------------------------------------------------
-- 1. A videos facet
--
-- `media_cache` allows {credits, keywords, providers, similar}, and the founder's
-- title-page structure asks for a Videos tab. Nothing fetches videos today, and the
-- fetch lives in a deployed edge function, so this migration cannot make trailers
-- appear -- it can only make them possible.
--
-- That asymmetry is why the tab is *not* being added to the screen as an empty one.
-- The rule this codebase has followed since the artwork-absent pass is that a section
-- without data is omitted rather than mocked, and the founder restated it for this
-- tranche as "no fake Reviews tab merely to populate navigation". So the schema and
-- the adapter learn about videos now, the screen renders the tab only when the facet
-- has rows, and the day the function is redeployed the tab appears by itself.
--
-- The TTL falls through to the default in `tmdb_put_facet`: a trailer list is stable
-- once a film is out, and there is no configured value to invent.
-- ---------------------------------------------------------------------------

alter table media_cache drop constraint media_cache_known_facet;

alter table media_cache
  add constraint media_cache_known_facet
  check (facet in ('credits', 'keywords', 'providers', 'similar', 'videos'));

comment on table media_cache is
  'Provider metadata too large or too volatile for media_items, one row per facet. Facets are a closed set so an unknown one is a failed write rather than a row nothing reads. `videos` was added 2026-08-16 with the title-page redesign; the adapter populates it only after redeployment, and the screen omits the tab until it does.';

-- ---------------------------------------------------------------------------
-- 2. Finding a person
--
-- The founder wants cast to be clickable and to route toward a person detail
-- architecture. There is no `people` table and this migration does not add one: the
-- only person data the app holds is inside `media_cache.credits`, and a table would
-- be a second copy to keep in step with a provider that already owns the truth.
--
-- So a person page answers its one useful question -- "what else of theirs is here" --
-- by asking the credits payloads which of them mention this person. That is a
-- containment query, and containment on jsonb is exactly what a GIN index serves.
--
-- Restricted to the credits facet with a partial index, because it is the only facet
-- whose payload is ever searched this way, and indexing the others would pay for
-- keywords and similar-title blobs nothing queries.
-- ---------------------------------------------------------------------------

create index if not exists media_cache_credits_payload
  on media_cache using gin (payload jsonb_path_ops)
  where facet = 'credits';
