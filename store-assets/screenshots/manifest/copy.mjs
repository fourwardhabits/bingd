/**
 * Every word a composed frame may carry, with where it already exists. Nothing here is
 * written for this pipeline. test/manifest.test.mjs fails if a frame uses anything else.
 *
 * In text the name is `bingd`. `bingd.` is the logo and is drawn, never typed.
 */

/** The six live store frames, read off the listings on 2026-11-01. */
const LIVE_STORE_FRAMES = 'live App Store and Google Play listing frames';
/** The landing page headline and its section heading. */
const LANDING_PAGE = 'web/build.mjs, landing page hero and section heading';

export const copy = {
  'head-to-head': {
    eyebrow: 'HOW IT WORKS',
    headline: ['Put your favorites', 'head to head'],
    sub: 'Quick comparisons build your ranking',
    source: LIVE_STORE_FRAMES,
  },
  'movies-and-tv': {
    eyebrow: 'MOVIES + TV',
    headline: ['Movies and TV,', 'one place'],
    sub: 'Rank movies and TV seasons separately',
    source: LIVE_STORE_FRAMES,
  },
  friends: {
    eyebrow: 'FRIENDS',
    headline: ['See what your', 'friends are watching'],
    sub: 'React, comment, send recommendations',
    source: LIVE_STORE_FRAMES,
  },
  watchlist: {
    eyebrow: 'WATCHLIST',
    headline: ['Save your', 'next watch'],
    sub: 'Your watchlist, plus picks from friends',
    source: LIVE_STORE_FRAMES,
  },
  'for-you': {
    eyebrow: 'FOR YOU',
    headline: ['Find something', 'worth watching'],
    sub: 'Recommendations shaped by your taste',
    source: LIVE_STORE_FRAMES,
  },
  'your-taste': {
    eyebrow: 'YOUR YEAR',
    headline: ['Your taste,', 'on the record'],
    sub: 'Set goals and unlock Awards',
    source: LIVE_STORE_FRAMES,
  },
  promise: {
    eyebrow: null,
    headline: ['Rank what you watch.', 'See where it really lands.'],
    sub: 'Stop guessing between 3.5 and 4 stars.',
    source: LANDING_PAGE,
  },
};

/**
 * The approved strings as whole sentences, to check `copy` against. Kept apart from the
 * line breaks above so a re-break cannot quietly become a rewrite.
 */
export const APPROVED_HEADLINES = [
  'Put your favorites head to head',
  'Movies and TV, one place',
  'See what your friends are watching',
  'Save your next watch',
  'Find something worth watching',
  'Your taste, on the record',
  'Rank what you watch. See where it really lands.',
];
