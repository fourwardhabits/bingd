import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The four metrics, in the order the chips draw them.
 *
 * **Titles | Movies | TV | Reviews**, which is the founder's correction of 2026-08-28.
 * Titles is the union of the two beside it, so the row reads as a total followed by its
 * two halves and then a different question — rather than the total, a different question,
 * and then the halves, which is what the first pass had.
 *
 * The value is the server's metric name, so the chip and the RPC argument are the same
 * string and there is no mapping table to fall out of step. `monthly_leaderboard` raises
 * P0002 on anything outside this set rather than falling back to the default, so a typo
 * here is a visible failure rather than a board about the wrong question.
 */
export const LEADERBOARD_METRICS = [
  { value: 'titles', label: 'Titles' },
  { value: 'movies', label: 'Movies' },
  { value: 'tv', label: 'TV' },
  { value: 'reviews', label: 'Reviews' },
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number]['value'];

export const DEFAULT_METRIC: LeaderboardMetric = 'titles';

export type LeaderboardEntry = {
  id: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** True when the account is private, so a tap lands on the locked shell. */
  isPrivate: boolean;
  count: number;
  /** Ties share a rank, so this is not the row's index. */
  rank: number;
  isYou: boolean;
};

export type MyStanding = {
  count: number;
  /** Null when they have done nothing this month — no position, rather than last. */
  rank: number | null;
  /** How many people are on the board *this viewer* can see. */
  entrants: number;
};

/**
 * This calendar month's standing, as far as this viewer is allowed to know.
 *
 * ---------------------------------------------------------------------------
 * IT IS A DIFFERENT LIST FOR EVERY READER, AND THAT IS NOT A CACHING PROBLEM
 *
 * `monthly_leaderboard` filters its population through `can_view_profile`, so a private
 * account the viewer has not been approved by is absent — count and all (founder §26).
 * That makes the answer *entirely* about who is asking, which is why the viewer is in
 * the query key. A key without it serves one reader another's board after an account
 * switch on a shared device, which is the defect reviews 6 and 10 each found somewhere
 * else in this app.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT WIRED INTO `invalidateAfterCollectionChange`
 *
 * Logging a film moves the reader's own row, so the temptation is to invalidate from
 * there. It is not worth it: the board is a monthly aggregate over everybody, the
 * reader's own contribution is one row of it, and the surface is reached by a deliberate
 * toggle rather than left on screen. A minute of `staleTime` and a pull-to-refresh is the
 * honest cost — and unlike the Reviews tab, nothing here *looks* like the reader's own
 * write failing to persist, which is the thing that made the missing invalidation there a
 * bug rather than a latency.
 */
export function useLeaderboard(viewerId: string, metric: LeaderboardMetric, enabled = true) {
  return useQuery({
    queryKey: ['leaderboard', viewerId, metric],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<LeaderboardEntry[]> => {
      const { data, error } = await supabase.rpc('monthly_leaderboard', {
        p_metric: metric,
        p_limit: 50,
      });
      if (error) throw error;

      return ((data ?? []) as {
        user_id: string;
        username: string;
        display_name: string | null;
        avatar_path: string | null;
        visibility: string;
        metric_count: number;
        rank: number;
        is_you: boolean;
      }[]).map((row) => ({
        id: row.user_id,
        username: row.username,
        name: row.display_name || row.username,
        avatarUri: avatarUri(row.avatar_path),
        isPrivate: row.visibility === 'private',
        count: row.metric_count,
        rank: row.rank,
        isYou: row.is_you,
      }));
    },
  });
}

/**
 * Where the reader stands, for the pinned row when their rank is past the end of the page.
 *
 * A second query rather than a field on the board, because it answers a question the
 * board structurally cannot: a rank of 84 is not on a page of 50. The board's own
 * `is_you` is what tells the screen which of the two to draw, so the pinned row and a
 * visible row can never both appear.
 */
export function useMyStanding(viewerId: string, metric: LeaderboardMetric, enabled = true) {
  return useQuery({
    queryKey: ['leaderboard-standing', viewerId, metric],
    enabled: enabled && Boolean(viewerId),
    staleTime: 60_000,
    queryFn: async (): Promise<MyStanding> => {
      const { data, error } = await supabase.rpc('my_leaderboard_standing', {
        p_metric: metric,
      });
      if (error) throw error;

      const row = (data as { metric_count: number; rank: number | null; entrants: number }[])?.[0];
      return {
        count: row?.metric_count ?? 0,
        rank: row?.rank ?? null,
        entrants: row?.entrants ?? 0,
      };
    },
  });
}

/**
 * The heading, and the one place the month is named.
 *
 * "This month" rather than the month's name. Both were on the table and the founder
 * allowed either; this one is right for the same reason `relativeTime` is used on the
 * feed — a reader knows what month it is, and the useful fact is that the board *resets*,
 * which "This month" says and "August" does not.
 */
export const LEADERBOARD_TITLE = 'This month';

/**
 * What an empty board says, per metric.
 *
 * Two sentences: what is true, then what the reader could do about it. The founder asked
 * for playful but restrained, which rules out both the scolding version ("you have
 * watched nothing") and the excitable one. The second line is an invitation and is
 * deliberately not a button — there is nothing to press here that the tab bar does not
 * already offer.
 */
export function emptyCopy(metric: LeaderboardMetric): { title: string; body: string } {
  switch (metric) {
    case 'movies':
      return { title: 'No films yet this month.', body: 'You could take the first spot.' };
    case 'tv':
      return { title: 'No seasons yet this month.', body: 'You could take the first spot.' };
    case 'reviews':
      return { title: 'No reviews yet this month.', body: 'Yours could be the first.' };
    default:
      return { title: 'No watches yet this month.', body: 'You could take the first spot.' };
  }
}

/**
 * The unit under a number, singular where it should be.
 *
 * "1 title" and not "1 titles", which is the sort of thing that reads as broken on the
 * one row a small beta most wants to look at — the reader's own, on a quiet month.
 */
export function countLabel(metric: LeaderboardMetric, count: number): string {
  const noun =
    metric === 'movies' ? 'film' : metric === 'tv' ? 'season' : metric === 'reviews' ? 'review' : 'title';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
