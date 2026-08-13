-- ===========================================================================
-- Where a catalogue row came from
--
-- media_items was designed around one provider. PRD §19 requires TMDB-derived
-- metadata to refresh or reduce to an identifier inside six months, and `fetched_at`
-- is how that is measured — but nothing on the row says whether TMDB is where it came
-- from, so a retention job would have to treat every row as TMDB's or none.
--
-- That question becomes concrete with the seed catalogue in the next migration, which
-- is Wikidata's: CC0, no attribution obligation, no retention window, and nothing to
-- renegotiate when a private test stops being private. Those rows must not expire, and
-- a TMDB row must, and the difference has to be written down rather than inferred from
-- which columns happen to be null.
-- ===========================================================================

create type catalogue_provenance as enum ('tmdb', 'wikidata', 'manual');

-- The default is 'tmdb' deliberately, and it is the unsafe-looking choice on purpose.
-- A row that arrives without stating its provenance is one nobody thought about, and
-- the two ways of being wrong are not symmetrical: defaulting to 'tmdb' can expire
-- metadata that did not have to expire, which costs a refetch, while defaulting to
-- 'wikidata' would silently exempt TMDB data from the six-month rule and turn a
-- forgotten argument into a licence breach.
alter table media_items
  add column provenance   catalogue_provenance not null default 'tmdb',
  add column wikidata_qid text;

comment on column media_items.provenance is
  'Which source this row''s metadata came from. Decides whether PRD §19''s six-month TMDB retention window applies: it does for tmdb, and does not for wikidata (CC0) or manual. Defaults to tmdb because that is the fail-safe direction — expiring a row that need not expire costs a refetch, while exempting a TMDB row from the window would breach the terms.';

comment on column media_items.wikidata_qid is
  'Wikidata entity id for a row seeded from Wikidata, e.g. Q1079. Kept so a re-fetch can update the row it produced, and so a title can still be identified if it turns out to have the wrong tmdb_id.';

create unique index media_items_wikidata on media_items (wikidata_qid)
  where wikidata_qid is not null;

-- Both are metadata about the provider, not about a user, and media_items is already
-- world-readable (`using (true)`), so no policy changes: a client can see which source
-- a title came from, which is exactly what an attribution line needs.
