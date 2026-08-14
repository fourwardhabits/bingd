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
  /** The ordinal in the ranking reveal. Nowhere else. */
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
  ordinal: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    fontVariant: ['tabular-nums'],
  },
} as const satisfies Record<string, TypeToken>;

export type TypographyToken = keyof typeof typography;
