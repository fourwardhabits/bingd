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
