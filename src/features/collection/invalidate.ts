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

  /**
   * **The three surfaces that show note text, which nothing has ever invalidated.**
   *
   * Founder physical finding, 2026-08-28: editing a published review left the old text
   * on the title's Reviews tab. The audit found one cause and it is this list — not a
   * write that failed, not a view, not a revision:
   *
   *   · `save_note` stores the new text and returns a new `note_updated_at`; the sheet's
   *     own state proves it landed, and re-opening the log sheet shows the edit.
   *   · `title_reviews` (20260825000100) selects `um.note` **live**, with no snapshot
   *     and no history table, so the server returns the new text the instant it is
   *     asked. `user_media` is keyed `(user_id, media_item_id)`, so there is not even a
   *     second row an edit could be selected out of — a duplicate review is unreachable.
   *   · Nothing asked. `['title-reviews', …]` appeared in exactly one place in the
   *     codebase — the hook that reads it.
   *
   * The global `staleTime` is 60s, which is why the founder could not shake it loose by
   * closing the sheet: the sheet opens *over* the title screen, so nothing unmounts, and
   * a remount inside the minute would not have refetched either. It looked like a write
   * that had not persisted and was a read nobody re-ran.
   *
   * This is the failure the module header describes — a surface added later gets added
   * to one writer's list or to none — reaching a third writer. It is fixed here, where
   * both note writers already come.
   *
   * **`title-reviews` by prefix**, because the full key is
   * `['title-reviews', mediaItemId, sort]` and the tab has two sorts: invalidating only
   * the visible one leaves the stale text waiting behind the other chip.
   *
   * **Only this title.** The key carries the media item, so no other film's Reviews tab
   * is refetched by an edit.
   *
   * A ranking moves this list too, not only a note edit: the row carries the author's
   * *live* score and the reaction count of their latest `title_ranked` event, both of
   * which a completed ranking changes. So it belongs to the whole collection change
   * rather than to a note-only branch.
   */
  invalidate(['title-reviews', mediaItemId]);

  /**
   * The author's own profile Reviews shelf, which reads `public_notes` under a key of
   * its own and had the identical defect for the identical reason.
   */
  invalidate(['profile-notes', userId]);

  /**
   * One activity opened from a notification, which hydrates through the same
   * `attachNotes` the feed does and so carries the note text with it.
   *
   * Keyed `['activity-event', viewerId, eventId]`, and the prefix here is the *viewer* —
   * this device's own reader. Stale copies in other people's caches are not reachable
   * from here and do not need to be: their `staleTime` expires and their feed refetches.
   */
  invalidate(['activity-event', userId]);

  // The spoiler set. Watching something is what unmasks other people's spoiler notes
  // about it, so a title logged now must stop being masked now.
  invalidate(['watched', userId]);

  /**
   * **The inbox, because one of its rows is a question about this collection.**
   *
   * A watched-with row offers **Rank** only while the reader has not ranked the title,
   * and `my_notifications` resolves that in the read that draws the row (`viewer_ranked`,
   * 20260830000100). Nothing else here would ever tell it the answer had changed: the
   * inbox's `staleTime` is 30s and its focus refetch is gated on staleness, so tapping
   * Rank, ranking the title and coming straight back left the control still offered —
   * an action pointing at a state the reader has already reached. Independent review 68.
   *
   * By prefix on the reader, which is the whole of that cache. Cheap: it is one round
   * trip against an index on `(recipient_id, created_at desc)`, and only when a
   * collection write has actually happened.
   */
  invalidate(['notifications', userId]);

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
   * **The feed and the inbox, because a watchlist write can now delete a post.**
   *
   * Queue Dragon counts the watchlist, and since `20260904000100` a collection-derived
   * award is held only while the collection still supports it — so removing a title can
   * revoke a tier, and the revocation takes that tier's `award_earned` feed event and
   * its congratulations with it. Neither key was here, so the badge went and the post
   * announcing it sat in a cached feed for the rest of the minute, above a notification
   * for an award the reader no longer had.
   *
   * The same two keys are what `invalidateAfterCollectionChange` already invalidates
   * for exactly this reason on the watched side, and `actor-activity` joins them
   * because the profile's Recent activity is the same rows under a different key.
   *
   * **An add moves them too**, and always did: `set_watchlist(true)` writes the
   * reader's durable `watchlist_added` event (20260820000300), and nothing here said
   * so — a bookmark pressed from the Feed did not show up in it. That was a real gap
   * before this tranche and it is closed by the same three lines.
   */
  void queryClient.invalidateQueries({ queryKey: ['feed', userId] });
  void queryClient.invalidateQueries({ queryKey: ['actor-activity', userId] });
  void queryClient.invalidateQueries({ queryKey: ['notifications', userId] });

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
