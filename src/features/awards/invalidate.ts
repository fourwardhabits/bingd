import type { QueryClient } from '@tanstack/react-query';

/**
 * The one place that knows Bingd Awards is cached, and the table of what moves it.
 *
 * **This is the third time the same defect has been found**, which is why it is a module
 * rather than a line. Awards is derived — there is no unlock ledger and no scheduler, so
 * every badge is a question asked of canonical data when the sheet opens (`use-awards.ts`)
 * — and it is cached for a minute. Both of those are right. What was wrong is that the
 * writers which change the answer did not say so.
 *
 * Review 21 found the collection path missing. `23a237f` fixed that one path. Review 21b
 * found the other four, and the shape of that finding is the point: **a fix applied at the
 * call site fixes the call sites you thought of.** So the knowledge lives here, one
 * function, and a new writer either calls it or is visibly missing from the table below.
 *
 * What it deliberately does not do is invalidate broadly. `queryClient.clear()` or an
 * unkeyed invalidate would take the catalogue, search and every other account's cache with
 * it, and this is a once-in-a-while write, not a per-keystroke one. The key carries the
 * account precisely so one reader's comment cannot refetch another's awards.
 */
export function invalidateAwards(queryClient: QueryClient, userId: string) {
  if (!userId) return;
  // Prefix, matching `useAwards`' `['awards', userId]` exactly and reaching any
  // descendant a future variant of the query adds.
  void queryClient.invalidateQueries({ queryKey: ['awards', userId] });
}

/**
 * Which mutations move which award, and which do not.
 *
 * Exported because a table in a comment is a table nothing checks. `invalidate.test.ts`
 * walks this and asserts that every `invalidates: true` row has a writer wired to
 * `invalidateAwards`, so adding a track without deciding what moves it is a test failure
 * rather than a stale badge on somebody's screen.
 *
 * The `false` rows are as load-bearing as the `true` ones: they are the audit's answer
 * that these were considered, not that they were forgotten. Independent review 21b
 * confirmed each of them.
 */
export const AWARD_SOURCES = [
  {
    metric: 'watched',
    awards: 'Movie Muncher, Season Snacker, the genre tracks, Passport Mode, Two-Screen Life',
    mutations: 'log, unlog, remove from collection, edit a watch date',
    writer: 'invalidateAfterCollectionChange',
    invalidates: true,
  },
  {
    metric: 'rankings',
    awards: 'Rating Rascal',
    mutations: 'rank, re-bucket, remove a ranking',
    writer: 'invalidateAfterCollectionChange',
    invalidates: true,
  },
  {
    metric: 'watchlist',
    awards: 'Queue Dragon',
    // Both routes: ranking removes the title from the watchlist server-side
    // (20260815040000), and the four surfaces with a bookmark control write it directly.
    mutations: 'add to or remove from the watchlist, from any of the four surfaces',
    writer: 'invalidateAfterWatchlistChange',
    invalidates: true,
  },
  {
    metric: 'written',
    awards: 'Comment Gremlin',
    // A public note is a `user_media` row, so the collection helper covers that half; a
    // comment is its own table and needed wiring.
    mutations: 'post, edit or delete a comment; save or clear a public note',
    writer: 'useCommentWrites + invalidateAfterCollectionChange',
    invalidates: true,
  },
  {
    metric: 'recommendationsSent',
    awards: 'Hype Courier',
    mutations: 'send a recommendation',
    writer: 'useRecommendTitle',
    invalidates: true,
  },
  {
    metric: 'mutualFollows',
    awards: 'Mutual Mania',
    // Following back an existing follower is the one that moves it locally: 4 → 5 with
    // no other trigger. Blocking removes both edges, so it moves the number down.
    mutations: 'follow, unfollow, approve a request, block, unblock',
    writer: 'useSocialWrites',
    invalidates: true,
  },
  {
    metric: 'reactionsReceived',
    awards: 'Heart Magnet',
    // The reader's own reaction is excluded from their own award by `neq('user_id')`,
    // so pressing one changes *somebody else's* Heart Magnet — on a device this app is
    // not running on. Nothing local can invalidate it, which is what the one-minute
    // staleTime is actually for.
    mutations: 'other people reacting to this reader’s activity',
    writer: null,
    invalidates: false,
  },
  {
    metric: 'invitedSignups',
    awards: 'Invite Instigator',
    // `activated_at` is written by nothing yet: there is no link resolver and
    // `app/i/[token].tsx` is a placeholder. When one exists it belongs in this table.
    mutations: 'an invitee activating — no writer exists yet',
    writer: null,
    invalidates: false,
  },
] as const;

/** Metrics no mutation on this device can move, so no writer owes them anything. */
export const AWARD_SOURCES_WITHOUT_A_WRITER = AWARD_SOURCES.filter(
  (source) => !source.invalidates,
).map((source) => source.metric);
