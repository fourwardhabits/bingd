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
  /**
   * Secondary prose: a list's description, a watch's note — writing that sits under a
   * title or date rather than being the page's subject (founder QA, 2026-09-21). One step
   * below `body`, with the same comfortable measure, so a paragraph still reads easily.
   * Never for titles, dates, actions or controls. design-system.md §11b.
   */
  bodySecondary: { fontFamily: fontFamily.sans, fontSize: 15, lineHeight: 22 },
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
   * **The heading system** (docs/design/heading-system.md, founder brief 2026-11-22). Three
   * roles below the serif page and sheet titles, and only elements with the same role
   * share one:
   *
   *   sectionHeading   a section of a content page — TRENDING NOW, TOP RANKED, CAST.
   *   groupLabel       a group inside a sheet, a settings screen or a dense list.
   *   label            a small key above or beside a value — MATCH, DIRECTOR.
   *
   * **A section heading.** Every page-level section on the Feed, both profiles, the title
   * page in both layouts, the person page, Settings' index, My lists and Watch history,
   * through `SectionHeader size="large"`, so a heading that serves the same purpose on two
   * screens is one heading. It replaces two treatments for one role: 15pt (+0.7) on the
   * Feed and the reader's own profile, and 12pt on somebody else's profile and the title
   * page.
   *
   * **Quieter than the 15pt it replaces, louder than 12.** Compared in context at 360 and
   * 320pt (heading-system.md §5): at 15pt with 0.7 tracking the caps read as labels laid
   * over the page and competed with the posts and posters under them; sentence case and
   * the serif both read as content rather than structure, and a neutral grey lost the warm
   * accent the page needs. 13pt with tighter tracking keeps the burgundy capitals the app
   * is known by and sits below the artwork, the post headline and the row titles in the
   * order a reader takes them in. Maroon on Paper is 8.2:1, on Parchment 7.4:1.
   *
   * Scales with the reader's text size without a ceiling, like every non-display token;
   * the Feed's headings alone stop at 130% beside the mode toggle (`FeedHeading`).
   */
  sectionHeading: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  /**
   * **A group label: a group inside a sheet, a settings screen or a dense list** — the
   * filter sheets' GENRE and TIME PERIOD, Where to Watch's STREAM and RENT, a notification
   * day, a search result kind, a year in Watch history, a Settings sub-screen's groups.
   *
   * The old `sectionHeader`, renamed for what it does and otherwise unchanged: it was
   * already this size everywhere the role is drawn. One step under `sectionHeading`,
   * because a group sits inside something that already has a heading of its own (a sheet's
   * title, a screen's title), and two headings of one size stacked read as siblings.
   */
  groupLabel: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  /**
   * **A small key above or beside a value**: MATCH and SHARED in the Match explainer, an
   * award's breakdown parts, the original title page's DIRECTOR and RUNTIME. Set in
   * `text.secondary` (6.4:1 on Paper, 5.8:1 on Parchment), never Maroon: it is metadata about
   * the line under it, not structure. It was three styles for one role (`caption` caps at
   * +0.2 in tertiary, `footnote` caps in tertiary, `footnote` caps at +0.6 in secondary), and
   * the one it settles on is the most legible of the three.
   */
  label: {
    fontFamily: fontFamily.sansMedium,
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
