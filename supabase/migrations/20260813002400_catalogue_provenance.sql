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

-- ---------------------------------------------------------------------------
-- The retention view has to read the column, or the column decides nothing
--
-- media_refresh_due (from 20260813001500) selects every row with a tmdb_id past the
-- window. Adding a provenance column without changing it would have left the column
-- written by the seed and read by nobody: the refresh job would still have offered
-- Wikidata rows to TMDB for refresh, and the justification above — that a retention job
-- can now tell the two apart — would have been true of the schema and false of the code.
--
-- provenance is also projected, so a job draining the view can log or branch on it
-- rather than joining back to find out what it is looking at. That is why this drops and
-- recreates rather than replacing: CREATE OR REPLACE VIEW can only append a column, and
-- the projection reads better with provenance beside the id it qualifies. Nothing depends
-- on the view yet — the refresh job it exists for is unwritten.
-- ---------------------------------------------------------------------------

drop view media_refresh_due;

create view media_refresh_due with (security_invoker = true) as
select mi.id,
       mi.kind,
       mi.tmdb_id,
       mi.parent_id,
       mi.provenance,
       mi.fetched_at
  from media_items mi
 where mi.provenance = 'tmdb'
   and mi.tmdb_id is not null
   and mi.fetched_at <
       now() - (((select value #>> '{}' from app_config
                   where key = 'tmdb.metadata_max_age_days')::integer)
                * interval '1 day')
   and (   exists (select 1 from user_media  um where um.media_item_id = mi.id)
        or exists (select 1 from rankings    r  where r.media_item_id  = mi.id)
        or exists (select 1 from watchlist   w  where w.media_item_id  = mi.id)
        or exists (select 1 from list_items  li where li.media_item_id = mi.id)
        or exists (select 1 from media_items s  where s.parent_id      = mi.id));

comment on view media_refresh_due is
  'TMDB-derived rows past the retention window that a user collection still references. Drained by the tmdb-adapter refresh job, which runs as service_role. Filtered on provenance, so CC0 rows — which have no expiry — are never offered for refresh.';
