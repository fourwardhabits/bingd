import * as SecureStore from 'expo-secure-store';

import { chunkedSecureStore } from './session-storage';

/**
 * SecureStore stands in for Keychain and Keystore, which no test environment has.
 * The mock is a plain map — the behaviour under test is the chunking, not the
 * platform store.
 */
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

const KEY = 'sb-abheeqyjzekiowkztfxv-auth-token';

/** What the Keychain counts, which is not what `String.length` returns. */
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

describe('chunked SecureStore', () => {
  it('round-trips a short value', async () => {
    await chunkedSecureStore.setItem(KEY, 'small');
    expect(await chunkedSecureStore.getItem(KEY)).toBe('small');
  });

  it('returns null for a key that was never written', async () => {
    expect(await chunkedSecureStore.getItem(KEY)).toBeNull();
  });

  /**
   * The reason this module exists. iOS Keychain rejects values much above 2 KB and a
   * real Supabase session — two JWTs plus user metadata — exceeds that, so an
   * unchunked adapter works throughout development and then fails on a live token.
   * The symptom is a user signed out on every cold start.
   */
  it('splits a session-sized value and reassembles it exactly', async () => {
    const session = 'x'.repeat(9_001);
    await chunkedSecureStore.setItem(KEY, session);

    const written = [...store.keys()].filter((k) => k !== `${KEY}.chunks`);
    expect(written.length).toBeGreaterThan(1);
    for (const key of written) {
      expect(byteLength(store.get(key)!)).toBeLessThanOrEqual(2048);
    }

    expect(await chunkedSecureStore.getItem(KEY)).toBe(session);
  });

  /**
   * Measured in bytes, because that is what the Keychain counts. A JWT is ASCII, so
   * the character count and the byte count agree for the token and diverge exactly
   * where the user's own data appears: JSON.stringify does not escape non-ASCII, so a
   * display name from Apple or Google in a non-Latin script costs two to four bytes
   * per character. Chunking by length would let a chunk weigh three times its
   * apparent size and be rejected by the limit chunking exists to respect — and only
   * for users whose names are not Latin, which is the worst possible distribution
   * for a bug.
   */
  it('respects the byte limit for non-ASCII content, not the character count', async () => {
    const value = JSON.stringify({ name: 'Ω'.repeat(4_000), token: 'x'.repeat(2_000) });
    await chunkedSecureStore.setItem(KEY, value);

    for (const key of [...store.keys()].filter((k) => k !== `${KEY}.chunks`)) {
      expect(byteLength(store.get(key)!)).toBeLessThanOrEqual(2048);
    }
    expect(await chunkedSecureStore.getItem(KEY)).toBe(value);
  });

  /**
   * A boundary landing inside a surrogate pair leaves a lone surrogate at the end of
   * one chunk and its partner at the start of the next. Both halves survive this
   * mock, but on a device the native bridge's UTF-8 conversion replaces each with
   * U+FFFD, so the rejoined string is not the one written. The damage lands inside a
   * JSON string value, which stays parseable, so the session loads and the name is
   * quietly wrong.
   */
  it('never splits a surrogate pair across chunks', async () => {
    // Emoji are four UTF-8 bytes each, so a boundary falls inside one unless the
    // split is code-point aware.
    const value = '🎬'.repeat(2_000);
    await chunkedSecureStore.setItem(KEY, value);

    for (const key of [...store.keys()].filter((k) => k !== `${KEY}.chunks`)) {
      const chunk = store.get(key)!;
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(await chunkedSecureStore.getItem(KEY)).toBe(value);
  });

  /**
   * Two writes at once used to interleave destructively: each begins by deleting the
   * other's chunks, and the count written last could describe a mixture. gotrue-js
   * happens to serialize its own storage calls, so this was unreachable in practice
   * and correct only by its caller's undocumented internals.
   */
  it('serializes overlapping writes to one key', async () => {
    const first = 'a'.repeat(5_000);
    const second = 'b'.repeat(3_000);

    await Promise.all([
      chunkedSecureStore.setItem(KEY, first),
      chunkedSecureStore.setItem(KEY, second),
    ]);

    // Whichever landed last, the result must be one of the two values entire, never a
    // blend of both and never a short read.
    expect([first, second]).toContain(await chunkedSecureStore.getItem(KEY));
  });

  it('preserves content exactly across a chunk boundary', async () => {
    // A repeated character would hide an off-by-one that duplicated or dropped a
    // character at a seam, because every wrong answer still looks right.
    const value = Array.from({ length: 5_000 }, (_, i) => String(i % 10)).join('');
    await chunkedSecureStore.setItem(KEY, value);
    expect(await chunkedSecureStore.getItem(KEY)).toBe(value);
  });

  it('leaves no stale chunks when a value shrinks', async () => {
    await chunkedSecureStore.setItem(KEY, 'y'.repeat(9_000));
    await chunkedSecureStore.setItem(KEY, 'short');

    expect(await chunkedSecureStore.getItem(KEY)).toBe('short');
    // Without the clear-before-write, the old chunks 1..n survive and a later read
    // appends them to the new value.
    expect([...store.keys()].sort()).toEqual([`${KEY}.0`, `${KEY}.chunks`]);
  });

  it('reads as absent, not as truncated, when a chunk is missing', async () => {
    await chunkedSecureStore.setItem(KEY, 'z'.repeat(5_000));
    store.delete(`${KEY}.1`);

    // Returning the surviving fragments would hand Supabase malformed JSON and
    // produce a parse error on every launch, which is far harder to diagnose than
    // being signed out once.
    expect(await chunkedSecureStore.getItem(KEY)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('removes every chunk on removeItem', async () => {
    await chunkedSecureStore.setItem(KEY, 'w'.repeat(7_000));
    await chunkedSecureStore.removeItem(KEY);

    expect(store.size).toBe(0);
    expect(await chunkedSecureStore.getItem(KEY)).toBeNull();
  });

  it('keeps two keys independent', async () => {
    await chunkedSecureStore.setItem('first', 'a'.repeat(4_000));
    await chunkedSecureStore.setItem('second', 'b'.repeat(4_000));

    expect(await chunkedSecureStore.getItem('first')).toBe('a'.repeat(4_000));
    await chunkedSecureStore.removeItem('first');
    expect(await chunkedSecureStore.getItem('second')).toBe('b'.repeat(4_000));
  });
});
