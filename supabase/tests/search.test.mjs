import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createTestDb } from './harness.mjs';

/**
 * search_titles.
 *
 * Tested against the seeded catalogue rather than against fixtures, because the failures
 * worth catching are about real titles: a stop word in "The Office", an accent in
 * "Amélie", a word in the middle of "The Dark Knight". A fixture called 'Test Movie'
 * would pass every one of them and prove nothing.
 *
 * Several of these assertions pass under a plain `like 'query%'` and several do not. The
 * ones that do not are the reason this migration exists, and they say so.
 */
describe('search_titles', () => {
  let t;
  let alice;

  before(async () => {
    t = await createTestDb();
    alice = await t.createUser({ username: 'alice' });
  });

  after(async () => t.close());

  /** Titles only, in the order the function returned them. */
  const search = async (query, limit) => {
    const { rows } = await t.sql(
      limit === undefined
        ? `select title, kind from search_titles($1)`
        : `select title, kind from search_titles($1, $2)`,
      limit === undefined ? [query] : [query, limit],
    );
    return rows.map((r) => r.title);
  };

  it('finds a film by a prefix of its title', async () => {
    assert.ok((await search('incep')).includes('Inception'));
  });

  it('finds a film by a word that is not at the start', async () => {
    // The case the old (title text_pattern_ops) index could not serve at all: it
    // supported `like 'Dark%'` and nothing else, so "knight" found nothing.
    assert.ok((await search('knight')).includes('The Dark Knight'));
  });

  it('ignores case', async () => {
    assert.ok((await search('INCEPTION')).includes('Inception'));
    assert.ok((await search('iNcEpTiOn')).includes('Inception'));
  });

  it('finds an accented title from unaccented typing', async () => {
    // Nobody types the é, and the fold is the only reason this works without unaccent.
    assert.ok((await search('amelie')).includes('Amélie'));
  });

  it('narrows as more words are typed, rather than widening', async () => {
    const dark = await search('dark');
    const both = await search('dark knight');

    assert.ok(both.includes('The Dark Knight'));
    assert.ok(both.length <= dark.length, 'a second word must narrow the result');
    assert.ok(
      both.every((title) => /dark/i.test(title) && /knight/i.test(title)),
      'every result must contain both words, not either',
    );
  });

  it('matches a partial word in each position, so typing can stop anywhere', async () => {
    assert.ok((await search('dar kni')).includes('The Dark Knight'));
  });

  it('puts a title that starts with the query first', async () => {
    // "man" matches Ant-Man and Man of Steel at exactly the same rank, and neither is an
    // exact name, so the prefix boost is the only thing deciding. The previous version of
    // this test used "her", where the boost changes nothing because Her is an exact name
    // and the shortest match — it passed with the boost deleted.
    assert.equal((await search('man'))[0], 'Man of Steel');
  });

  it('is not defeated by a stop word', async () => {
    // The reason for the 'simple' configuration. Under 'english', 'the' is a stop word:
    // to_tsquery drops it, the query becomes empty, and this returns nothing.
    const results = await search('the');
    assert.ok(results.length > 0, 'searching "the" must return something');
    assert.ok(
      results.some((title) => /^the /i.test(title)),
      'and should favour titles that begin with it',
    );
  });

  it('returns nothing for a blank or punctuation-only query', async () => {
    // An empty search box returning the whole catalogue is worse than returning nothing.
    for (const query of ['', '   ', '...', '&', null]) {
      assert.deepEqual(await search(query), [], `query ${JSON.stringify(query)}`);
    }
  });

  it('treats tsquery operators as text rather than as syntax', async () => {
    // to_tsquery would raise a syntax error on every one of these. Splitting on
    // non-alphanumerics means they cannot reach it.
    for (const query of ['fast & furious', 'star | wars', '!alien', 'a <-> b', '(inception)']) {
      await assert.doesNotReject(() => search(query), `query ${JSON.stringify(query)}`);
    }
    assert.ok((await search('fast & furious')).some((title) => /furious/i.test(title)));
  });

  it('returns films and series but never a season', async () => {
    // PRD §26.2 AC 1 is movies and series; a season is reached from its series page. A
    // season is titled "Season 4" and a screen of bare ordinals, stripped of the shows they
    // belong to, would be useless.
    const { rows } = await t.sql(`select kind from search_titles('season', 50)`);
    assert.equal(
      rows.filter((r) => r.kind === 'season').length,
      0,
      'a search for the word "season" must still not return season rows',
    );
  });

  it('leads with the film whose whole name was typed, not with its sequel', async () => {
    // Both are prefix matches and both tie on ts_rank exactly, so the tiebreak decides —
    // and the tiebreak is release date, which prefers the sequel every time. Before the
    // exact-name tier, typing the complete title of The Dark Knight led with The Dark
    // Knight Rises, and "alien" led with Aliens.
    assert.equal((await search('the dark knight'))[0], 'The Dark Knight');
    assert.equal((await search('dark knight'))[0], 'The Dark Knight');
    assert.equal((await search('alien'))[0], 'Alien');
  });

  it('recognises a name typed without its punctuation', async () => {
    // The stored sort key collapses punctuation, so what the user types can match what the
    // catalogue holds. Without that, only the query side is normalised and the two never
    // meet.
    const { rows } = await t.sql(
      `select title from media_items where sort_key = media_sort_key(title) and title like '%: %' limit 1`,
    );
    if (rows.length === 0) return;

    const spoken = rows[0].title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    assert.equal((await search(spoken))[0], rows[0].title);
  });

  describe('punctuation the user did not type', () => {
    // 20260815020000. Before it, "Spiderman" returned nothing at all: the
    // catalogue holds "Spider-Man", which indexes as 'spider-man', 'spider' and
    // 'man', and 'spiderman:*' is a prefix of none of the three.
    it('finds a hyphenated title typed as one word', async () => {
      const results = await search('spiderman');
      assert.ok(results.length > 0, '"spiderman" must not come back empty');
      assert.ok(results.includes('Spider-Man'), `got ${JSON.stringify(results.slice(0, 5))}`);
    });

    it('leads with the film whose name was typed, punctuation or not', async () => {
      // Finding it is half the job. Without the squashed sort key this returned
      // Spider-Man 2 or Homecoming first, because the exact-title tier compares
      // against the spaced sort key and "spiderman" is not "spider man".
      assert.equal((await search('spiderman'))[0], 'Spider-Man');
      assert.equal((await search('spider man'))[0], 'Spider-Man');
      assert.equal((await search('Spider-Man'))[0], 'Spider-Man');
    });

    it('still narrows when the rest of the name follows', async () => {
      assert.equal((await search('spiderman no way home'))[0], 'Spider-Man: No Way Home');
      assert.equal((await search('spider man homecoming'))[0], 'Spider-Man: Homecoming');
    });

    it('matches across a period in an abbreviation', async () => {
      assert.ok((await search('dr no')).includes('Dr. No'));
      assert.ok((await search('drno')).includes('Dr. No'));
    });

    it('matches across an apostrophe, typographic or typed', async () => {
      // The catalogue holds both spellings of the apostrophe — Life of Brian has
      // the typographic ’ and Flying Circus the ASCII ' — and neither survives
      // the squash, so one query has to reach both.
      const results = await search('montypythons');
      assert.equal(results.length, 2, `got ${JSON.stringify(results)}`);
      assert.ok(results.every((title) => title.startsWith('Monty Python')));
    });

    it('does not let the squashed branch widen a single-token search', async () => {
      // The concatenation is ORed in, which widens rather than narrows, so it is
      // only added when there are two or more tokens. With one token the
      // concatenation *is* the token and adding it would change nothing except
      // to make the query harder to read.
      const wide = await search('the');
      const narrow = await search('the dark knight');
      assert.ok(narrow.length < wide.length, 'more words must still mean fewer results');
      assert.equal(narrow[0], 'The Dark Knight');
    });
  });

  it('keeps the prefix boost when the user types the space before the next word', async () => {
    // The boost used to compare against the raw query text, so "man " — which is what a
    // person types on the way to a second word — matched no title at all and turned the
    // boost off for every row, mid-sentence.
    for (const query of ['man ', ' man', 'man.', '  man  ']) {
      assert.equal((await search(query))[0], 'Man of Steel', `query ${JSON.stringify(query)}`);
    }
  });

  it('respects the limit, and clamps a nonsense one', async () => {
    assert.equal((await search('the', 3)).length, 3);
    assert.ok((await search('the', 5000)).length <= 50, 'a caller cannot ask for the catalogue');
    // Zero means zero. It used to be floored to one, so a caller asking for no rows got a
    // row.
    assert.equal((await search('the', 0)).length, 0);
    assert.equal((await search('the', -1)).length, 0);
  });

  it('ranks from the stored column instead of recomputing the vector', async () => {
    // This is what the plan test was supposed to guarantee and did not. The old function
    // repeated the index's expression in its WHERE and again in its ORDER BY; inlining that
    // expression by hand produced identical results, dropped the index from the plan, took
    // a query from 9ms to 122ms, and every test passed.
    //
    // Reading prosrc is crude, but it is the only thing that can see inside a security
    // definer function that the planner will not inline. The performance claim rests on
    // ranking being a column read, and nothing else here can tell.
    const { rows } = await t.sql(`
      select prosrc from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'search_titles'
    `);
    const body = rows[0].prosrc;

    assert.match(body, /search_vec/, 'the function must read the stored vector');
    assert.doesNotMatch(
      body,
      /media_search\s*\(|to_tsvector\s*\(/,
      'computing the vector per row is what the stored column exists to avoid',
    );
    assert.doesNotMatch(
      body,
      /media_fold\s*\(\s*mi\./,
      'folding a title per row is the same mistake in the other sort key',
    );
  });

  it('uses the index rather than reading the catalogue', async () => {
    // The predicate is now a plain column reference, so this and the function cannot
    // disagree about what is being matched — which was the whole hazard.
    const { rows } = await t.sql(`
      explain (costs off)
      select id from media_items where search_vec @@ to_tsquery('simple', 'incep:*')
    `);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /media_items_search/, `expected a GIN index scan, got:\n${plan}`);
  });

  it('folds every character in its table, losing none of them', async () => {
    // translate() silently deletes characters when its two arguments are different
    // lengths, so a typo in the table would quietly stop folding everything after it.
    const from = 'áàâäãåāąăæçćčđďðéèêëēęěğíìîïīıłľñńňóòôöõøōőœřšśşßťțþúùûüūůűýÿžźż';
    const { rows } = await t.sql(`select media_fold($1) as folded, length($1) as n`, [from]);

    assert.equal(rows[0].folded, 'aaaaaaaaaacccdddeeeeeeegiiiiiillnnnooooooooorsssstttuuuuuuuyyzzz');
    assert.equal(rows[0].folded.length, rows[0].n, 'the two halves of the table must be the same length');
  });

  it('folds an uppercase and a decomposed spelling to the same thing', async () => {
    // "é" arrives either as one code point or as "e" plus a combining acute, and the two
    // look identical. Without normalize(), a title pasted from one source and a query typed
    // in the other form never match, for no reason a user could see.
    const { rows } = await t.sql(
      `select media_fold('Amélie') as composed, media_fold($1) as decomposed, media_fold('AMÉLIE') as upper`,
      ['Ame\u0301lie'],
    );
    assert.equal(rows[0].composed, 'amelie');
    assert.equal(rows[0].decomposed, 'amelie');
    assert.equal(rows[0].upper, 'amelie');
  });

  /**
   * Titles the seeded catalogue does not contain. Everything above uses real rows on
   * purpose; these three cases cannot be tested that way, because every seeded title is
   * ASCII after folding and every original_title is null.
   */
  describe('titles the seed does not have', () => {
    let cyrillic;

    before(async () => {
      cyrillic = await t.createMovie('Война и мир', 111001);
      await t.createMovie('千と千尋の神隠し', 111002);
      await t.createMovie('Čapek a Ostrava', 111003);

      const others = await t.createMovie('The Others', 111004);
      await t.sql(`update media_items set original_title = 'Los Otros' where id = $1`, [others]);
    });

    it('finds a non-Latin title when it is typed', async () => {
      // The tokenizer used to split on [^a-z0-9]+, which treated every non-ASCII character
      // as a separator and discarded it. These rows indexed correctly and were unreachable.
      assert.ok((await search('Война')).includes('Война и мир'), 'Cyrillic');
      assert.ok((await search('千と千尋の神隠し')).includes('千と千尋の神隠し'), 'Japanese');
    });

    it('does not turn an unfolded letter into a word break', async () => {
      // Worse than a miss: "Čapek" was searched for as "apek", because č survived the fold
      // and then acted as a separator. That is a different word, and it matches other
      // things.
      const found = await search('Čapek');
      assert.ok(found.includes('Čapek a Ostrava'), 'the exact spelling must find it');
      assert.ok((await search('capek')).includes('Čapek a Ostrava'), 'and so must the fold');
      assert.ok(!found.includes('Apeks'), 'and it must not be searched for as "apek"');
    });

    it('searches the original title as well as the displayed one', async () => {
      // Null on all 2,010 seeded rows, so nothing else in this file exercises it. The
      // provider adapter fills it, and removing it from the vector broke no test at all.
      assert.ok((await search('los otros')).includes('The Others'));
    });

    it('stops reading the query at a hundred characters', async () => {
      // The cap is what bounds the work, since every token costs an index probe. It is
      // silent, so both directions are worth pinning: what precedes it still searches, and
      // what follows it is gone.
      assert.ok(
        (await search(`inception${' '.repeat(100)}zzzznotaword`)).includes('Inception'),
        'a word beginning past the cap must not narrow the search, because it is never read',
      );
      assert.deepEqual(
        await search(`${'z'.repeat(120)} inception`),
        [],
        'and it must not widen it either: what survives truncation is still ANDed',
      );
    });

    it('prefers the title that was named exactly over a more popular near-miss', async () => {
      // The reason the exact tier sits above popularity rather than below it. Today
      // popularity is null on every row, so the coverage tiebreak happens to produce the
      // same answer and this looks redundant; the moment the provider adapter fills
      // popularity in, a well-known sequel outranks the film whose name was typed.
      const named = await t.createMovie('Probe Knight', 111005);
      const sequel = await t.createMovie('Probe Knight Returns', 111006);
      await t.sql(`update media_items set popularity = 900 where id = $1`, [sequel]);
      await t.sql(`update media_items set popularity = 1 where id = $1`, [named]);

      assert.equal((await search('probe knight'))[0], 'Probe Knight');
    });

    it('breaks a tie on everything by id, so a page cannot come back two ways', async () => {
      // Two rows alike in title, popularity and date, inserted so that heap order is the
      // reverse of id order: without the id tiebreak the function is free to return either,
      // and pagination starts skipping and repeating titles. Asserting this by running the
      // query twice proves nothing — one session, one plan, one heap order.
      const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const low = '00000000-0000-4000-8000-000000000001';
      await t.sql(
        `insert into media_items (id, kind, tmdb_id, title, provenance) values
           ($1, 'movie', -111007, 'Probe Twin', 'manual'),
           ($2, 'movie', -111008, 'Probe Twin', 'manual')`,
        [high, low],
      );

      const { rows } = await t.sql(`select id from search_titles('probe twin', 10)`);
      assert.deepEqual(rows.map((r) => r.id), [low, high]);
    });

    it('builds the stored sort key with the same Unicode tokenizer as the query', async () => {
      // The two have to agree or the exact-name and prefix tiers compare a folded query
      // against a key built by different rules. Under the old ASCII splitter this row's
      // sort key was the empty string.
      const { rows } = await t.sql(`select sort_key from media_items where id = $1`, [cyrillic]);
      assert.equal(rows[0].sort_key, 'война и мир');
    });

    it('narrows on an eleventh word instead of ignoring it', async () => {
      // An earlier draft kept the first ten tokens and dropped the rest, so word eleven
      // widened the search. "The Lord of the Rings: The Fellowship of the Ring" is already
      // ten words.
      const ten = 'the lord of the rings the fellowship of the ring';
      const eleven = `${ten} zzzznotaword`;
      assert.deepEqual(await search(eleven), [], 'an eleventh word that matches nothing must exclude everything');
    });
  });

  it('is callable by a signed-in user and not by a stranger', async () => {
    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select count(*)::int as n from search_titles('inception')`);
      assert.ok(rows[0].n > 0, 'a signed-in caller must get results');
    });

    await t.asAnon(async () => {
      const err = await t.errorFrom(`select * from search_titles('inception')`);
      assert.ok(err, 'search must be refused for an anonymous caller');
      assert.match(err.message, /permission denied/i);
    });
  });

  it('keeps the column generators internal', async () => {
    // They exist to generate columns, not to be called. A client-callable function is a
    // maintenance promise, and these two are free to change.
    await t.asUser(alice, async () => {
      for (const call of [`select media_search('x', 'y')`, `select media_sort_key('x')`]) {
        const err = await t.errorFrom(call);
        assert.ok(err, `${call} should be refused`);
        assert.match(err.message, /permission denied/i);
      }
    });
  });

  it('reaches the fold as the caller, and not as the owner', async () => {
    // search_titles is security invoker so that a future policy hiding rows would apply to
    // it. The cost is that its caller needs the fold, which is why media_fold is granted
    // and the other two are not.
    await t.asUser(alice, async () => {
      const { rows } = await t.sql(`select media_fold('Amélie') as folded`);
      assert.equal(rows[0].folded, 'amelie');
    });

    await t.asAnon(async () => {
      const err = await t.errorFrom(`select media_fold('x')`);
      assert.ok(err, 'a signed-out caller has no reason to fold anything');
      assert.match(err.message, /permission denied/i);
    });
  });
});
