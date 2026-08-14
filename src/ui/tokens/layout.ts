import { inkAlpha } from './color';

/** 4pt base. Source: docs/design/design-system.md §5. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const layout = {
  /** Minimum Parchment on every screen edge. Posters are never full-bleed. */
  gutter: space[4],
  sectionGap: space[6],
  cardPadding: space[4],
  /** Efficient surfaces: Rankings, Search. */
  rowMinHeight: 56,
  /** WCAG minimum, applied to every interactive element without exception. */
  minTapTarget: 44,
  buttonMinHeight: 48,
  aspect: { poster: 2 / 3, backdrop: 16 / 9 },
  avatar: { xs: 24, sm: 32, md: 44, lg: 72 },
  icon: { sm: 20, md: 24, lg: 28 },
  control: { searchFieldHeight: 40, chipHeight: 32, headerHeight: 44 },
  row: { dense: 56, media: 76, ordinalColumn: 28 },
} as const;

/** No pill buttons — PRD §5. Full-round is for avatars only. */
export const radius = {
  card: 12,
  control: 8,
  sheet: 20,
  full: 9999,
} as const;

/** Two levels only, both Ink-based (design-system.md §6). */
export const elevation = {
  e1: {
    shadowColor: inkAlpha(1),
    shadowOpacity: 0.06,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  e2: {
    shadowColor: inkAlpha(1),
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

/** Source: design-system.md §6. The reveal is the single exception (§9). */
export const duration = {
  state: 120,
  sheet: 200,
  navigation: 260,
  revealPanel: 280,
  revealCount: 500,
} as const;

/**
 * Artwork always renders 2:3, the TMDB standard. Source: design-system.md §7.
 *
 * Radius is 8 below 100pt wide and 12 at or above, which keeps the *visual*
 * corner constant as the poster scales — a 12pt radius on a 40pt thumbnail
 * eats the artwork.
 */
export const poster = {
  xs: { width: 40, height: 60 },
  sm: { width: 56, height: 84 },
  md: { width: 88, height: 132 },
  lg: { width: 132, height: 198 },
  xl: { width: 180, height: 270 },
} as const;

export type PosterSize = keyof typeof poster;

export const posterRadius = (size: PosterSize) =>
  poster[size].width >= 100 ? radius.card : radius.control;

/** Shadows on small posters produce visual noise in a list. */
export const posterHasShadow = (size: PosterSize) =>
  poster[size].width >= poster.md.width;
