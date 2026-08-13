/**
 * The only file in the app permitted to contain a color literal.
 * Enforced by the lint rule in eslint.config.js.
 *
 * Source: docs/design/design-system.md §1–§3. Brand values are fixed by PRD §5.
 */

/** Fixed by PRD §5. Not open to adjustment. */
export const brand = {
  parchment: '#F5EBDD',
  maroon: '#773744',
  ink: '#242326',
  amber: '#D4A64C',
  sage: '#92A895',
  /** Reserved for the future dark theme. Not used in v1. */
  midnight: '#19242D',
} as const;

/** Ink at a given alpha. Shadows and borders use Ink, never black — pure black
 *  on a warm ground reads as a grey smudge (design-system.md §6). */
export const inkAlpha = (alpha: number) => `rgba(36, 35, 38, ${alpha})`;

/** Tints and shades of Parchment and Ink. No new hues. */
export const surface = {
  base: brand.parchment,
  raised: '#FCF6EC',
  sunken: '#EADFCF',
} as const;

export const border = {
  hairline: inkAlpha(0.12),
  strong: inkAlpha(0.24),
} as const;

/**
 * Contrast ratios against Parchment are asserted by src/ui/tokens/contrast.test.ts.
 * There is deliberately no fourth, lighter text tone: it would fall below 4.5:1,
 * and the honest fix for "less important" is smaller type or more space.
 */
export const text = {
  primary: brand.ink, // 13.3:1
  secondary: '#5F5A56', // 5.8:1
  tertiary: '#6E6862', // 4.7:1
  /** Ink on an Amber or Sage fill. Amber and Sage are fills, never ink. */
  onFill: brand.ink,
  /** Parchment on Maroon. */
  inverse: brand.parchment,
} as const;

export const semantic = {
  action: brand.maroon,
  actionText: brand.parchment,
  /** Milestone fills and the reveal surface. Never text. */
  emphasis: brand.amber,
  /** Watched, completed, sync success. Never text. */
  progress: brand.sage,
  /** Reuses Maroon rather than introducing a red the palette does not have.
   *  Destructive actions are always confirmed with a verb, never color alone. */
  danger: brand.maroon,
  focusRing: brand.maroon,
} as const;

/**
 * Three buckets, always in this order. Not red/yellow/green: that triad says
 * "bad/mediocre/good" about the film rather than about the viewer's response,
 * and it fails for red-green color vision deficiency (design-system.md §3).
 *
 * Stone is a derived warm grey, named so it cannot be mistaken for a brand
 * accent. Amber is deliberately excluded — its job is celebration.
 */
export const bucket = {
  loved: brand.maroon,
  fine: brand.sage,
  notForMe: '#9A8F86',
} as const;

export const color = { brand, surface, border, text, semantic, bucket } as const;
