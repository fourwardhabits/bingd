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
  /** The reader's own glyph, or null. Its presence is what fills the control. */
  mineGlyph?: string | null;
  /** The distinct glyphs present, most common first (PRD §14). */
  glyphs?: string[];
  /** A plain tap: toggles the default reaction on or off. */
  onPress: () => void;
  /** A long press: opens the full picker. */
  onLongPress?: () => void;
  /** Tapping the summary opens the list of who reacted. */
  onPressSummary?: () => void;
  /** Rendered inside the row, above the actions — see `ReactionPill`. */
  picker?: React.ReactNode;
};

export type ActivityRowProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  /** Opens the actor's profile. Absent for the viewer's own activity. */
  onPressActor?: () => void;
  /** The verb between the actor and the title: "ranked", "watched", "finished". */
  verb: string;
  /** Names the actor said they watched it with (PRD §14). */
  companions?: string[];
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
  companions = [],
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
              {/* Inside the sentence rather than on a line of its own. "Sai and
                  Anna watched" is the fact; a separate "with Anna" row would be a
                  second band for three words. */}
              {companions.length ? (
                <Text variant="footnote" tone="secondary">
                  {' with '}
                  <Text variant="footnote" style={styles.entity}>
                    {companionNames(companions)}
                  </Text>
                </Text>
              ) : null}
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

      {/* The glyphs people used and how many there were, and nothing else.
          Subordinate to the film by construction: footnote size, indented under the
          poster, no per-kind tally. `disagree` is countable on the activity it
          belongs to and nowhere else, which is the difference between banter and a
          scoreboard (PRD §14). The breakdown lives behind the tap. */}
      {reaction && reaction.count > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${reaction.count} ${reaction.count === 1 ? 'reaction' : 'reactions'}. See who reacted.`}
          onPress={reaction.onPressSummary}
          disabled={!reaction.onPressSummary}
          style={({ pressed }) => [styles.reactors, pressed && styles.pressed]}
        >
          {reaction.glyphs?.length ? (
            <View style={styles.glyphs} accessibilityElementsHidden>
              {/* Overlapped rather than spaced, so three glyphs read as one object
                  and cost the width of about two. */}
              {reaction.glyphs.slice(0, 3).map((glyph, index) => (
                <View key={glyph} style={[styles.glyph, index > 0 && styles.glyphOverlap]}>
                  <Text variant="footnote" allowFontScaling={false}>
                    {glyph}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text variant="footnote" tone="secondary">
            {reaction.count}
          </Text>
        </Pressable>
      ) : null}

      {reaction?.picker ? <View style={styles.picker}>{reaction.picker}</View> : null}

      <View style={styles.actions}>
        {reaction ? (
          /**
           * Tap toggles the default; long press opens the six.
           *
           * The control used to render the reader's own glyph, which put the same
           * emoji on the row twice — once in the summary cluster above, once here —
           * and read as a duplicate rather than as two different statements. The
           * summary is social proof; this is a control, and a control's job is to
           * say whether *I* have acted.
           *
           * So it stays an icon and changes state instead: a filled Maroon heart
           * when I have reacted, an outline when I have not. The glyph I chose is
           * still visible — it is in the cluster above, where it is counted with
           * everybody else's, which is the only place it means anything.
           */
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(reaction.mineGlyph) }}
            accessibilityLabel={
              reaction.mineGlyph
                ? `You reacted to ${filmName}. Tap to remove, long press to change.`
                : `React to ${actorName}'s activity about ${filmName}. Long press for more reactions.`
            }
            accessibilityHint="Long press to choose a different reaction"
            onPress={reaction.onPress}
            onLongPress={reaction.onLongPress}
            hitSlop={theme.space[2]}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Ionicons
              name={reaction.mineGlyph ? 'heart' : 'heart-outline'}
              size={theme.layout.icon.sm}
              color={reaction.mineGlyph ? theme.semantic.action : theme.text.secondary}
            />
            {reaction.mineGlyph ? (
              <Text variant="caption" tone="action">
                You
              </Text>
            ) : null}
          </Pressable>
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
 * "Anna", "Anna and Raj", or "Anna and 3 others".
 *
 * Two names is the ceiling here as it is for reactions, and for the same reason: the
 * sentence has to stay one line at a footnote size, and ten tagged friends written
 * out would push the title off the row they are attached to.
 */
function companionNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 1;
  return `${names[0]} and ${rest} others`;
}

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
  glyphs: { flexDirection: "row", alignItems: "center" },
  glyph: {
    width: 18,
    height: 18,
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface.base,
  },
  // Half a glyph of overlap: enough to read as a cluster, not so much that the
  // one underneath becomes unidentifiable.
  glyphOverlap: { marginLeft: -6 },
  picker: { paddingLeft: theme.poster.xs.width + theme.space[3] },
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
