import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { TasteBucketSheet, type TasteSubject } from '@/features/onboarding/TasteBucketSheet';
import {
  FIRST_FIVE,
  useCompleteTasteOnboarding,
  useTasteOnboarding,
} from '@/features/onboarding/use-taste-onboarding';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  Button,
  EmptyState,
  Screen,
  SearchField,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';

/**
 * Build your taste — the first five films (PRD onboarding, founder decision 2026-08-16).
 *
 * The shape of the decision worth recording: **each film is ranked the moment it is
 * chosen**, rather than choosing five and ranking them afterwards. Ranking is
 * comparative here, so the second film is placed against the first and the fifth against
 * four — a list chosen up front would have to be ranked in a burst at the end, which is
 * both a longer wait and a worse mechanic, because the comparisons stop being about the
 * film in front of you.
 *
 * **Nothing here is a copy of the ranking flow.** The comparisons are the real
 * `RankingSheet` driving the real `rank_start`/`rank_answer` session. The one thing this
 * screen does differently from the Log tab is that it does not stamp a watch date, and
 * that is the point rather than an omission: the first five may be films somebody saw
 * fifteen years ago, and recording them as watched today would quietly put five titles
 * into this year's Goals. `TasteBucketSheet` explains the mechanics of that.
 *
 * **Progress is read from the data.** There is no local step counter, so closing the app
 * on film three and reopening lands on film three — see `use-taste-onboarding.ts`.
 *
 * Movies only. TV is ranked per season and a season is reached through its series, which
 * is two navigations deep and the wrong thing to meet in the first minute.
 */
export default function TasteOnboardingScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const [input, setInput] = useState('');
  const [choosing, setChoosing] = useState<TasteSubject | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);

  const state = useTasteOnboarding(profile.id);
  const complete = useCompleteTasteOnboarding(profile.id);
  const ranked = state.data?.ranked ?? 0;
  const done = ranked >= FIRST_FIVE;

  const { results, idle, isPending, isError, refetch, providerSearching } = useTitleSearch(input);
  // Films only. A series cannot be ranked at all, so offering one here is offering a
  // dead end at the exact moment somebody is deciding whether this app works.
  const films = results.filter((result) => result.kind === 'movie');

  const leave = async ({ skipped }: { skipped: boolean }) => {
    await complete({ skipped });
    router.replace('/(tabs)/feed');
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />

      {done ? (
        <Summary
          onExplore={() => void leave({ skipped: false })}
          onCollection={async () => {
            await complete({ skipped: false });
            router.replace('/(tabs)/collection');
          }}
        />
      ) : (
        <>
          <View style={styles.intro}>
            <Text variant="title1">Build your taste</Text>
            <Text variant="body" tone="secondary">
              Rank five films you have seen. Bingd learns from how they compare to each
              other, not from stars.
            </Text>

            <Progress ranked={ranked} />
          </View>

          <View style={styles.field}>
            <SearchField
              accessibilityLabel="Search for a film"
              placeholder="A film you have seen"
              value={input}
              onChangeText={setInput}
              onClear={() => setInput('')}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
          </View>

          {idle ? (
            <ScrollView
              contentContainerStyle={styles.idle}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              <EmptyState
                kind="nothingYet"
                compact
                title="Start with one you love"
                body="Anything you have ever seen. The first one needs no comparison."
              />
            </ScrollView>
          ) : isError ? (
            <EmptyState
              kind="couldNotLoad"
              title="Could not search"
              body="Search needs a connection."
              action={{ label: 'Try again', onPress: () => void refetch() }}
            />
          ) : isPending ? (
            <SkeletonRow count={5} />
          ) : films.length === 0 ? (
            <View style={styles.status}>
              <Text variant="body" tone="tertiary">
                {providerSearching ? 'Looking further afield…' : 'No films match that.'}
              </Text>
            </View>
          ) : (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={styles.results}
            >
              {films.map((film: SearchResult) => (
                <TitleRow
                  key={film.id}
                  title={film.title}
                  year={yearOf(film.release_date)}
                  posterUri={posterUri(film.poster_path)}
                  onPress={() =>
                    setChoosing({
                      id: film.id,
                      title: film.title,
                      year: yearOf(film.release_date),
                      posterUri: posterUri(film.poster_path, 'card'),
                    })
                  }
                />
              ))}
            </ScrollView>
          )}

          {/* Quiet, and at the bottom. Somebody who cannot think of five films they
              have seen must not be held on this screen forever — but it is the last
              thing offered rather than an equal alternative to the thing that makes
              the app work. */}
          <View style={styles.skip}>
            <Button label="Not now" kind="tertiary" onPress={() => void leave({ skipped: true })} />
          </View>
        </>
      )}

      <TasteBucketSheet
        subject={choosing}
        onClose={() => setChoosing(null)}
        onChosen={(bucket) => {
          if (!choosing) return;
          // Straight into comparisons, with no second tap — the same continuous motion
          // the Log tab uses (screens.md §4).
          setRanking({
            id: choosing.id,
            title: choosing.title,
            bucket,
            posterUri: choosing.posterUri,
            mode: 'start',
          });
          setChoosing(null);
        }}
      />

      <RankingSheet
        subject={ranking}
        onClose={() => {
          setRanking(null);
          setInput('');
          // The count is the progress, so it is re-read rather than incremented. A
          // placement that failed leaves the number where it was, which is the truth.
          void state.refetch();
        }}
        onRankAnother={() => {
          setRanking(null);
          setInput('');
          void state.refetch();
        }}
      />
    </Screen>
  );
}

/** Five dots, not a percentage. The number is small enough to count. */
function Progress({ ranked }: { ranked: number }) {
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel={`${ranked} of ${FIRST_FIVE} films ranked`}
    >
      {Array.from({ length: FIRST_FIVE }, (_, index) => (
        <View
          key={index}
          style={[styles.pip, index < ranked ? styles.pipDone : styles.pipTodo]}
        />
      ))}
      <Text variant="footnote" tone="secondary" style={styles.progressLabel}>
        {ranked} of {FIRST_FIVE}
      </Text>
    </View>
  );
}

/**
 * What five rankings bought, said plainly.
 *
 * Deliberately not a personality verdict. Five films is enough to order a list and to
 * seed recommendations; it is nowhere near enough to tell somebody what kind of viewer
 * they are, and saying so would be the app making something up in the first minute of
 * a relationship built on it not doing that.
 */
function Summary({
  onExplore,
  onCollection,
}: {
  onExplore: () => void;
  onCollection: () => void;
}) {
  return (
    <View style={styles.summary}>
      <Text variant="title1" style={styles.centre}>
        That is a start
      </Text>
      <Text variant="body" tone="secondary" style={styles.centre}>
        Five films is enough to rank against, so everything you log from here finds its
        place by comparison. For You gets better the more you add.
      </Text>

      <View style={styles.summaryActions}>
        <Button label="Explore For You" onPress={onExplore} />
        <Button label="See my collection" kind="secondary" onPress={onCollection} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[6],
    paddingBottom: theme.space[4],
    gap: theme.space[3],
  },
  progress: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  pip: { width: 28, height: 6, borderRadius: theme.radius.control },
  pipDone: { backgroundColor: theme.semantic.score },
  pipTodo: { backgroundColor: theme.border.hairline },
  progressLabel: { marginLeft: theme.space[2] },
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  idle: { paddingTop: theme.space[4] },
  status: { padding: theme.layout.gutter },
  results: { paddingBottom: theme.space[8] },
  skip: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[3] },
  summary: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.space[5],
    paddingHorizontal: theme.layout.gutter,
  },
  centre: { textAlign: 'center' },
  summaryActions: { gap: theme.space[3] },
});
