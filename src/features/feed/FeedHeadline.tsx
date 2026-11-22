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
 * "+ 5 more" → "+ 5 more" with every space non-breaking: the phrase is one unit, and the
 * only non-breaking spaces a headline has (founder, natural wrap, 2026-11-22). Everything
 * around it — the name, the verb, the title, the year, the gap before the count — wraps at
 * its ordinary word boundaries, wherever the line ends on this phone at this text size.
 */
export const bindPhrase = (phrase: string) => phrase.replace(/ /g, NBSP);

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
  /** The reader's font scale, for the avatar's cap-height offset (`avatarCapOffset`). */
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
 *
 * **Natural wrapping, never truncated** (founder, 2026-11-22). The sentence breaks at its
 * own word boundaries, so "(2013) + 3 more" or "+ 3 more" may hang on the next line; no
 * line is forced short to push a title down whole. Only "+ 3 more" is bound, so it never
 * splits into "+ 3" / "more". And there is no line cap, no ellipsis and no shrinking on
 * any post: phones differ, so a long headline takes another line rather than losing words.
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
  fontScale = 1,
}: FeedHeadlineProps) {
  const showsCompanions = companions.length > 0 && !grouped;
  const linkPhrase = tailAction ? `${tailAction.connector} ${tailAction.label}` : null;
  const plainCount = !tailAction && tail ? splitCountTail(tail) : null;
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
        {/* No `numberOfLines`, on any post: the whole sentence, however many lines it
            takes. The single-title post's three-line clamp cut long titles off at 130%
            text on a 320pt phone (founder, 2026-11-22). */}
        <Text variant="subhead" tone="secondary" testID="feed-card-headline">
          <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
            {actorName}
          </Text>
          {` ${verb} `}
          <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
            {filmName}
            {year ? (
              // An ordinary space: `(2013)` is one token and sits on whichever line natural
              // wrapping puts it.
              <Text variant="subhead" tone="secondary" style={styles.year}>
                {` (${year})`}
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
              count comes before the tail, so a sentence can carry both, after an ordinary
              space. A "+" is not a word, so it is part of the link ("+ 2 more" is one press
              and one unit, on every platform); "and" stays ordinary ink before "2 more", as
              the legacy sentence had it, bound to it so "and" never ends a line alone. */}
          {tailAction && linkPhrase ? (
            <Text variant="subhead" tone="secondary">
              {tailAction.connector === '+' ? ' ' : ` ${tailAction.connector}${NBSP}`}
              <SentenceLink
                label={bindPhrase(tailAction.connector === '+' ? linkPhrase : tailAction.label)}
                onPress={tailAction.onPress}
                accessibilityLabel={tailAction.label}
                testID="feed-card-tail-link"
              />
            </Text>
          ) : null}
          {plainCount
            ? ` ${bindPhrase(plainCount.phrase)}${plainCount.rest}`
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
