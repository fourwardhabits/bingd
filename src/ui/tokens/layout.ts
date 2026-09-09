import { inkAlpha } from './color';

/** 4pt base. Source: docs/design/design-system.md §5. */
export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  /**
   * The interval between two *sections* of a reading page (title detail, 2026-09-07).
   *
   * `space[6]` separates blocks inside a section and was doing section duty as well, so
   * "genres, then SCORES" was spaced exactly like "heading, then the heading's own
   * content" — and the title page read as one undifferentiated column rather than as a
   * sequence of answers to different questions.
   *
   * 28 is the next step on the same 4pt grid every other key here sits on, so this is a
   * scale entry and not a one-off constant: the founder's spacing contract asks for
   * 24–28 at every section seam, and this is the top of that range, used where no rule
   * carries the change.
   */
  7: 28,
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
  /**
   * `xxs` is the feed row's actor chip, overlaid on the corner of a 40pt poster
   * (`ActivityRow`). It is deliberately below the 24pt floor the standalone sizes
   * observe: a circle here is read against artwork it sits on rather than on its
   * own, and at 24 it covered three fifths of the poster's width and stopped
   * reading as a stamp. `Avatar` drops to one initial below `xs` for the same
   * reason — two will not fit.
   */
  avatar: { xxs: 18, xs: 24, sm: 32, md: 44, lg: 72 },
  icon: { sm: 20, md: 24, lg: 28 },
  control: {
    searchFieldHeight: 40,
    chipHeight: 32,
    headerHeight: 44,
    /**
     * The ceiling on a **content-sized** button standing in a row beside icon controls
     * (title detail, founder lock, 2026-09-07).
     *
     * The Rank/Ranked control took `flex: 1` and therefore the whole content width, which
     * the founder rejected on the device: a full-width primary reads as a form's submit
     * button, and it is the reason the row below the identity block looked like chrome.
     * It is sized by its own label now, and this is only the guard at the top end — at
     * large text sizes a label-sized button can otherwise walk across the whole column.
     *
     * 168 is the top of the founder's 150–170 range. `Ranked` sets to about 132 at the
     * default text size, so on an ordinary phone this never binds; it exists for 130%
     * type, where it is the difference between a compact control and a full-width one.
     */
    inlineButtonMaxWidth: 168,
    /**
     * The floor under that same control, so its two states are one width
     * (founder, physical QA, 2026-09-08).
     *
     * `Rank` and `Ranked` are two characters apart, and a content-sized button therefore
     * grew by about that much the instant a ranking succeeded — carrying the bookmark and
     * recommend glyphs beside it a step to the right. Small, and the founder saw it: the
     * row twitched at the same moment the page was telling them the thing had worked.
     *
     * 132 is not a new measurement. It is the one the ceiling above is already derived
     * from — *"`Ranked` sets to about 132 at the default text size"* — so the floor is the
     * wider label's own width, and at default type both states now measure the same.
     *
     * **What this does not claim.** At larger text sizes both labels outgrow 132 and the
     * two-character difference returns, bounded by `inlineButtonMaxWidth`. Holding them
     * equal at every type size would mean measuring the longer label at runtime and
     * reserving it, which is a great deal of machinery for a few points of drift at 130%
     * type. This fixes the case the founder is actually looking at.
     */
    inlineButtonMinWidth: 132,
  },
  /**
   * What lifts a 32pt chip to the 44pt target without drawing it any larger
   * (2026-09-07). Vertical is the arithmetic, `(44 - 32) / 2`; horizontal is half of
   * a chip row's `space[2]` gap, so two neighbours' slops meet without crossing and a
   * press between them still belongs to the nearer one. `FilterChip`, `SortMenu` and
   * the title page's genre chips share it, which is what keeps three rows of the same
   * control answering a thumb the same way.
   */
  chipHitSlop: { top: 6, bottom: 6, left: space[1], right: space[1] },
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
  /**
   * `detail` is the title page's Scores row, and all three units share it — the
   * reader's own score, the mean over the people they follow, and bingd.'s.
   *
   * **It replaces `xl` (64), which is deleted rather than deprecated.** `xl` existed for
   * exactly one place: the personal-score cluster that hung off the poster's corner, and
   * the founder's 2026-09-07 direction moves the reader's own number into the Scores row
   * with the other two. Nothing else ever used it, so leaving it would leave a size in
   * the system that documents a composition the app no longer has.
   *
   * 48 rather than `lg` (56) or `md` (44): three of these sit across a 358pt content
   * width with their labels beside them, and at 56 the row runs out of column before the
   * third label is set. The hierarchy between the three is carried by *fill*, not by
   * diameter — see `ScoreBadge`'s `variant`.
   */
  scoreBadge: { lg: 56, detail: 48, md: 44, sm: 40 },
  /**
   * The award badge's well (Bingd Awards, 2026-08-18).
   *
   * A shade larger than `scoreBadge.md`, because a score is a number and a badge is a
   * drawing: the popcorn bucket has a face on it, and at 44 the face is a smudge.
   */
  awardBadge: 52,
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
  /**
   * The title page's identity poster, on the right of the title block.
   *
   * Between `md` and `lg` because neither worked: at 88 the artwork stopped being the
   * counterweight to a serif title and read as a thumbnail somebody had left there, and
   * at 132 the column left too little width to set that title in beside it.
   *
   * At 100 wide it takes `radius.card` and a shadow from the rules below with no new
   * branch in either, which is the test of whether a size belongs on this scale.
   */
  detail: { width: 100, height: 150 },
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
export const posterHasShadow = (size: PosterSize) => poster[size].width >= poster.md.width;
