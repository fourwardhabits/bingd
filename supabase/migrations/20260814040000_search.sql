-- ---------------------------------------------------------------------------
-- Title search over the local catalogue
--
-- The first thing a user does is type a few letters and expect a film. Until now
-- media_items had a btree index on (title text_pattern_ops), which serves
-- `like 'Incep%'` and nothing else: not case-insensitive, not accent-insensitive, and
-- unable to match a word in the middle of a title. Searching "knight" would never find
-- The Dark Knight.
--
-- This adds three things: a fold, a search vector, and one RPC.
--
-- WHY NOT pg_trgm OR unaccent
--
-- Both would be the obvious tools and both are extensions. The test harness is PGlite,
-- which already cannot provide citext and shims it as plain text (see harness.mjs), so an
-- extension-based search would be exercised by nothing before it reached the hosted
-- database — and search is the one path every screen depends on. Full text search,
-- to_tsvector and GIN are Postgres core, present in both, so what CI runs is what
-- production runs.
--
-- WHY THE 'simple' CONFIGURATION, NOT 'english'
--
-- 'english' stems and drops stop words. Titles are mostly proper nouns, where stemming
-- earns little, and the stop-word list actively hurts: 'the' and 'of' are dropped, so
-- "The Office" indexes as one lexeme and a search for "the" produces an empty tsquery and
-- therefore no rows at all. 'simple' lower-cases and splits, which is what a title index
-- wants. Prefix matching does the work stemming would have.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The fold
--
-- Amélie has to be reachable by typing "amelie", and a viewer will not type the accent.
-- unaccent() does this properly, against a full Unicode transliteration table, and is an
-- extension; this is a fixed table covering the Latin alphabet, which is what the
-- catalogue contains.
--
-- Its limits, stated rather than discovered later: it folds Latin script only, so a
-- Cyrillic, Greek, Japanese or Arabic title is left as it stands and is reachable only by
-- typing it (Wikidata gives us English labels, so this does not bite today). Ligatures
-- lose their second letter — 'æ' becomes 'a', so "Æon Flux" answers to "aon" and not to
-- "aeon". Both are worth revisiting when unaccent is available on both sides.
--
-- IMMUTABLE is not decoration: it is what allows the expression index below to exist.
-- lower() and translate() are both immutable, so this genuinely is.
-- ---------------------------------------------------------------------------

create or replace function media_fold(p_text text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select translate(
           lower(coalesce(p_text, '')),
           'áàâäãåāæéèêëēíìîïīóòôöõøōœúùûüūñçćšśžźýÿđłß',
           'aaaaaaaaeeeeeiiiiioooooooouuuuunccsszzyydls'
         );
$$;

comment on function media_fold is
  'Lower-cases and strips Latin diacritics so a search for "amelie" finds "Amélie". A fixed table rather than unaccent(), which is an extension the PGlite test harness cannot load — see the header of 20260814040000. IMMUTABLE, which is what lets media_search be indexed.';

-- ---------------------------------------------------------------------------
-- 2. The search vector
--
-- Both titles go in. original_title is null throughout the Wikidata seed but the provider
-- adapter will fill it, and a viewer looking for "Sen to Chihiro" should find Spirited
-- Away without a second index arriving later to make it work.
-- ---------------------------------------------------------------------------

create or replace function media_search(p_title text, p_original_title text)
returns tsvector
language sql immutable parallel safe
set search_path = public
as $$
  select to_tsvector(
           'simple',
           media_fold(p_title) || ' ' || media_fold(p_original_title)
         );
$$;

comment on function media_search is
  'The indexed search vector for a media_items row. Folded and built with the simple configuration: no stemming and no stop words, so "The Office" stays findable by "the".';

-- The index this whole migration exists for. It must name the expression exactly as
-- search_titles calls it, or the planner will not use it.
create index media_items_search on media_items using gin (media_search(title, original_title));

-- ---------------------------------------------------------------------------
-- 3. search_titles
--
-- Films and series only. PRD §26.2 AC 1 is "movies and TV series", and a season is
-- reached from its series page (AC 2) — which is also the only place it makes sense, since
-- every season in the catalogue is titled "Season 3" and a screen full of those, stripped
-- of the show they belong to, would be useless. media_items is world-readable, so a client
-- lists a series' seasons directly and needs no RPC for it.
--
-- The tsquery is assembled here rather than handed to to_tsquery raw. to_tsquery has an
-- operator syntax — & | ! <-> and parentheses — and a user typing "Fast & Furious" would
-- otherwise get a syntax error, while a user typing something more deliberate would be
-- writing query operators. Splitting on non-alphanumerics and rebuilding makes that
-- impossible by construction rather than by escaping.
--
-- Every token gets :* so typing stops mattering: "dar kni" finds The Dark Knight. Tokens
-- are ANDed, because a second word is how a person narrows a search, not how they widen it.
-- ---------------------------------------------------------------------------

create or replace function search_titles(p_query text, p_limit integer default 20)
returns table (
  id           uuid,
  kind         media_kind,
  title        text,
  release_date date,
  poster_path  text,
  provenance   catalogue_provenance
)
language sql stable security definer
set search_path = public
as $$
  with folded as (
    -- Capped, because nothing good comes of a 4kB search box and every token costs an
    -- index probe.
    select media_fold(left(coalesce(p_query, ''), 100)) as text
  ),
  tokens as (
    select tok
      from folded, unnest(regexp_split_to_array(folded.text, '[^a-z0-9]+')) as t(tok)
     where tok <> ''
     limit 10
  ),
  q as (
    -- string_agg over no rows is null and to_tsquery is strict, so a blank or
    -- punctuation-only query yields a null tsquery and the join below returns nothing.
    -- An empty search returning the whole catalogue would be worse.
    select to_tsquery('simple', string_agg(tok || ':*', ' & ')) as ts,
           (select text from folded) as prefix
      from tokens
  )
  select mi.id, mi.kind, mi.title, mi.release_date, mi.poster_path, mi.provenance
    from media_items mi, q
   where q.ts is not null
     and mi.kind in ('movie', 'series')
     and media_search(mi.title, mi.original_title) @@ q.ts
   -- A title that starts with what was typed comes first, because that is almost always
   -- the one being looked for: "her" should offer Her before The Butcher's Wife.
   -- starts_with() rather than like, so % and _ in the query are not pattern operators.
   order by starts_with(media_fold(mi.title), q.prefix) desc,
            ts_rank(media_search(mi.title, mi.original_title), q.ts) desc,
            -- Null throughout the seed; the adapter fills it and this starts working.
            mi.popularity desc nulls last,
            mi.release_date desc nulls last,
            -- Title then id, so the order is total. Two rows tying on everything above
            -- would otherwise swap between calls, which makes pagination lie.
            mi.title,
            mi.id
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

comment on function search_titles is
  'Prefix-and-token search over the local catalogue, films and series only. Signed-in callers only, per PRD §26.2 AC 1. Seasons are reached from the series page, not from search.';

-- ---------------------------------------------------------------------------
-- 4. Privileges
--
-- Postgres grants EXECUTE on a new function to PUBLIC, so creating one is enough to
-- publish it. The revoke is therefore not tidying — it is the thing that keeps media_fold
-- and media_search internal. Only search_titles is granted, and only to authenticated:
-- 20260813001800's allow-list is authoritative, and function-grants.test.mjs fails on any
-- function reachable by a client role that is not named in it.
-- ---------------------------------------------------------------------------

revoke execute on function media_fold(text) from public, anon, authenticated;
revoke execute on function media_search(text, text) from public, anon, authenticated;
revoke execute on function search_titles(text, integer) from public, anon, authenticated;

grant execute on function search_titles(text, integer) to authenticated;
