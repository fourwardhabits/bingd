import {
  SCHEMA_DRIFT_CODES,
  diagnose,
  isSchemaDrift,
  readContractBreach,
} from './diagnose';

/**
 * What a screen is allowed to say when a query fails.
 *
 * Two opposing requirements meet here. A device test needs to be able to identify the
 * failing dependency — "could not load" cost an afternoon when the cause was one
 * absent column. And a build handed to a tester must not put backend text on screen
 * indiscriminately, because Postgres echoes rejected input in constraint and type
 * errors, which can be another person's value.
 *
 * The line is drawn at schema shape: a missing column, function or table names
 * nothing but the schema, and is exactly the class of failure that keeps happening
 * while the backend trails the client.
 */

// The env mock in jest.setup.js reports the `preview` variant, so these run on the
// non-production side of the gate. The production case is asserted separately below.
describe('outside production', () => {
  it('names a missing column, which is always an unapplied migration', () => {
    const message = diagnose({
      code: '42703',
      message: 'column user_media.note_visibility does not exist',
    });

    expect(message).toContain('note_visibility');
    expect(message).toContain('Backend is out of date');
  });

  it('names a missing function', () => {
    expect(diagnose({ code: 'PGRST202', message: 'Could not find the function' })).toContain(
      'Backend is out of date',
    );
  });

  it('says a stale cache is a stale cache, which has a different remedy', () => {
    expect(diagnose({ code: 'PGRST205', message: 'table not found in cache' })).toContain(
      'Schema cache is stale',
    );
  });

  it('says nothing about anything else, whatever the message contains', () => {
    // A constraint violation echoes the value that violated it. That value can be
    // somebody's note, and none of it helps identify a missing dependency.
    expect(
      diagnose({ code: '23514', message: 'value "a private sentence" violates constraint' }),
    ).toBeNull();
    expect(diagnose({ message: 'Network request failed' })).toBeNull();
    expect(diagnose({ code: '500', message: 'internal error' })).toBeNull();
  });

  it('says nothing when there is nothing to say', () => {
    expect(diagnose(null)).toBeNull();
    expect(diagnose(undefined)).toBeNull();
    expect(diagnose({})).toBeNull();
  });
});

describe('isSchemaDrift', () => {
  it('is true for the three codes that mean the client and the database disagree', () => {
    for (const code of ['42703', 'PGRST202', 'PGRST205']) {
      expect(isSchemaDrift({ code })).toBe(true);
    }
  });

  it('is false for the ones a retry might actually fix', () => {
    expect(isSchemaDrift({ code: '500' })).toBe(false);
    expect(isSchemaDrift(null)).toBe(false);
  });
});

describe('readContractBreach', () => {
  /**
   * The three codes, read off a *body* rather than a thrown error.
   *
   * `isSchemaDrift` above is asked by a screen holding an error object. This is asked by
   * the fetch chokepoint holding a response it has just parsed, one layer below any
   * screen — which is the layer a held migration actually breaks, because the RPC that
   * does not exist fails identically on every surface that calls it.
   */
  it.each([
    [
      'PGRST202',
      'Could not find the function public.rank_again(p_media_item_id) in the schema cache',
      'public.rank_again',
    ],
    ['PGRST205', "Could not find the table 'public.group_picks' in the schema cache", 'public.group_picks'],
    ['42703', 'column media_items.episode_count does not exist', 'media_items.episode_count'],
    ['42703', 'column "causal_step" does not exist', 'causal_step'],
  ])('names what %s says is missing', (code, message, symbol) => {
    expect(readContractBreach({ code, message })).toEqual({ code, symbol });
  });

  it('reports the breach even when the message names nothing it will read', () => {
    // Better an unnamed contract failure in Sentry than none: the code alone says the
    // build and the database disagree, which is the thing nobody could see before.
    expect(readContractBreach({ code: 'PGRST202', message: 'schema cache' })).toEqual({
      code: 'PGRST202',
      symbol: null,
    });
    expect(readContractBreach({ code: 'PGRST202' })).toEqual({ code: 'PGRST202', symbol: null });
  });

  it('never carries the message, so an echoed value cannot ride out on one', () => {
    // Not hypothetical: `diagnose` above refuses to print arbitrary messages because
    // Postgres echoes rejected input, and this is the same rule one layer lower. A
    // message shaped like a drift message but carrying prose yields an identifier or
    // nothing — never the sentence.
    const breach = readContractBreach({
      code: '42703',
      message: 'column note does not exist, value was "a private sentence"',
    });
    expect(breach).toEqual({ code: '42703', symbol: 'note' });
    expect(JSON.stringify(breach)).not.toContain('private sentence');
  });

  it('is silent for everything that is not one of the three', () => {
    expect(readContractBreach({ code: '23514', message: 'column x does not exist' })).toBeNull();
    expect(readContractBreach({ code: 'PGRST301' })).toBeNull();
    expect(readContractBreach(null)).toBeNull();
    expect(readContractBreach('PGRST202')).toBeNull();
    expect(readContractBreach({})).toBeNull();
  });

  it('holds the same three codes the drift predicate does', () => {
    expect([...SCHEMA_DRIFT_CODES].sort()).toEqual(['42703', 'PGRST202', 'PGRST205']);
  });
});
