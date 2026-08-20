import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

export type ReviewSort = 'top' | 'recent';

export type TitleReview = {
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** The author's own Bingd score, or null if they wrote without ranking. */
  score: number | null;
  text: string;
  hasSpoilers: boolean;
  updatedAt: string | null;
  /** Reactions on the activity this note belongs to. */
  reactionCount: number;
};

/**
 * Reviews on a title, which are Bingd's own public Notes.
 *
 * **There is no second content model, and that is the whole design.** A review is a
 * public Note on this exact canonical movie or season — the same text the Feed shows,
 * governed by the same `note_visibility`, carrying the same spoiler flag, reportable
 * the same way. One source of truth, which is what the founder asked for in as many
 * words. Writing one is `save_note` through the log sheet; there is no separate
 * composer and there is nothing to keep in step.
 *
 * What this replaced was TMDB's reviews, which are another site's members writing about
 * a film. They were labelled honestly and they were still the wrong content for a tab
 * called Reviews on a social product: the founder's correction is that the tab should
 * be Bingd's, and the alternative — relabelling somebody else's user-generated content
 * as critic or professional writing — is the one thing that was never on the table.
 *
 * `title_reviews` is definer and reuses `public_notes`' visibility predicate verbatim,
 * so a private author, a block in either direction and a suspended account are all
 * handled in the one place this schema expresses that rule. It adds the three facts
 * `public_notes` deliberately refuses to carry: who wrote it, their **live** score
 * (derived, not the feed event's snapshot, which drifts), and how many people reacted
 * to the activity the note belongs to.
 */
export function useTitleReviews(mediaItemId: string | null, sort: ReviewSort) {
  return useQuery({
    queryKey: ['title-reviews', mediaItemId, sort],
    enabled: Boolean(mediaItemId),
    queryFn: async (): Promise<TitleReview[]> => {
      const { data, error } = await supabase.rpc('title_reviews', {
        p_media_item_id: mediaItemId,
        p_sort: sort,
        p_limit: 50,
      });
      if (error) throw error;

      return ((data ?? []) as {
        user_id: string;
        username: string;
        display_name: string | null;
        avatar_path: string | null;
        note: string;
        has_spoilers: boolean;
        updated_at: string | null;
        score: string | number | null;
        reaction_count: number | null;
      }[]).map((row) => ({
        userId: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        // `numeric` crosses the wire as a string. Converted once, here, rather than at
        // every place a score is formatted.
        score: row.score === null ? null : Number(row.score),
        text: row.note,
        hasSpoilers: row.has_spoilers,
        updatedAt: row.updated_at,
        reactionCount: row.reaction_count ?? 0,
      }));
    },
  });
}
