/**
 * What each marketing frame shows. `scene` fills the main device; `inset` is the smaller
 * overlapping phone the live store frames use. Both are ids from scenes.mjs. A frame with
 * `artwork: false` has no device at all, so it carries no poster artwork under any license.
 *
 * `focus` is how far down the screen a device starts, as a fraction of its height, for a
 * scene whose subject sits low: the ranking sheets rise from the bottom. Compose clamps it so
 * the screen always fills the device, so tall canvases simply show more of the page above.
 */
export const frames = {
  'head-to-head': { copy: 'head-to-head', scene: 'compare', focus: 0.27 },
  'movies-and-tv': { copy: 'movies-and-tv', scene: 'collection-movies', inset: 'collection-tv' },
  friends: { copy: 'friends', scene: 'feed', inset: 'comments' },
  watchlist: { copy: 'watchlist', scene: 'watchlist', inset: 'sent-to-you' },
  'for-you': { copy: 'for-you', scene: 'for-you' },
  'your-taste': { copy: 'your-taste', scene: 'awards', inset: 'profile' },
  promise: { copy: 'promise', scene: 'reveal', focus: 0.445 },
  'promise-brand': { copy: 'promise', artwork: false },
};

export const STORE_FRAMES = [
  'head-to-head',
  'movies-and-tv',
  'friends',
  'watchlist',
  'for-you',
  'your-taste',
];

export const SOCIAL_FRAMES = ['promise', 'head-to-head', 'friends'];
