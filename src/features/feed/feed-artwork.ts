import { backdropUri, posterUri } from '@/lib/images';

/**
 * What a Feed card leads with (cinematic Feed, 2026-11-04).
 *
 * The same order the title page's hero uses (`lib/hero.ts`), at the card's own sizes:
 *
 *   1. the title's own backdrop;
 *   2. the parent series' backdrop — which is what every season card draws, because this
 *      provider returns no season backdrops at all;
 *   3. the poster, the season's own first and then the series', set at its true 2:3 shape
 *      over a blurred copy of itself — never stretched or cropped to the wide frame;
 *   4. nothing, and the card draws the designed initials frame in the poster's place.
 *
 * Kept separate from `heroArtwork` rather than parameterising it, so the Feed cannot move
 * the title page by accident: that file is shared with the title-page experiment.
 */
export type FeedArtwork =
  | { treatment: 'backdrop'; uri: string }
  | { treatment: 'poster'; uri: string }
  | { treatment: 'none'; uri: null };

export function feedArtwork(item: {
  backdropPath?: string | null;
  posterPath?: string | null;
  parentBackdropPath?: string | null;
  parentPosterPath?: string | null;
}): FeedArtwork {
  // w780: the card is at most ~360pt wide, which is 1080px at 3x — w1280 is the title
  // page's bucket and would be twenty of them per page for no visible gain.
  const backdrop =
    backdropUri(item.backdropPath, 'card') ?? backdropUri(item.parentBackdropPath, 'card');
  if (backdrop) return { treatment: 'backdrop', uri: backdrop };

  const poster = posterUri(item.posterPath, 'row') ?? posterUri(item.parentPosterPath, 'row');
  if (poster) return { treatment: 'poster', uri: poster };

  return { treatment: 'none', uri: null };
}

/**
 * Which activities the Feed draws as a card: the ones about a title.
 *
 * Awards and goals keep their compact row — their subject is a badge, not a film, and a
 * badge stretched to a 190pt frame is a worse picture of it. Since 2026-11-19 that row
 * carries the card's labelled Like and Comment (`ActivityRow`'s `labelledActions`), so the
 * engagement is the same either way. Follow stories keep theirs.
 * A grouped ranking sitting is a card about its first title, as its row already was.
 */
const CARD_TYPES = new Set([
  'title_ranked',
  'title_logged',
  'season_completed',
  'watchlist_added',
  'ranking_batch',
]);

export const takesFeedCard = (item: { type: string; mediaItemId: string | null }) =>
  Boolean(item.mediaItemId) && CARD_TYPES.has(item.type);

/**
 * **A single title's hero: 3:2 of the artwork's width** (refined card feed, founder spec
 * 2026-11-22). Replaces the 16:9 frame clamped into 150–190pt.
 *
 * Why 3:2. The card now holds the artwork inside its outline and 12pt inset, so the frame is
 * 26pt narrower than the old gutter-to-gutter panel, and 16:9 of that would be *shorter* than
 * before. 3:2 is the still frame of 35mm film: tall enough to read as a picture rather than
 * a strip, and it takes only about 8% off each side of a 16:9 backdrop (the image is
 * cropped, never letterboxed). 4:3 or squarer would crop a quarter of the backdrop and
 * add 40pt+ of scroll per post; 16:10 would add almost nothing at 320–360pt.
 *
 *     screen   artwork   old height   new height
 *     320pt    262pt     162pt        175pt   (+13)
 *     360pt    302pt     185pt        201pt   (+16)
 *     390pt    332pt     190pt        221pt   (+31)
 *     430pt    372pt     190pt        248pt   (+58)
 *
 * The floor keeps a very narrow window from a sliver; the ceiling stops a tablet or a wide
 * browser from turning one post into a screenful.
 */
export const ARTWORK_ASPECT = 3 / 2;
export const ARTWORK_MIN_HEIGHT = 150;
export const ARTWORK_MAX_HEIGHT = 280;

/** The hero's height for an artwork `artworkWidth` wide: 3:2, clamped. */
export function artworkHeight(artworkWidth: number): number {
  const natural = Math.round(artworkWidth / ARTWORK_ASPECT);
  return Math.min(ARTWORK_MAX_HEIGHT, Math.max(ARTWORK_MIN_HEIGHT, natural));
}
