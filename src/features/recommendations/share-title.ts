import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Platform, Share } from 'react-native';

import { compactName, type MediaKind } from '@/lib/titles';

import { normaliseNote } from './use-recommend';

export type ShareableTitle = {
  mediaItemId: string;
  kind: MediaKind;
  title: string;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
};

/**
 * **Share off bingd's glyph**: each platform's own share symbol, so the control reads as
 * "through another app" rather than as a second Recommend. Drawn on the Recommend sheet's
 * Share off bingd button (it was the title page's ⋯ row in #350).
 */
export const SHARE_ICON: ComponentProps<typeof Ionicons>['name'] =
  Platform.OS === 'android' ? 'share-social-outline' : 'share-outline';

/**
 * The link an off-platform title share carries: one segment, `media_items.id`.
 *
 * It used to be `/title/<kind>/<id>`, which no route serves, so every share opened
 * `+not-found` for anybody with the app and a 404 for anybody without it. `/title/*` is
 * claimed in the Apple App Site Association file and already sits inside links people
 * have been sent, so the path is not renamed.
 */
export const titleShareUrl = (mediaItemId: string): string =>
  `https://bingd.app/title/${mediaItemId}`;

/**
 * The message an off-platform title share sends: an optional note, the title's compact
 * name, and its link. Nothing else — no invite link and no sender identity (the reasons
 * are on `RecommendSheet`'s `shareOffPlatform`, where this lived first).
 */
export function titleShareMessage(subject: ShareableTitle, note?: string | null): string {
  const name =
    compactName({
      kind: subject.kind,
      title: subject.title,
      seriesTitle: subject.seriesTitle,
      seasonNumber: subject.seasonNumber,
    }) ?? subject.title;
  const typed = normaliseNote(note ?? '');
  return `${typed ? `${typed}\n\n` : ''}${name} on bingd\n${titleShareUrl(subject.mediaItemId)}`;
}

/**
 * **Share off bingd**: the native share sheet, carrying the title's link.
 *
 * Its one door is the Recommend sheet's secondary button; the title page's ⋯ row that
 * also called it (#350) was removed on the founder's review of the live build. Rejects when the operating system could not open the sheet; the
 * caller decides where that is said.
 */
export async function shareTitleOffBingd(
  subject: ShareableTitle,
  note?: string | null,
): Promise<void> {
  await Share.share({
    message: titleShareMessage(subject, note),
    url: titleShareUrl(subject.mediaItemId),
  });
}
