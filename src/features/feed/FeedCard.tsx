import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import { Avatar, Poster, ScoreBadge, SpoilerNote, Text } from '@/ui/components';
import type { ActivityReaction } from '@/ui/components/ActivityRow';
import { fontFamily, paperAlpha, theme } from '@/ui/tokens';

import { artworkHeight, type FeedArtwork } from './feed-artwork';

export type FeedCardProps = {
  actorName: string;
  actorAvatarUri?: string | null;
  /** Opens the actor's profile. Absent for the viewer's own activity. */
  onPressActor?: () => void;
  verb: string;
  tail?: string | null;
  /** "ranked Sheroes **and 2 more**" — see `ActivityRow`, whose grammar this keeps. */
  tailAction?: { connector: string; label: string; onPress: () => void } | null;
  companions?: string[];
  title: string | null;
  year?: number | null;
  /** `PG-13 · 148m · Science Fiction · Adventure`. */
  metadata?: string | null;
  /** `2nd watch`. */
  watchLabel?: string | null;
  timeLabel: string;
  artwork: FeedArtwork;
  score?: number | null;
  bucket?: Bucket | null;
  /**
   * The review the actor chose to publish with this activity — `public_notes`, which only
   * ever returns a note its author shared. Never a comment, which is somebody else's remark.
   */
  review?: { text: string; hasSpoilers: boolean; masked: boolean } | null;
  onPressTitle: () => void;
  reaction: ActivityReaction & { mineLabel?: string | null };
  onPressComments?: () => void;
  commentCount?: number;
  /** Save to the reader's watchlist. Absent on their own activity. */
  onPressSave?: () => void;
  saved?: boolean;
  /** The Recommend sheet, which ends in "Share off bingd". Absent for a whole series. */
  onPressShare?: () => void;
};

/**
 * One title activity as a cinematic card (founder-approved direction, 2026-11-04).
 *
 *     [face] Maya Chen ranked Oppenheimer (2023)
 *            12m ago · R · 181m · Drama · History
 *     ┌──────────────────────────────────────────┐
 *     │  backdrop, 150–190pt                 (9.2)│
 *     └──────────────────────────────────────────┘
 *     "The review, if one was published…"            ← absent, not empty, without one
 *     ❤️😂 4 reactions                                ← absent with no reactions
 *     ──────────────────────────────────────────      ← hairline, only under a summary
 *     ♡ Like      💬 Comment      🔖 Save      ➤ Share
 *
 * Feed only. The profile's Recent activity and the conversation page keep `ActivityRow`,
 * which is the compact form those surfaces were designed around.
 *
 * Every behaviour is the row's, rearranged: the same sentence grammar, the same reaction
 * gestures (tap for the heart, hold for the six), the same comment sheet, the same
 * watchlist write and Recommend sheet, the same spoiler masks. Nothing here reads or
 * writes anything; the screen hands it decided values and callbacks.
 */
export function FeedCard({
  actorName,
  actorAvatarUri,
  onPressActor,
  verb,
  tail = null,
  tailAction = null,
  companions = [],
  title,
  year,
  metadata,
  watchLabel,
  timeLabel,
  artwork,
  score,
  bucket,
  review,
  onPressTitle,
  reaction,
  onPressComments,
  commentCount = 0,
  onPressSave,
  saved = false,
  onPressShare,
}: FeedCardProps) {
  const filmName = title ?? 'a title';
  const { width } = useWindowDimensions();
  const cardWidth = width - theme.layout.gutter * 2;
  // With no artwork anywhere the frame holds only the initials, so it takes the compact
  // height: a 190pt panel of Parchment is space spent on nothing.
  const height = artwork.treatment === 'none' ? NO_ARTWORK_HEIGHT : artworkHeight(cardWidth);
  const posterHeight = height - theme.space[3] * 2;
  const posterWidth = Math.round((posterHeight * 2) / 3);
  const subline = [timeLabel, watchLabel, metadata].filter(Boolean).join(' · ');

  const mine = reaction.mineGlyph ?? null;
  const othersGlyphs = (reaction.glyphs ?? []).filter((glyph) => glyph !== mine).slice(0, 3);

  return (
    <View style={styles.card} testID="feed-card">
      {/* 1. Who did what, and when. */}
      <View style={styles.header}>
        {onPressActor ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${actorName}'s profile`}
            onPress={onPressActor}
            hitSlop={theme.space[1]}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Avatar size="sm" uri={actorAvatarUri} name={actorName} />
          </Pressable>
        ) : (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Avatar size="sm" uri={actorAvatarUri} name={actorName} />
          </View>
        )}
        <View style={styles.headerCopy}>
          {/* One sentence, wrapped by the layout — `ActivityRow`'s grammar unchanged,
              including the non-breaking join that stops `(2023)` orphaning. */}
          {/* Three lines, like the row — and no clamp at all when the sentence ends in a
              control: "and 2 more" is the only way into a sitting, and truncation would
              cut exactly that (independent review, 2026-11-04). */}
          <Text variant="subhead" tone="secondary" numberOfLines={tailAction ? undefined : 3}>
            <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
              {actorName}
            </Text>
            {` ${verb} `}
            <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
              {filmName}
              {year ? (
                <Text variant="subhead" tone="secondary" style={styles.year}>
                  {` (${year})`}
                </Text>
              ) : null}
            </Text>
            {companions.length ? (
              <Text variant="subhead" tone="secondary">
                {' with '}
                <Text variant="subhead" style={styles.entity}>
                  {companionNames(companions)}
                </Text>
              </Text>
            ) : null}
            {tail ? ` ${tail}` : null}
            {!tail && tailAction ? (
              <Text variant="subhead" tone="secondary">
                {` ${tailAction.connector} `}
                <Text
                  variant="subhead"
                  style={styles.entity}
                  onPress={tailAction.onPress}
                  accessibilityRole="button"
                >
                  {tailAction.label}
                </Text>
              </Text>
            ) : null}
          </Text>
          {subline ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {subline}
            </Text>
          ) : null}
        </View>
      </View>

      {/* 2 and 3. The artwork, and the score on it. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[filmName, year, score != null ? null : metadata]
          .filter(Boolean)
          .join(', ')}
        accessibilityHint="Opens the title"
        onPress={onPressTitle}
        testID="feed-card-artwork"
        style={({ pressed }) => [styles.artwork, { height }, pressed && styles.pressed]}
      >
        {artwork.treatment === 'backdrop' ? (
          <Image
            source={{ uri: artwork.uri }}
            recyclingKey={artwork.uri}
            contentFit="cover"
            transition={theme.duration.state}
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors
          />
        ) : (
          /**
           * No usable wide image: the poster at its own 2:3 shape, over a soft-focus copy
           * of itself so the frame is the film's colours rather than an empty panel. The
           * wash keeps the field quiet and is a flat Paper tint, not a gradient. With no
           * poster either, the frame is Parchment and the initials stand in.
           */
          <>
            {artwork.uri ? (
              <>
                <Image
                  source={{ uri: artwork.uri }}
                  recyclingKey={`${artwork.uri}#field`}
                  contentFit="cover"
                  blurRadius={24}
                  style={StyleSheet.absoluteFill}
                  accessibilityIgnoresInvertColors
                />
                <View style={[StyleSheet.absoluteFill, styles.wash]} />
              </>
            ) : null}
            <View style={styles.posterSlot} testID="feed-card-poster-fallback">
              <Poster uri={artwork.uri} title={filmName} width={posterWidth} />
            </View>
          </>
        )}
        <View pointerEvents="none" style={styles.artworkHairline} />
        {score != null ? (
          <View style={styles.scoreRing} pointerEvents="none" testID="feed-card-score">
            <ScoreBadge score={score} bucket={bucket} size="detail" />
          </View>
        ) : null}
      </Pressable>

      {/* 4. The review the actor published, prominently — or nothing at all. */}
      {review ? (
        <View style={styles.review}>
          <SpoilerNote
            text={review.text}
            hasSpoilers={review.hasSpoilers}
            masked={review.masked}
            numberOfLines={3}
            titleForLabel={title}
          />
        </View>
      ) : null}

      {/*
       * 5. One social area: the reaction summary, then the actions — on the card's
       * gutters, so the cluster's first glyph and the Like icon share one left edge and
       * Share ends on the artwork's right edge (post-QA sprint 2, 2026-11-05). No line
       * between the two (UI cohesion pass, 2026-11-06): they are one group, and proximity
       * says so. With no reactions there is no summary: just the row.
       */}
      <View style={styles.social} testID="feed-card-social">
        {reaction.count > 0 ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${reactionCountLabel(reaction.count)}. See who reacted.`}
              onPress={reaction.onPressSummary}
              disabled={!reaction.onPressSummary}
              hitSlop={{ top: 6, bottom: 6 }}
              style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
              testID="feed-card-reactions"
            >
              <View
                style={styles.glyphs}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {(mine ? [mine, ...othersGlyphs] : othersGlyphs)
                  .slice(0, 3)
                  .map((glyph, index) => (
                    <Text
                      key={glyph}
                      variant="footnote"
                      allowFontScaling={false}
                      style={[styles.glyph, index > 0 && styles.glyphOverlap]}
                    >
                      {glyph}
                    </Text>
                  ))}
              </View>
              <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.shrink}>
                {reactionCountLabel(reaction.count)}
              </Text>
            </Pressable>
          </>
        ) : null}

        {reaction.picker ? <View style={styles.picker}>{reaction.picker}</View> : null}

        <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: Boolean(mine) }}
          accessibilityLabel={
            mine
              ? `You reacted to ${filmName}. Tap to remove, long press to change.`
              : `React to ${actorName}'s activity about ${filmName}. Long press for more reactions.`
          }
          accessibilityHint={
            reaction.onLongPress ? 'Long press to choose a different reaction' : undefined
          }
          onPress={reaction.onPress}
          onLongPress={reaction.onLongPress}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="feed-card-like"
        >
          {mine && mine !== HEART ? (
            <Text variant="caption" allowFontScaling={false} style={styles.mineGlyph}>
              {mine}
            </Text>
          ) : (
            <Ionicons
              name={mine ? 'heart' : 'heart-outline'}
              size={theme.layout.icon.sm}
              color={mine ? theme.semantic.action : theme.text.secondary}
            />
          )}
          <Text
            variant="footnote"
            tone={mine ? 'action' : 'secondary'}
            numberOfLines={1}
            style={styles.shrink}
          >
            {mine ? (mine === HEART ? 'Liked' : (reaction.mineLabel ?? 'Reacted')) : 'Like'}
          </Text>
        </Pressable>

        {onPressComments ? (
          <Action
            icon="chatbubble-outline"
            label={commentCount > 0 ? String(commentCount) : 'Comment'}
            accessibilityLabel={
              commentCount > 0
                ? `${commentCount} ${commentCount === 1 ? 'comment' : 'comments'} on ${actorName}'s activity about ${filmName}. Open them.`
                : `Comment on ${actorName}'s activity about ${filmName}`
            }
            onPress={onPressComments}
            testID="feed-card-comment"
          />
        ) : null}

        {onPressSave ? (
          <Action
            icon={saved ? 'bookmark' : 'bookmark-outline'}
            active={saved}
            selected={saved}
            label={saved ? 'Saved' : 'Save'}
            accessibilityLabel={
              saved ? `${filmName} is in your watchlist` : `Add ${filmName} to your watchlist`
            }
            onPress={onPressSave}
            testID="feed-card-save"
          />
        ) : null}

        {onPressShare ? (
          <Action
            icon="paper-plane-outline"
            label="Share"
            accessibilityLabel={`Share ${filmName} with a friend`}
            onPress={onPressShare}
            testID="feed-card-share"
          />
        ) : null}
        </View>
      </View>
    </View>
  );
}

/** "1 reaction", "4 reactions" — a count only; who reacted is the detail sheet's job. */
export function reactionCountLabel(count: number) {
  return `${count} ${count === 1 ? 'reaction' : 'reactions'}`;
}

const HEART = '❤️';

/** The frame for a title with no artwork at all: a 64×96 initials poster and the score. */
const NO_ARTWORK_HEIGHT = 120;

function Action({
  icon,
  label,
  accessibilityLabel,
  onPress,
  active = false,
  selected,
  testID,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  active?: boolean;
  selected?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={active ? theme.semantic.action : theme.text.secondary}
      />
      <Text
        variant="footnote"
        tone={active ? 'action' : 'secondary'}
        numberOfLines={1}
        style={styles.shrink}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** "Anna", "Anna and Raj", or "Anna and 3 others" — `ActivityRow`'s rule. */
function companionNames(names: string[]) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

const styles = StyleSheet.create({
  /**
   * **28pt above each post, 12pt more than before** (UI cohesion pass, 2026-11-06). The
   * one hairline between posts stays; the extra air above the next avatar is what makes
   * a post read as the end of one thing and the start of another, while everything
   * inside a post keeps its compact 12pt rhythm.
   */
  card: {
    paddingTop: theme.space[4] + theme.space[3],
    paddingBottom: theme.space[2],
    gap: theme.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  headerCopy: { flex: 1, gap: 2 },
  entity: { fontFamily: fontFamily.sansSemibold, color: theme.text.primary },
  year: { fontFamily: fontFamily.sans },
  artwork: {
    marginHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.card,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
  },
  wash: { backgroundColor: paperAlpha(0.28) },
  posterSlot: {
    position: 'absolute',
    top: theme.space[3],
    left: theme.space[3],
    bottom: theme.space[3],
  },
  artworkHairline: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    borderRadius: theme.radius.card,
  },
  /**
   * The score on the artwork: the Maroon circle with a thin Paper ring, which is what
   * keeps it legible on a dark frame and a pale one alike. Bottom-right, inset, at 48pt
   * — about a quarter of the frame's height — so it reads first without hiding the image.
   */
  scoreRing: {
    position: 'absolute',
    right: theme.space[3],
    bottom: theme.space[3],
    padding: 2,
    borderRadius: theme.radius.full,
    backgroundColor: paperAlpha(0.92),
  },
  review: { paddingHorizontal: theme.layout.gutter },
  /**
   * The social area holds its own rhythm rather than the card's 12pt gap: summary and
   * actions read as one group, 8pt under the artwork or the review.
   */
  social: { marginTop: -theme.space[1] },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.space[2],
    marginHorizontal: theme.layout.gutter,
    minHeight: 32,
  },
  glyphs: { flexDirection: 'row', alignItems: 'center' },
  glyph: { fontSize: 15, lineHeight: undefined, includeFontPadding: false },
  glyphOverlap: { marginLeft: -3 },
  picker: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  /**
   * The actions sit on the gutters too: each target is padded 8pt either side, and the
   * row is inset 8pt less than the gutter, so the Like icon starts on the same edge as
   * the reaction cluster and Share ends on the artwork's right edge. Each keeps a 44pt
   * minimum in both directions; under large text a label shortens before anything
   * leaves the row.
   */
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter - theme.space[2],
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 1,
    gap: theme.space[1] + 2,
    minHeight: theme.layout.minTapTarget,
    minWidth: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[2],
  },
  shrink: { flexShrink: 1 },
  mineGlyph: { fontSize: 17, lineHeight: undefined, includeFontPadding: false },
  pressed: { opacity: 0.7 },
});
