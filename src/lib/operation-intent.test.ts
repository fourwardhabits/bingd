import { renderHookWithProviders } from '@/test-utils/render';

import { answerWasLost, useOperationIntent } from './operation-intent';

/**
 * **The rule `collection/writes.ts` states and nothing in this app was keeping:** an
 * operation id belongs to the intent, not to the attempt.
 *
 * `_claim_operation` can only refuse a replay carrying the id it already saw. Minting
 * inside the writer meant every retry looked new, so the ledger the server maintains for
 * exactly this purpose never got a chance to use it. Reviews 21h, 21i and 21j found it one
 * writer at a time, and the reason it survived that long is that the obvious test is the
 * wrong one: almost nothing here can store a duplicate *row*. What a replay does spend is
 * a rate-limit slot.
 *
 * The tests below are about the state machine, not about any one caller.
 */

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${(issued += 1)}` }));

beforeEach(() => {
  issued = 0;
});

const mount = async () => {
  const { result } = await renderHookWithProviders(() => useOperationIntent());
  return result.current;
};

describe('one id per intent', () => {
  it('gives the same id to a retry of the same intent', async () => {
    const withIntent = await mount();
    const seen: string[] = [];
    const lost = async (id: string) => {
      seen.push(id);
      return { error: { code: '', message: 'TypeError: Network request failed' } };
    };

    await withIntent('follow:ada', lost, answerWasLost);
    await withIntent('follow:ada', lost, answerWasLost);

    expect(seen).toEqual(['id-1', 'id-1']);
  });

  it('gives different intents ids of their own', async () => {
    // Sharing one across two would have the second answered `already_applied` — a
    // control that reports success and does nothing, which is the failure mode holding
    // an id can cause.
    const withIntent = await mount();
    const seen: string[] = [];
    const lost = async (id: string) => {
      seen.push(id);
      return { error: { code: '', message: 'lost' } };
    };

    await withIntent('follow:ada', lost, answerWasLost);
    await withIntent('follow:grace', lost, answerWasLost);

    expect(seen).toEqual(['id-1', 'id-2']);
  });

  it('releases the id as soon as the server answers, and takes a fresh one after', async () => {
    const withIntent = await mount();
    const seen: string[] = [];
    const answered = async (id: string) => {
      seen.push(id);
      return { error: null };
    };

    await withIntent('follow:ada', answered, answerWasLost);
    await withIntent('follow:ada', answered, answerWasLost);

    // Two genuine follows of the same person — the second is a real second intent, and
    // replaying the first id would have it answered `already_applied`.
    expect(seen).toEqual(['id-1', 'id-2']);
  });

  it('releases on a refusal too, because a refusal is an answer', async () => {
    // The asymmetry that matters. A refusal establishes the outcome, so there is nothing
    // to replay — and some refusals (`recommend_title`'s, deliberately) keep their claim,
    // which would make a held id answer `already_applied` to a write nobody has stored.
    const withIntent = await mount();
    const seen: string[] = [];
    const refused = async (id: string) => {
      seen.push(id);
      return { error: { code: '42501', message: 'suspended' } };
    };

    await withIntent('follow:ada', refused, answerWasLost);
    await withIntent('follow:ada', refused, answerWasLost);

    expect(seen).toEqual(['id-1', 'id-2']);
  });

  it('holds it for 08007, which carries a code and answers nothing', async () => {
    const withIntent = await mount();
    const seen: string[] = [];
    const unknown = async (id: string) => {
      seen.push(id);
      return { error: { code: '08007', message: 'transaction resolution unknown' } };
    };

    await withIntent('follow:ada', unknown, answerWasLost);
    await withIntent('follow:ada', unknown, answerWasLost);

    expect(seen).toEqual(['id-1', 'id-1']);
  });

  it('returns the call’s own result untouched', async () => {
    const withIntent = await mount();

    const result = await withIntent(
      'anything',
      async () => ({ error: null, data: { status: 'ok' } }),
      answerWasLost,
    );

    expect(result).toEqual({ error: null, data: { status: 'ok' } });
  });

  it('lets a caller decide for itself what "unresolved" means', async () => {
    // `useAccountWrites` classifies inside its own `run` and reports `changed`, so the
    // predicate reads that rather than a PostgREST error. Required rather than
    // defaulted: a default that guessed wrong would fail silently.
    const withIntent = await mount();
    const seen: string[] = [];
    const call = async (id: string) => {
      seen.push(id);
      return { ok: false as const, changed: true };
    };

    await withIntent('save', call, (r) => r.changed);
    await withIntent('save', call, (r) => r.changed);

    expect(seen).toEqual(['id-1', 'id-1']);
  });
});

/**
 * **Two attempts at one intent can be in flight at once**, and independent review 21k
 * found that the first version handled that badly in both directions.
 *
 * A control that is pressed twice quickly, or a queued save landing beside a manual retry,
 * puts two calls on the same key. They share an id — that is the design — and
 * `_claim_operation` grants it to exactly one of them, answering the other
 * `already_applied`. What the map does while they overlap is the part that was wrong.
 */
describe('when two attempts at one intent overlap', () => {
  /** A call whose answer the test releases by hand. */
  const deferred = () => {
    let settle!: (value: { error: { code?: string } | null }) => void;
    const promise = new Promise<{ error: { code?: string } | null }>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  };

  it('keeps the id when one attempt answers and the other is left unresolved', async () => {
    // 21k's sequence. Without the re-assert: the answered attempt empties the map, the
    // unresolved one has nothing to put back, and the retry the person is invited to
    // make mints a second id and spends a second slot for an intent that already has one.
    const withIntent = await mount();
    const seen: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = withIntent('follow:ada', (id) => { seen.push(id); return first.promise; }, answerWasLost);
    const b = withIntent('follow:ada', (id) => { seen.push(id); return second.promise; }, answerWasLost);

    first.settle({ error: null });
    await a;
    second.settle({ error: { code: '' } });
    await b;

    await withIntent('follow:ada', async (id) => { seen.push(id); return { error: null }; }, answerWasLost);

    expect(seen[0]).toBe('id-1');
    expect(seen[1]).toBe('id-1');
    // The retry carries the id the server can recognise, so it is free.
    expect(seen[2]).toBe('id-1');
  });

  it('does not let a stale unresolved attempt put its id back over a newer one', async () => {
    /**
     * Review 21l, and the sharpest ordering of the three.
     *
     * Two attempts share A. One answers and releases A. A third press mints B and goes
     * unresolved, so B is what a retry should carry. Then the second A attempt finally
     * comes back unresolved — and an unconditional re-assert would write A over B.
     * **A has already been claimed**, so the retry for B's genuine intent would be
     * answered `already_applied`: a write that reports success and stores nothing.
     */
    const withIntent = await mount();
    const seen: string[] = [];
    const slow = deferred();

    const stale = withIntent(
      'follow:ada',
      (id) => { seen.push(id); return slow.promise; },
      answerWasLost,
    );
    // A concurrent attempt on the same id is answered, which releases it.
    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: null }; },
      answerWasLost,
    );
    // A genuinely new intent mints B and goes unresolved, so B is held.
    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: { code: '' } }; },
      answerWasLost,
    );

    // Only now does the first attempt come back, unresolved, carrying the spent A.
    slow.settle({ error: { code: '' } });
    await stale;

    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: null }; },
      answerWasLost,
    );

    expect(seen.slice(0, 3)).toEqual(['id-1', 'id-1', 'id-2']);
    // B, not the resurrected A.
    expect(seen[3]).toBe('id-2');
  });
  it('prefers the newer unresolved attempt when an older one restored itself first', async () => {
    /**
     * Review 21m, and the reason the guard is an *order* rather than a presence check.
     *
     * Two attempts share A; one answers and clears it. Two newer attempts share B; one
     * of those answers and clears it. Now the stale A comes back unresolved into an
     * empty map and holds an id **older** than the B attempt still to return — and a
     * presence check would leave A there. A is spent, so the retry for B's genuine
     * intent would be answered `already_applied`: success reported, nothing stored.
     */
    const withIntent = await mount();
    const seen: string[] = [];
    const staleA = deferred();
    const slowB = deferred();

    // Generation 1: two attempts on A, one of which is left hanging.
    const a = withIntent(
      'follow:ada',
      (id) => { seen.push(id); return staleA.promise; },
      answerWasLost,
    );
    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: null }; },
      answerWasLost,
    );

    // Generation 2: two attempts on B, one of which is left hanging.
    const b = withIntent(
      'follow:ada',
      (id) => { seen.push(id); return slowB.promise; },
      answerWasLost,
    );
    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: null }; },
      answerWasLost,
    );

    // The older one comes back first and puts itself into an empty map.
    staleA.settle({ error: { code: '' } });
    await a;
    // Then the newer one, which is the attempt a retry should actually carry.
    slowB.settle({ error: { code: '' } });
    await b;

    await withIntent(
      'follow:ada',
      async (id) => { seen.push(id); return { error: null }; },
      answerWasLost,
    );

    expect(seen.slice(0, 4)).toEqual(['id-1', 'id-1', 'id-2', 'id-2']);
    // B, not the older A that got there first.
    expect(seen[4]).toBe('id-2');
  });
  it('does not let a late answer release an id minted after it', async () => {
    // The same race from the other side: an attempt resolving late, after a concurrent
    // one settled the key and a third press minted a fresh id. Deleting unconditionally
    // would release that newer id and lose its protection.
    const withIntent = await mount();
    const seen: string[] = [];
    const slow = deferred();

    const a = withIntent('follow:ada', (id) => { seen.push(id); return slow.promise; }, answerWasLost);
    // A second attempt resolves first and releases id-1.
    await withIntent('follow:ada', async (id) => { seen.push(id); return { error: null }; }, answerWasLost);
    // A third is a new intent and takes id-2, which goes unanswered and is held.
    await withIntent('follow:ada', async (id) => { seen.push(id); return { error: { code: '' } }; }, answerWasLost);

    // Only now does the first one answer, carrying the stale id-1.
    slow.settle({ error: null });
    await a;

    await withIntent('follow:ada', async (id) => { seen.push(id); return { error: null }; }, answerWasLost);

    expect(seen.slice(0, 3)).toEqual(['id-1', 'id-1', 'id-2']);
    // id-2 is still held, because the late answer belonged to id-1.
    expect(seen[3]).toBe('id-2');
  });
});

describe('what counts as an answer', () => {
  it.each([
    ['no error at all', null],
    ['a refusal this app raises', { code: '42501' }],
    ['a validation refusal', { code: '22023' }],
  ])('treats %s as answered', (_name, error) => {
    expect(answerWasLost({ error })).toBe(false);
  });

  it.each([
    ['a request that was never answered', { code: '' }],
    ['a transaction whose resolution is unknown', { code: '08007' }],
    ['a gateway body with no code at all', {}],
  ])('treats %s as unresolved', (_name, error) => {
    expect(answerWasLost({ error })).toBe(true);
  });
});
