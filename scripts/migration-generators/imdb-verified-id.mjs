// Generates supabase/migrations/20261118000100_a_verified_imdb_id_outweighs_a_display_title.sql.
//
// The two functions that re-check an IMDb identity are copied VERBATIM from
// 20261113000100 (the migration that last defined them) and changed only through `edit`,
// which throws unless each anchor occurs exactly once. So the diff against the applied
// definition is exactly the edits listed here, and the Letterboxd branch of
// _import_provider_resolve is unchanged by construction.
//
// Usage: node scripts/migration-generators/imdb-verified-id.mjs  (rewrites the migration;
// the committed file must be byte-identical to what this writes).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { edit, fn, MIG } from './extract.mjs';

const SOURCE = '20261113000100_an_import_from_more_than_one_place.sql';
const OUT = join(MIG, '20261118000100_a_verified_imdb_id_outweighs_a_display_title.sql');

// ---------------------------------------------------------------------------------------
// Tier 1: a catalogue title carrying the tt id was written there by a /find answer, so it
// is held to the verified rule (kind and year), not the title rule.
// ---------------------------------------------------------------------------------------
const tier1 = edit(
  fn(SOURCE, '_import_match_batch_imdb'),
  [
    [
      `  -- for this exact tt id. Its kind must be the one the IMDb type implies and its title and
  -- year must agree with the row's own. Anything else -- no title, two titles, a different
  -- kind -- is not settled here:`,
      `  -- for this exact tt id. Its kind must be the one the IMDb type implies and its year must
  -- agree with the row's own (20261118000100: the mapping is TMDB's own /find answer, so a
  -- display-title difference is not a contradiction; _import_imdb_verified_agrees).
  -- Anything else -- no title, two titles, a different kind -- is not settled here:`,
    ],
    [
      `  --   a different kind, or disagree   unmatched: the id is TMDB-confirmed, so asking TMDB
  --                                   again would return the same title`,
      `  --   a different kind, or a year     unmatched: the id is TMDB-confirmed, so asking TMDB
  --   out of tolerance                again would return the same title`,
    ],
    [
      `             when not _import_imdb_identity_agrees(l.only_id, l.name, l.original, l.year) then null`,
      `             when not _import_imdb_verified_agrees(l.only_id, l.expected, l.year) then null`,
    ],
    [
      `             when not _import_imdb_identity_agrees(l.only_id, l.name, l.original, l.year)
               then 'unmatched'`,
      `             when not _import_imdb_verified_agrees(l.only_id, l.expected, l.year)
               then 'unmatched'`,
    ],
  ],
  '_import_match_batch_imdb',
);

// ---------------------------------------------------------------------------------------
// The provider re-check. 20261113000100 defined it with `create function` after a drop;
// the signature is unchanged here, so `create or replace` keeps its ACL.
// ---------------------------------------------------------------------------------------
const sourceText = readFileSync(join(MIG, SOURCE), 'utf8');
const resolveStart = sourceText.indexOf('create function _import_provider_resolve(');
if (resolveStart < 0) throw new Error('_import_provider_resolve not in source');
const resolveEnd = sourceText.indexOf('\n$$;', resolveStart);
const resolveSrc = sourceText.slice(resolveStart, resolveEnd + 4);

const resolve = edit(
  resolveSrc,
  [
    [
      'create function _import_provider_resolve(',
      'create or replace function _import_provider_resolve(',
    ],
    [
      `  -- 20261113000100. An IMDb row. The Edge Function's answer is checked again here rather
  -- than trusted: the destination type must be what the IMDb type implies (IMDb's type
  -- is matching evidence, never a reclassification), and the title and year must agree.
  -- A disagreement settles the row unmatched: asking again would get the same answer.`,
      `  -- 20261113000100. An IMDb row. The Edge Function's answer is checked again here rather
  -- than trusted: the destination type must be what the IMDb type implies (IMDb's type
  -- is matching evidence, never a reclassification), and the year must agree.
  -- A disagreement settles the row unmatched: asking again would get the same answer.
  --
  -- 20261118000100. WHICH rule depends on what the answer is. A /find answer for this
  -- row's own tt id (p_imdb_id = the row's id) is TMDB's mapping, and is held to kind and
  -- year only (_import_imdb_verified_agrees), exactly as the Edge Function's
  -- verifiedIdentityAgrees holds it, so neither side rejects what the other accepted. A
  -- title-search answer proves nothing about the id and keeps the title rule
  -- (_import_imdb_identity_agrees), which accepts every title the Edge Function's strict
  -- pick and pickOriginal can choose.`,
    ],
    [
      `      if v_kind is null or v_expected is null or v_kind <> v_expected
         or not _import_imdb_identity_agrees(p_media_item_id, v_name, v_original, v_year)
      then`,
      `      if v_kind is null or v_expected is null or v_kind <> v_expected
         or not (case
                   when p_imdb_id is not null and p_imdb_id = v_tt
                     then _import_imdb_verified_agrees(p_media_item_id, v_expected, v_year)
                   else _import_imdb_identity_agrees(p_media_item_id, v_name, v_original, v_year)
                 end)
      then`,
    ],
  ],
  '_import_provider_resolve',
);

const migration = `-- A verified IMDb id outweighs a display title (founder QA, 2026-11-12; spec §3 P0).
--
-- The founder's own IMDb import ended nine titles in "Couldn't match" whose right film was
-- one tt id away: IMDb "Harry Potter and the Sorcerer's Stone" is TMDB 671 "Harry Potter
-- and the Philosopher's Stone"; IMDb "Star Wars: Episode VII - The Force Awakens" is TMDB
-- 140607 "Star Wars: The Force Awakens". TMDB's own /find for the exact id names the right
-- title, and every IMDb tier then required a squashed display title in common
-- (_import_imdb_identity_agrees), so a regional title, a franchise prefix or subtitle, "&"
-- for "and", or a show the two catalogues name differently was refused as a conflict.
--
-- The rule now, in the Edge Function (match.mjs verifiedIdentityAgrees) and here alike:
--
--   A /find answer, or a catalogue title carrying the id (which only a /find answer ever
--   writes), is the title when it is the one title of the kind the IMDb type implies and
--   its release year is within one of IMDb's. The display title is not consulted.
--
--   Still vetoes: the other kind (never a reclassification), two titles claiming one id
--   (ambiguous), an episode or season (unsupported), a year out of tolerance (unmatched).
--
--   A title search still proves nothing about the id, keeps the title rule, never writes
--   the id, and never chooses by popularity.
--
-- Changed, and nothing else:
--   _import_imdb_verified_agrees   new; service internals only, like its siblings
--   _import_match_batch_imdb       Tier 1 calls it instead of the title rule
--   _import_provider_resolve       the IMDb branch calls it for a /find answer; the
--                                  Letterboxd branch is byte-for-byte what it was
--
-- Both functions are copied verbatim from 20261113000100 and changed only through the
-- single-occurrence edits in scripts/migration-generators/imdb-verified-id.mjs. No
-- applied migration is edited. Signatures are unchanged, so \`create or replace\` keeps
-- every ACL; the grants are restated so the file says what it means.
--
-- Version 20261118000100: 20261116* is #275's and 20261117* is #278's.

create or replace function _import_imdb_verified_agrees(
  p_media_item_id uuid,
  p_expected      media_kind,
  p_year          integer
)
returns boolean
language sql
stable
set search_path = public
as $$
  -- The media item is of the kind the IMDb type implies, and its release year is within
  -- one of the row's where both are known. The title is deliberately not read: this is
  -- the test for a title TMDB itself mapped to the row's tt id. Mirrors
  -- verifiedIdentityAgrees (supabase/functions/letterboxd-import/match.mjs).
  select exists (
    select 1
      from media_items mi
     where mi.id = p_media_item_id
       and p_expected is not null
       and mi.kind = p_expected
       and (p_year is null or mi.release_date is null
            or abs(extract(year from mi.release_date)::integer - p_year) <= 1)
  );
$$;
comment on function _import_imdb_verified_agrees(uuid, media_kind, integer) is
  'Whether a media item TMDB mapped to an IMDb row''s own tt id (a /find answer, or media_items.imdb_id, which only a /find answer writes) is that row''s title: the expected kind, and release years within one where both are known. The display title is not consulted: a verified id outweighs a regional, franchise or translated title (20261118000100). Mirrored by verifiedIdentityAgrees in match.mjs.';
revoke execute on function _import_imdb_verified_agrees(uuid, media_kind, integer) from public, anon, authenticated;

comment on function _import_imdb_identity_agrees(uuid, text, text, integer) is
  'Whether a media item is plausibly the title an IMDb row names: a squashed title or original title in common, and release years within one where both are known. Since 20261118000100 the test for a TITLE-SEARCH answer only; a /find answer and a catalogue title carrying the id are held to _import_imdb_verified_agrees.';

${tier1}
comment on function _import_match_batch_imdb(uuid, integer) is
  'One bounded slice of local matching for an IMDb job: the tt id against media_items.imdb_id, with the IMDb type''s kind and the row''s year checked (_import_imdb_verified_agrees; the display title is not, since 20261118000100). Unsupported types settle here without a provider request. Never writes a mapping. Internal; reached only through _import_match_batch.';
revoke execute on function _import_match_batch_imdb(uuid, integer) from public, anon, authenticated;

${resolve}
revoke execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function _import_provider_resolve(uuid, uuid, boolean, text, boolean) to service_role;
`;

writeFileSync(OUT, migration);
console.log('wrote', OUT, migration.length, 'chars');
