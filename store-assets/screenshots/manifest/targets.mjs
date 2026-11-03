import { SOCIAL_FRAMES, STORE_FRAMES } from './frames.mjs';

/**
 * Canvases are what compose renders. Each is laid out once at its largest size; several
 * export targets can come from one canvas when their aspect ratios all but match.
 * All measurements are pixels at the canvas's own size.
 *
 * `viewedAt` is the CSS width the image is seen at on a phone. Amber on Maroon is 3.88:1,
 * which only passes as WCAG large text, so `type.eyebrow` must still be 18.66px bold at that
 * width. test/manifest.test.mjs enforces it. A canvas too small for that gets `eyebrow: null`
 * and loses the eyebrow rather than shrinking it.
 */
export const canvases = {
  'store-tall': {
    width: 1320,
    height: 2868,
    template: 'portrait',
    viewedAt: 390,
    type: { eyebrow: 66, headline: 126, sub: 58 },
    text: { top: 140, gap: 28 },
    // The foot of the canvas must fall through content, not the tab bar. The test checks it.
    device: { width: 1140, top: 880, inset: { width: 596, right: 54, bottom: 78 } },
  },
  'play-phone': {
    width: 1080,
    height: 1920,
    template: 'portrait',
    viewedAt: 390,
    type: { eyebrow: 56, headline: 102, sub: 46 },
    text: { top: 100, gap: 22 },
    device: { width: 880, top: 620, inset: { width: 440, right: 36, bottom: 48 } },
  },
  'social-portrait': {
    width: 1080,
    height: 1350,
    template: 'portrait',
    viewedAt: 390,
    type: { eyebrow: 54, headline: 84, sub: 42 },
    text: { top: 72, gap: 18 },
    // No inset on social canvases: at phone size it would be under 100px wide and unreadable.
    device: { width: 690, top: 540 },
  },
  'social-square': {
    width: 1080,
    height: 1080,
    template: 'portrait',
    viewedAt: 390,
    type: { eyebrow: 54, headline: 76, sub: 38 },
    text: { top: 56, gap: 14 },
    // 580, not 620: at 620 the Visual 2.0 score sheet's buttons fell off the foot of the canvas.
    device: { width: 580, top: 440 },
  },
  'social-link': {
    width: 1200,
    height: 630,
    template: 'landscape',
    viewedAt: 390,
    type: { eyebrow: null, headline: 56, sub: 28 },
    text: { left: 72, gap: 20, width: 620 },
    device: { width: 360, top: 60, right: 72 },
  },
  'play-feature': {
    width: 1024,
    height: 500,
    template: 'brand',
    viewedAt: 390,
    type: { eyebrow: null, headline: 50, sub: 24 },
    text: { gap: 20 },
    logo: { markWidth: 150, wordmark: 72 },
  },
};

/**
 * Every file the pipeline produces, from this one list.
 *
 * Apple sizes are from the App Store Connect "Screenshot specifications" page, read
 * 2026-11-02. It now states the required iPhone size as Dynamic Island (medium display),
 * 1179x2556 or 1206x2622, which older checklists do not list. Face ID (large display) is
 * required only when Dynamic Island (large display) is not supplied; it stays here because
 * it is the fallback those pages scale from. PNG or JPEG, no alpha, up to ten per size.
 * `supportsTablet` is false in app.config.ts, so no iPad sizes apply.
 *
 * Google Play is from "Add preview assets to showcase your app", read 2026-11-02: JPEG or
 * 24-bit PNG with no alpha, 320 to 3840px, long side at most twice the short side, 1080x1920
 * recommended, and four at 1080px or more for promotion eligibility. The live 480x1042
 * frames are past that 2:1 limit, so these are composed fresh at 9:16 rather than resized.
 *
 * Website images match web/src/shot-*.webp: 640 wide, 1285 tall, WebP at quality 80 and
 * effort 6, the settings web/shots.mjs writes.
 */
export const targets = [
  {
    id: 'app-store-dynamic-island-large',
    surface: 'app-store',
    width: 1320,
    height: 2868,
    format: 'png',
    canvas: 'store-tall',
    frames: STORE_FRAMES,
  },
  {
    id: 'app-store-dynamic-island-medium',
    surface: 'app-store',
    width: 1206,
    height: 2622,
    format: 'png',
    canvas: 'store-tall',
    frames: STORE_FRAMES,
  },
  {
    id: 'app-store-face-id-large',
    surface: 'app-store',
    width: 1284,
    height: 2778,
    format: 'png',
    canvas: 'store-tall',
    frames: STORE_FRAMES,
  },
  {
    id: 'google-play-phone',
    surface: 'google-play',
    width: 1080,
    height: 1920,
    format: 'png',
    canvas: 'play-phone',
    frames: STORE_FRAMES,
  },
  {
    id: 'google-play-feature-graphic',
    surface: 'google-play',
    width: 1024,
    height: 500,
    format: 'png',
    canvas: 'play-feature',
    frames: ['promise-brand'],
  },
  {
    id: 'social-portrait',
    surface: 'social',
    width: 1080,
    height: 1350,
    format: 'png',
    canvas: 'social-portrait',
    frames: SOCIAL_FRAMES,
  },
  {
    id: 'social-square',
    surface: 'social',
    width: 1080,
    height: 1080,
    format: 'png',
    canvas: 'social-square',
    frames: SOCIAL_FRAMES,
  },
  {
    id: 'social-link',
    surface: 'social',
    width: 1200,
    height: 630,
    format: 'png',
    canvas: 'social-link',
    frames: ['promise'],
  },
  {
    id: 'website',
    surface: 'website',
    width: 640,
    height: 1285,
    format: 'webp',
    quality: 80,
    effort: 6,
    /** Output name to raw scene. No frame: the site shows the bare screen. */
    shots: {
      'shot-compare': 'compare',
      'shot-score': 'reveal',
      'shot-ranked': 'first-five',
      'shot-feed': 'feed',
      'shot-comments': 'comments',
      'shot-movies': 'collection-movies',
      'shot-tv': 'collection-tv',
      'shot-watchlist': 'watchlist',
      'shot-foryou': 'for-you',
      'shot-recommended': 'sent-to-you',
      'shot-grouppicks': 'group-picks',
    },
  },
];

/** Formats each surface accepts. Apple and Google both refuse an alpha channel. */
export const SURFACE_RULES = {
  'app-store': { formats: ['png', 'jpeg'], noAlpha: true },
  'google-play': { formats: ['png', 'jpeg'], noAlpha: true, maxScreenshotRatio: 2 },
  social: { formats: ['png', 'jpeg'], noAlpha: true },
  website: { formats: ['webp'], noAlpha: true },
};
