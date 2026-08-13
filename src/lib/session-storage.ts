import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Session storage for the Supabase client.
 *
 * `docs/architecture/auth.md` §5 requires refresh tokens in `expo-secure-store` —
 * Keychain on iOS, Keystore on Android — and names `AsyncStorage` specifically as
 * the wrong answer, being unencrypted plaintext on disk. The scaffold used
 * AsyncStorage, which is the default every example reaches for.
 *
 * The reason examples reach for it is that SecureStore is not a drop-in: iOS
 * Keychain rejects values much above 2 KB, and a Supabase session — two JWTs plus
 * user metadata — routinely exceeds that. A naive swap appears to work through
 * development and then fails on a real token, at which point the symptom is a user
 * silently signed out on every cold start. So values are chunked.
 */

// Comfortably under the limit that provokes a Keychain warning, leaving room for
// the key itself.
const CHUNK_SIZE = 1800;

/** SecureStore keys accept alphanumerics, `.`, `-` and `_`. Supabase's keys do too. */
const chunkKey = (key: string, index: number) => `${key}.${index}`;
const countKey = (key: string) => `${key}.chunks`;

/**
 * Web has no Keychain. `localStorage` is the platform's own answer and is what
 * Supabase uses there by default; this only exists so the module is importable in
 * the web build rather than to make the web build secure.
 */
const web = {
  getItem: (key: string) => Promise.resolve(globalThis.localStorage?.getItem(key) ?? null),
  setItem: (key: string, value: string) => {
    globalThis.localStorage?.setItem(key, value);
    return Promise.resolve();
  },
  removeItem: (key: string) => {
    globalThis.localStorage?.removeItem(key);
    return Promise.resolve();
  },
};

async function removeChunks(key: string) {
  const count = Number(await SecureStore.getItemAsync(countKey(key))) || 0;
  await Promise.all([
    SecureStore.deleteItemAsync(countKey(key)),
    ...Array.from({ length: count }, (_, i) => SecureStore.deleteItemAsync(chunkKey(key, i))),
  ]);
}

const native = {
  async getItem(key: string) {
    const count = Number(await SecureStore.getItemAsync(countKey(key)));
    if (!count) return null;

    const chunks = await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(chunkKey(key, i))),
    );

    // A partial read means the store was interrupted mid-write, or a chunk was
    // evicted. Returning the fragments would hand Supabase a truncated JSON string
    // and produce a parse error on every launch, which is much harder to diagnose
    // than being signed out once.
    if (chunks.some((chunk) => chunk === null)) {
      await removeChunks(key);
      return null;
    }

    return chunks.join('');
  },

  async setItem(key: string, value: string) {
    // Clear first, or shrinking from five chunks to two leaves three stale ones
    // that a later read would happily append.
    await removeChunks(key);

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }

    await Promise.all(
      chunks.map((chunk, i) => SecureStore.setItemAsync(chunkKey(key, i), chunk)),
    );
    // Written last, so an interrupted write leaves no count and therefore reads as
    // absent rather than as a short value.
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));
  },

  removeItem: removeChunks,
};

/**
 * Exported so the chunking can be tested directly. The platform test below is
 * evaluated at import time, and jest-expo runs the suite under a web platform too,
 * where `sessionStorage` would resolve to the localStorage adapter and the
 * interesting code would go unexercised on every run.
 */
export const chunkedSecureStore = native;

export const sessionStorage = Platform.OS === 'web' ? web : native;
