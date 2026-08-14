-- ---------------------------------------------------------------------------
-- Title search over the local catalogue
--
-- The first thing a user does is type a few letters and expect a film. Until now
-- media_items had a btree index on (title text_pattern_ops), which serves
-- `like 'Incep%'` and nothing else: not case-insensitive, not accent-insensitive, and
-- unable to match a word in the middle of a title. Searching "knight" would never find
-- The Dark Knight.
--
-- This adds a fold, two stored columns, and one RPC.
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
--
-- WHY STORED COLUMNS RATHER THAN AN EXPRESSION INDEX
--
-- The first draft indexed `media_search(title, original_title)` as an expression and had
-- the function repeat that expression in its WHERE and again in its ORDER BY. Two problems,
-- both found by review rather than by the tests:
--
--   The ORDER BY recomputed the vector for every row the index returned, which was 96% of
--   the query's cost. Grown to 100k rows a one-letter query took 7.6 seconds, and
--   search-as-you-type generates a one-letter query on every first keystroke.
--
--   The function's copy of the expression could drift from the index's. Results would stay
--   correct while the index quietly stopped being used, and a test asserting the plan of a
--   hand-written query — rather than of the function — would not notice.
--
-- Generated columns fix both at once. There is one expression, in one place, and ranking
-- reads a column instead of computing anything. Drift is not a thing that can happen.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The fold
--
-- Amélie has to be reachable by typing "amelie", and a viewer will not type the accent.
-- unaccent() does this properly, against a full Unicode transliteration table, and is an
-- extension; this is a fixed table covering the Latin alphabet, which is what the
-- catalogue contains.
--
-- normalize(..., NFC) first, because "é" can arrive as one code point or as "e" followed by
-- a combining acute, and the two are indistinguishable on screen. Without this, a title
-- pasted from one source and a query typed on a keyboard that produces the other form
-- would not match, for no reason a user could ever see.
--
-- Its limits, stated rather than discovered later: it folds Latin script only. A Cyrillic,
-- Greek or Japanese title keeps its own characters — which is fine, because the tokenizer
-- in §3 is Unicode-aware and the query side is folded by this same function, so both sides
-- agree and the title is reachable by typing it. Ligatures lose their second letter: 'æ'
-- becomes 'a', so "Æon Flux" answers to "aon" and not to "aeon", and 'ß' becomes one 's'.
--
-- IMMUTABLE is not decoration: it is what allows the generated columns below to exist.
-- lower(), translate() and normalize() are all immutable, so this genuinely is.
-- ---------------------------------------------------------------------------

create or replace function media_fold(p_text text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select translate(
           lower(normalize(coalesce(p_text, ''), NFC)),
           'áàâäãåāąăæçćčđďðéèêëēęěğíìîïīıłľñńňóòôöõøōőœřšśşßťțþúùûüūůűýÿžźż',
           'aaaaaaaaaacccdddeeeeeeegiiiiiillnnnooooooooorsssstttuuuuuuuyyzzz'
         );
$$;

comment on function media_fold is
  'Lower-cases, composes to NFC, and strips Latin diacritics so a search for "amelie" finds "Amélie". A fixed table rather than unaccent(), which is an extension the PGlite test harness cannot load — see the header of 20260814040000. IMMUTABLE, which is what lets the generated columns be generated.';

-- ---------------------------------------------------------------------------
-- 2. What gets indexed
--
-- Both titles go into the vector. original_title is null throughout the Wikidata seed but
-- the provider adapter will fill it, and a viewer looking for "Los Otros" should find The
-- Others without a second index arriving later to make it work.
--
-- media_sort_key is the folded title with every run of non-alphanumerics collapsed to a
-- single space. It is what the ordering compares against, and it has to be built the same
-- way the query is: "Spider-Man: No Way Home" typed as "spider man no way home" should
-- count as naming that film exactly, and it only does if the hyphen and the colon are
-- treated the same on both sides.
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
  'The stored search vector for a media_items row. Folded and built with the simple configuration: no stemming and no stop words, so "The Office" stays findable by "the".';

create or replace function media_sort_key(p_title text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select btrim(regexp_replace(media_fold(p_title), '[^[:alnum:]]+', ' ', 'g'));
$$;

comment on function media_sort_key is
  'The folded title reduced to words separated by single spaces, so that a query typed without punctuation can still be recognised as naming a title exactly.';

alter table media_items
  add column search_vec tsvector generated always as (media_search(title, original_title)) stored,
  add column sort_key   text     generated always as (media_sort_key(title))               stored;

create index media_items_search on media_items using gin (search_vec);

-- Serves the leading sort keys: an exact name, then a prefix of one.
create index media_items_sort_key on media_items (sort_key text_pattern_ops);

-- ---------------------------------------------------------------------------
-- 3. search_titles
--
-- Films and series only. PRD §26.2 AC 1 is "movies and TV series", and a season is
-- reached from its series page (AC 2) — which is also the only place it makes sense, since
-- a season is titled "Season 4" and a screen full of bare ordinals, stripped of the shows
-- they belong to, would be useless. media_items is world-readable, so a client lists a
-- series' seasons directly and needs no RPC for it. PRD §8's v1 scope line does say
-- "movie, series, and season search", which contradicts §26.2; recorded in open questions
-- rather than settled here.
--
-- The tsquery is assembled here rather than handed to to_tsquery raw. to_tsquery has an
-- operator syntax — & | ! <-> and parentheses — and a user typing "Fast & Furious" would
-- otherwise get a syntax error, while a user typing something more deliberate would be
-- writing query operators. Splitting on non-alphanumerics and rebuilding makes that
-- impossible by construction rather than by escaping.
--
-- The split is [^[:alnum:]]+ and not [^a-z0-9]+. The ASCII form silently deleted every
-- character the fold does not cover, so a Cyrillic or Japanese title was unreachable even
-- when typed exactly, and "Čapek" was searched for as "apek" — a different word, which is
-- worse than finding nothing.
--
-- Every token gets :* so typing stops mattering: "dar kni" finds The Dark Knight. Tokens
-- are ANDed, because a second word is how a person narrows a search, not how they widen it.
-- There is no cap on the number of tokens: an earlier draft kept the first ten and dropped
-- the rest, which meant the eleventh word widened the search instead of narrowing it, and
-- "The Lord of the Rings: The Fellowship of the Ring" is already ten. The 100-character cap
-- bounds the work instead, and it bounds it honestly, because a truncated query is a
-- prefix of what was typed rather than a different query.
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
-- security invoker, unlike the other read RPCs. media_items is world-readable, so this
-- needs no elevated rights, and a definer function would silently keep returning rows if a
-- future policy ever hid some.
language sql stable security invoker
set search_path = public
as $$
  with folded as (
    -- Capped, because nothing good comes of a 4kB search box and every token costs an
    -- index probe.
    select media_fold(left(coalesce(p_query, ''), 100)) as text
  ),
  tokens as (
    select tok
      from folded, unnest(regexp_split_to_array(folded.text, '[^[:alnum:]]+')) as t(tok)
     where tok <> ''
  ),
  q as (
    -- string_agg over no rows is null and to_tsquery is strict, so a blank or
    -- punctuation-only query yields a null tsquery and the join below returns nothing.
    -- An empty search returning the whole catalogue would be worse.
    --
    -- The prefix is rebuilt from the tokens rather than taken from the raw query, so that
    -- typing the space before the next word does not turn the ordering boost off.
    select to_tsquery('simple', string_agg(tok || ':*', ' & ')) as ts,
           string_agg(tok, ' ')                                 as prefix
      from tokens
  )
  select mi.id, mi.kind, mi.title, mi.release_date, mi.poster_path, mi.provenance
    from media_items mi, q
   where q.ts is not null
     and mi.kind in ('movie', 'series')
     and mi.search_vec @@ q.ts
   -- Typing a film's whole name puts that film first. Without this tier the tiebreak below
   -- is release date, which systematically prefers the sequel: "the dark knight" led with
   -- The Dark Knight Rises, and "alien" with Aliens.
   order by (mi.sort_key = q.prefix) desc,
            -- Then a title that starts with what was typed, because that is almost always
            -- the one being looked for: "her" should offer Her before The Butcher's Wife.
            starts_with(mi.sort_key, q.prefix) desc,
            ts_rank(mi.search_vec, q.ts) desc,
            -- Null throughout the seed; the adapter fills it and this starts working.
            mi.popularity desc nulls last,
            -- How much of the title the query accounts for. ts_rank does not normalise for
            -- length, so "dark knight" ties The Dark Knight with The Dark Knight Rises
            -- exactly, and the words the user typed are a larger share of the shorter one.
            char_length(mi.sort_key),
            mi.release_date desc nulls last,
            -- Title then id, so the order is total. Two rows tying on everything above
            -- would otherwise be free to swap, which makes pagination lie — and the
            -- catalogue really does contain two films called Dune.
            mi.title,
            mi.id
   -- Floor of zero, not one: a caller asking for no rows means it. The cap is the reason
   -- the ordering work above stays bounded.
   limit least(greatest(coalesce(p_limit, 20), 0), 50);
$$;

comment on function search_titles is
  'Prefix-and-token search over the local catalogue, films and series only. Signed-in callers only, per PRD §26.2 AC 1. Seasons are reached from the series page, not from search.';

-- ---------------------------------------------------------------------------
-- 4. Privileges
--
-- 20260813001800 and 20260813002100 revoke EXECUTE by default for functions created by
-- this role, so these revokes are belt and braces rather than the thing standing between a
-- client and media_search. What is authoritative is the allow-list: function-grants.test.mjs
-- fails on any function reachable by a client role that is not named in it, which is the
-- check that survives someone creating a function as a different owner.
--
-- media_fold is granted, which the other two are not. That is the price of search_titles
-- running as the caller: it folds the query text, and a security invoker function cannot
-- call something the caller may not. The price is small — it is a pure function of a
-- string, returning a folded copy of what was handed to it, and it knows nothing about
-- anybody. The alternative was inlining the fold table into search_titles, which would put
-- a second copy of it in the tree for the two to disagree about.
--
-- search_titles is granted to authenticated only, per PRD §26.2 AC 1. That is a product
-- rule and not a privacy measure: anon can already read the whole catalogue through
-- PostgREST, because catalogue metadata is not user data.
-- ---------------------------------------------------------------------------

revoke execute on function media_fold(text) from public, anon;
revoke execute on function media_search(text, text) from public, anon, authenticated;
revoke execute on function media_sort_key(text) from public, anon, authenticated;
revoke execute on function search_titles(text, integer) from public, anon, authenticated;

grant execute on function media_fold(text)              to authenticated;
grant execute on function search_titles(text, integer)  to authenticated;
