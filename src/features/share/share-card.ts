import * as Sharing from 'expo-sharing';
import type { RefObject } from 'react';
import { Share, type View } from 'react-native';
import { captureRef, releaseCapture } from 'react-native-view-shot';

/**
 * Captures a mounted card and opens the system share sheet on the image.
 *
 * Throws when no image could be made or the platform cannot share a file, so the caller
 * can offer the words instead. Dismissing the share sheet is not a failure: the OS does
 * not say what somebody did with it, so this resolves either way.
 *
 * `useRenderInContext` is iOS only and is what lets a card be captured while its preview
 * is scaled to fit the sheet: it draws the layer in its own coordinates, where the default
 * snapshot would take on the scale. Android's capture already ignores a parent's transform.
 *
 * The file is released even when sharing throws, because it is the person's list sitting
 * in a cache folder, and nothing else will clean it up before the OS does.
 */
export async function shareCardImage(
  card: RefObject<View | null>,
  dialogTitle: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing a file is not available here.');
  }

  const uri = await captureRef(card, {
    format: 'png',
    quality: 1,
    result: 'tmpfile',
    useRenderInContext: true,
  });

  try {
    await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle });
  } finally {
    releaseCapture(uri);
  }
}

/** The fallback: the same list as a message, through the sheet every other share uses. */
export async function shareCardText(message: string): Promise<void> {
  await Share.share({ message });
}
