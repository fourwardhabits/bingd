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
 * badge stretched to a 190pt frame is a worse picture of it. Follow stories keep theirs.
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

/** The founder's band, 150–190pt; a 16:9 frame of the card's width, clamped into it. */
export const ARTWORK_MIN_HEIGHT = 150;
export const ARTWORK_MAX_HEIGHT = 190;

/**
 * 16:9 of the card's width, clamped. At 390pt that is 190 (the 16:9 would be 201); at
 * 360pt it is 185; at 320pt it is 162 — a backdrop is cropped a little at the top and
 * bottom on wide phones, and never letterboxed.
 */
export function artworkHeight(cardWidth: number): number {
  const natural = Math.round((cardWidth * 9) / 16);
  return Math.min(ARTWORK_MAX_HEIGHT, Math.max(ARTWORK_MIN_HEIGHT, natural));
}
