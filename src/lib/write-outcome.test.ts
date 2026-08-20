import { classifyStorageWrite, classifyWrite, mustReconcile, REFUSAL_CODES } from './write-outcome';

/**
 * **The classifier is the whole of Beta Hardening §1's last round**, so it is tested as
 * a state machine rather than as a helper.
 *
 * The rule it replaced was "the error carries a SQLSTATE, so the server answered no".
 * Independent review 21e killed it with one code: `08007 transaction_resolution_unknown`
 * is Postgres saying, in a SQLSTATE, that it does not know whether the transaction
 * committed. Every test below is a shape a real client actually receives — the error
 * objects are copied from what `postgrest-js@2.112.3` constructs, not invented.
 */

describe('what an answer proves', () => {
  it('treats no error as a commit', () => {
    expect(classifyWrite(null)).toBe('committed');
    expect(classifyWrite(undefined)).toBe('committed');
  });

  it('treats a refusal this app raises on purpose as a refusal', () => {
    // `assert_can_write` on a suspended account, and the four beside it. A PL/pgSQL
    // `raise exception` aborts its own transaction, so this one is proof.
    expect(classifyWrite({ code: '42501', message: 'suspended' })).toBe('refused');
    expect(classifyWrite({ code: '22023', message: 'that date is in the future' })).toBe('refused');
    expect(classifyWrite({ code: '28000', message: 'no session' })).toBe('refused');
    expect(classifyWrite({ code: '55000', message: 'already ranked' })).toBe('refused');
    expect(classifyWrite({ code: 'P0002', message: 'no such title' })).toBe('refused');
  });

  /**
   * **The finding.** `08007` is the transaction manager saying it lost the connection
   * during `COMMIT` and cannot tell you which side of it the transaction landed on. It
   * carries a code, so the old rule called it a refusal and the caller left a saved row
   * out of its cache.
   */
  it('treats 08007 as unknown, because that is precisely what it means', () => {
    expect(classifyWrite({ code: '08007', message: 'transaction resolution unknown' })).toBe(
      'unknown',
    );
    expect(REFUSAL_CODES.has('08007')).toBe(false);
  });

  it('treats the rest of the connection class the same way', () => {
    // PostgREST passes the `08` class through with its codes. A connection that failed
    // at an unstated moment is not a statement that failed.
    expect(classifyWrite({ code: '08006', message: 'connection failure' })).toBe('unknown');
    expect(classifyWrite({ code: '08003', message: 'connection does not exist' })).toBe('unknown');
    // The database going down under an in-flight commit is the same shape.
    expect(classifyWrite({ code: '57P01', message: 'terminating connection' })).toBe('unknown');
  });

  it('treats a SQLSTATE nobody here has reasoned about as unknown', () => {
    // The direction of the trade: an unrecognised refusal costs one redundant refetch,
    // an unrecognised ambiguity costs a screen that disagrees with the database. This
    // is also what keeps the list above from becoming an encyclopedia of every code
    // Postgres defines, half of them guessed at.
    expect(classifyWrite({ code: '40001', message: 'could not serialize access' })).toBe('unknown');
    expect(classifyWrite({ code: 'XX000', message: 'internal error' })).toBe('unknown');
  });

  /**
   * Three transport failures, and `postgrest-js` gives all three `code: ''`.
   *
   * A dropped socket after the request went out is the case that matters: the statement
   * may have run to completion and the reply may simply not exist any more.
   */
  it('treats a request that was never answered as unknown', () => {
    // A dead socket mid-flight.
    expect(classifyWrite({ code: '', message: 'TypeError: Network request failed' })).toBe(
      'unknown',
    );
    // An abort or a timeout. `postgrest-js` blanks the code and puts the reason in `hint`.
    expect(classifyWrite({ code: '', message: 'AbortError: The user aborted a request.' })).toBe(
      'unknown',
    );
    // A gateway answering with HTML, which `processResponse` cannot parse — it builds
    // an error with a message and no `code` property at all.
    expect(classifyWrite({ message: '<html>502 Bad Gateway</html>' })).toBe('unknown');
  });

  /**
   * A transport failure *before* transmission is indistinguishable from one after it,
   * and this test exists to record that rather than to pretend otherwise.
   *
   * `fetch` rejects with the same `TypeError` whether DNS never resolved or the
   * connection died with the request already on the wire, and `postgrest-js` flattens
   * both into `{ code: '', message: 'TypeError: ...' }`. There is no field to read.
   * Calling the first one "refused" would be inventing certainty; it is answered as
   * unknown and costs a refetch that was not needed.
   */
  it('cannot tell a request that never left from one whose reply was lost, and says so', () => {
    expect(classifyWrite({ code: '', message: 'TypeError: Failed to fetch' })).toBe('unknown');
  });
});

describe('what an answer proves in Storage, which speaks HTTP', () => {
  it('treats no error as a commit', () => {
    expect(classifyStorageWrite(null)).toBe('committed');
  });

  it('treats a 4xx as the API declining a request it understood', () => {
    expect(classifyStorageWrite({ status: 403, statusCode: '403' })).toBe('refused');
    expect(classifyStorageWrite({ status: 404, statusCode: '404' })).toBe('refused');
    expect(classifyStorageWrite({ status: 429, statusCode: '429' })).toBe('refused');
  });

  it('treats a 5xx as unknown, because the delete may have run before it fell over', () => {
    expect(classifyStorageWrite({ status: 500, statusCode: '500' })).toBe('unknown');
    expect(classifyStorageWrite({ status: 502, statusCode: '502' })).toBe('unknown');
  });

  it('treats a timeout as unknown rather than as a refusal', () => {
    // 408 says the server stopped waiting, not that it did nothing.
    expect(classifyStorageWrite({ status: 408, statusCode: '408' })).toBe('unknown');
  });

  it('treats a StorageUnknownError, which carries no status at all, as unknown', () => {
    // What a dead socket becomes on the way out of `storage-js`.
    expect(classifyStorageWrite({ status: undefined, statusCode: undefined })).toBe('unknown');
    expect(classifyStorageWrite({})).toBe('unknown');
  });
});

describe('whether the caller has to reconcile', () => {
  it('is true for a commit and for an unknown, and false only for a refusal', () => {
    // The asymmetry is the fix. Reconciling on success alone is what left four callers
    // showing an error over a cache the server had already moved underneath them.
    expect(mustReconcile('committed')).toBe(true);
    expect(mustReconcile('unknown')).toBe(true);
    expect(mustReconcile('refused')).toBe(false);
  });
});
