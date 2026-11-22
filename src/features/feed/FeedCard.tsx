import { Image } from 'expo-image';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';
import {
  ENGAGEMENT_EDGE,
  EngagementRow,
  Poster,
  PosterRail,
  PosterSaveButton,
  ReactionSummary,
  ScoreBadge,
  SpoilerNote,
  type ActivityReaction,
} from '@/ui/components';
import { FEED_SAVE_LABELS, type PosterTile } from '@/ui/components/PosterWall';
import { paperAlpha, theme } from '@/ui/tokens';

import { artworkHeight, type FeedArtwork } from './feed-artwork';
import { FeedHeadline } from './FeedHeadline';
import {
  FEED_CARD,
  FeedPostSurface,
  feedCardContentWidth,
  feedCardInnerWidth,
} from './FeedPostSurface';

export type FeedCardProps = {
  /**
   * The first post under RECENT ACTIVITY: its card starts 8pt under the heading, so the
   * heading still sits 20pt above the avatar and belongs to the post (`FEED_CARD.leading`).
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
  /**
   * **The reader's own bookmark, on the artwork** (founder, 2026-11-22): the For You tile's
   * control in the artwork's top-right corner; the author's score keeps the bottom-right.
   * `saved` is the READER's state, never the author's. A tap toggles it and opens nothing.
   * There is no second Save under the artwork. Absent on a group (each of its posters has
   * its own) and wherever the title cannot be watchlisted.
   */
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
    /** The reader's bookmark on every poster (`PosterRail`'s `onToggleSave`). */
    onToggleSave?: (tile: PosterTile) => void;
  } | null;
};

/**
 * One title activity as a cinematic card (founder-approved direction, 2026-11-04), on the
 * refined card surface since 2026-11-22 (`FeedPostSurface`).
 *
 *     ╭──────────────────────────────────────────────╮
 *     │ [face] Maya Chen ranked Oppenheimer (2023)   │
 *     │        12m ago · R · 181m · Drama · History  │
 *     │ ┌──────────────────────────────────────────┐ │
 *     │ │  backdrop, 3:2                       [🔖]│ │
 *     │ │                                     (9.2)│ │
 *     │ └──────────────────────────────────────────┘ │
 *     │ "The review, if one was published…"          │ ← absent, not empty, without one
 *     │ ❤️😂 Priya and 3 others like this             │ ← absent with no reactions
 *     │  ♡ Like (4)    💬 Comment (2)    ➤ Share     │ ← `EngagementRow`
 *     ╰──────────────────────────────────────────────╯
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
}: FeedCardProps) {
  const grouped = rail != null;
  /**
   * A group names its newest title and keeps "+ N more" (or "and N more") as the link to
   * the complete list, never a bare count such as "ranked 16 titles" (founder, 2026-11-22).
   */
  const filmName = title ?? 'a title';
  const { width, fontScale } = useWindowDimensions();
  const innerWidth = feedCardInnerWidth(width);
  const artworkWidth = feedCardContentWidth(width);
  // With no artwork anywhere the frame holds only the initials, so it takes the compact
  // height: a tall panel of Parchment is space spent on nothing.
  const height = artwork.treatment === 'none' ? NO_ARTWORK_HEIGHT : artworkHeight(artworkWidth);
  const posterHeight = height - theme.space[3] * 2;
  const posterWidth = Math.round((posterHeight * 2) / 3);
  const subline = (grouped ? [timeLabel] : [timeLabel, watchLabel, metadata])
    .filter(Boolean)
    .join(' · ');

  const canReact = reaction.canReact !== false;
  const mine = canReact ? (reaction.mineGlyph ?? null) : null;
  const othersGlyphs = (reaction.glyphs ?? []).filter((glyph) => glyph !== mine).slice(0, 3);

  return (
    <FeedPostSurface leading={leading} style={styles.card} testID="feed-card">
      {/* 1. Who did what, and when. */}
      <View style={styles.inset}>
        <FeedHeadline
          actorName={actorName}
          actorAvatarUri={actorAvatarUri}
          onPressActor={onPressActor}
          verb={verb}
          filmName={filmName}
          year={year}
          onPressTitle={onPressTitle}
          companions={companions}
          onPressCompanions={onPressCompanions}
          grouped={grouped}
          tailAction={tailAction}
          tail={tail}
          subline={subline}
          fontScale={fontScale}
        />
      </View>

      {/* 2 and 3. The artwork, and the score on it — or, for a group, its posters. */}
      {rail ? (
        <View testID="feed-card-rail">
          <PosterRail
            label={`${actorName}'s ${rail.total} titles`}
            tiles={rail.tiles}
            onPressTile={rail.onPressTile}
            width={innerWidth}
            inset={FEED_CARD.inset}
            loadingCount={rail.loading ? Math.min(rail.total, 4) : 0}
            onToggleSave={rail.onToggleSave}
            testID="feed-card-rail-scroll"
          />
        </View>
      ) : (
        <View style={[styles.artwork, { height }]} testID="feed-card-hero">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={[filmName, year, score != null ? null : metadata]
              .filter(Boolean)
              .join(', ')}
            accessibilityHint="Opens the title"
            onPress={onPressTitle}
            testID="feed-card-artwork"
            style={({ pressed }) => [StyleSheet.absoluteFill, pressed && styles.pressed]}
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
          {/* Beside the artwork's press, not inside it, so it can never open the title. */}
          {onPressSave ? (
            <View style={styles.heroSave} pointerEvents="box-none">
              <PosterSaveButton
                saved={saved}
                title={filmName}
                labels={FEED_SAVE_LABELS}
                onPress={onPressSave}
                testID="feed-card-save"
              />
            </View>
          ) : null}
        </View>
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
       * the card's inset (post-QA sprint 2, 2026-11-05); no line between the two (UI
       * cohesion pass, 2026-11-06): they are one group, and proximity says so. With no
       * reactions there is no summary: just the row.
       *
       * The row is `EngagementRow`, the one every Feed post draws (founder, 2026-11-19):
       * Like · Comment · Share in equal columns, each with its count once there is one.
       * The Like is offered on the reader's own post too (founder, 2026-11-11). The
       * bookmark is the artwork's and is never repeated here.
       */}
      <View style={styles.social} testID="feed-card-social">
        {reaction.count > 0 ? (
          <ReactionSummary
            glyphs={
              reaction.summaryGlyphs ??
              (mine ? [mine, ...othersGlyphs] : othersGlyphs).slice(0, 3)
            }
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

        {reaction.picker && canReact ? (
          <View style={styles.picker}>{reaction.picker}</View>
        ) : null}

        {ACTION_DIVIDER === 'inset' ? (
          <View style={styles.divider} testID="feed-card-divider" />
        ) : null}

        <EngagementRow
          actorName={actorName}
          subject={filmName}
          reaction={reaction}
          onPressComments={onPressComments}
          commentCount={commentCount}
          onPressShare={grouped ? undefined : onPressShare}
          style={styles.actions}
          testID="feed-card"
        />
      </View>
    </FeedPostSurface>
  );
}

/**
 * **The line above the actions: none, or a short faint inset rule** (founder spec
 * 2026-11-22). One switch so the two can be compared on a device. `'inset'` draws a
 * hairline of `border.hairline` (Ink at 12%, a neutral grey, never Maroon) inset to the
 * card's content edges; `'none'` draws nothing and lets proximity group the actions with
 * the post, as the card's outline already closes it.
 *
 * Ships `'none'`: in the 360 and 390pt screenshots the rule made the bottom of a white card
 * read as a footer bar, a second boundary 44pt above the outline that already ends it.
 */
export const ACTION_DIVIDER: 'none' | 'inset' = 'none';

/** "1 reaction", "4 reactions" — the summary for a caller that has not named anybody. */
export function reactionCountLabel(count: number) {
  return `${count} ${count === 1 ? 'reaction' : 'reactions'}`;
}

/** The frame for a title with no artwork at all: a 64×96 initials poster and the score. */
const NO_ARTWORK_HEIGHT = 120;

/** The artwork's corners: the control radius, one step inside the card's 12, so the two nest. */
const ARTWORK_RADIUS = theme.radius.control;

/**
 * The bookmark and the score are both 12pt in from the artwork's corners. The bookmark's
 * 44pt box draws its 28pt glyph 4pt in from its own corner, so the box sits 8pt in.
 */
const CORNER_INSET = theme.space[3];

const styles = StyleSheet.create({
  /**
   * The card's own rhythm: 12pt from its outline to the headline, 12pt between blocks. The
   * actions close it with no padding below: their 44pt columns centre the labels, which
   * leaves about 13pt of white under the words, the same as above the headline.
   */
  card: { paddingTop: FEED_CARD.inset, gap: FEED_CARD.inset },
  inset: { paddingHorizontal: FEED_CARD.inset },
  artwork: {
    marginHorizontal: FEED_CARD.inset,
    borderRadius: ARTWORK_RADIUS,
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
    borderRadius: ARTWORK_RADIUS,
  },
  /**
   * The score on the artwork: the Maroon circle with a thin Paper ring, which is what
   * keeps it legible on a dark frame and a pale one alike. Bottom-right, 12pt in, at 48pt.
   */
  scoreRing: {
    position: 'absolute',
    right: CORNER_INSET,
    bottom: CORNER_INSET,
    padding: 2,
    borderRadius: theme.radius.full,
    backgroundColor: paperAlpha(0.92),
  },
  /**
   * The reader's bookmark on the artwork: the poster tile's 44pt control, upper-right, its
   * glyph 12pt in from both edges like the score opposite it. The whole box is inside the
   * frame (the shortest frame is 150pt), so nothing clips it.
   */
  heroSave: {
    position: 'absolute',
    top: CORNER_INSET - theme.space[1],
    right: CORNER_INSET - theme.space[1],
  },
  review: { paddingHorizontal: FEED_CARD.inset },
  /**
   * The social area holds its own rhythm rather than the card's 12pt gap: summary and
   * actions read as one group, 8pt under the artwork or the review.
   */
  social: { marginTop: -theme.space[1] },
  summary: { marginHorizontal: FEED_CARD.inset },
  picker: { paddingHorizontal: FEED_CARD.inset, paddingTop: theme.space[2] },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: FEED_CARD.inset,
    backgroundColor: theme.border.hairline,
  },
  /**
   * The actions span the card, `ENGAGEMENT_EDGE` in from its outline, in equal columns
   * (founder, 2026-11-19). Each column keeps a 44pt minimum in both directions; see
   * `EngagementRow`.
   */
  actions: { paddingHorizontal: ENGAGEMENT_EDGE },
  pressed: { opacity: 0.7 },
});
