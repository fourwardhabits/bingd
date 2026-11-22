import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, CompanionNames, SentenceLink, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import type { TailAction } from './activity';

/** U+00A0. A space the line breaker may not break at. */
export const NBSP = ' ';

/**
 * **The post's avatar: `sm`, 32pt** (refined card feed, 2026-11-22).
 *
 * Evaluated against 36 and `md` (44). The headline block is 38pt at its shortest (a 20pt
 * line, 2pt, a 16pt time line), so 44 would make every one-line post 6pt taller, which is
 * the density the spec keeps; 36 is not a size the token scale has. 32, top-aligned with
 * the headline's first line, reads as the start of the sentence rather than as a badge
 * centred on a block that grows downward when the sentence wraps.
 */
export const HEADLINE_AVATAR = 'sm' as const;

/** Avatar to headline. */
export const HEADLINE_GAP = theme.space[3];

/**
 * Inter's vertical metrics, from the bundled font's own tables (`@expo-google-fonts/inter`,
 * every weight shares them): 2048 units per em, `hhea` ascender 1984 and descender 494,
 * `OS/2` cap height 1490. Read once from the TTF rather than guessed, so the offset below
 * is arithmetic, not a nudge.
 */
const INTER = { unitsPerEm: 2048, ascender: 1984, descender: 494, capHeight: 1490 } as const;

/**
 * **How far the avatar sits below the headline's line box: to the first line's cap height**
 * (Feed QA polish, founder, 2026-11-22: "the profile picture looks slightly too high").
 *
 * #368 top-aligned the avatar with the first line's *box*. The box is taller than the
 * letters: `subhead` is 14pt type on a 20pt line, so the text sits in 16.9pt of font
 * height with 1.5pt of leading above it, and Inter's capitals start another 3.4pt below
 * the ascender. So the tops of "Suraj" were 4.9pt under the avatar's top edge and the face
 * peeked above the sentence. Aligning the circle's top with the cap height of the first
 * line puts it level with the first letters, the way the eye reads alignment.
 *
 * Both platforms centre the font in its line height, and both scale the line height with
 * the text size, so the offset is the same arithmetic at any `fontScale`: 5pt at 100%, 6pt
 * at 130%. Rounded to a whole point so the avatar lands on the pixel grid.
 */
export function avatarCapOffset(fontScale = 1): number {
  const { fontSize, lineHeight } = theme.typography.subhead;
  const size = fontSize * fontScale;
  const line = (lineHeight ?? fontSize) * fontScale;
  const em = (units: number) => (units / INTER.unitsPerEm) * size;
  const leading = (line - em(INTER.ascender + INTER.descender)) / 2;
  return Math.round(leading + em(INTER.ascender - INTER.capHeight));
}

/**
 * **Inter's advance widths, per character, from the bundled font files** (Feed QA polish,
 * 2026-11-22), as a fraction of the font size: every printable ASCII character in
 * `Inter_600SemiBold` (the title and the count) and `Inter_400Regular` (the year), read
 * from each TTF's `hmtx` table. Per character and per weight rather than an average,
 * because the rule below decides whether a title fits on a line, and an average that
 * overstated "Portrait of a Lady on Fire (2019)" by 5% pushed the year onto a line of its
 * own.
 */
const ADVANCE_CHARS =
  '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const SEMIBOLD = [
  0.321, 0.523, 0.644, 0.65, 1.004, 0.663, 0.326, 0.373, 0.373, 0.54, 0.673, 0.319, 0.465,
  0.319, 0.379, 0.66, 0.423, 0.623, 0.636, 0.666, 0.612, 0.64, 0.576, 0.64, 0.64, 0.319, 0.329,
  0.673, 0.673, 0.673, 0.543, 0.999, 0.728, 0.659, 0.737, 0.722, 0.605, 0.588, 0.749, 0.746,
  0.277, 0.58, 0.703, 0.565, 0.922, 0.759, 0.769, 0.645, 0.773, 0.652, 0.65, 0.66, 0.736, 0.728,
  1.02, 0.72, 0.713, 0.652, 0.373, 0.379, 0.373, 0.481, 0.469, 0.351, 0.574, 0.624, 0.583,
  0.624, 0.591, 0.389, 0.625, 0.612, 0.262, 0.262, 0.569, 0.262, 0.9, 0.612, 0.609, 0.624,
  0.624, 0.397, 0.549, 0.353, 0.612, 0.587, 0.839, 0.569, 0.588, 0.566, 0.455, 0.359, 0.455,
  0.673,
];
const REGULAR = [
  0.288, 0.466, 0.633, 0.642, 0.982, 0.644, 0.3, 0.365, 0.365, 0.501, 0.662, 0.288, 0.46, 0.288,
  0.36, 0.631, 0.407, 0.61, 0.618, 0.646, 0.593, 0.62, 0.566, 0.619, 0.62, 0.288, 0.302, 0.662,
  0.662, 0.662, 0.511, 0.966, 0.69, 0.654, 0.73, 0.722, 0.601, 0.59, 0.746, 0.743, 0.269, 0.571,
  0.672, 0.565, 0.903, 0.753, 0.765, 0.639, 0.765, 0.644, 0.642, 0.646, 0.744, 0.69, 0.985,
  0.682, 0.679, 0.629, 0.365, 0.36, 0.365, 0.471, 0.456, 0.323, 0.562, 0.612, 0.571, 0.612,
  0.583, 0.37, 0.613, 0.591, 0.242, 0.242, 0.549, 0.242, 0.876, 0.591, 0.6, 0.612, 0.612, 0.376,
  0.528, 0.327, 0.591, 0.562, 0.818, 0.546, 0.562, 0.552, 0.426, 0.333, 0.426, 0.662,
];
const SPACE_ADVANCE = 0.281;
/** Anything outside the table (accented and non-Latin letters): a wide lowercase letter. */
const OTHER_ADVANCE = 0.65;

/** A run's estimated width at `fontSize` (already multiplied by the font scale). */
export const estimateHeadlineWidth = (
  text: string,
  fontSize: number,
  weight: 'semibold' | 'regular' = 'semibold',
) => {
  const table = weight === 'semibold' ? SEMIBOLD : REGULAR;
  let width = 0;
  for (const char of text) {
    const index = char === ' ' || char === NBSP ? -2 : ADVANCE_CHARS.indexOf(char);
    width +=
      index === -2
        ? SPACE_ADVANCE
        : index >= 0
          ? (table[index] ?? OTHER_ADVANCE)
          : OTHER_ADVANCE;
  }
  return width * fontSize;
};

/**
 * The estimate errs long by this much, so a bound chunk is never wider than its line. The
 * advances are exact; this covers what they leave out: kerning (Inter's tightens more pairs
 * than it loosens) and each platform rounding glyph positions to its pixel grid.
 */
const SAFETY = 1.02;

/** "+ 5 more" → "+ 5 more" with every space non-breaking: the phrase is one unit. */
export const bindPhrase = (phrase: string) => phrase.replace(/ /g, NBSP);

/** Whether a run `width` wide (estimated) fits one line `lineWidth` wide; unknown fits. */
const fits = (width: number, lineWidth: number | null) =>
  lineWidth == null || width * SAFETY <= lineWidth;

export type HeadlineJoins = {
  /** The title as drawn: every space non-breaking when the whole title fits on a line. */
  title: string;
  /** What goes between the title and `(2013)`. */
  beforeYear: string;
  /** What goes between the title (or its year) and the count phrase, `+ 3 more`. */
  beforeCount: string;
};

/**
 * **Where a headline may break** (Feed QA polish, founder, Android QA of #368, 2026-11-22).
 *
 * #368 bound "+ 3 more" to the title's last word, which on a 320pt phone gave
 * "Suraj ranked Nathan for" / "You (2013) + 3 more": the count stayed together and the
 * title was cut in half. The rule now works from the whole title outwards, measured against
 * the headline's line width at the reader's text size, and never special-cases a title:
 *
 *   1. **A title that fits on one line is never split.** Its own spaces become
 *      non-breaking, so when it does not fit after "Suraj ranked" the line breaks *before*
 *      it and the title starts the next line whole: "Suraj ranked" / "Nathan for You (2013)
 *      + 3 more".
 *   2. **The year stays with a title that fits with it**, so `(2013)` never starts a line
 *      after a short title.
 *   3. **"+ 3 more" joins the year (or the title) only when the whole of title, year and
 *      count fits on one line.** Otherwise the break falls between the year and the count:
 *      "Portrait of a Lady on Fire (2019)" / "+ 3 more to their watchlist". The phrase
 *      itself is always one unit (`bindPhrase`).
 *   4. **A title too long for any line wraps at its own spaces**, as ordinary text, and the
 *      year and the count travel together as one unit after it ("(2001) + 15 more"), so
 *      the title's last word is never dragged onto the next line by them.
 *
 * Nothing is truncated or shortened; a long headline takes another line. The estimate errs
 * long (`SAFETY`), so a bound run is never wider than the line it has to fit.
 */
export function headlineJoins({
  title,
  year,
  countPhrase,
  lineWidth,
  fontSize,
}: {
  title: string;
  year?: number | null;
  /** `+ 3 more`, `and 2 more`; null when the sentence has no count. */
  countPhrase: string | null;
  lineWidth: number | null;
  fontSize: number;
}): HeadlineJoins {
  // The title and the count are semibold runs; the year is set in the regular weight.
  const titleWidth = estimateHeadlineWidth(title, fontSize);
  const yearWidth = year ? estimateHeadlineWidth(` (${year})`, fontSize, 'regular') : 0;
  const countWidth = countPhrase ? estimateHeadlineWidth(` ${countPhrase}`, fontSize) : 0;

  const whole = fits(titleWidth, lineWidth);
  const yearStays = Boolean(year) && whole && fits(titleWidth + yearWidth, lineWidth);

  let beforeCount = ' ';
  if (countPhrase) {
    if (!year) {
      beforeCount = whole && fits(titleWidth + countWidth, lineWidth) ? NBSP : ' ';
    } else if (yearStays) {
      beforeCount = fits(titleWidth + yearWidth + countWidth, lineWidth) ? NBSP : ' ';
    } else {
      // The year has left the title's line, or the title wraps: "(2013) + 3 more" is a unit.
      beforeCount = fits(yearWidth + countWidth, lineWidth) ? NBSP : ' ';
    }
  }

  return {
    title: whole ? bindPhrase(title) : title,
    beforeYear: yearStays ? NBSP : ' ',
    beforeCount,
  };
}

/**
 * A plain-text tail that opens with a count — "+ 5 more to their watchlist", on a surface
 * with no list to open — split into its bound phrase and the rest, so it takes the same
 * rule as the linked phrase. Null for any other tail.
 */
export function splitCountTail(tail: string): { phrase: string; rest: string } | null {
  const match = /^((?:\+|and) \d+ (?:more|others?))(.*)$/.exec(tail);
  if (!match) return null;
  return { phrase: match[1] ?? '', rest: match[2] ?? '' };
}

export type FeedHeadlineProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  onPressActor?: () => void;
  verb: string;
  /** The title as the sentence names it ("a title" when there is none). */
  filmName: string;
  year?: number | null;
  onPressTitle: () => void;
  companions: string[];
  onPressCompanions?: () => void;
  grouped: boolean;
  tailAction: TailAction | null;
  tail: string | null;
  /** `12m ago · 2nd watch · PG-13 · 148m`. */
  subline: string;
  /** The width the sentence wraps in, for the measured join; null when unknown. */
  lineWidth: number | null;
  /** The reader's font scale, which the measured join multiplies the type size by. */
  fontScale?: number;
};

/**
 * **Who did what, and when** — the post's headline (refined card feed, 2026-11-22).
 *
 *     (A) Maya Chen ranked Oppenheimer (2023) + 5 more
 *         12m ago
 *
 * `ActivityRow`'s sentence grammar unchanged, newest title first, laid out beside the
 * avatar. The avatar is **top-aligned** with the headline's first line, so a sentence
 * that wraps grows away from the face rather than re-centring it.
 */
export function FeedHeadline({
  actorName,
  actorAvatarUri,
  onPressActor,
  verb,
  filmName,
  year,
  onPressTitle,
  companions,
  onPressCompanions,
  grouped,
  tailAction,
  tail,
  subline,
  lineWidth,
  fontScale = 1,
}: FeedHeadlineProps) {
  // A sentence that ends in a control is never clamped: the count is the only way into the
  // rest, and truncation would cut exactly that.
  const companionsLink = !grouped && companions.length > 2 && onPressCompanions != null;
  const holdsLink = grouped || tailAction != null || companionsLink;
  const showsCompanions = companions.length > 0 && !grouped;

  const fontSize = theme.typography.subhead.fontSize * fontScale;
  const linkPhrase = tailAction ? `${tailAction.connector} ${tailAction.label}` : null;
  const plainCount = !tailAction && tail ? splitCountTail(tail) : null;
  const joins = headlineJoins({
    title: filmName,
    year,
    countPhrase: linkPhrase ?? plainCount?.phrase ?? null,
    lineWidth,
    fontSize,
  });
  // A count is joined to the title only when it directly follows it; after "with Anna and
  // 2 others" it follows a name, and an ordinary space is the right break.
  const beforeCount = showsCompanions ? ' ' : joins.beforeCount;
  const avatarOffset = { marginTop: avatarCapOffset(fontScale) };

  return (
    <View style={styles.header}>
      {onPressActor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actorName}'s profile`}
          onPress={onPressActor}
          hitSlop={theme.space[1]}
          style={({ pressed }) => [avatarOffset, pressed && styles.pressed]}
          testID="feed-card-avatar"
        >
          <Avatar size={HEADLINE_AVATAR} uri={actorAvatarUri} name={actorName} />
        </Pressable>
      ) : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={avatarOffset}
          testID="feed-card-avatar"
        >
          <Avatar size={HEADLINE_AVATAR} uri={actorAvatarUri} name={actorName} />
        </View>
      )}
      <View style={styles.copy}>
        {/* Three lines, like the row — and no clamp at all when the sentence ends in a
            control: "+ 2 more" is the only way into a sitting, and truncation would cut
            exactly that (independent review, 2026-11-04). */}
        <Text
          variant="subhead"
          tone="secondary"
          numberOfLines={holdsLink ? undefined : 3}
          testID="feed-card-headline"
        >
          <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
            {actorName}
          </Text>
          {` ${verb} `}
          <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
            {joins.title}
            {year ? (
              // Bound to a title that fits with it, so `(2013)` never starts a line after a
              // short title (`headlineJoins`).
              <Text variant="subhead" tone="secondary" style={styles.year}>
                {`${joins.beforeYear}(${year})`}
              </Text>
            ) : null}
          </Text>
          {showsCompanions ? (
            <Text variant="subhead" tone="secondary">
              {' with '}
              <CompanionNames
                names={companions}
                onPressAll={onPressCompanions}
                entityStyle={styles.entity}
                testID="feed-card-companions-link"
              />
            </Text>
          ) : null}
          {/* "ranked Sheroes + 2 more", "added Dune + 4 more to their watchlist": the
              count comes before the tail, so a sentence can carry both, and where it may
              break is `headlineJoins`' decision. A "+" is not a word, so it is
              part of the link ("+ 2 more" is one press and one unit, on every platform);
              "and" stays ordinary ink before "2 more", as the legacy sentence had it. */}
          {tailAction && linkPhrase ? (
            <Text variant="subhead" tone="secondary">
              {tailAction.connector === '+'
                ? beforeCount
                : `${beforeCount}${tailAction.connector}${NBSP}`}
              <SentenceLink
                label={bindPhrase(tailAction.connector === '+' ? linkPhrase : tailAction.label)}
                onPress={tailAction.onPress}
                accessibilityLabel={tailAction.label}
                testID="feed-card-tail-link"
              />
            </Text>
          ) : null}
          {plainCount
            ? `${beforeCount}${bindPhrase(plainCount.phrase)}${plainCount.rest}`
            : tail
              ? ` ${tail}`
              : null}
        </Text>
        {subline ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {subline}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Top-aligned (refined card feed, 2026-11-22), whatever the sentence's length; the avatar
   * then drops to the first line's cap height (`avatarCapOffset`).
   */
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: HEADLINE_GAP },
  copy: { flex: 1, gap: 2 },
  entity: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  year: { fontFamily: fontFamily.sans },
  pressed: { opacity: 0.7 },
});
