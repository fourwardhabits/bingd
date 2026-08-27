import type { TextStyle } from 'react-native';

/**
 * Source: docs/design/design-system.md §4.
 *
 * DM Serif Display ships Regular and Italic only — there is no bold. Serif
 * emphasis therefore comes from size and space, never from weight.
 */
export const fontFamily = {
  serif: 'DMSerifDisplay_400Regular',
  serifItalic: 'DMSerifDisplay_400Regular_Italic',
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemibold: 'Inter_600SemiBold',
} as const;

/** Display tokens cap their Dynamic Type scaling because they are already at
 *  display scale and clip before the larger size helps. Nothing scales below 100%. */
type TypeToken = TextStyle & { maxFontSizeMultiplier?: number };

export const typography = {
  /** The score in the ranking reveal. Nowhere else. */
  reveal: {
    fontFamily: fontFamily.serif,
    fontSize: 88,
    lineHeight: 88,
    maxFontSizeMultiplier: 1.3,
  },
  display: {
    fontFamily: fontFamily.serif,
    fontSize: 40,
    lineHeight: 44,
    maxFontSizeMultiplier: 1.3,
  },
  title1: { fontFamily: fontFamily.serif, fontSize: 28, lineHeight: 34 },
  title2: { fontFamily: fontFamily.serif, fontSize: 22, lineHeight: 28 },
  headline: { fontFamily: fontFamily.sansSemibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fontFamily.sans, fontSize: 16, lineHeight: 24 },
  callout: { fontFamily: fontFamily.sansMedium, fontSize: 15, lineHeight: 20 },
  subhead: { fontFamily: fontFamily.sansMedium, fontSize: 14, lineHeight: 20 },
  footnote: { fontFamily: fontFamily.sans, fontSize: 13, lineHeight: 18 },
  caption: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.2,
  },
  /**
   * The number inside a score badge. Tabular so a column of badges does not
   * jitter between `8.7` and `10.0`. Inter rather than serif: DM Serif has no
   * bold, and a serif score reads as editorial rather than as data.
   */
  score: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 17,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
  ordinal: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
  /**
   * Section headers, set in Maroon (design-system.md §4). They were `subhead`
   * in `text.tertiary`, which is small, low-contrast and low-weight all at
   * once — technically passing at 5.2:1 and reading as a disclaimer rather
   * than as structure.
   */
  sectionHeader: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
} as const satisfies Record<string, TypeToken>;

export type TypographyToken = keyof typeof typography;

/**
 * Text style for single-line `TextInput`s — `body` without its `lineHeight`.
 *
 * On iOS a paragraph line-height taller than the font is applied to a
 * `TextInput` as attributed-string leading, which pushes the glyph baseline
 * low inside the field: the container centres, the text does not. Every input
 * on the physical device sat visibly below centre for exactly this reason.
 * `paddingVertical: 0` removes Android's built-in input padding so the same
 * centring holds there. Multiline inputs opt back into their own spacing.
 */
export const inputText = {
  fontFamily: typography.body.fontFamily,
  fontSize: typography.body.fontSize,
  paddingVertical: 0,
} as const satisfies TextStyle;
