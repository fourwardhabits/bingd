-- ---------------------------------------------------------------------------
-- Search across punctuation: "Spiderman" has to find "Spider-Man"
--
-- THE FAILURE
--
-- to_tsvector('simple', 'spider-man') emits three lexemes: 'spider-man',
-- 'spider' and 'man'. A user typing "Spiderman" produces the single token
-- 'spiderman:*', which is a prefix of none of them, so the search returns
-- nothing at all -- and a user whose search for a Spider-Man film comes back
-- empty concludes the catalogue is small, not that they typed a hyphen wrong.
--
-- It runs the other way too. A title stored as "Spiderman" indexes as one
-- lexeme, and a user typing "spider man" produces 'spider:* & man:*'. The first
-- prefix-matches; the second does not; the AND fails.
--
-- Titles are full of punctuation nobody types the same way twice: hyphens,
-- colons, ampersands, apostrophes, periods in initials.
--
-- WHY NOT pg_trgm
--
-- Same reason as 20260814040000: it is an extension, the test harness is PGlite
-- and cannot load one, and search is the path every screen depends on. What CI
-- runs has to be what production runs. This is core Postgres.
--
-- THE FIX, IN TWO HALVES
--
-- Index side: each title also indexes a *squashed* form with every
-- non-alphanumeric removed outright rather than replaced by a space, so
-- "Spider-Man" additionally indexes as 'spiderman'. That alone handles every
-- single-token query, which is the common case.
--
-- Query side: when the user typed more than one token, their tokens are also
-- concatenated and ORed in, so "spider man" searches
-- (spider:* & man:*) | spiderman:*. One token needs no such treatment -- the
-- index side already covers it -- and adding one anyway would widen every
-- search for no gain.
--
-- The OR is the part to be careful about, because it widens rather than
-- narrows, which is the opposite of what a second word should do. It is
-- bounded by requiring two tokens: with one, the concatenation *is* the token
-- and the branch is redundant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The squashed form
--
-- Distinct from media_sort_key, which collapses punctuation to a single space.
-- Both are needed and they are not interchangeable: the spaced form is what
-- makes "spider man no way home" recognisable as naming a title exactly, and
-- the squashed form is what makes "spiderman" find it at all.
-- ---------------------------------------------------------------------------

create or replace function media_squash(p_text text)
returns text
language sql immutable parallel safe
set search_path = public
as $$
  select regexp_replace(media_fold(p_text), '[^[:alnum:]]+', '', 'g');
$$;

comment on function media_squash is
  'The folded title with all punctuation and spacing removed, so "Spider-Man" and "Spiderman" reduce to the same string. Distinct from media_sort_key, which collapses to spaces instead — see 20260815020000.';

-- ---------------------------------------------------------------------------
-- 2. Rebuilding the generated columns
--
-- The order here is load-bearing, and getting it wrong is silent.
--
-- A stored generated column holds a *value*, not a rule that re-runs. Replacing
-- media_search would leave every existing row carrying the vector the old
-- definition produced, so new titles would be findable by the squashed form and
-- the entire back catalogue would not -- with nothing failing anywhere to say
-- so. The column has to be dropped and re-added, which is what forces the
-- rewrite.
--
-- Dropping it first also avoids replacing a function that a generated column
-- still depends on, which Postgres permits and should not.
--
-- Dropping the column drops media_items_search with it; both are recreated
-- below.
-- ---------------------------------------------------------------------------

alter table media_items drop column search_vec;

create or replace function media_search(p_title text, p_original_title text)
returns tsvector
language sql immutable parallel safe
set search_path = public
as $$
  select to_tsvector(
           'simple',
           concat_ws(
             ' ',
             media_fold(p_title),
             media_fold(p_original_title),
             media_squash(p_title),
             media_squash(p_original_title)
           )
         );
$$;

comment on function media_search is
  'The stored search vector for a media_items row: both titles, each in a folded form and a squashed no-punctuation form. Built with the simple configuration — no stemming and no stop words, so "The Office" stays findable by "the".';

alter table media_items
  add column search_vec tsvector generated always as (media_search(title, original_title)) stored;

create index media_items_search on media_items using gin (search_vec);

-- The squashed sort key exists for *ordering*, not matching.
--
-- Without it the fix would find the right film and then bury it. Someone typing
-- "spiderman" exactly names a title whose sort_key is "spider man", so neither
-- the exact-title tier nor the prefix tier in search_titles would fire, and the
-- film they named would sort below whatever ts_rank happened to prefer.
alter table media_items
  add column sort_key_squashed text generated always as (media_squash(title)) stored;

create index media_items_sort_key_squashed on media_items (sort_key_squashed text_pattern_ops);

-- ---------------------------------------------------------------------------
-- 3. search_titles
--
-- Recreated whole. Everything outside the `q` CTE and the first two ORDER BY
-- tiers is carried forward verbatim from 20260814040000 §3, including the
-- reasoning encoded in the remaining tiers.
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
language sql stable security invoker
set search_path = public
as $$
  with folded as (
    -- Capped, because nothing good comes of a 4kB search box and every token
    -- costs an index probe.
    select media_fold(left(coalesce(p_query, ''), 100)) as text
  ),
  tokens as (
    select tok
      from folded, unnest(regexp_split_to_array(folded.text, '[^[:alnum:]]+')) as t(tok)
     where tok <> ''
  ),
  q as (
    select
      to_tsquery(
        'simple',
        case
          -- Two or more tokens: also try them run together, which is the only
          -- direction the index side cannot cover. Parenthesised, because
          -- to_tsquery binds & tighter than | and the AND branch has to stay
          -- one unit.
          when count(*) > 1 then
            '(' || string_agg(tok || ':*', ' & ') || ') | '
                || string_agg(tok, '') || ':*'
          else string_agg(tok || ':*', ' & ')
        end
      ) as ts,
      -- string_agg over no rows is null and to_tsquery is strict, so a blank or
      -- punctuation-only query yields a null tsquery and the join below returns
      -- nothing. An empty search returning the whole catalogue would be worse.
      --
      -- Both prefixes are rebuilt from the tokens rather than taken from the
      -- raw query, so that typing the space before the next word does not turn
      -- the ordering boost off.
      string_agg(tok, ' ') as prefix,
      string_agg(tok, '')  as squashed
      from tokens
  )
  select mi.id, mi.kind, mi.title, mi.release_date, mi.poster_path, mi.provenance
    from media_items mi, q
   where q.ts is not null
     and mi.kind in ('movie', 'series')
     and mi.search_vec @@ q.ts
   -- Typing a film's whole name puts that film first, whether or not the
   -- punctuation was typed. Without this tier the tiebreak below is release
   -- date, which systematically prefers the sequel: "the dark knight" led with
   -- The Dark Knight Rises, and "alien" with Aliens.
   order by (mi.sort_key = q.prefix or mi.sort_key_squashed = q.squashed) desc,
            -- Then a title that starts with what was typed, because that is
            -- almost always the one being looked for: "her" should offer Her
            -- before The Butcher's Wife.
            (starts_with(mi.sort_key, q.prefix)
               or starts_with(mi.sort_key_squashed, q.squashed)) desc,
            ts_rank(mi.search_vec, q.ts) desc,
            -- Null throughout the seed; the adapter fills it and this starts working.
            mi.popularity desc nulls last,
            -- How much of the title the query accounts for. ts_rank does not
            -- normalise for length, so "dark knight" ties The Dark Knight with
            -- The Dark Knight Rises exactly, and the words the user typed are a
            -- larger share of the shorter one.
            char_length(mi.sort_key),
            mi.release_date desc nulls last,
            -- Title then id, so the order is total. Two rows tying on
            -- everything above would otherwise be free to swap, which makes
            -- pagination lie — and the catalogue really does contain two films
            -- called Dune.
            mi.title,
            mi.id
   limit least(greatest(coalesce(p_limit, 20), 0), 50);
$$;

comment on function search_titles is
  'Prefix-and-token search over the local catalogue, films and series only, matching across punctuation in both directions. Signed-in callers only, per PRD §26.2 AC 1. Seasons are reached from the series page, not from search.';

-- ---------------------------------------------------------------------------
-- 4. Privileges
--
-- media_squash is reachable by nobody. Unlike media_fold it is never called by
-- search_titles at runtime — it appears only inside generated columns, which
-- are evaluated by the table's owner — so there is nothing for a client role to
-- need it for.
-- ---------------------------------------------------------------------------

revoke execute on function media_squash(text) from public, anon, authenticated;
revoke execute on function media_search(text, text) from public, anon, authenticated;
revoke execute on function search_titles(text, integer) from public, anon, authenticated;

grant execute on function search_titles(text, integer) to authenticated;
