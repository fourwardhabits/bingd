/**
 * Poster paths into something an `<Image>` can load.
 *
 * `media_items.poster_path` holds TMDB's path form — `/qJ2tW6WMUDux911r6m7haRef0WH.jpg` —
 * not a URL, because the size is a display decision and storing one would freeze it. The
 * seed catalogue from Wikidata has no posters at all (data-model.md §5), so every path is
 * null until the TMDB adapter lands; this exists so that the day it does, the value is
 * already carried to the screens instead of being dropped on the way.
 *
 * Sizes are TMDB's own width buckets. w342 is the largest that is still smaller than a
 * phone's row artwork at 3x, and w500 covers the comparison cards.
 */
import { env } from './env';

const BASE = 'https://image.tmdb.org/t/p';

export type PosterSize = 'row' | 'card';
export type BackdropSize = 'card' | 'hero';

const WIDTH: Record<PosterSize, string> = {
  row: 'w342',
  card: 'w500',
};

const BACKDROP_WIDTH: Record<BackdropSize, string> = {
  card: 'w780',
  hero: 'w1280',
};

export const posterUri = (path: string | null | undefined, size: PosterSize = 'row') =>
  path ? `${BASE}/${WIDTH[size]}${path}` : null;

export const backdropUri = (
  path: string | null | undefined,
  size: BackdropSize = 'card',
) => (path ? `${BASE}/${BACKDROP_WIDTH[size]}${path}` : null);

/**
 * An episode still.
 *
 * `w300` is TMDB's small still bucket and is the right one for this. The Episodes tab
 * draws stills at the content width of a phone, roughly 350pt, and a 16:9 still is
 * wide rather than tall; the next bucket up is `w780`, which is more pixels than the
 * screen can use and up to two hundred of them on one season page.
 *
 * There is deliberately no second size. Nothing else in the app renders a still, and
 * a size bucket exists for a screen rather than for completeness.
 *
 * Null for an episode TMDB has no still for, which is every unaired one and a good
 * many older ones. The row then renders text only rather than a placeholder box, the
 * same choice `profileUri` and the cast strip make.
 */
export const stillUri = (path: string | null | undefined) =>
  path ? `${BASE}/w300${path}` : null;

/**
 * A cast member's photograph.
 *
 * w185 is TMDB's portrait bucket and is larger than any face this app draws — the
 * cast strip's is 64pt, so even at 3x there is headroom. There is deliberately no
 * second size: a bigger one would only be wanted by a person page that shows a
 * portrait rather than a headshot, and that page does not exist yet.
 *
 * Null for a person with no photo, which is common for anyone below the top billing.
 * The strip falls back to initials, the same treatment `Avatar` gives a user without
 * one — never a grey silhouette, which reads as a broken image rather than a choice.
 */
export const profileUri = (path: string | null | undefined) =>
  path ? `${BASE}/w185${path}` : null;

/**
 * A YouTube key into a watch URL.
 *
 * `media_cache.videos` stores the key, not a URL, for the same reason poster paths
 * are stored as paths. This is the one place that turns it back, and it produces a
 * watch link rather than an embed: opening the app or the browser is what the phone
 * does well, and an in-app player would be a native dependency for one screen.
 */
export const videoUri = (key: string | null | undefined) => {
  if (!key) return null;
  // A YouTube video id is eleven characters of `[A-Za-z0-9_-]`. Anything else is not
  // a key, and the app is about to hand it to `Linking.openURL` — so it is checked
  // rather than escaped. Encoding a bad key would produce a valid YouTube URL for a
  // video that does not exist, which fails silently on the device; refusing it lets
  // the row simply not be tappable, and the shape is provider-owned data that has
  // never varied.
  if (!/^[A-Za-z0-9_-]{11}$/.test(key)) return null;
  return `https://www.youtube.com/watch?v=${key}`;
};

/**
 * An avatar object path into a URL.
 *
 * `profiles.avatar_path` stores `{uuid}/{filename}` and not a URL, because the
 * origin belongs to the deployment rather than to the row: a dump restored into
 * a second project would otherwise leave every face pointing at the first one.
 * See 20260815020000.
 *
 * The bucket is public, so this is a plain URL rather than a signed one and
 * needs no round trip. Resolve at the two data boundaries — the session profile
 * and the feed query — so nothing downstream ever holds a bare path.
 */
export const avatarUri = (path: string | null | undefined) =>
  path ? `${env.supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/avatars/${path}` : null;
