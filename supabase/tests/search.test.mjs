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
    // "her" matches a great many titles as a prefix of a word. The one actually being
    // looked for is the film called Her, and rank alone does not reliably produce it.
    const results = await search('her');
    const her = results.indexOf('Her');
    if (her !== -1) assert.equal(her, 0, `Her should lead: got ${results.slice(0, 3).join(', ')}`);
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
    // PRD §26.2 AC 1 is movies and series; a season is reached from its series page. It
    // would also be useless here, since every season in the catalogue is titled "Season 3".
    const { rows } = await t.sql(`select kind from search_titles('season', 50)`);
    assert.equal(
      rows.filter((r) => r.kind === 'season').length,
      0,
      'a search for the word "season" must still not return season rows',
    );
  });

  it('respects the limit, and caps it', async () => {
    assert.equal((await search('the', 3)).length, 3);
    assert.ok((await search('the', 5000)).length <= 50, 'a caller cannot ask for the catalogue');
    assert.ok((await search('the', -1)).length >= 1, 'a nonsense limit must not return nothing');
  });

  it('orders totally, so the same query twice gives the same page', async () => {
    // Without the title and id tiebreaks, rows tying on rank swap between calls and
    // pagination starts skipping and repeating titles.
    const first = await search('the', 25);
    assert.deepEqual(await search('the', 25), first);
  });

  it('uses the index rather than reading the catalogue', async () => {
    // The assertion that keeps this fast as the catalogue grows. If the expression in
    // search_titles ever stops matching the expression in the index, this notices —
    // nothing else would, because the results stay correct.
    const { rows } = await t.sql(`
      explain (costs off)
      select id from media_items
       where media_search(title, original_title) @@ to_tsquery('simple', 'incep:*')
    `);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /media_items_search/, `expected a GIN index scan, got:\n${plan}`);
  });

  it('folds every character in its table, losing none of them', async () => {
    // translate() silently deletes characters when its two arguments are different
    // lengths, so a typo in the table would quietly stop folding everything after it.
    const { rows } = await t.sql(`select media_fold($1) as folded`, [
      'ÁÀÂÄÃÅĀÆÉÈÊËĒÍÌÎÏĪÓÒÔÖÕØŌŒÚÙÛÜŪÑÇĆŠŚŽŹÝŸĐŁß',
    ]);
    assert.equal(rows[0].folded, 'aaaaaaaaeeeeeiiiiioooooooouuuuunccsszzyydls');
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

  it('keeps the fold and the vector internal', async () => {
    // They exist to be indexed, not called. A client-callable function is a maintenance
    // promise, and these two are free to change.
    await t.asUser(alice, async () => {
      for (const call of [`select media_fold('x')`, `select media_search('x', 'y')`]) {
        const err = await t.errorFrom(call);
        assert.ok(err, `${call} should be refused`);
        assert.match(err.message, /permission denied/i);
      }
    });
  });
});
