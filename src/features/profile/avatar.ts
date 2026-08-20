import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '@/lib/supabase';
import { classifyStorageWrite, classifyWrite } from '@/lib/write-outcome';

/**
 * Choosing, downscaling, and uploading a profile picture.
 *
 * Kept out of the component because three of the four steps can fail in ways
 * that need distinguishing — a declined permission is not an error, a failed
 * upload is, and a failed cleanup of the previous file is neither.
 */

/** Displayed at 44pt at the largest, so 512 is already generous at 3x. */
const EDGE = 512;

/** Enough for a face at this size; the difference from 0.9 is invisible and
 *  roughly halves the bytes. */
const QUALITY = 0.8;

export type AvatarResult =
  | { outcome: 'ok'; path: string }
  | { outcome: 'cancelled' }
  | { outcome: 'denied' }
  /**
   * `changed` means `set_avatar` may have moved the profile's pointer anyway — the same
   * flag, and the same rule, as `collection/writes.ts`. The caller refetches the profile
   * on it rather than leaving a face on screen that is no longer the stored one.
   */
  | { outcome: 'failed'; message: string; changed?: boolean };

/**
 * Opens the library, downscales what comes back, uploads it, and points the
 * profile at it.
 *
 * The order matters. The profile row is updated only after the bytes are
 * readable, so a failed upload leaves the old picture in place rather than a
 * broken image; and the previous file is deleted only after the row has moved,
 * so a failure in between costs an orphaned object rather than a missing face.
 */
export async function pickAndUploadAvatar(userId: string, previousPath: string | null) {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { outcome: 'denied' } as const;

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    // Square, because every surface that renders an avatar renders it in a
    // circle. Cropping at the source beats cropping at every call site.
    aspect: [1, 1],
    quality: 1,
  });
  if (picked.canceled || !picked.assets[0]) return { outcome: 'cancelled' } as const;

  try {
    const path = await upload(userId, picked.assets[0].uri);

    // The pointer moves before the old file goes, and the old file going is not
    // allowed to fail the operation: the user's picture has already changed.
    if (previousPath && previousPath !== path) {
      void supabase.storage.from('avatars').remove([previousPath]);
    }

    return { outcome: 'ok', path } as const;
  } catch (error) {
    // `upload` marks the pointer write it could not account for. Anything else that
    // throws here — a failed resize, a failed upload — never reached `set_avatar`.
    const changed = (error as { pointerMayHaveMoved?: boolean })?.pointerMayHaveMoved === true;
    return {
      outcome: 'failed',
      message: error instanceof Error ? error.message : 'The upload did not finish.',
      changed,
    } as const;
  }
}

/** Clears the picture without touching the library. */
export async function removeAvatar(previousPath: string | null): Promise<AvatarResult> {
  const { error } = await supabase.rpc('set_avatar', { p_object_path: null });
  if (error) {
    // A refusal this app raises on purpose left the pointer where it was. Anything else
    // may have cleared it, and the caller has a profile to refetch either way
    // (`lib/write-outcome.ts`). Independent review 21e's invariant.
    return {
      outcome: 'failed',
      message: error.message,
      changed: classifyWrite(error) === 'unknown',
    };
  }

  if (previousPath) void supabase.storage.from('avatars').remove([previousPath]);
  return { outcome: 'ok', path: '' };
}

/**
 * What a sweep of the avatar folder actually established.
 *
 * A count on its own could not answer the question the caller has, which is not "how
 * many" but "**is there anything to reconcile, and can I claim this finished**". A
 * single `number | null` collapsed three different states into one `null`: nothing was
 * removed; something was removed and then a later page failed; a removal request was
 * never answered. Independent review 21e found the middle one on screen — the first page
 * of pictures deleted, the next listing refused, `delete_account` refused after it, and
 * the generic alert shown over a profile whose picture had silently gone.
 */
export type AvatarSweep = {
  /**
   * Objects this call **definitely** removed: a `remove` that was acknowledged. A floor
   * rather than a total whenever `uncertain` is set.
   */
  removed: number;
  /**
   * True only when the folder was walked to the end and everything in it went. False for
   * a failed listing, a nested entry, an unanswered removal, or the page ceiling.
   */
  complete: boolean;
  /**
   * A removal request went unanswered, so the bytes it named may be gone without this
   * count saying so. Distinct from `complete`, which is about the *folder*; this is
   * about the *number*.
   */
  uncertain: boolean;
};

/** Whether the caller has a profile to refetch, whatever else it is about to say. */
export const avatarsMayHaveGone = (sweep: AvatarSweep) => sweep.removed > 0 || sweep.uncertain;

/**
 * Every picture this account has ever uploaded, deleted through the Storage API.
 *
 * **Through the API, and this is the whole point of the function.** Deleting a row
 * from `storage.objects` in SQL removes the metadata and leaves the file itself in
 * the bucket — Supabase says so explicitly, and independent review 14 raised it as a
 * Blocker against an account deletion that claimed to remove the picture and only
 * removed the row pointing at it. The API call is the only thing that removes bytes.
 *
 * Every upload writes a fresh filename (`upload` below says why), so an account that
 * has changed its picture three times has three objects and only the current one is
 * named by `profiles.avatar_path`. Listing the folder is what finds the other two.
 *
 * The storage policies key on the path's first segment being the caller's own uuid,
 * so this can only ever reach the caller's own folder — the same rule `set_avatar`
 * restates where the profile row is touched.
 *
 * **Nothing it has already done is discarded when a later step fails.** Each page that
 * comes back acknowledged is added to `removed` and stays there; the loop then stops and
 * reports why. That is the whole of review 21e's fourth Major: the previous version
 * returned `null` from any later failure, so "we removed nothing" and "we removed the
 * first hundred and then lost the connection" reached the caller as the same value.
 *
 * A **listing** that fails costs nothing but certainty: it is a read, so it cannot have
 * changed anything, and `removed` still stands exactly. A **removal** that fails is the
 * ambiguous one — `classifyStorageWrite` separates a 4xx, which is the API declining a
 * request it understood, from a 5xx or a dead socket, which may well have deleted the
 * objects on the way to failing.
 */
export async function deleteAllAvatars(userId: string): Promise<AvatarSweep> {
  const PAGE = 100;
  // A ceiling, so a listing that never shortens cannot loop forever. Ten thousand
  // objects is far past anything a real account produces and far short of a hang.
  const MAX_PAGES = 100;

  let removed = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Always offset zero, because the previous pass deleted what it listed — paging
    // forward through a shrinking list would skip a page for every page removed.
    const { data, error } = await supabase.storage
      .from('avatars')
      .list(userId, { limit: PAGE, offset: 0 });
    // A read cannot have changed anything, so what earlier pages did still stands
    // exactly. Only the folder's emptiness is now unknown.
    if (error) return { removed, complete: false, uncertain: false };

    const listed = data ?? [];
    // `list` returns two kinds of thing: objects, which carry an id, and *prefixes* —
    // subfolders — which do not. Passing a prefix to `remove` is a no-op that reports
    // success, so counting one would overstate what was deleted. (Supabase's
    // `.emptyFolderPlaceholder` is a real object with a real id and is removed like
    // any other; it is not what this filter is about.)
    const objects = listed.filter((object) => Boolean(object.name) && object.id !== null);

    // **Anything that is not a removable object stops this.** Independent review 14c:
    // the storage insert policy checks only that the *first* path segment is the
    // caller's uuid, so a modified client could have written `{id}/nested/file.jpg`
    // — and Storage lists `nested` as an entry with no id. Filtering it away and then
    // deciding the page was short would report success while those bytes stayed in
    // the bucket. `20260817000600` narrows the policy so nothing new can nest; this
    // is what makes the answer honest about anything that already did.
    //
    // Not a recursive walk: the app has never written a nested path, so finding one
    // means something unexpected is in the folder, and "we could not be sure this is
    // finished" is the true statement rather than a best effort dressed as completion.
    if (objects.length !== listed.length) return { removed, complete: false, uncertain: false };

    if (!objects.length) return { removed, complete: true, uncertain: false };

    const { error: removeError } = await supabase.storage
      .from('avatars')
      .remove(objects.map((object) => `${userId}/${object.name}`));

    if (removeError) {
      // A 4xx is the API declining a request it understood, so those objects are still
      // there and `removed` is exact. Anything else — a 5xx, a timeout, a socket that
      // died with the DELETE already sent — may have removed every one of them.
      const uncertain = classifyStorageWrite(removeError) === 'unknown';
      return { removed, complete: false, uncertain };
    }

    removed += objects.length;

    // A short page means the listing had nothing more to give. Measured on the raw
    // listing, which is now the same set — the check above guarantees it. Independent
    // review 14b: the first version stopped after one page of a hundred and reported
    // success, so an account with more uploads than that had its remaining bytes
    // orphaned by the metadata sweep with nobody told.
    if (listed.length < PAGE) return { removed, complete: true, uncertain: false };
  }

  // Ran out of passes with the folder still non-empty. Everything counted did go; what
  // is not established is that nothing is left.
  return { removed, complete: false, uncertain: false };
}

async function upload(userId: string, sourceUri: string) {
  const context = ImageManipulator.manipulate(sourceUri).resize({ width: EDGE, height: EDGE });
  const image = await context.renderAsync();
  const resized = await image.saveAsync({ compress: QUALITY, format: SaveFormat.JPEG });

  // A fresh name each time. Overwriting at a stable path would leave the CDN
  // and every already-rendered `<Image>` serving the previous face until their
  // caches expired, which reads as the upload having silently failed.
  const path = `${userId}/${Date.now()}.jpg`;

  // `fetch` on a local file URI is how a React Native client turns one into
  // bytes; `FormData` and a bare path both fail here, and both fail by
  // uploading a zero-byte object rather than by raising.
  const body = await (await fetch(resized.uri)).arrayBuffer();

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, body, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) throw uploadError;

  const { error: pointerError } = await supabase.rpc('set_avatar', { p_object_path: path });
  if (pointerError) {
    /**
     * **The cleanup only runs when the pointer certainly did not move.**
     *
     * The bytes are up, and if `set_avatar` was refused nothing references them —
     * removing them keeps the bucket from accumulating orphans. But if the outcome is
     * unknown the row may already point here, and deleting the object would turn a
     * recoverable "try again" into a profile whose avatar URL 404s for everybody who
     * loads it. An orphaned object costs a few kilobytes; this costs a face.
     *
     * The flag rides on the thrown error because `pickAndUploadAvatar` is the only
     * caller and it needs to know whether there is a profile to refetch.
     */
    if (classifyWrite(pointerError) === 'unknown') {
      throw Object.assign(pointerError, { pointerMayHaveMoved: true });
    }
    void supabase.storage.from('avatars').remove([path]);
    throw pointerError;
  }

  return path;
}
