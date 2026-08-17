import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '@/lib/supabase';

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
  | { outcome: 'failed'; message: string };

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
    return {
      outcome: 'failed',
      message: error instanceof Error ? error.message : 'The upload did not finish.',
    } as const;
  }
}

/** Clears the picture without touching the library. */
export async function removeAvatar(previousPath: string | null): Promise<AvatarResult> {
  const { error } = await supabase.rpc('set_avatar', { p_object_path: null });
  if (error) return { outcome: 'failed', message: error.message };

  if (previousPath) void supabase.storage.from('avatars').remove([previousPath]);
  return { outcome: 'ok', path: '' };
}

/**
 * Every picture this account has ever uploaded, deleted through the Storage API.
 *
 * **Through the API, and this is the whole point of the function.** Deleting a row
 * from `storage.objects` in SQL removes the metadata and leaves the file itself in
 * the bucket — Supabase says so explicitly, and independent review 14 raised it as a
 * Blocker against an account deletion that claimed to remove the picture and only
 * removed the row pointing at it. The API call is the only thing that removes bytes.
 *
 * Every upload writes a fresh filename (`upload` above says why), so an account that
 * has changed its picture three times has three objects and only the current one is
 * named by `profiles.avatar_path`. Listing the folder is what finds the other two.
 *
 * The storage policies key on the path's first segment being the caller's own uuid,
 * so this can only ever reach the caller's own folder — the same rule `set_avatar`
 * restates where the profile row is touched.
 *
 * Returns how many were removed, or null when the listing itself failed. Null is not
 * zero: the caller has to be able to tell "there was nothing" from "we could not
 * look", because only one of those is safe to describe as having deleted anything.
 */
export async function deleteAllAvatars(userId: string): Promise<number | null> {
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
    if (error) return null;

    const listed = data ?? [];
    // A folder placeholder has no id. Passing one to `remove` is a no-op that reports
    // success, so counting it would overstate what was deleted.
    const objects = listed.filter((object) => Boolean(object.name) && object.id !== null);

    // **Anything that is not a removable object stops this.** Independent review 14c:
    // the storage insert policy checks only that the *first* path segment is the
    // caller's uuid, so a modified client could have written `{id}/nested/file.jpg`
    // — and Storage lists `nested` as an entry with no id. Filtering it away and then
    // deciding the page was short would report success while those bytes stayed in
    // the bucket. `20260817000600` narrows the policy so nothing new can nest; this
    // is what makes the answer honest about anything that already did.
    //
    // Null rather than a recursive walk: the app has never written a nested path, so
    // finding one means something unexpected is in the folder, and "we could not be
    // sure" is the true statement rather than a best effort dressed as completion.
    if (objects.length !== listed.length) return null;

    if (!objects.length) return removed;

    const { error: removeError } = await supabase.storage
      .from('avatars')
      .remove(objects.map((object) => `${userId}/${object.name}`));
    if (removeError) return null;
    removed += objects.length;

    // A short page means the listing had nothing more to give. Measured on the raw
    // listing, which is now the same set — the check above guarantees it. Independent
    // review 14b: the first version stopped after one page of a hundred and reported
    // success, so an account with more uploads than that had its remaining bytes
    // orphaned by the metadata sweep with nobody told.
    if (listed.length < PAGE) return removed;
  }

  // Ran out of passes with the folder still non-empty. Null rather than the count,
  // because the caller's whole use for this is telling "everything is gone" from
  // "something may be left", and this is the second.
  return null;
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
    // The bytes are up but nothing points at them. Removing them keeps the
    // bucket from accumulating objects no profile references.
    void supabase.storage.from('avatars').remove([path]);
    throw pointerError;
  }

  return path;
}
