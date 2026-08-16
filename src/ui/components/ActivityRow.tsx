import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { fontFamily, theme } from '../tokens';
import { Avatar } from './Avatar';
import { Poster } from './Poster';
import { ScoreBadge } from './ScoreBadge';
import { SpoilerNote } from './SpoilerNote';
import { Text } from './Text';

export type ActivityReaction = {
  /** How many people have reacted at all. */
  count: number;
  /** Whether the signed-in user is one of them. */
  mine: boolean;
  /** The distinct glyphs present, most common first (PRD §14). */
  glyphs?: string[];
  /** At most two, for "Jerry and Beth". Never includes the reader. */
  names?: string[];
  /** Reactors beyond the named ones, already netted off. */
  others?: number;
  onPress: () => void;
};

export type ActivityRowProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  /** Opens the actor's profile. Absent for the viewer's own activity. */
  onPressActor?: () => void;
  /** The verb between the actor and the title: "ranked", "watched", "finished". */
  verb: string;
  /** Already in its full form — "Parks and Recreation — Season 2" (`lib/titles.ts`). */
  title: string | null;
  year?: number | null;
  posterUri?: string | null;
  /** `148m · Sci-fi`, beneath the title inside the card. */
  metadata?: string | null;
  score?: number | null;
  bucket?: Bucket | null;
  note?: string | null;
  noteHasSpoilers?: boolean;
  /** Decided by `shouldMask`, never by this component. */
  noteMasked?: boolean;
  timeLabel: string;
  onPressTitle: () => void;
  onPressWatchlist?: () => void;
  inWatchlist?: boolean;
  onPressShare?: () => void;
  reaction?: ActivityReaction;
};

/**
 * One activity, as a divider-separated row (screens.md §7).
 *
 * Rebuilt on 2026-08-16 after a device test. The structure was right and the density
 * was not: an avatar line, a card line, a note and an action line each took their own
 * band of the screen, so three events filled a phone and the feed read as a stack of
 * receipts. Beli fits five or six in the same space, and the difference is not
 * smaller type — it is that the sentence, the artwork and the score occupy *one*
 * band, with everything else hanging off it.
 *
 * So: poster on the left, the sentence and the metadata stacked beside it, the score
 * on the right, all in one row. Actions become icons under it rather than labelled
 * controls, because "Watchlist" set in a footnote beside "Saved" was the widest thing
 * on the row and said the least.
 *
 * The poster is small on purpose and that is unchanged. Beli's feed is carried by
 * food photography that its users took; every Bingd activity for the same film shows
 * the same official poster, so artwork cannot be what distinguishes one row from the
 * next. The score badge does that work.
 */
export function ActivityRow({
  actorName,
  actorAvatarUri,
  onPressActor,
  verb,
  title,
  year,
  posterUri,
  metadata,
  score,
  bucket,
  note,
  noteHasSpoilers = false,
  noteMasked = false,
  timeLabel,
  onPressTitle,
  onPressWatchlist,
  inWatchlist = false,
  onPressShare,
  reaction,
}: ActivityRowProps) {
  const filmName = title ?? 'a title';

  return (
    <View style={styles.row}>
      <View style={styles.main}>
        {/* The title, never the sentence. Poster derives its placeholder
            initials from whatever it is given, so passing the sentence in
            rendered "Someone ranked a title." as a confident-looking SR. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[filmName, year, metadata].filter(Boolean).join(', ')}
          onPress={onPressTitle}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Poster uri={posterUri} title={filmName} size="xs" />
        </Pressable>

        <View style={styles.copy}>
          {/* The avatar sits *inside* the sentence line rather than above it. That
              is the single change that bought most of the density: the header band
              it used to have was 32pt of mostly empty row, and the face is doing the
              same job at 24 beside the words it belongs to. */}
          <View style={styles.who}>
            <Pressable
              accessibilityRole={onPressActor ? 'button' : undefined}
              accessibilityLabel={onPressActor ? `${actorName}'s profile` : actorName}
              onPress={onPressActor}
              disabled={!onPressActor}
              hitSlop={theme.space[1]}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Avatar size="xs" uri={actorAvatarUri} name={actorName} />
            </Pressable>
            {/* Bolded entities inside one sentence, which is Beli's treatment and
                what makes the row scannable without a separate header line. Both
                entities are pressable, so the sentence is also the navigation. */}
            <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.sentence}>
              <Text variant="footnote" style={styles.entity} onPress={onPressActor}>
                {actorName}
              </Text>
              {` ${verb}`}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filmName}
            onPress={onPressTitle}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text variant="callout" numberOfLines={1}>
              {filmName}
              {year ? (
                <Text variant="callout" tone="secondary">
                  {'  '}
                  {year}
                </Text>
              ) : null}
            </Text>
          </Pressable>

          {metadata ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {metadata}
            </Text>
          ) : null}
        </View>

        {score != null ? (
          <View style={styles.badge}>
            <ScoreBadge score={score} bucket={bucket} size="sm" />
          </View>
        ) : null}
      </View>

      {note ? (
        <View style={styles.note}>
          <SpoilerNote
            text={note}
            hasSpoilers={noteHasSpoilers}
            masked={noteMasked}
            numberOfLines={2}
            titleForLabel={title}
          />
        </View>
      ) : null}

      {/* PRD §14: the glyphs present, at most two names, then a residual count.
          Never a per-kind tally, and never anything that could be aggregated onto a
          person — `disagree` in particular is countable on the activity it belongs
          to and nowhere else, which is the difference between banter and a
          scoreboard. */}
      {reaction && reaction.count > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={reactionSummaryLabel(reaction)}
          onPress={reaction.onPress}
          style={({ pressed }) => [styles.reactors, pressed && styles.pressed]}
        >
          {reaction.glyphs?.length ? (
            <Text variant="footnote" accessibilityElementsHidden>
              {reaction.glyphs.join(' ')}
            </Text>
          ) : null}
          <Text variant="footnote" tone="secondary" numberOfLines={1}>
            {reactorSummary(reaction)}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.actions}>
        {reaction ? (
          <IconAction
            icon={reaction.mine ? 'heart' : 'heart-outline'}
            active={reaction.mine}
            label={
              reaction.mine
                ? `You reacted to ${filmName}. Change or remove your reaction.`
                : `React to ${actorName}'s activity about ${filmName}`
            }
            badge={reaction.count > 0 ? String(reaction.count) : undefined}
            onPress={reaction.onPress}
          />
        ) : null}

        {/* Comments are deferred (PRD §14) and a disabled comment icon is worse
            than none, so there is no placeholder for one here. */}

        {onPressWatchlist ? (
          <IconAction
            icon={inWatchlist ? 'bookmark' : 'bookmark-outline'}
            active={inWatchlist}
            selected={inWatchlist}
            label={
              inWatchlist ? `${filmName} is in your watchlist` : `Add ${filmName} to your watchlist`
            }
            onPress={onPressWatchlist}
          />
        ) : null}

        {onPressShare ? (
          <IconAction icon="share-outline" label={`Share ${filmName}`} onPress={onPressShare} />
        ) : null}

        <Text variant="caption" tone="tertiary" style={styles.time}>
          {timeLabel}
        </Text>
      </View>
    </View>
  );
}

/**
 * "Jerry and Beth", or "Jerry, Beth and 4 others".
 *
 * Two names then a residual, which is PRD §14 and Messenger's pattern. Naming
 * everyone turns a friendly row into a list, and naming nobody makes a number that
 * says less than one name would.
 */
function reactorSummary({ names = [], others = 0, count }: ActivityReaction) {
  // Nobody to name means the only reactor is the reader themselves, or the
  // reactors' profiles did not resolve. A count is the honest fallback.
  if (!names.length) return count === 1 ? '1 reaction' : `${count} reactions`;

  const named = names.length === 1 ? names[0] : `${names[0]} and ${names[1]}`;
  if (others <= 0) return named;
  return `${named} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

/** The same sentence, plus what pressing it does. */
const reactionSummaryLabel = (reaction: ActivityReaction) =>
  `${reactorSummary(reaction)} reacted. Open reactions.`;

/**
 * An action as an icon.
 *
 * The label is what a screen reader gets, and it names the thing being acted on
 * rather than the glyph — "Add Sinners to your watchlist", not "Bookmark". An icon
 * row is only denser than a text row if the meaning moves into the label rather than
 * being dropped.
 */
function IconAction({
  icon,
  label,
  onPress,
  active = false,
  selected,
  badge,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  badge?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={theme.space[2]}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      {badge ? (
        <Text variant="caption" tone={active ? 'action' : 'secondary'}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  main: { flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 2 },
  who: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  sentence: { flex: 1 },
  entity: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  badge: { alignSelf: 'center' },
  // Indented to the poster's right edge, so a note reads as belonging to the row
  // above it rather than starting a new one.
  note: { paddingLeft: theme.poster.xs.width + theme.space[3] },
  reactors: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingLeft: theme.poster.xs.width + theme.space[3],
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[5],
    paddingLeft: theme.poster.xs.width + theme.space[3],
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
  },
  time: { flex: 1, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
