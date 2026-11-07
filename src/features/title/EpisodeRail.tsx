import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ListRenderItem,
} from 'react-native';

import { formatShortDate } from '@/lib/dates';
import { stillUri } from '@/lib/images';
import { Sheet, SheetDone, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { TitleEpisode } from './use-season-episodes';

/**
 * **One season's episodes as a single horizontal rail** (founder hotfix, 2026-11-07).
 *
 * The Episodes section used to be a column of `EpisodeRow`s, each with a full-width still
 * and up to three lines of synopsis, which made a twenty-episode season the longest page in
 * the app. The rail keeps only what a reader scans for while working out which season they
 * watched — the still, the number and the name — and every other fact moves one tap away,
 * into a sheet (`EpisodeSheet` below). Nothing is dropped: the sheet shows the full title,
 * the whole synopsis, the air date and the runtime the row used to show.
 *
 * **Still informational.** An episode is metadata in bingd; the rankable unit is the
 * season (PRD §10). Opening an episode logs, scores and writes nothing, and there is no
 * per-episode watched state to draw.
 *
 * **Every card has the same frame.** A rail of mixed heights would read as broken, so an
 * episode TMDB has no still for (every unaired one, many older ones) keeps the 16:9 frame
 * on Parchment with a quiet television glyph, rather than collapsing.
 *
 * **Virtualised, in the scroll direction only.** A horizontal `FlatList` inside the page's
 * vertical scroller is the supported nesting, so a two-hundred-episode season costs a few
 * cards at a time and needs no "Show all".
 *
 * **No vertical padding of its own.** Like `TrailerRail`, the space above the rail belongs
 * to the section, outside the scroller, so a rail still coasting from a fling cannot take
 * a press meant for the heading above it or the one below it.
 */
export function EpisodeRail({
  episodes,
  seasonLabel,
}: {
  episodes: readonly TitleEpisode[];
  /** `Season 2`, for the sheet's eyebrow. Null when the page has no season number. */
  seasonLabel?: string | null;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = railCardWidth(width);
  const [open, setOpen] = useState<number | null>(null);

  const renderItem = useCallback<ListRenderItem<TitleEpisode>>(
    ({ item, index }) => (
      <EpisodeCard
        index={index}
        episodeNumber={item.episode_number}
        title={item.title}
        stillPath={item.still_path}
        width={cardWidth}
        onOpen={setOpen}
      />
    ),
    [cardWidth],
  );

  if (!episodes.length) return null;
  const selected = open == null ? null : (episodes[open] ?? null);

  return (
    <>
      <FlatList
        horizontal
        data={episodes}
        // Position as well as number: TMDB occasionally repeats an episode number within a
        // season, and the normalizer keeps both rather than losing a real episode.
        keyExtractor={(item, index) => `${item.episode_number}-${index}`}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
        ItemSeparatorComponent={Gap}
        initialNumToRender={6}
        windowSize={5}
        decelerationRate="fast"
        testID="episode-rail"
      />
      {selected ? (
        <EpisodeSheet
          episode={selected}
          seasonLabel={seasonLabel ?? null}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/**
 * A card wide enough for a readable still and narrow enough that the next one peeks in at
 * the right edge, which is the rail's only affordance: about 196pt at 320, 222 at 360 and
 * the 240 ceiling at 412 and beyond.
 */
export const railCardWidth = (screenWidth: number) =>
  Math.min(CARD_MAX, Math.round((screenWidth - theme.layout.gutter) / 1.55));

const CARD_MAX = 240;

const Gap = () => <View style={styles.gap} />;

/** `Episode 3`: the number is never dropped, and stands in for a missing name. */
const numberLabel = (episodeNumber: number) => `Episode ${episodeNumber}`;

const EpisodeCard = memo(function EpisodeCard({
  index,
  episodeNumber,
  title,
  stillPath,
  width,
  onOpen,
}: {
  index: number;
  episodeNumber: number;
  title: string | null;
  stillPath: string | null;
  width: number;
  onOpen: (index: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const uri = failed ? null : stillUri(stillPath);
  const number = numberLabel(episodeNumber);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title ? `${number}, ${title}` : number}
      accessibilityHint="Shows the episode's details"
      onPress={() => onOpen(index)}
      style={({ pressed }) => [styles.card, { width }, pressed && styles.pressed]}
      testID={`episode-card-${episodeNumber}`}
    >
      <View style={styles.frame} testID="episode-frame">
        {uri ? (
          <Image
            source={{ uri }}
            contentFit="cover"
            transition={theme.duration.state}
            style={StyleSheet.absoluteFill}
            onError={() => setFailed(true)}
            accessibilityIgnoresInvertColors
            testID="episode-still"
          />
        ) : (
          <Ionicons
            name="tv-outline"
            size={theme.layout.icon.lg}
            color={theme.text.tertiary}
            testID="episode-still-missing"
          />
        )}
      </View>
      <Text variant="caption" tone="tertiary" numberOfLines={1}>
        {number}
      </Text>
      {title ? (
        <Text variant="callout" numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
      ) : null}
    </Pressable>
  );
});

/**
 * One episode, in full: the larger still, `Season 2 · Episode 3`, the whole title, the air
 * date and runtime, and the complete synopsis. Only what TMDB published is drawn; a missing
 * field is simply absent, never "Unknown". Scrolls inside the app's standard `Sheet`, so a
 * long synopsis at a large text size is still reachable to its last line.
 */
export function EpisodeSheet({
  episode,
  seasonLabel,
  onClose,
}: {
  episode: TitleEpisode;
  seasonLabel: string | null;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  const number = numberLabel(episode.episode_number);
  const name = episode.title || number;
  const uri = failed ? null : stillUri(episode.still_path, 'sheet');
  const eyebrow = [seasonLabel, number].filter(Boolean).join(' · ');
  const runtime =
    typeof episode.runtime_minutes === 'number' && episode.runtime_minutes > 0
      ? `${Math.trunc(episode.runtime_minutes)} min`
      : null;
  const meta = [formatShortDate(episode.air_date), runtime].filter(Boolean).join(' · ');

  return (
    <Sheet visible onClose={onClose} label={`${eyebrow}, ${name}`}>
      <ScrollView
        style={{ maxHeight: Math.round(height * 0.7) }}
        contentContainerStyle={styles.sheetBody}
        testID="episode-sheet"
      >
        {uri ? (
          <Image
            source={{ uri }}
            contentFit="cover"
            transition={theme.duration.state}
            style={styles.sheetStill}
            onError={() => setFailed(true)}
            accessibilityIgnoresInvertColors
            testID="episode-sheet-still"
          />
        ) : null}
        <View style={styles.sheetHeading}>
          <Text variant="caption" tone="tertiary">
            {eyebrow}
          </Text>
          <Text variant="title2" accessibilityRole="header">
            {name}
          </Text>
          {meta ? (
            <Text variant="footnote" tone="secondary" testID="episode-sheet-meta">
              {meta}
            </Text>
          ) : null}
        </View>
        {episode.overview ? (
          <Text variant="body" tone="secondary">
            {episode.overview}
          </Text>
        ) : null}
      </ScrollView>
      <SheetDone onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  rail: { paddingHorizontal: theme.layout.gutter },
  gap: { width: theme.space[3] },
  card: { gap: theme.space[1] },
  frame: {
    width: '100%',
    aspectRatio: theme.layout.aspect.backdrop,
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBody: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[2],
    gap: theme.space[3],
  },
  sheetStill: {
    width: '100%',
    aspectRatio: theme.layout.aspect.backdrop,
    borderRadius: theme.radius.control,
    backgroundColor: theme.surface.sunken,
  },
  sheetHeading: { gap: theme.space[1] },
  pressed: { opacity: 0.7 },
});
