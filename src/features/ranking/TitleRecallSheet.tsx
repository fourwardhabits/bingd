import { useQuery } from '@tanstack/react-query';
import { ScrollView, StyleSheet, View } from 'react-native';

import { activityMetadata } from '@/features/feed/activity';
import { useCredits } from '@/features/title/use-credits';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { compactName } from '@/lib/titles';
import { theme } from '@/ui/tokens';
import { Button, EmptyState, Poster, Sheet, SkeletonRow, Text } from '@/ui/components';

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
 * jogs a memory — the full name, when it came out, how long it is, what kind of thing
 * it is, who made it, who is in it, and what it is about.
 *
 * **It adds no new data path.** The row comes from `media_items`, which is the same
 * table the comparison card already reads; the credits come from the `credits` facet
 * of `media_cache`, which the title page has been reading since the integration
 * landed. Nothing here reaches TMDB, and nothing here is fetched until somebody
 * actually presses and holds — the sheet is mounted only while open, so a session that
 * never asks costs nothing.
 *
 * Credits are non-fatal on purpose, exactly as they are on the title page: a catalogue
 * row that was never enriched has no `credits` facet, and the reminder is still a
 * reminder without a director. It renders what it has.
 */

export type TitleRecallSheetProps = {
  /** The title to remind the reader of, or null when the sheet is closed. */
  mediaItemId: string | null;
  onClose: () => void;
};

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
          'id, kind, title, season_number, release_date, runtime_minutes, episode_count, overview, poster_path, genres, original_language, certification, parent:parent_id(title, genres, original_language, certification)',
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

  if (!mediaItemId) return null;

  const row = recall.data ?? null;
  const name = row ? compactName(row) : null;
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

  // Director for a film, creator for a season — `use-credits` reads the same crew
  // list for both and TMDB files a show's creator under Directing, so one line
  // serves both and is labelled for whichever this is.
  const maker = credits.data?.director ?? null;
  const cast = (credits.data?.cast ?? []).slice(0, 6);

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
           * Scrollable, because an overview is as long as TMDB wrote it and a sheet
           * that clipped one mid-sentence would be worse at this job than no sheet.
           * The Sheet caps itself at 90% of the screen, so this scrolls only when the
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

            {row.overview ? <Text variant="body">{row.overview}</Text> : null}

            {cast.length ? (
              <Text variant="footnote" tone="secondary">
                {`With ${cast.map((person) => person.name).join(', ')}`}
              </Text>
            ) : null}

            {/* Nothing at all is a real outcome for a seed row that was never
                enriched, and an empty sheet reads as broken. */}
            {!maker && !row.overview && !cast.length ? (
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
  foot: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
});
