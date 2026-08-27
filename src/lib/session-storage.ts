import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { note } from './flight-recorder';

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

const disk = {
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
 * What this process last wrote or read for a key, so a request does not go to the
 * Keychain to find out what it already knows.
 *
 * **This is on the critical path of every authenticated request, which is not obvious
 * and is the reason it exists.** `@supabase/supabase-js` builds each request through
 * `fetchWithAuth`, which awaits `auth.getSession()` first; `getSession` has no in-memory
 * session and calls `storage.getItem` every single time. Through the chunked adapter
 * below that is one Keychain read for the count plus one per chunk — four or so round
 * trips over the native bridge — **per query**, serialized against every other request's
 * by the queue above. A screen that mounts a dozen queries pays fifty Keychain reads in
 * one line before any of them reaches the network, and the founder's build-4 device did
 * this on five mounted tabs at once.
 *
 * Worse than slow: `SecureStore.getItemAsync` is a promise the platform does not promise
 * to settle. One that never does takes every subsequent authenticated request and
 * sign-out with it, because they all queue behind it on this key. A value held in memory
 * removes both — the cost and the shared hang — for every read after the first.
 *
 * **Sound because this adapter is the only writer.** There is one process, one Supabase
 * client, and no app extension touching these keys, so nothing can change the Keychain
 * underneath the mirror without coming through here. Writes update it optimistically —
 * a read during an in-flight write should see what is being written, which is what
 * queueing behind the write would also have produced — and a *failed* write drops the
 * entry rather than guessing, so the next read goes back to the disk that knows.
 */
const mirror = new Map<string, string | null>();

/**
 * How many times a key has been written or removed, so a read cannot install a stale
 * answer over a newer one.
 *
 * **Independent review 49's finding, and it is a sign-out bug rather than a cache nit.**
 * A read that misses the mirror goes to the Keychain, and the Keychain is slow — so a
 * `setItem` or `removeItem` can begin and finish while that read is still out. Without
 * this counter the read's `.then` would then overwrite the newer value with the older
 * one, and the two shapes that lands in are exactly the two that matter here: a session
 * served *after* it was deleted, so a sign-out silently un-happens, and the previous
 * account's session served to the next one on the same device.
 */
const revision = new Map<string, number>();

const bumpRevision = (key: string) => {
  const next = (revision.get(key) ?? 0) + 1;
  revision.set(key, next);
  return next;
};

/** Test seam: the next test must not inherit the previous one's session. */
export function resetSessionMirror() {
  mirror.clear();
  revision.clear();
}

/**
 * The adapter Supabase is given: the chunked store above, with a memory mirror in front.
 *
 * Reads are answered from memory whenever this process already knows the answer, so the
 * per-request Keychain traffic described at `mirror` happens once per key per launch
 * rather than once per query. Writes go to the Keychain and update the mirror; a write
 * that fails invalidates it rather than leaving a claim behind.
 */
const native = {
  getItem(key: string): Promise<string | null> {
    const held = mirror.get(key);
    if (held !== undefined) return Promise.resolve(held);

    const startedAt = revision.get(key) ?? 0;
    // The Keychain lane, timed. A read that does not answer is one of the two shapes that
    // can stall every authenticated request at once, and it leaves no other trace.
    const began = Date.now();

    return disk.getItem(key).then((value) => {
      note('store', 'read', value === null ? 'absent' : 'present', Date.now() - began);
      // Only when nothing was written or removed while this read was out. Otherwise the
      // newer value stands and this answer is simply old — see `revision`.
      if ((revision.get(key) ?? 0) === startedAt) mirror.set(key, value);

      const current = mirror.get(key);
      return current !== undefined ? current : value;
    });
  },

  setItem(key: string, value: string): Promise<void> {
    // Optimistic: a read taken while this write is in flight should see what is being
    // written, which is also what queueing behind the write would have returned.
    const at = bumpRevision(key);
    mirror.set(key, value);
    const began = Date.now();

    return disk
      .setItem(key, value)
      .then(() => note('store', 'write', 'ok', Date.now() - began))
      .catch((error: unknown) => {
        note('store', 'write', 'failed', Date.now() - began);
        // The disk did not take it, so this process no longer knows what the disk holds.
        // Forgetting sends the next read back to the store that does — but only if this is
        // still the newest claim, because a later write's value must not be dropped
        // because an earlier one failed.
        if (revision.get(key) === at) mirror.delete(key);
        throw error;
      });
  },

  removeItem(key: string): Promise<void> {
    const at = bumpRevision(key);
    mirror.set(key, null);

    return disk.removeItem(key).catch((error: unknown) => {
      if (revision.get(key) === at) mirror.delete(key);
      throw error;
    });
  },
};

/**
 * Exported so the chunking can be tested directly. The platform test below is
 * evaluated at import time, and jest-expo runs the suite under a web platform too,
 * where `sessionStorage` would resolve to the localStorage adapter and the
 * interesting code would go unexercised on every run.
 *
 * Deliberately the **unmirrored** store: what these tests are about is the split, the
 * rejoin and the interrupted write, none of which a memory hit would reach.
 */
export const chunkedSecureStore = disk;

export const sessionStorage = Platform.OS === 'web' ? web : native;
