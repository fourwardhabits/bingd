import { diagnose, isSchemaDrift } from './diagnose';

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
