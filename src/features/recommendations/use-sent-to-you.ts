import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { CollectionItem } from '@/features/collection/filters';
import { avatarUri } from '@/lib/images';
import { effectiveGenres, effectiveLanguage, parentOf, type EmbeddedParent } from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';

/**
 * `Sent to you`: the human half of the recommendations tab.
 *
 * Deliberately not merged into For You. The algorithm's slate is built from the
 * reader's own taste and a popularity prior, and PRD §13 requires every reason it
 * gives to be reproducible from stored signals — a friend's opinion is neither, and
 * mixing the two would make the engine assert something it did not compute.
 */

export type SentRecommendation = {
  id: string;
  senderId: string;
  senderUsername: string;
  senderName: string;
  senderAvatarUri: string | null;
  mediaItemId: string;
  kind: 'movie' | 'season' | 'series';
  title: string;
  seriesTitle: string | null;
  posterPath: string | null;
  year: number | null;
  genres: string[];
  language: string | null;
  runtimeMinutes: number | null;
  recommendedAt: string;
  openedAt: string | null;
};

type Row = {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string | null;
  sender_avatar_path: string | null;
  media_item_id: string;
  media_kind: 'movie' | 'season' | 'series';
  media_title: string;
  series_title: string | null;
  poster_path: string | null;
  release_date: string | null;
  genres: string[] | null;
  original_language: string | null;
  runtime_minutes: number | null;
  recommended_at: string;
  opened_at: string | null;
};

const yearOf = (date: string | null): number | null => {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
};

/**
 * The list, in the order the server returns it.
 *
 * Ordering is the database's — unopened first, then newest — and is deliberately not
 * re-sorted here. Two sorts over the same list is how a screen comes to disagree with
 * the badge above it.
 */
export function useSentToYou(viewerId: string) {
  return useQuery({
    queryKey: ['sent-to-you', viewerId],
    staleTime: 30_000,
    queryFn: async (): Promise<SentRecommendation[]> => {
      const { data, error } = await supabase.rpc('recommendations_to_me', {
        p_limit: SENT_LIMIT,
      });
      if (error) throw error;

      const rows = (data ?? []) as Row[];
      const inherited = await inheritedMetadata(rows);

      return rows.map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        senderUsername: row.sender_username,
        senderName: row.sender_display_name || row.sender_username,
        senderAvatarUri: avatarUri(row.sender_avatar_path),
        mediaItemId: row.media_item_id,
        kind: row.media_kind,
        title: row.media_title,
        seriesTitle: row.series_title,
        posterPath: row.poster_path,
        year: yearOf(row.release_date),
        ...(inherited.get(row.media_item_id) ?? {
          genres: row.genres ?? [],
          language: row.original_language,
        }),
        runtimeMinutes: row.runtime_minutes,
        recommendedAt: row.recommended_at,
        openedAt: row.opened_at,
      }));
    },
  });
}

/**
 * The genres and language of any **seasons** in the list, taken from their series.
 *
 * `recommendations_to_me` returns the media row's own `genres` and
 * `original_language`, and a season has neither — so a recommended season was
 * invisible the moment the reader put a genre filter on the tab, which is the same
 * defect the collection had before `lib/media-metadata.ts`.
 *
 * Resolved with one supplementary read of `media_items` rather than by widening the
 * RPC, because widening the RPC is a migration and this is a client-side composition
 * over a catalogue table every client can already read. One query, only when the list
 * actually contains a season, over at most the hundred rows the RPC returns.
 *
 * A failure here is not a failure of the list: the rows keep their own metadata, which
 * is what they had before, and the filter is the only thing that notices.
 */
async function inheritedMetadata(
  rows: readonly Row[],
): Promise<Map<string, { genres: string[]; language: string | null }>> {
  const seasonIds = rows.filter((row) => row.media_kind === 'season').map((row) => row.media_item_id);
  if (seasonIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('media_items')
    .select('id, genres, original_language, parent:parent_id(genres, original_language)')
    .in('id', seasonIds);
  if (error) return new Map();

  type SeasonRow = {
    id: string;
    genres: string[] | null;
    original_language: string | null;
    parent: EmbeddedParent;
  };

  const resolved = new Map<string, { genres: string[]; language: string | null }>();
  for (const season of (data ?? []) as unknown as SeasonRow[]) {
    const parent = parentOf(season.parent);
    const subject = {
      kind: 'season' as const,
      genres: season.genres,
      language: season.original_language,
      parent: parent ? { genres: parent.genres, language: parent.original_language } : null,
    };
    resolved.set(season.id, {
      genres: effectiveGenres(subject),
      language: effectiveLanguage(subject),
    });
  }
  return resolved;
}

/**
 * As many as this list can hold, which is as many as the server will return.
 *
 * `recommendations_to_me` clamps its `p_limit` to 200 (`20260817001300`), so this is the
 * ceiling and not a preference. It was 100, which is half of what was available for no
 * reason anybody wrote down.
 */
export const SENT_LIMIT = 200;

/** How many have not been opened, which is what the tab's dot carries. */
export const unopenedCount = (rows: SentRecommendation[] | undefined) =>
  (rows ?? []).filter((row) => !row.openedAt).length;

/**
 * Whether that number is the whole truth or a floor.
 *
 * **A capped list may not be presented as a total**, which is the rule this whole pass is
 * about, and this is the one place in the app where the cap is the server's rather than
 * PostgREST's — so it cannot be paged away without a migration. What it can be is honest.
 *
 * The server orders unopened first, so the unopened rows are a prefix of what arrives.
 * That makes the test exact rather than defensive: if the prefix does not fill the page,
 * every unopened recommendation is in hand and the count is the count. Only when the
 * whole page is unopened can there be more, and only then does the chip say "200+".
 *
 * Independent review 21c found this one, after the first sweep looked only at PostgREST's
 * cap and not at a limit the app asks for itself.
 */
export const unopenedIsAtLeast = (rows: SentRecommendation[] | undefined) =>
  (rows ?? []).length >= SENT_LIMIT && unopenedCount(rows) >= SENT_LIMIT;

/**
 * A recommendation as the shared filter sheet sees it.
 *
 * The same widening `asCollectionItem` performs for a For You candidate, and for the
 * same reason: one filter model over both tabs is what makes the founder's "Comedy on
 * For you, switch to Sent to you, still Comedy" true without a second implementation.
 *
 * Score, bucket and watch date are null. Nothing here has been ranked by the reader,
 * which is why the sheet is asked not to offer those controls.
 */
export const asCollectionItem = (row: SentRecommendation): CollectionItem => ({
  mediaItemId: row.mediaItemId,
  title: row.title,
  seriesTitle: row.seriesTitle,
  kind: row.kind,
  year: row.year,
  posterPath: row.posterPath,
  genres: row.genres,
  language: row.language,
  runtimeMinutes: row.runtimeMinutes,
  score: null,
  bucket: null,
  watchedOn: null,
});

/**
 * Marks one opened, once.
 *
 * Fired when the reader taps through to the title, which is the only moment anybody
 * can honestly call it opened. The server refuses to move an existing timestamp, so a
 * second tap changes nothing — and a failure is swallowed rather than surfaced,
 * because "we could not record that you looked at this" is not a sentence worth
 * interrupting somebody with.
 */
export function useMarkRecommendationOpened(viewerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (recommendationId: string) => {
      await supabase.rpc('mark_recommendation_opened', {
        p_recommendation_id: recommendationId,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sent-to-you', viewerId] }),
  });
}

/**
 * "2d ago", and the handful of shapes around it.
 *
 * A date alone is wrong for this list: recency is half of what the row is telling you,
 * and "17/08/2026" makes the reader do the subtraction. Absolute once it is past a
 * fortnight, where the exact interval has stopped being the useful fact.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days <= 14) return `${days}d ago`;

  return new Date(then).toLocaleDateString();
}
