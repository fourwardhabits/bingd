-- TMDB's reviews leave, because Bingd has its own.
-- Specification: founder acceptance corrections 2026-08-17, item 4.
--
-- ===========================================================================
-- WHAT CHANGED, AND WHY IT IS A DELETION RATHER THAN A HIDE
--
-- `20260817000500` added a `reviews` facet and the adapter filled it from TMDB's
-- `/reviews` endpoint. The labelling was scrupulous — heading, caption, ratings shown
-- as TMDB's, and a test asserting the words *critic*, *professional* and *community
-- review* never appeared near them — because that endpoint is another site's members
-- writing about a film, and the one thing it must never be is dressed up as
-- professional criticism.
--
-- The founder's correction is that scrupulous labelling was solving the wrong problem.
-- A tab called Reviews on a social product should be **Bingd's** reviews. So the tab is
-- now `title_reviews` over Bingd's own public Notes, and TMDB's have no reader.
--
-- Provider data with no reader is not free. PRD §19 puts every TMDB-derived row under a
-- six-month retention obligation, and `media_cache` rows are not swept by anything —
-- `media_refresh_due` covers `media_items`. Keeping the facet "in case" would mean
-- carrying somebody else's users' writing indefinitely for a surface that does not
-- exist. So it goes, and the closed set goes back to what it was before.
--
-- The order matters: the rows first, then the constraint. A check constraint cannot be
-- narrowed while a row violates it.
-- ===========================================================================

delete from media_cache where facet = 'reviews';

alter table media_cache drop constraint media_cache_known_facet;

alter table media_cache
  add constraint media_cache_known_facet
  check (facet in ('credits', 'keywords', 'providers', 'similar', 'videos'));

comment on table media_cache is
  'Provider metadata too large or too volatile for media_items, one row per facet. Facets are a closed set so an unknown one is a failed write rather than a row nothing reads. `videos` was added 2026-08-16 with the title-page redesign. `reviews` was added 2026-08-17 and removed the same day: the Reviews tab is Bingd''s own public Notes (title_reviews), so TMDB''s had no reader, and provider data with no reader is a retention obligation for nothing.';

-- The TTL key is left in `app_config` rather than removed. It is one key in a jsonb
-- object, `tmdb_put_facet` reads it only when asked for a facet named `reviews`, and
-- nothing can ask any more -- the constraint above refuses the write. Removing it would
-- be a second statement against a shared config row for no behavioural gain, and the
-- merge pattern every migration here uses (`value || key`) means a stray key is inert
-- rather than misleading.
