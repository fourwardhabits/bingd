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

/**
 * Measured in UTF-8 bytes, which is what the Keychain counts, and deliberately not
 * in string length. A JWT is ASCII, so the two agree for the token itself and
 * diverge exactly where the user's own data appears: `JSON.stringify` does not
 * escape non-ASCII, so a Cyrillic, CJK, or emoji display name arriving from Apple or
 * Google makes each character cost two to four bytes. Counting characters would let
 * a 1800-character chunk weigh over 3 KB and be rejected by the very limit the
 * chunking exists to respect, on the accounts of exactly the users whose names are
 * not Latin.
 */
const CHUNK_BYTES = 1536;

/** The UTF-8 width of one code point, without depending on TextEncoder. */
function utf8Width(codePoint: number) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Splits on code point boundaries. A plain `slice` counts UTF-16 code units and can
 * cut an emoji in half, leaving a lone surrogate at the end of one chunk and its
 * partner at the start of the next. Each half survives storage, and the native
 * bridge's UTF-8 conversion replaces it with U+FFFD, so the rejoined string is not
 * the one that was written. The damage lands inside a JSON string value, which stays
 * parseable, so the session still loads and the name is quietly corrupted.
 */
function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;

  for (const character of value) {
    const width = utf8Width(character.codePointAt(0)!);
    if (current !== '' && bytes + width > CHUNK_BYTES) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += width;
  }

  if (current !== '' || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * One operation at a time per key.
 *
 * Two overlapping writes interleave destructively: each begins by deleting the
 * other's chunks, and the count written last may describe a mixture of both. Today
 * gotrue-js serializes its own storage calls within a client instance, so this never
 * happens — but that is an undocumented internal, and an adapter that is only correct
 * because of its caller's implementation details is one library upgrade from being
 * wrong. The queue is five lines and removes the dependency.
 */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // Runs after the previous operation whether it resolved or threw: a failed write
  // must not stall the queue behind it forever.
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

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
  getItem(key: string) {
    return serialize(key, async () => {
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
    });
  },

  setItem(key: string, value: string) {
    return serialize(key, async () => {
      // Clear first, or shrinking from five chunks to two leaves three stale ones
      // that a later read would happily append.
      await removeChunks(key);

      const chunks = splitIntoChunks(value);

      await Promise.all(
        chunks.map((chunk, i) => SecureStore.setItemAsync(chunkKey(key, i), chunk)),
      );
      // Written last, so an interrupted write leaves no count and therefore reads as
      // absent rather than as a short value.
      await SecureStore.setItemAsync(countKey(key), String(chunks.length));
    });
  },

  removeItem(key: string) {
    return serialize(key, () => removeChunks(key));
  },
};

/**
 * Exported so the chunking can be tested directly. The platform test below is
 * evaluated at import time, and jest-expo runs the suite under a web platform too,
 * where `sessionStorage` would resolve to the localStorage adapter and the
 * interesting code would go unexercised on every run.
 */
export const chunkedSecureStore = native;

export const sessionStorage = Platform.OS === 'web' ? web : native;
