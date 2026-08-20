import { useMemo } from 'react';

import { posterUri } from '@/lib/images';
import { PosterShelf } from '@/ui/components';

import { useProfileWatchlist } from './use-public-profile';

export type ProfileWatchlistProps = {
  userId: string;
  onPressTitle: (mediaItemId: string) => void;
};

/**
 * What somebody wants to watch next, directly under what they love most.
 *
 * **Founder decision, 2026-08-20.** Top Ranked answers "what is this person's taste";
 * this answers "what are they about to watch", and the second is the socially actionable
 * half — "I want to watch that too" is a reason to message somebody, and the ranked wall
 * never produces one because it is about things already finished.
 *
 * ## A shelf rather than a wall
 *
 * `TopRanked` is a `PosterGrid`: three across, two rows, a complete statement. This is a
 * `PosterShelf`, which solves its card width so the last card is clipped at 70% — about
 * three and a half posters at normal phone width. That clip is the entire affordance, and
 * it is why this is a shelf: a watchlist is a queue with an end the profile is not trying
 * to show, and a grid would either claim to be the whole thing or need a "See all" going
 * somewhere that does not exist. **There is no separate Watchlist profile screen for beta**
 * — Collection is where the full list is, for the account that owns it.
 *
 * ## No empty state
 *
 * `PosterShelf` renders nothing for an empty `tiles`, and this adds no empty state of its
 * own. That is load-bearing rather than lazy: a profile the viewer is not authorised for
 * returns zero rows from `watchlist_read`, and the *only* way an unviewable watchlist and
 * an empty one can look identical is if neither draws anything. A "Nothing saved yet" line
 * would be a disclosure that the account exists and has an empty list, which is more than a
 * private profile is meant to say.
 *
 * That is also why there is no skeleton here. It would appear for a profile that is about
 * to render nothing at all, which announces the section before knowing whether there is one.
 *
 * ## No bookmark control
 *
 * The tiles carry no `saved` state and no toggle. This is a statement about *their*
 * intent, and a control that let the viewer edit the shelf they are reading would need to
 * mean "add this to my own list" — a different action wearing the same icon. The title
 * page is one tap away and has the real control.
 */
export function ProfileWatchlist({ userId, onPressTitle }: ProfileWatchlistProps) {
  const watchlist = useProfileWatchlist(userId);

  const tiles = useMemo(
    () =>
      (watchlist.data ?? []).map((entry) => ({
        id: entry.mediaItemId,
        // Already `Series, S2` for a season: `useProfileWatchlist` compacts it, so the
        // shelf and the title page it opens agree on what the thing is called.
        title: entry.title,
        year: entry.year,
        posterUri: posterUri(entry.posterPath, 'card'),
      })),
    [watchlist.data],
  );

  return <PosterShelf title="Watchlist" tiles={tiles} onPressTile={(tile) => onPressTitle(tile.id)} />;
}
