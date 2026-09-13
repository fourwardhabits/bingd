import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { activityMetadata } from '@/features/feed/activity';
import { useCredits } from '@/features/title/use-credits';
import { useSeasonEpisodes } from '@/features/title/use-season-episodes';
import { formatShortDate } from '@/lib/dates';
import { backdropUri, posterUri, stillUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { compactName } from '@/lib/titles';
import { theme } from '@/ui/tokens';
import {
  Button,
  ClampedText,
  EmptyState,
  EpisodeRow,
  Poster,
  Sheet,
  SkeletonRow,
  Text,
} from '@/ui/components';

/**
 * "Which one was that again?", answered without leaving the comparison.
 *
 * Founder request: a poster and a name are enough to recognise a film and not always
 * enough to *remember* it, and the only way out of that was to abandon the ranking,
 * look the title up, and start again — which loses the session and the answers already
 * given. This is the same question asked in place.
 *
 * **A reminder, not the title page.** No score, no community rating, no watchlist
 * control, no reviews, nothing the reader could act on: an action here would be a
 * second decision competing with the one comparison they are in the middle of, and the
 * title page is one tap away *after* the ranking finishes. What is here is only what
 * jogs a memory.
 *
 * ---------------------------------------------------------------------------
 * WHAT "JOGS A MEMORY" MEANS IS DIFFERENT FOR THE TWO KINDS, AND THE SHEET
 * SPENT A RELEASE PRETENDING IT WAS NOT
 *
 * One component drew both, and every field on it was a fact about the *title*. That is
 * the right set for a film. It is close to useless for a season, because a season
 * comparison is routinely **Season 1 against Season 4 of the same series** — and
 * against that question the poster is the same artwork with a different number, the
 * genres and the certification are inherited from the parent and therefore identical by
 * construction, and the cast are the same six people in every season of the show. The
 * sheet spent its whole height on fields that cannot separate the two things it was
 * opened to separate.
 *
 * The one thing that does separate them is what happened in the season, so a season
 * gets **its episodes** — the same `EpisodeRow` the season page draws, reading the same
 * `['episodes', id]` cache, so a reader who looked at that page in the last hour pays
 * nothing for this.
 *
 * And a film gets the one asset that beats prose at this: **its backdrop**. A synopsis
 * tells you the plot of a film you watched in 2019, and the plot is the thing you
 * forgot. `media_items.backdrop_path` was already on the row and simply was not being
 * selected.
 *
 * **One image, and deliberately not a strip of them.** TMDB has no movie equivalent of
 * an episode still: `/movie/{id}/images` returns *backdrops*, which are key art rather
 * than scenes — frequently the same composition in several languages, several of them
 * with the title burned into the picture. Five of those is five near-identical crops of
 * one frame. The adapter has never fetched that endpoint and this does not add it, so
 * the image below costs no provider request at all.
 *
 * ---------------------------------------------------------------------------
 * THE DATA PATHS, AND THE ONE THAT IS NEW
 *
 * The row comes from `media_items`, which is the same table the comparison card already
 * reads; the credits come from the `credits` facet of `media_cache`. Neither reaches
 * TMDB. The episodes are the new one, and they are cheap for the reason above: the
 * season page seeds `['episodes', id]` on mount, so this usually reads a warm cache,
 * and when it does not it is one `season-episodes` call against the reader's own hourly
 * ceiling. It is `enabled` only once the row has come back saying `season`, so a film
 * never asks.
 *
 * Nothing is fetched until somebody presses Details, because the sheet is mounted only
 * while open — and the `key` at the call site is what keeps that true on the *second*
 * open as well as the first.
 *
 * Credits and episodes are both non-fatal on purpose: a catalogue row that was never
 * enriched has no `credits` facet, and a reminder is still a reminder without a
 * director. It renders what it has.
 */

export type TitleRecallSheetProps = {
  /** The title to remind the reader of, or null when the sheet is closed. */
  mediaItemId: string | null;
  onClose: () => void;
};

/**
 * How many episodes the reminder draws before it offers the rest.
 *
 * **Six, where the season page shows fifty.** The two numbers answer different
 * questions, and the difference is the boundary this sheet is built on: the page is a
 * place to read a season, and this is a glance at one from inside a comparison the
 * reader is trying to finish. Six is about a screen and a half of stills, which is
 * enough to place a season and short enough that the reader can still feel they are in
 * the middle of something else.
 */
export const RECALL_EPISODES_FIRST_PAGE = 6;

/**
 * Lines of synopsis before `… more`.
 *
 * Three, where the title page's `Synopsis` takes four. Same reason as the episode count
 * above. It was not clamped at all before this, and an unclamped TMDB season overview
 * is most of the sheet before the episodes have started.
 */
const SYNOPSIS_LINES = 3;

/**
 * How many names the cast line carries.
 *
 * **Three, where it used to be six.** Six names joined by commas is a list and reads as
 * prose; three is a cue, and "the one with X" is genuinely how people locate a film. On
 * a season the line is not drawn at all unless the episodes are missing, so in practice
 * this is the film's number.
 */
const CAST_NAMES = 3;

type RecallRow = {
  id: string;
  kind: 'movie' | 'series' | 'season' | null;
  title: string | null;
  season_number: number | null;
  release_date: string | null;
  runtime_minutes: number | null;
  episode_count: number | null;
  overview: string | null;
  poster_path: string | null;
  /**
   * The film's one backdrop, already in the catalogue.
   *
   * Never populated for a season — TMDB's `/tv/{id}/season/{n}` returns a poster and no
   * backdrop, which `lib/hero.ts` documents over all thousand of them — so this is read
   * for a film and nothing else. The parent series' backdrop is deliberately *not*
   * borrowed the way the hero borrows it: it is one image that is identical across every
   * season of the show, and it would sit directly above episode stills that are not,
   * which is the opposite of what this sheet is for.
   */
  backdrop_path: string | null;
  genres: string[] | null;
  original_language: string | null;
  certification: string | null;
  parent: {
    title: string | null;
    genres: string[] | null;
    original_language: string | null;
    certification: string | null;
  } | null;
};

/**
 * The row this sheet needs, which is a different subset from the title page's.
 *
 * Its own key for the reason `queryKeys.comparisonCard` records: two shapes cached
 * under one key is a race over which screen read the row first. `enabled` keeps it
 * from firing at all until there is something to recall.
 */
function useTitleRecall(mediaItemId: string | null) {
  return useQuery({
    queryKey: queryKeys.titleRecall(mediaItemId ?? ''),
    enabled: Boolean(mediaItemId),
    // The same five minutes as the comparison card. Nothing on this row changes
    // during a ranking session, and a reader who checks two titles in one session
    // should not pay twice for the second look at the first.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RecallRow> => {
      const { data, error } = await supabase
        .from('media_items')
        // The parent comes with it because a season inherits its certification and
        // its genres from the series, and because "Season 2" is not a name — the
        // series' title is half of what `compactName` prints.
        .select(
          'id, kind, title, season_number, release_date, runtime_minutes, episode_count, overview, poster_path, backdrop_path, genres, original_language, certification, parent:parent_id(title, genres, original_language, certification)',
        )
        .eq('id', mediaItemId ?? '')
        .single();
      if (error) throw error;
      return data as unknown as RecallRow;
    },
  });
}

export function TitleRecallSheet({ mediaItemId, onClose }: TitleRecallSheetProps) {
  const recall = useTitleRecall(mediaItemId);
  const credits = useCredits(mediaItemId);

  const row = recall.data ?? null;
  const isSeason = row?.kind === 'season';
  /**
   * Enabled by the answer to the query above it, which is why it cannot be hoisted.
   *
   * The kind is a fact about the row, so this necessarily starts disabled and turns on
   * a beat later. That is the correct shape rather than a compromise: a film must never
   * ask for episodes, and the only thing that knows it is a film is the row.
   */
  const episodes = useSeasonEpisodes(mediaItemId, isSeason);
  /**
   * Collapsed on every open, which the `key` at the call site is what guarantees.
   *
   * Plain component state and deliberately not lifted: it is not session state, the
   * server knows nothing about it, and it has no business surviving the sheet closing.
   */
  const [showAllEpisodes, setShowAllEpisodes] = useState(false);

  if (!mediaItemId) return null;

  /**
   * **The heading said "Season 1", and that is the whole question this sheet answers.**
   *
   * `compactName` reads `seriesTitle` and `seasonNumber`; a `media_items` row carries
   * `parent.title` and `season_number`. Handing it the row unmapped means neither field
   * is found, so it falls through to `media_items.title` — which TMDB writes as the bare
   * words "Season 1". A reader who pressed Details on a season to work out *which show
   * this was* got a poster, the words "Season 1", and no name at all.
   *
   * The query has selected the parent since the sheet shipped, and its own comment says
   * why: "the series' title is half of what `compactName` prints". It was selected and
   * then not passed. Every other caller in the app maps explicitly — `CollectionView`,
   * the title screen, the recommendation sheets — and this is that mapping.
   *
   * No `parentIsVisible` here. The title screen passes it because the show's name is
   * already at the top of the page it is on; nothing on this sheet says it, so the long
   * form is the only one that identifies the thing.
   */
  const name = row
    ? compactName({
        kind: row.kind,
        title: row.title,
        seriesTitle: row.parent?.title ?? null,
        seasonNumber: row.season_number,
      })
    : null;
  const year = row?.release_date ? row.release_date.slice(0, 4) : null;
  const meta = row
    ? activityMetadata({
        kind: row.kind,
        genres: row.genres,
        // The language, so a title recalled mid-ranking says Anime where the title page
        // says Anime. `activityMetadata` normalises; it needs both halves to.
        language: row.original_language,
        certification: row.certification,
        runtimeMinutes: row.runtime_minutes,
        episodeCount: row.episode_count,
        parent: row.parent,
      })
    : null;

  /**
   * A director for a film, a **Creator** for anything else, and never one standing in
   * for the other.
   *
   * ---------------------------------------------------------------------------
   * THIS LINE WAS PRINTING A FALSEHOOD, AND HAD BEEN SINCE THE SHEET SHIPPED
   *
   * It read `credits.director` for both kinds and labelled it "Created by" for the
   * television one. `use-credits` says at length why that is wrong: on a season payload
   * the `Director` credit is an **episode** director, the person who directed one of
   * nine, and `director` falls back to anyone in the Directing department besides. So a
   * season comparison could credit a whole show to a jobbing episode director, in the
   * one place on the screen a reader has no way to check it.
   *
   * The founder's rule for this line, set on 2026-09-07, is that `TV-MA · 24 episodes`
   * beats a misleading person. `use-credits` grew a Creator-only `showrunner` for it and
   * the title page moved over; this sheet was missed. It reads `showrunner` now, it is
   * absent when there is no `Creator` credit, and `director` is never its fallback.
   */
  const maker =
    row?.kind === 'movie' ? (credits.data?.director ?? null) : (credits.data?.showrunner ?? null);
  const cast = (credits.data?.cast ?? []).slice(0, CAST_NAMES);
  const backdrop = row?.kind === 'movie' ? backdropUri(row.backdrop_path, 'card') : null;

  const episodeList = episodes.data ?? [];
  const hasEpisodes = isSeason && episodeList.length > 0;
  /**
   * True from the first render of a season, before the request has even been made.
   *
   * `isPending` is React Query's "no data yet", and it is what keeps the cast line from
   * appearing for a frame and then being replaced by a list of episodes. The section
   * draws a skeleton instead, which is a claim that something is coming rather than a
   * different answer to the same question.
   */
  const episodesPending = isSeason && episodes.isPending;
  /**
   * **The cast line is a film's, and a season's only when the episodes did not arrive.**
   *
   * Six series regulars are the same six people in Season 1 and in Season 4, so on the
   * one surface whose whole job is telling those apart the line carries no information
   * at all. It survives as the fallback rather than being deleted outright because a
   * season whose episode list is empty or errored must not end up with *less* than the
   * sheet showed before this change.
   */
  const showsCast = cast.length > 0 && (!isSeason || (!hasEpisodes && !episodesPending));

  const visibleEpisodes = showAllEpisodes
    ? episodeList
    : episodeList.slice(0, RECALL_EPISODES_FIRST_PAGE);

  return (
    <Sheet visible onClose={onClose} label={name ? `About ${name}` : 'About this title'}>
      <View style={styles.sheet}>
        {recall.isPending ? (
          <View style={styles.state}>
            <SkeletonRow count={3} />
          </View>
        ) : recall.isError || !row ? (
          <View style={styles.state}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load this title"
              body="Your comparison is still here — close this and carry on."
            />
          </View>
        ) : (
          /**
           * Scrollable, because a season's episodes are as many as the season had. The
           * Sheet caps itself at 90% of the screen, so this scrolls only when the
           * content is genuinely taller than that.
           */
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.head}>
              <Poster uri={posterUri(row.poster_path, 'card')} title={name ?? ''} size="sm" />
              <View style={styles.headText}>
                <Text variant="title2">{name ?? 'Untitled'}</Text>
                {year ? (
                  <Text variant="footnote" tone="secondary">
                    {year}
                  </Text>
                ) : null}
                {meta ? (
                  <Text variant="footnote" tone="tertiary">
                    {meta}
                  </Text>
                ) : null}
              </View>
            </View>

            {maker ? (
              <Text variant="subhead" tone="secondary">
                {row.kind === 'movie' ? `Directed by ${maker}` : `Created by ${maker}`}
              </Text>
            ) : null}

            {/**
             * `ClampedText` rather than a bare `Text`, which is the app's one
             * implementation of `… more` on the last visible line rather than orphaned
             * under the paragraph. This was unclamped until now.
             */}
            {row.overview ? (
              <ClampedText
                text={row.overview}
                clamp={SYNOPSIS_LINES}
                testIDPrefix="recall-synopsis"
                expandLabel="Expand description"
                // A reminder closes again, like the title page's synopsis: the reader
                // stays on this sheet, and an opened paragraph they cannot put away is a
                // paragraph between them and the episodes.
                collapseLabel="Collapse description"
              />
            ) : null}

            {/**
             * THE MEMORY SECTION. A film's is its backdrop; a season's is its episodes.
             *
             * No heading over either. A header saying "Episodes" starts turning this back
             * into the tabbed page it is explicitly not, and the stills and the numbers
             * announce what they are perfectly well on their own.
             */}
            {backdrop ? (
              <View
                style={styles.backdrop}
                /**
                 * A cue, not content. The title beside it already names the film, so
                 * announcing "image" here would add a stop to a screen reader's path
                 * through the sheet and say nothing at it.
                 */
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Image
                  source={{ uri: backdrop }}
                  contentFit="cover"
                  transition={theme.duration.state}
                  style={styles.backdropImage}
                  accessibilityIgnoresInvertColors
                />
              </View>
            ) : null}

            {hasEpisodes ? (
              <View style={styles.episodes}>
                {visibleEpisodes.map((episode, index) => (
                  <EpisodeRow
                    // Keyed on position as well as number. TMDB occasionally repeats an
                    // episode number within a season, and the normalizer keeps both
                    // rather than losing a real episode to tidy up a display key.
                    key={`${episode.episode_number}-${index}`}
                    episodeNumber={episode.episode_number}
                    title={episode.title}
                    airDate={formatShortDate(episode.air_date)}
                    runtimeMinutes={episode.runtime_minutes}
                    stillUri={stillUri(episode.still_path)}
                    overview={episode.overview}
                  />
                ))}

                {/**
                 * **In place, and emphatically not another sheet.** This is already a
                 * `<Modal>` presented from inside the ranking's own; a third presentation
                 * is the shape of the freeze `Sheet`'s notes describe, and there is
                 * nothing behind this control worth spending one on. The count is in the
                 * label as well as in the text, so a screen reader hears what it is being
                 * offered rather than "show all, button".
                 */}
                {!showAllEpisodes && episodeList.length > RECALL_EPISODES_FIRST_PAGE ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Show all ${episodeList.length} episodes`}
                    onPress={() => setShowAllEpisodes(true)}
                    style={({ pressed }) => [styles.showAll, pressed && styles.pressed]}
                  >
                    <Text variant="callout" tone="action">
                      Show all {episodeList.length} episodes
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : episodesPending ? (
              /**
               * Two rows rather than the season page's three: this is a section inside a
               * sheet that has already drawn its identity and its synopsis, so the
               * skeleton says "more is coming" rather than "the screen is loading".
               *
               * **In the same negative margin the rows get**, which is not decoration:
               * `SkeletonRow` insets itself by a gutter exactly as `EpisodeRow` does, so
               * leaving it in the padded flow put the placeholder a whole gutter inside
               * the content it stands for, and the section visibly slid sideways the
               * moment the episodes arrived.
               */
              <View style={styles.episodes}>
                <SkeletonRow count={2} />
              </View>
            ) : null}

            {showsCast ? (
              <Text variant="footnote" tone="secondary">
                {`With ${cast.map((person) => person.name).join(', ')}`}
              </Text>
            ) : null}

            {/**
              * Nothing at all is a real outcome for a seed row that was never enriched,
              * and an empty sheet reads as broken. Every section above has to be absent
              * for this to be true, which is why the list is long.
              *
              * **Both pending flags are in it, and one of them was missing.** The
              * reasoning behind `episodesPending` — that saying the wrong thing for a
              * frame is worse than saying nothing for a frame — is exactly as true of
              * the credits: a film with no overview and no backdrop but an ordinary cast
              * would otherwise render this sentence until `media_cache` answered, and
              * then replace it with the cast line.
              */}
            {!maker &&
            !row.overview &&
            !showsCast &&
            !backdrop &&
            !hasEpisodes &&
            !episodesPending &&
            !credits.isPending ? (
              <Text variant="body" tone="secondary">
                We do not have a description for this one yet.
              </Text>
            ) : null}
          </ScrollView>
        )}

        {/* The only control, and it goes back rather than forward. Named "Back to
            ranking" instead of "Close" because that is the reassurance the reader
            wants at this moment: the comparison they were in is still there. */}
        <View style={styles.foot}>
          <Button label="Back to ranking" kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: theme.space[2] },
  state: { padding: theme.layout.gutter },
  body: {
    padding: theme.layout.gutter,
    gap: theme.space[4],
  },
  head: {
    flexDirection: 'row',
    gap: theme.space[4],
  },
  // Shrinks so a long series name wraps inside the row rather than pushing the
  // poster off the edge of the sheet.
  headText: { flex: 1, gap: theme.space[1] },
  /**
   * The film's one image, framed exactly as `EpisodeRow` frames a still.
   *
   * Deliberately that and not `Backdrop`, which is the hero's frame: a card radius and a
   * hairline, sized to sit at the top of a page. These two are the *same element* in the
   * two halves of one sheet — the film's memory section and the season's have to read as
   * one idea, and they only do that if the picture is the same picture.
   */
  backdrop: {
    borderRadius: theme.radius.control,
    overflow: 'hidden',
    backgroundColor: theme.surface.sunken,
  },
  backdropImage: {
    width: '100%',
    // 16:9, the same token the stills use.
    aspectRatio: theme.layout.aspect.backdrop,
  },
  // `EpisodeRow` insets itself by a gutter, having been written for a page that does not
  // inset its own content, and this scroll content is already inset by one. Cancelling it
  // here is what puts the stills at the same width as the page's.
  episodes: { marginHorizontal: -theme.layout.gutter },
  showAll: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.gutter,
  },
  pressed: { opacity: 0.6 },
  foot: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
});
