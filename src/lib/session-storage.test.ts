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
      expect(store.get(key)!.length).toBeLessThanOrEqual(2048);
    }

    expect(await chunkedSecureStore.getItem(KEY)).toBe(session);
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
