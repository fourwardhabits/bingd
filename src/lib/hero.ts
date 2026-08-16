import { backdropUri, posterUri } from './images';

export type HeroArtwork =
  | { treatment: 'backdrop'; uri: string }
  /** A poster standing in for a backdrop, blurred so it reads as a field rather
   *  than as artwork someone stretched. */
  | { treatment: 'poster'; uri: string }
  | { treatment: 'none'; uri: null };

export type HeroSources = {
  backdropPath?: string | null;
  posterPath?: string | null;
  /** The parent series, for a season. */
  parentBackdropPath?: string | null;
  parentPosterPath?: string | null;
};

/**
 * Which image a title page's hero should use, in a fixed order.
 *
 * A season page rendered blank at the top, and the reason is not a bug in the
 * screen: **no season in the catalogue has a backdrop, and none ever will from this
 * provider.** TMDB's `/tv/{id}/season/{n}` returns a poster and no `backdrop_path`,
 * so a season's own backdrop is null for all 1000 of them. The hero collapsed to its
 * 96pt band every time, which is the correct behaviour for a film with no artwork and
 * the wrong one for a season whose series has a perfectly good backdrop sitting one
 * row away.
 *
 * So the order is:
 *
 *   1. the season's own backdrop — never populated today, kept first because it costs
 *      nothing and the page upgrades by itself if the provider ever fills it;
 *   2. the parent series' backdrop — what actually renders, and the right image
 *      anyway: the show's key art is what a season looks like;
 *   3. a poster, blurred, when there is no backdrop anywhere. The season's own first,
 *      then the series'.
 *   4. nothing, and the page keeps its collapsed band rather than inventing a
 *      surface.
 *
 * Deliberately pure and deliberately not a hook: the ordering is the part worth
 * testing, and it is easier to be sure of when it does not need a screen to run.
 */
export function heroArtwork(sources: HeroSources): HeroArtwork {
  const backdrop =
    backdropUri(sources.backdropPath, 'hero') ?? backdropUri(sources.parentBackdropPath, 'hero');
  if (backdrop) return { treatment: 'backdrop', uri: backdrop };

  const poster = posterUri(sources.posterPath, 'card') ?? posterUri(sources.parentPosterPath, 'card');
  if (poster) return { treatment: 'poster', uri: poster };

  return { treatment: 'none', uri: null };
}
