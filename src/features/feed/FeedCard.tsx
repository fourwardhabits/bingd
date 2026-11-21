import { Image } from 'expo-image';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import {
  Avatar,
  CompanionNames,
  ENGAGEMENT_EDGE,
  EngagementRow,
  Poster,
  PosterRail,
  ReactionSummary,
  ScoreBadge,
  SentenceLink,
  SpoilerNote,
  Text,
  type ActivityReaction,
} from '@/ui/components';
import type { PosterTile } from '@/ui/components/PosterWall';
import { fontFamily, paperAlpha, theme } from '@/ui/tokens';

import { artworkHeight, type FeedArtwork } from './feed-artwork';

export type FeedCardProps = {
  /**
   * The first post under RECENT ACTIVITY: 20pt above it rather than 28, so the heading
   * belongs to the post (marquee cohesion sprint, 2026-11-07; 12pt until the founder's
   * Preview QA asked for a little more room under the heading).
   */
  leading?: boolean;
  actorName: string;
  actorAvatarUri?: string | null;
  /** Opens the actor's profile. Absent for the viewer's own activity. */
  onPressActor?: () => void;
  verb: string;
  tail?: string | null;
  /** "ranked Sheroes **and 2 more**" — see `ActivityRow`, whose grammar this keeps. */
  tailAction?: { connector: string; label: string; onPress: () => void } | null;
  companions?: string[];
  /**
   * Opens every person the actor watched with. Given, "with Anna and **2 others**" makes
   * the count a link (founder, 2026-11-19); absent, the count is plain entity ink.
   */
  onPressCompanions?: () => void;
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
  reaction: ActivityReaction;
  onPressComments?: () => void;
  commentCount?: number;
  /** Save to the reader's watchlist. Absent on their own activity and on a group. */
  onPressSave?: () => void;
  saved?: boolean;
  /** The Recommend sheet, which ends in "Share off bingd". Absent on a group. */
  onPressShare?: () => void;
  /**
   * **A group drawn as its posters** (Feed poster rails, founder spec 2026-11-16).
   *
   * Present only on a grouped watchlist post or ranking sitting. The sentence then names the
   * group by its size ("ranked 8 titles"), the artwork is a horizontal rail of the members'
   * posters, each opening its own title, and the group's name in the sentence ("8 titles")
   * opens the complete list; there is no separate "View all" under the rail (founder,
   * 2026-11-17: the posters are the way in). The
   * metadata line keeps only the time: one title's genres and certification do not describe
   * a batch. A caller passes no Save and no Share for a group, rail or not, since both
   * would act on the representative title alone (founder, 2026-11-19); the card draws
   * neither beside a rail in any case.
   */
  rail?: {
    total: number;
    tiles: PosterTile[];
    /** Placeholder frames while the preview loads. */
    loading?: boolean;
    onPressTile: (tile: PosterTile) => void;
    onPressAll: () => void;
  } | null;
  /**
   * **An activity session** (20261130000900): a group of rankings and saves from one half
   * hour. Given with a rail, the sentence names the newest title instead of the group's size
   * ("ranked Kaiju No. 8 + 15 more"), with `tailAction` as the way into the complete list,
   * and the line under it carries `breakdown` ("9 ranked · 7 saved") when the session mixes
   * both, so the sentence never claims every title was ranked or every title saved.
   */
  session?: { breakdown: string | null } | null;
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
 *     ❤️😂 Priya and 3 others reacted                 ← absent with no reactions
 *     ♡ Like      💬 Comment      🔖 Save      ➤ Share    ← `EngagementRow`
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
  onPressCompanions,
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
  leading = false,
  rail = null,
  session = null,
}: FeedCardProps) {
  const grouped = rail != null;
  // A session names its newest title and keeps "+ N more" as the link to the list.
  const namesLead = grouped && session != null;
  const groupName = rail && !namesLead ? `${rail.total} titles` : null;
  const filmName = groupName ?? title ?? 'a title';
  const { width } = useWindowDimensions();
  const cardWidth = width - theme.layout.gutter * 2;
  // With no artwork anywhere the frame holds only the initials, so it takes the compact
  // height: a 190pt panel of Parchment is space spent on nothing.
  const height = artwork.treatment === 'none' ? NO_ARTWORK_HEIGHT : artworkHeight(cardWidth);
  const posterHeight = height - theme.space[3] * 2;
  const posterWidth = Math.round((posterHeight * 2) / 3);
  const subline = (
    grouped ? [timeLabel, session?.breakdown] : [timeLabel, watchLabel, metadata]
  )
    .filter(Boolean)
    .join(' · ');

  const canReact = reaction.canReact !== false;
  const mine = canReact ? (reaction.mineGlyph ?? null) : null;
  const othersGlyphs = (reaction.glyphs ?? []).filter((glyph) => glyph !== mine).slice(0, 3);
  // A sentence that ends in a control is never clamped: the count is the only way into the
  // rest, and truncation would cut exactly that.
  const companionsLink = !grouped && companions.length > 2 && onPressCompanions != null;
  const holdsLink = grouped || tailAction != null || companionsLink;
  const showsTailAction = tailAction != null && (!grouped || namesLead);

  return (
    <View style={[styles.card, leading && styles.cardLeading]} testID="feed-card">
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
          <Text variant="subhead" tone="secondary" numberOfLines={holdsLink ? undefined : 3}>
            <Text variant="subhead" style={styles.entity} onPress={onPressActor}>
              {actorName}
            </Text>
            {` ${verb} `}
            {/* A group is named by its size, and the size opens the complete list — never
                the representative title (founder, 2026-11-19). */}
            {rail && groupName ? (
              <SentenceLink
                label={groupName}
                onPress={rail.onPressAll}
                testID="feed-card-group-link"
              />
            ) : (
              <Text variant="subhead" style={styles.entity} onPress={onPressTitle}>
                {filmName}
                {year ? (
                  <Text variant="subhead" tone="secondary" style={styles.year}>
                    {` (${year})`}
                  </Text>
                ) : null}
              </Text>
            )}
            {companions.length && !grouped ? (
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
            {/* "ranked Sheroes and 2 more", and since grouped watchlist posts
                (20261125000100) "added Dune and 4 others to their watchlist": the count
                comes before the tail, so a sentence can carry both. */}
            {tailAction && showsTailAction ? (
              <Text variant="subhead" tone="secondary">
                {` ${tailAction.connector} `}
                <SentenceLink
                  label={tailAction.label}
                  onPress={tailAction.onPress}
                  testID="feed-card-tail-link"
                />
              </Text>
            ) : null}
            {tail ? ` ${tail}` : null}
          </Text>
          {subline ? (
            <Text variant="caption" tone="tertiary" numberOfLines={1}>
              {subline}
            </Text>
          ) : null}
        </View>
      </View>

      {/* 2 and 3. The artwork, and the score on it — or, for a group, its posters. */}
      {rail ? (
        <View style={styles.rail} testID="feed-card-rail">
          <PosterRail
            label={`${actorName}'s ${rail.total} titles`}
            tiles={rail.tiles}
            onPressTile={rail.onPressTile}
            width={cardWidth}
            loadingCount={rail.loading ? Math.min(rail.total, 4) : 0}
            testID="feed-card-rail-scroll"
          />
        </View>
      ) : (
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
      )}

      {/* 4. The review the actor published, prominently — or nothing at all. */}
      {review && !grouped ? (
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
       * 5. One social area: the reaction summary, then the actions. The summary sits on
       * the card's gutters (post-QA sprint 2, 2026-11-05); no line between the two (UI
       * cohesion pass, 2026-11-06): they are one group, and proximity says so. With no
       * reactions there is no summary: just the row.
       *
       * The row is `EngagementRow`, the one every Feed post draws (founder, 2026-11-19):
       * equal columns across the card's width, so a group's Like and Comment read as a
       * pair rather than as two controls at opposite edges. The Like is offered on the
       * reader's own post too (founder, 2026-11-11); Save is not.
       */}
      <View style={styles.social} testID="feed-card-social">
        {reaction.count > 0 ? (
          <ReactionSummary
            glyphs={reaction.summaryGlyphs ?? (mine ? [mine, ...othersGlyphs] : othersGlyphs).slice(0, 3)}
            forms={
              reaction.summaryForms?.length
                ? reaction.summaryForms
                : [reactionCountLabel(reaction.count)]
            }
            onPress={reaction.onPressSummary}
            style={styles.summary}
            testID="feed-card-reactions"
          />
        ) : null}

        {reaction.picker && canReact ? <View style={styles.picker}>{reaction.picker}</View> : null}

        <EngagementRow
          actorName={actorName}
          subject={filmName}
          reaction={reaction}
          onPressComments={onPressComments}
          commentCount={commentCount}
          onPressSave={grouped ? undefined : onPressSave}
          saved={saved}
          onPressShare={grouped ? undefined : onPressShare}
          style={styles.actions}
          testID="feed-card"
        />
      </View>
    </View>
  );
}

/** "1 reaction", "4 reactions" — the summary for a caller that has not named anybody. */
export function reactionCountLabel(count: number) {
  return `${count} ${count === 1 ? 'reaction' : 'reactions'}`;
}

/** The frame for a title with no artwork at all: a 64×96 initials poster and the score. */
const NO_ARTWORK_HEIGHT = 120;

const styles = StyleSheet.create({
  // The rail sits where the artwork would, on the card's gutters.
  rail: { marginHorizontal: theme.layout.gutter },
  /**
   * **16pt above each post** (founder, device, 2026-11-19: "cut in half" from the 28pt of
   * the UI cohesion pass, 2026-11-06). On a phone the 28pt read as a gap between the
   * hairline and the next avatar rather than as a boundary. 16 is the 4pt-grid step nearest
   * half, and still a step above the post's own 12pt rhythm, so the line is still where
   * one post ends and the next begins.
   */
  card: {
    paddingTop: theme.space[4],
    paddingBottom: theme.space[2],
    gap: theme.space[3],
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomColor: theme.border.hairline,
  },
  cardLeading: { paddingTop: theme.space[5] },
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
  summary: { marginHorizontal: theme.layout.gutter },
  picker: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  /**
   * The actions span the card, `ENGAGEMENT_EDGE` in from the screen's edges, in equal
   * columns (founder, 2026-11-19). That replaced a row of content-sized targets spread
   * edge to edge, which put a group's two actions at opposite ends of the card. Each
   * column keeps a 44pt minimum in both directions; see `EngagementRow`.
   */
  actions: { paddingHorizontal: ENGAGEMENT_EDGE },
  pressed: { opacity: 0.7 },
});
