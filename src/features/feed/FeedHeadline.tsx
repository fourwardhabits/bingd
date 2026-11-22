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
 * Inter's advance by character class, as a fraction of the font size, at the headline's
 * semibold weight (the heavier of its two): a space or a parenthesis is a third of a capital,
 * and a mean such as `estimateTextWidth`'s 0.56em overstates a chunk like `(2023) + 15 more`
 * by a tenth, which is the difference between binding the count and orphaning it at 320pt.
 */
const ADVANCE = {
  space: 0.28,
  narrow: 0.34, // ( ) . , : ; ' ! i l j t f r I
  digit: 0.62,
  upper: 0.7,
  wide: 0.86, // m w M W
  other: 0.56,
} as const;

const charAdvance = (char: string) => {
  if (char === ' ' || char === NBSP) return ADVANCE.space;
  if (/[().,:;'’!iljtfrI]/.test(char)) return ADVANCE.narrow;
  if (/[0-9+]/.test(char)) return ADVANCE.digit;
  if (/[mwMW]/.test(char)) return ADVANCE.wide;
  if (/[A-Z]/.test(char)) return ADVANCE.upper;
  return ADVANCE.other;
};

/** A run's estimated width at `fontSize` (already multiplied by the font scale). */
export const estimateHeadlineWidth = (text: string, fontSize: number) =>
  [...text].reduce((sum, char) => sum + charAdvance(char), 0) * fontSize;

/** The estimate errs long by this much, so a bound chunk is never wider than its line. */
const SAFETY = 1.05;

/** "+ 5 more" → "+ 5 more" with every space non-breaking: the phrase is one unit. */
export const bindPhrase = (phrase: string) => phrase.replace(/ /g, NBSP);

/**
 * **What joins a count phrase to the word before it** (refined card feed, 2026-11-22).
 *
 * "Suraj added Dune: Part Two (2024) + 5 more to their watchlist" used to wrap as
 * "…Part Two (2024) +" / "5 more…", or leave "+ 5 more" alone on a line. The phrase is
 * now bound internally (`bindPhrase`), and bound to the last word of the title (with its
 * year, which is bound to the title already) by a non-breaking space, so the break moves
 * back into the title's own words.
 *
 * **Measured, so it cannot overflow.** A chunk of unbreakable text wider than the line is
 * broken mid-word by the text engine, which is worse than the orphan. So the join is
 * non-breaking only while `lead + phrase` is estimated to fit the headline's line width at
 * the reader's font scale; past that it is an ordinary space, and the phrase, still bound,
 * starts the next line. `lineWidth` null (unknown) is treated as fitting.
 */
export function countJoin(
  lead: string,
  phrase: string,
  lineWidth: number | null,
  fontSize: number,
): string {
  if (lineWidth == null) return NBSP;
  const chunk = `${lead} ${phrase}`;
  return estimateHeadlineWidth(chunk, fontSize) * SAFETY <= lineWidth ? NBSP : ' ';
}

/** The title's last word with its bound year: what a count phrase is joined to. */
export const leadWord = (title: string, year?: number | null) => {
  const words = title.trim().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  return year ? `${last} (${year})` : last;
};

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
  const lead = leadWord(filmName, year);
  // A count is joined to the title only when it directly follows it; after "with Anna and
  // 2 others" it follows a name, and an ordinary space is the right break.
  const joinFor = (phrase: string) =>
    showsCompanions ? ' ' : countJoin(lead, phrase, lineWidth, fontSize);

  const linkPhrase = tailAction ? `${tailAction.connector} ${tailAction.label}` : null;
  const plainCount = !tailAction && tail ? splitCountTail(tail) : null;

  return (
    <View style={styles.header}>
      {onPressActor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${actorName}'s profile`}
          onPress={onPressActor}
          hitSlop={theme.space[1]}
          style={({ pressed }) => pressed && styles.pressed}
          testID="feed-card-avatar"
        >
          <Avatar size={HEADLINE_AVATAR} uri={actorAvatarUri} name={actorName} />
        </Pressable>
      ) : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
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
            {filmName}
            {year ? (
              // Non-breaking, so `(2023)` never starts a line of its own (`ActivityRow`).
              <Text variant="subhead" tone="secondary" style={styles.year}>
                {`${NBSP}(${year})`}
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
              count comes before the tail, so a sentence can carry both, and the count is
              bound to the title's last word (`countJoin`). A "+" is not a word, so it is
              part of the link ("+ 2 more" is one press and one unit, on every platform);
              "and" stays ordinary ink before "2 more", as the legacy sentence had it. */}
          {tailAction && linkPhrase ? (
            <Text variant="subhead" tone="secondary">
              {tailAction.connector === '+'
                ? joinFor(linkPhrase)
                : `${joinFor(linkPhrase)}${tailAction.connector}${NBSP}`}
              <SentenceLink
                label={bindPhrase(tailAction.connector === '+' ? linkPhrase : tailAction.label)}
                onPress={tailAction.onPress}
                accessibilityLabel={tailAction.label}
                testID="feed-card-tail-link"
              />
            </Text>
          ) : null}
          {plainCount
            ? `${joinFor(plainCount.phrase)}${bindPhrase(plainCount.phrase)}${plainCount.rest}`
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
   * Top-aligned (refined card feed, 2026-11-22): the avatar's top edge is the first line's
   * top edge, whatever the sentence's length.
   */
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: HEADLINE_GAP },
  copy: { flex: 1, gap: 2 },
  entity: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  year: { fontFamily: fontFamily.sans },
  pressed: { opacity: 0.7 },
});
