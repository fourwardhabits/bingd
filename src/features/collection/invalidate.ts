import type { QueryClient } from '@tanstack/react-query';

import { invalidateAwards } from '@/features/awards/invalidate';
import { queryKeys } from '@/lib/query';

/**
 * Everything that stops being true when someone logs or ranks a title.
 *
 * The founder ranked a film and the Feed did not show it. The cause was not a race
 * or a cache time — the ranking path simply never invalidated the feed key. It
 * invalidated the category's rankings, the collection and the title, which is the set
 * that was correct when it was written and has been wrong since the feed started
 * reading `feed_events`, which `_rank_finalize` writes to.
 *
 * The reason it went unnoticed is that each writer kept its own list. Two sheets,
 * two lists, and a surface added later only ever gets added to one of them. So the
 * list lives here now, and both writers call it — a new surface is added in one place
 * or it is broken in both, which is at least a failure that shows up immediately.
 *
 * This is deliberately not `queryClient.clear()` or an unkeyed invalidate. Every key
 * below is one a completed ranking genuinely changes, and the expensive reads that it
 * does not change — the catalogue, search, another person's profile, credits, videos —
 * are left alone.
 */
export function invalidateAfterCollectionChange(
  queryClient: QueryClient,
  userId: string,
  mediaItemId: string,
  // The ranking session reports its category as a bare string from the server, so
  // this takes one too and narrows it here rather than making every caller cast.
  options: { category?: string } = {},
) {
  const invalidate = (queryKey: readonly unknown[]) =>
    void queryClient.invalidateQueries({ queryKey });

  // The ranked list this title landed in. Both are invalidated when the category is
  // not known, because a re-bucket can move a title between them and the caller that
  // knows which one is the one that just finished a session.
  if (options.category === 'movies' || options.category === 'tv_seasons') {
    invalidate(queryKeys.rankings(userId, options.category));
  } else {
    invalidate(queryKeys.rankings(userId, 'movies'));
    invalidate(queryKeys.rankings(userId, 'tv_seasons'));
  }

  // Logged/ranked counts, the unranked queue, and — by prefix — the watchlist, whose
  // key is `[...collection(userId), 'watchlist']`. Ranking removes the title from the
  // watchlist server-side (20260815040000), so this is what stops a just-ranked title
  // still reading "In watchlist".
  invalidate(queryKeys.collection(userId));

  // The profile's Watchlist shelf, which is *not* under that prefix — it is a bounded,
  // date-ordered read with a key of its own. Same reason as the line above: the trigger
  // in `20260815040000` takes a title off the watchlist the moment it is logged or
  // ranked, so a shelf still showing it is showing something the server has deleted.
  invalidate(['profile-watchlist', userId]);

  // The title page: the catalogue half and, by prefix, the personal half at
  // `[...title(id), 'personal', userId]`.
  invalidate(queryKeys.title(mediaItemId));
  invalidate(queryKeys.logState(userId, mediaItemId));

  // The feed. `_rank_finalize` writes a `feed_events` row, so the activity exists the
  // moment the session ends and only the cache was hiding it. Keyed by prefix because
  // the full key carries a cursor object.
  invalidate(['feed', userId]);

  // Profile → Recent activity, which asks about one actor rather than a follow set.
  invalidate(['actor-activity', userId]);

  // The spoiler set. Watching something is what unmasks other people's spoiler notes
  // about it, so a title logged now must stop being masked now.
  invalidate(['watched', userId]);

  /**
   * The community aggregate for this exact title: the reader's own new rating is part
   * of it, and a score that excludes the rating you just gave reads as broken.
   *
   * The account is in the key because the aggregate is viewer-relative — it excludes
   * accounts blocked in either direction — and this line was left at
   * `['community-score', mediaItemId]` when the key gained its account, which prefix
   * matching then matched against nothing at all. Silent, because the test seeded the
   * obsolete shape too. Independent review found it at 10b.
   *
   * The Following score is deliberately **not** invalidated here. It is the mean over
   * other people's rankings, and nothing the reader does to their own collection can
   * move it.
   */
  invalidate(['community-score', userId, mediaItemId]);

  /**
   * Taste Match, on every profile this session has looked at, and the People suggestions
   * that are scored by the same function.
   *
   * Both are computed over the *viewer's* rankings as one half of the pair, so ranking
   * anything moves every one of them at once — an 84% that does not move after the
   * reader ranks five more films is a number that looks stuck, and the People list is
   * ordered by exactly that number.
   *
   * Keyed by prefix on the viewer, which is the whole cached set: `['taste-match',
   * viewerId, subjectId]` and `['people-taste-matches', viewerId]`. The *other* half of
   * each pair moving — the subject ranking something — cannot be invalidated from here
   * and does not need to be: `useTasteMatch` holds no `staleTime`, so it refetches the
   * next time the profile is opened.
   *
   * `people-mutuals` is deliberately absent. It is a fact about the follow graph and
   * nothing about ranking a film changes it; `useSocialWrites` invalidates it where it
   * genuinely moves.
   */
  invalidate(['taste-match', userId]);
  invalidate(['people-taste-matches', userId]);

  // Yearly goal progress. Keyed by prefix rather than by `queryKeys.goals(userId,
  // year)`, because the year the user just logged is not necessarily the year on
  // screen: logging a film watched last December has to move *that* year's bar, and
  // this module has no business computing which year that was.
  invalidate(['goals', userId]);

  /**
   * Bingd Awards, which is the exact failure this module was written to prevent
   * happening again — and it happened again anyway, twice.
   *
   * Thirteen of the twenty tracks are functions of the watched collection, so logging a
   * film moves them by construction. Awards arrived after this list existed and was
   * never added to it, so for up to its one-minute `staleTime` the sheet showed the count
   * from before the log — while `use-awards.ts` asserted the opposite in a comment.
   * Review 21 found that; review 21b then found that fixing it *here* had fixed one
   * writer of five. So the key itself is not written out any more:
   * `awards/invalidate.ts` owns it, and the four other writers call the same function.
   */
  invalidateAwards(queryClient, userId);
}

/**
 * Everything that stops being true when a title goes on or off the watchlist.
 *
 * Four surfaces carry a bookmark control — the title page, the Feed, Recommendations and
 * a person's credits — and each kept its own invalidation list, which is precisely the
 * arrangement the module above exists to argue against. All four moved **Queue Dragon**
 * and none of them said so: 24 → 25, and the badge did not move for a minute.
 *
 * The shared part is here. Each caller still adds what only it knows about — the title
 * page also refreshes the title, Recommendations also refreshes its slate — because
 * folding those in would make every bookmark press refetch surfaces it cannot change.
 */
export function invalidateAfterWatchlistChange(queryClient: QueryClient, userId: string) {
  void queryClient.invalidateQueries({
    queryKey: [...queryKeys.collection(userId), 'watchlist'],
  });

  /**
   * The profile shelf, which is a *second read of the same table* rather than a second
   * copy of the state (`profile/use-public-profile.ts`).
   *
   * It has its own key because it is bounded and ordered by `created_at` — twelve rows
   * rather than the whole backlog — so it is not a prefix of the collection key above and
   * would not have been invalidated by it. Keyed by prefix here because the full key
   * carries the limit.
   *
   * Only the viewer's own shelf. Saving a title cannot change what is on somebody else's,
   * and invalidating every profile visited this session would refetch a stranger's shelf
   * on every bookmark press.
   */
  void queryClient.invalidateQueries({ queryKey: ['profile-watchlist', userId] });

  invalidateAwards(queryClient, userId);
}
