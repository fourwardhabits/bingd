/**
 * The only file in the app permitted to contain a color literal.
 * Enforced by the lint rule in eslint.config.js.
 *
 * Source: docs/design/design-system.md §1–§3. Brand values are fixed by PRD §5.
 */

/** Fixed by PRD §5. Not open to adjustment. */
export const brand = {
  /** The base surface since 2026-08-15. Parchment's hue with most of the
   *  saturation removed, which is what gives artwork headroom (§1). */
  paper: '#FBF8F4',
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

/**
 * Paper at a given alpha, for the title hero's scrim (design-system.md §7).
 *
 * The hero has to dissolve into the page rather than end at a line, and the
 * page is Paper — so the fade is Paper going opaque, not black going
 * transparent. A black scrim over warm artwork on a warm page reads as dirt.
 */
export const paperAlpha = (alpha: number) => `rgba(251, 248, 244, ${alpha})`;

/**
 * Three surfaces ordered by how far above the page they sit (design-system.md §2).
 *
 * The direction is the part worth getting right: `raised` goes toward white and
 * `sunken` goes toward Parchment, so a card lifts by getting lighter and a well
 * recedes by getting warmer. Parchment was the background until 2026-08-15 and
 * is now the accent — it is where the brand's warmth lives, on the elements a
 * user touches rather than in the empty space behind them.
 */
export const surface = {
  base: brand.paper,
  /** Pure white, not a tint. Paper is already close enough to white that a
   *  tinted card would not read as raised at all. */
  raised: '#FFFFFF',
  sunken: brand.parchment,
} as const;

export const border = {
  hairline: inkAlpha(0.12),
  strong: inkAlpha(0.24),
} as const;

/**
 * Contrast ratios are asserted by src/ui/tokens/contrast.test.ts against *both*
 * Paper and Parchment, because both are real backgrounds now. Ratios below are
 * quoted on Paper / on Parchment; the Parchment figure is the binding one, and
 * `tertiary` at 4.7:1 there is the tightest pair in the system.
 *
 * There is deliberately no fourth, lighter text tone: it would fall below 4.5:1,
 * and the honest fix for "less important" is smaller type or more space.
 */
export const text = {
  primary: brand.ink, // 14.8:1 / 13.3:1
  secondary: '#5F5A56', // 6.4:1 / 5.8:1
  tertiary: '#6E6862', // 5.2:1 / 4.7:1
  /** Ink on an Amber, Sage or Stone fill. All three are fills, never ink. */
  onFill: brand.ink,
  /** Parchment on Maroon, 7.4:1. Stays Parchment rather than Paper: Paper would
   *  measure 8.2:1, but warm-on-deep is the brand's pairing and 7.4:1 already
   *  clears AA with room, so there is nothing to buy by going colder. */
  inverse: brand.parchment,
} as const;

export const semantic = {
  action: brand.maroon,
  actionText: brand.parchment,
  /**
   * The score system: one deep Maroon carrying Parchment, everywhere a derived
   * 0–10 score is stated (founder decision, 2026-08-16).
   *
   * Named rather than reusing `action`, which is the same hex today. A score
   * surface and a button are not the same thing, and a future change to either
   * must not silently repaint the other — the reveal panel is the proof, having
   * spent months Amber because nothing named the score treatment for it to miss.
   *
   * `scoreInk` on `score` is 7.4:1, the same certified pair as `bucketInk.loved`.
   */
  score: brand.maroon,
  scoreInk: brand.parchment,
  /** Milestone fills. Never text. */
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

/**
 * The ink that goes on each bucket fill — the "certified pairs" of
 * design-system.md §3, and the reason the score badge can be chromatic at all.
 *
 * Every combination here is measured and asserted. Nothing else in the system
 * puts text on a brand colour, and nothing may without being added here first.
 */
export const bucketInk = {
  loved: text.inverse, // Parchment on Maroon, 7.4:1
  fine: text.onFill, // Ink on Sage, 6.1:1
  notForMe: text.onFill, // Ink on Stone, 4.9:1
} as const;

export type BucketKey = keyof typeof bucket;

export const color = { brand, surface, border, text, semantic, bucket, bucketInk } as const;
