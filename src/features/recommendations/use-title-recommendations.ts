import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

import type { SentRecommendation } from './use-sent-to-you';

/**
 * Who recommended *this* title to the reader (20260929000100).
 *
 * The title page used to learn this from the link — `recBy` and `recAt`, set by a tap in
 * Sent to you and by nothing else — on the reasoning that the fact belonged to the
 * navigation. The approved note tranche reverses that: a friend's unanswered
 * recommendation, and now the words they sent with it, is a fact about this title *for
 * this reader* until they rank it, however they arrived. A push, the inbox, search and the
 * Feed all land here without a parameter, and the note is the one thing they most need.
 *
 * So the page asks. `title_recommendations_for_me` is `security invoker` and filters on
 * `recipient_id = auth.uid()`: RLS admits only delivered rows (a pending note stays
 * unreadable), `profiles_read` drops blocked and private senders, and suspended ones are
 * joined away. Nothing here decides visibility.
 */

export type TitleRecommendation = {
  id: string;
  senderId: string;
  senderUsername: string;
  senderName: string;
  senderAvatarUri: string | null;
  message: string | null;
  recommendedAt: string;
  openedAt: string | null;
};

type Row = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string | null;
  sender_avatar_path: string | null;
  message: string | null;
  recommended_at: string;
  opened_at: string | null;
};

export const titleRecommendationsKey = (viewerId: string, mediaItemId: string) =>
  ['title-recommendations', viewerId, mediaItemId] as const;

/**
 * The delivered recommendations of one exact title, newest first, at most ten.
 *
 * `enabled` is the caller's: the page asks only for a film or a season the reader has
 * not ranked, which is the same rule Sent to you applies (`withoutRanked`). A failure
 * leaves the page without the card rather than failing anything — including against a
 * backend one migration behind, which answers with a missing function.
 */
export function useTitleRecommendations(viewerId: string, mediaItemId: string, enabled: boolean) {
  return useQuery({
    queryKey: titleRecommendationsKey(viewerId, mediaItemId),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<TitleRecommendation[]> => {
      const { data, error } = await supabase.rpc('title_recommendations_for_me', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;
      return ((data ?? []) as Row[]).map(fromRow);
    },
  });
}

const fromRow = (row: Row): TitleRecommendation => ({
  id: row.id,
  senderId: row.sender_id,
  senderUsername: row.sender_username,
  senderName: row.sender_display_name || row.sender_username,
  senderAvatarUri: avatarUri(row.sender_avatar_path),
  message: row.message,
  recommendedAt: row.recommended_at,
  openedAt: row.opened_at,
});

/**
 * What Sent to you already knows, in the shape the title page reads.
 *
 * Handed to `setQueryData` on the way through a Sent to you tap so the card is on the
 * page's first frame instead of arriving a round trip later. Every delivered row for the
 * title is used, not only the one tapped, so "Ada and 2 others" is right from the start;
 * the seed is marked stale so the page still asks the server once.
 */
export const seedFromSentToYou = (
  rows: readonly SentRecommendation[],
  mediaItemId: string,
): TitleRecommendation[] =>
  rows
    .filter((row) => row.mediaItemId === mediaItemId)
    .map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderUsername: row.senderUsername,
      senderName: row.senderName,
      senderAvatarUri: row.senderAvatarUri,
      message: row.message,
      recommendedAt: row.recommendedAt,
      openedAt: row.openedAt,
    }))
    .sort((a, b) => b.recommendedAt.localeCompare(a.recommendedAt));

/**
 * The recommendation the card leads with.
 *
 * The newest one that carries a note, because a note is the more useful fact and the
 * sheet has everybody else; the newest of all when nobody wrote one. Rows arrive newest
 * first from the server, and the seed is sorted the same way.
 */
export function headlineOf(rows: readonly TitleRecommendation[]): TitleRecommendation | null {
  return rows.find((row) => row.message) ?? rows[0] ?? null;
}
