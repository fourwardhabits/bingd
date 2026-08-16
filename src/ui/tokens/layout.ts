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
  /** Minimum Paper on every screen edge. The title-page hero is the one
   *  full-bleed surface in the app (design-system.md §7). */
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
  /**
   * The compact list row (design-system.md §8). 60pt is set by the text block —
   * two lines of type plus padding — and poster.row is sized to fit inside it.
   * A row must never take its height from its artwork.
   */
  compactRow: 60,
  /**
   * Filled circle carrying the derived score (design-system.md §8).
   *
   * `sm` went from 36 to 40 on 2026-08-16. `ScoreBadge` sizes its number to fit
   * `10.0` rather than the more common `8.7`, and at 36 that arithmetic yields
   * 13pt — legible, but visibly smaller than the row's own footnote beside it.
   * Four points of diameter buys two of type and the badge reads as the row's
   * anchor again.
   */
  scoreBadge: { lg: 56, md: 44, sm: 40 },
  /** Tight, because wide gutters make a poster wall read as scattered. */
  posterGrid: { columns: 3, gap: space[1] + 2 },
  posterShelf: { gap: space[2] + 2, peek: 0.7 },
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
 * Radius steps down with size, which keeps the *visual* corner constant as the
 * poster scales — a 12pt radius on a 40pt thumbnail eats the artwork.
 */
export const poster = {
  /**
   * Sized to fit *inside* a 60pt row rather than to define one. `sm` is 84pt
   * tall, so a row pinned to it was 84pt for two lines of type — artwork
   * dictating rhythm, which is the bug this size exists to prevent.
   */
  row: { width: 38, height: 57 },
  xs: { width: 40, height: 60 },
  sm: { width: 56, height: 84 },
  md: { width: 88, height: 132 },
  lg: { width: 132, height: 198 },
  xl: { width: 180, height: 270 },
} as const;

export type PosterSize = keyof typeof poster;

export const posterRadius = (size: PosterSize) => {
  const { width } = poster[size];
  if (width >= 100) return radius.card;
  if (width >= 60) return radius.control;
  return 6;
};

/** Shadows on small posters produce visual noise in a list. */
export const posterHasShadow = (size: PosterSize) =>
  poster[size].width >= poster.md.width;
