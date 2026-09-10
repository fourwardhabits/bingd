import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useCurrentProfile, UseDifferentAccountButton } from '@/features/auth';
import { useRankedCollection } from '@/features/collection/use-collection';
import { bandSizes, formatScore, scoreFor } from '@/features/collection/score';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import { PICK_TARGET, setRankingOutcome } from '@/features/onboarding/pick-five';
import { useStarterMovies } from '@/features/onboarding/use-starter-movies';
import { TasteBucketSheet, type TasteSubject } from '@/features/onboarding/TasteBucketSheet';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import {
  FIRST_FIVE,
  useBeginTasteOnboarding,
  useTasteOnboarding,
} from '@/features/onboarding/use-taste-onboarding';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { useTrending } from '@/features/trending/use-trending';
import { DiagnosticsSheet } from '@/features/diagnostics/DiagnosticsSheet';
import { diagnosticsAvailable } from '@/features/diagnostics/availability';
import { track } from '@/lib/analytics';
import { note } from '@/lib/flight-recorder';
import { posterUri } from '@/lib/images';
import { theme } from '@/ui/tokens';
import {
  Button,
  LoadingScreen,
  Poster,
  Screen,
  SearchField,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';

/**
 * The first five: pick one, rank it, pick the next, five times, then Your First Five.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN WAS REBUILT (founder, physical iOS 1.0.1 build 9, 2026-09-09)
 *
 * The previous version asked for all five titles first and then ranked all five. That
 * shape had a good argument behind it — "pick five" is a task somebody can picture the
 * end of — and it lost to two things on a device.
 *
 * **It is not the product.** Ranking against what you have already ranked *is* bingd.,
 * and a flow that separates choosing from ranking teaches the app in the wrong order: the
 * reader spends the first half of onboarding doing something the app will never ask of
 * them again. The founder's direction is the real loop, from the first title:
 *
 *     pick -> rank -> pick -> rank -> ... -> five -> Your First Five
 *
 * **And it dead-ended.** The founder chose *I liked it* for the first film, finished the
 * comparisons, saw the post-rank completion sheet, closed it, and onboarding stopped. The
 * cause is in the old file and it is structural rather than cosmetic: the bucket sheet's
 * subject was derived from the run's cursor alone —
 *
 *     subject={ranking ? null : toSubject(current)}
 *
 * — so the moment the first placement landed, `current` advanced to the second film and
 * the bucket sheet became visible **while the log sheet was still open on top of it**.
 * Two React Native `<Modal>`s asked to present at once from one screen; iOS presents the
 * first and refuses the second, React believes both are up, and closing the one that
 * exists leaves a screen whose only remaining control is a modal that will never appear.
 *
 * So the fix is not "close the log sheet more carefully". It is that **the run is a state
 * machine with one sheet in it**, below, and the log sheet is gone from onboarding
 * entirely — which is also what the founder's brief asks for on its own terms.
 *
 * ---------------------------------------------------------------------------
 * THE STATE MACHINE, AND WHY EXACTLY ONE SHEET CAN EVER BE MOUNTED
 *
 *     picking            the search field and the starter grid; no sheet
 *       | choose a title
 *     bucket             TasteBucketSheet over that title
 *       | how was it?                          | dismissed -> back to picking
 *     ranking            RankingSheet over that title
 *       | placed                               | dismissed -> back to picking
 *     picking            progress is now n of 5
 *
 * `step` is one value, so the sheets are mutually exclusive *by construction* rather than
 * by two conditions that have to agree. There is no arrangement of state in which both
 * are non-null, which is the invariant the founder's dead end was the absence of.
 *
 * The payoff is still derived rather than stored — see `placed` — because progress that
 * is a fact about `rankings` cannot disagree with `rankings`.
 *
 * ---------------------------------------------------------------------------
 * NO POST-RANK SHEET, WHICH IS A CONTRACT AND NOT A HIDDEN BUTTON
 *
 * `RankingSheet` takes `onPlaced` here instead of `onFinishLog`, and that prop suppresses
 * the reveal as well as the log sheet. Its own note carries the reasoning: the payoff of
 * this flow is *Your First Five*, and five per-title reveals on the way to it are four
 * interruptions in a sentence that has not finished. Nothing about the ranking itself
 * changes — the same `rank_start`/`rank_answer` session, the same comparisons, the same
 * scores, and the same celebration queue, left standing so an award earned on film three
 * arrives after the flow rather than across it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RELAUNCH DOES, AND WHY IT IS ALWAYS THE PICKER
 *
 * Nothing about the run is written to the device any more, and the deletion is the point.
 * Progress is `rankings`, which survives anything; a title that was mid-comparison when
 * the app died is simply not ranked, so it comes back as a title to pick. Reopening on
 * the picker at *n of 5* is true, actionable and cannot strand anybody — where reopening
 * into a sheet would restore the reader to the exact state they were in when the process
 * ended, which on the founder's device was the state that ended it.
 *
 * The cost is honest and small: a film whose bucket was saved but whose comparisons never
 * finished has a `user_media` row and no ranking, which is what any abandoned rank in the
 * app leaves behind, and picking it again is idempotent (`set_bucket` assigns).
 *
 * ---------------------------------------------------------------------------
 * WHAT DELIBERATELY DID NOT CHANGE
 *
 * **The ranking engine.** Nothing here re-implements a comparison, a band, a score or a
 * placement.
 *
 * **No watch date.** `set_bucket` writes none, so five films somebody saw fifteen years
 * ago do not land in this year's Goals. `TasteBucketSheet` explains the mechanics.
 *
 * **Movies only.** A series cannot be ranked and a season is two navigations deep.
 */
export default function TasteOnboardingScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();

  const state = useTasteOnboarding(profile.id);
  const begin = useBeginTasteOnboarding(profile.id);

  const [input, setInput] = useState('');
  const [step, setStep] = useState<RunStep>({ kind: 'picking' });

  /**
   * Enrol, or leave — the screen decides, because routing deliberately will not.
   *
   * Routing sends people into the group and never takes them out, so this screen is the
   * only thing standing between an established account that reached `/onboarding/taste`
   * from a deep link and being marked `active` and held here.
   *
   * **`begin` is called from here and nowhere else now.** It used to be called by the
   * motivation step as well, which was the real start of the flow; that screen is gone
   * (see `OnboardingHeader`), so this is the flow's first screen and its own enrolment.
   */
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !state.data) return;
    settled.current = true;

    if (!state.data.needed) {
      router.replace('/(tabs)/feed');
      return;
    }
    void begin();
  }, [state.data, begin, router]);

  const { results, idle, isPending, isError, retry, providerSearching } = useTitleSearch(input);
  const starters = useStarterMovies(profile.id);
  /**
   * **The bridge over the deployment gap, and the floor under a young platform.**
   *
   * `starter_movies` arrives in `20260915000100`, and a migration is deployed on its own
   * schedule — the beta lane points at the production project (`config/backends.cjs`), so
   * a build can reach a backend where this function does not exist yet and PostgREST
   * answers 404. It is also, on its own terms, allowed to return nothing: it can only
   * answer with movies the catalogue holds.
   *
   * Either way the consequence would be the screen the founder already met — an empty
   * grid on the first screen of the product — so the old source stays as the floor. It is
   * one cached `select`, shared with the Feed's shelf and already warm on most launches,
   * and it is only ever *read* when the better answer has none.
   */
  const trending = useTrending();
  /**
   * The account's ranked movies: the run's progress, and the payoff's contents.
   *
   * One query serving both, and it is the one the ranking already warms — `apply`
   * invalidates this key on every placement, so it follows the run without anything here
   * asking it to.
   */
  const rankedMovies = useRankedCollection(profile.id, 'movies');

  const rankedIds = new Set((rankedMovies.data ?? []).map((entry) => entry.mediaItemId));
  /**
   * How many of the five are done.
   *
   * The ranked movies themselves, not a counter and not a membership test against a
   * stored selection. An account only reaches this screen with an empty collection —
   * `readState` admits `ranked === 0 && logged === 0` — so every ranked movie on it is
   * one this run placed, and there is no second list that could disagree.
   */
  const placed = Math.min(rankedIds.size, PICK_TARGET);
  const payoff = placed >= PICK_TARGET;

  // Nothing until both answers are in. Drawing the picker first and then deciding shows
  // the grid for a beat to somebody who is about to be sent to the feed, which is the
  // wrong first thing to say to an account that has been in use for months. The ranked
  // list is waited on with it: without it `placed` is zero on the first frame and a
  // resumed run would draw *1 of 5* before correcting itself.
  if (!state.data || rankedMovies.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingScreen />
      </Screen>
    );
  }

  /**
   * Send a chosen title into the run.
   *
   * Refuses one that is already ranked. `starter_movies` excludes them server-side and
   * the search results are filtered below, so this is the third line of the same defence
   * — and it is the one that would matter, because picking a title that is already placed
   * is a step that cannot advance and five is the only way off this screen.
   */
  const choose = (pick: TasteSubject) => {
    if (rankedIds.has(pick.id)) return;
    setInput('');
    setStep({ kind: 'bucket', pick });
  };

  /** Back to the picker, from a dismissal at either sheet. Never anywhere else. */
  const backToPicker = () => setStep({ kind: 'picking' });

  const leavePayoff = () => {
    track({ name: 'onboarding_step_completed', props: { step: 'payoff', outcome: 'continued' } });
    // Recorded where it is known. The notification step reports it at the end and must
    // not have to re-derive it from a query that may not have answered.
    void setRankingOutcome(profile.id, 'completed');
    advance('people');
    router.replace('/onboarding/people');
  };

  const skip = () => {
    track({ name: 'onboarding_step_completed', props: { step: 'pick', outcome: 'skipped' } });
    void setRankingOutcome(profile.id, 'skipped');
    advance('people');
    router.replace('/onboarding/people');
  };

  const films = results.filter(
    (result) => result.kind === 'movie' && !rankedIds.has(result.id),
  );
  /**
   * The grid: the community list, or the old shelf when there is no community list.
   *
   * The fallback is only consulted when the better source has answered with nothing, so
   * on a backend where `starter_movies` is deployed it is never read at all. The
   * already-ranked filter is applied to both — `starter_movies` does it in SQL and the
   * shelf knows nothing about the caller — because offering back a movie that is already
   * placed is a step that cannot advance.
   */
  const community = (starters.data ?? []).filter((item) => !rankedIds.has(item.id));
  const grid: { id: string; title: string; year: number | null; posterUri: string | null }[] =
    community.length > 0
      ? community
      : (trending.data?.items ?? [])
          .filter((item) => item.kind === 'movie' && !rankedIds.has(item.mediaItemId))
          .map((item) => ({
            id: item.mediaItemId,
            title: item.title,
            year: item.year,
            posterUri: posterUri(item.posterPath, 'card'),
          }));
  const tileWidth = Math.floor(
    (width - theme.layout.gutter * 2 - theme.layout.posterGrid.gap * 2) / 3,
  );

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <OnboardingHeader step={payoff ? 'payoff' : 'rank'} />

      {payoff ? (
        <FirstFive onContinue={leavePayoff} />
      ) : (
        <>
          <View style={styles.intro}>
            <Text variant="title1">
              {placed === 0 ? 'Pick a movie you have seen' : 'Pick another one'}
            </Text>
            <Text variant="body" tone="secondary">
              {placed === 0
                ? 'Rate it, and bingd. will ask you to compare. Five of these and your list is started.'
                : 'Each one gets compared against the ones before it.'}
            </Text>
            <Progress placed={placed} />
          </View>

          <View style={styles.field}>
            <SearchField
              accessibilityLabel="Search for a movie"
              placeholder="A movie you've seen"
              value={input}
              onChangeText={setInput}
              onClear={() => setInput('')}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
          </View>

          {idle && (starters.isPending || trending.isPending) ? (
            // Outside the grid's own ScrollView: its content container is a wrapping row,
            // and a skeleton laid out inside one is a row of stripes rather than a
            // placeholder for a grid.
            <SkeletonRow count={6} />
          ) : idle ? (
            /**
             * The grid, which is load-bearing rather than decorative.
             *
             * A bare instruction over an empty search box asks the reader to already know
             * what they want, five times over. These are the movies this community has
             * ranked highest among the titles enough people have ranked to mean anything
             * (`starter_movies`), topped up from catalogue popularity while the platform
             * is small — and it is deliberately long, because the founder ran the old
             * twelve-row trending shelf out after four picks.
             *
             * **It claims nothing in words.** No heading, no "popular on bingd."; the
             * instruction above is the task and this is simply the first place to look.
             */
            <ScrollView
              contentContainerStyle={styles.grid}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              {grid.length === 0 ? (
                <View style={styles.status}>
                  <Text variant="body" tone="tertiary">
                    Search for a movie you have seen.
                  </Text>
                </View>
              ) : (
                grid.map((item) => (
                  <PickTile
                    key={item.id}
                    width={tileWidth}
                    title={item.title}
                    posterUri={item.posterUri}
                    onPress={() =>
                      choose({
                        id: item.id,
                        title: item.title,
                        year: item.year,
                        posterUri: item.posterUri,
                      })
                    }
                  />
                ))
              )}
            </ScrollView>
          ) : isError ? (
            <View style={styles.status}>
              <Text variant="body" tone="tertiary">
                Search needs a connection.
              </Text>
              <Button label="Try again" kind="secondary" onPress={retry} />
            </View>
          ) : isPending ? (
            <SkeletonRow count={5} />
          ) : films.length === 0 ? (
            <View style={styles.status}>
              <Text variant="body" tone="tertiary">
                {providerSearching ? 'Looking further afield…' : 'No movies match that.'}
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
                    choose({
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

          <View style={styles.footer}>
            {/**
             * **The way out, kept.**
             *
             * The picker is the only screen in the flow that could hold somebody
             * indefinitely: five rankings is a hard requirement to reach the next control,
             * and somebody who cannot think of five movies they have seen must not be held
             * here forever. That is a stranding this codebase has already paid for once.
             *
             * Quiet and tertiary, and it skips to the People step rather than out of
             * onboarding — leaving the ranking is not the same as leaving the flow, and
             * the social half still has something to offer somebody who declined this one.
             */}
            <Button label="Not now" kind="tertiary" onPress={skip} />
            {/* This screen has no header and Settings is unreachable from it, so for the
                wrong account signed in on this phone it would otherwise be a locked room.
                See `UseDifferentAccountButton`. */}
            <UseDifferentAccountButton />
          </View>
        </>
      )}

      {/* One sheet at a time, by construction. See the header. */}
      <TasteBucketSheet
        subject={step.kind === 'bucket' ? step.pick : null}
        // Dismissing the question returns to the picker rather than leaving the title
        // hanging as a cursor nothing can clear. Nothing has been written yet.
        onClose={backToPicker}
        onChosen={(bucket) => {
          if (step.kind !== 'bucket') return;
          setStep({
            kind: 'ranking',
            subject: {
              id: step.pick.id,
              title: step.pick.title,
              bucket,
              posterUri: step.pick.posterUri ?? null,
              kind: 'movie',
              mode: 'start',
            },
          });
        }}
      />

      <RankingSheet
        subject={step.kind === 'ranking' ? step.subject : null}
        // Dismissed mid-comparison. The session is cancelled by the sheet itself, the
        // title is not ranked, and the picker is where somebody can act — including on
        // the same film again, which is why the run holds no cursor to be confused by it.
        onClose={backToPicker}
        /**
         * The placement, with no reveal and no log sheet. This is the founder's
         * "transition directly to the next picker", and it is one assignment because the
         * progress it moves is `rankings` rather than anything held here.
         *
         * The starter list is invalidated with it: the movie just ranked is excluded by
         * `starter_movies` server-side, so the grid has to ask again to stop offering it.
         */
        onPlaced={() => {
          note('onboarding', 'placed', String(placed + 1));
          setStep({ kind: 'picking' });
          void queryClient.invalidateQueries({
            queryKey: ['onboarding-starter-movies', profile.id],
          });
        }}
        surface="onboarding"
      />
    </Screen>
  );
}

/**
 * Where the run is, as one value.
 *
 * The type is the invariant: `bucket` and `ranking` cannot both be true of it, so the two
 * sheets below cannot both be mounted. See the header for the dead end that came from
 * deriving them separately.
 */
type RunStep =
  | { kind: 'picking' }
  | { kind: 'bucket'; pick: TasteSubject }
  | { kind: 'ranking'; subject: RankingSubject };

/** Five dots and a count, not a percentage. The number is small enough to count. */
function Progress({ placed }: { placed: number }) {
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel={`${placed} of ${PICK_TARGET} movies ranked`}
    >
      {Array.from({ length: PICK_TARGET }, (_, index) => (
        <View key={index} style={[styles.pip, index < placed ? styles.pipDone : styles.pipTodo]} />
      ))}
      <Text variant="footnote" tone="secondary" style={styles.progressLabel}>
        {`${placed} of ${PICK_TARGET}`}
      </Text>
    </View>
  );
}

/**
 * One poster in the grid.
 *
 * **No selected state any more.** Choosing is no longer an accumulation somebody can see
 * and undo — a tap opens the bucket question for that film immediately — so the tile is a
 * button rather than a checkbox, and it says so to a screen reader. The check mark and
 * the quiet-at-five treatment went with the two-phase flow they described.
 */
function PickTile({
  width,
  title,
  posterUri: uri,
  onPress,
}: {
  width: number;
  title: string;
  posterUri: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={[{ width }, styles.tile]}
    >
      <View style={styles.tileFrame}>
        <Poster uri={uri} title={title} width={width} />
      </View>
    </Pressable>
  );
}

/**
 * Your First Five.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE PAYOFF
 *
 * The ordinal leads the row and the score follows it, one size down. Both are present and
 * there is no doubt which one the screen is about.
 *
 * **The scores are the real arithmetic**, `scoreFor` over `bandSizes`, which is the same
 * function the reveal and the collection use. Nothing is recomputed with a second model:
 * four movies in the loved band land on 10.0, 9.0, 8.0 and 7.0 because the band runs 10
 * to 7 and the score interpolates across it.
 *
 * **And it is now the first time a score is shown at all**, which is what the per-title
 * reveals were costing it. Nothing here explains the algorithm: the explanation belongs
 * under the first reveal somebody meets in the app proper, and a lesson on the payoff
 * turns a reward into homework.
 *
 * One primary action. There is no competing *Explore For You* or *Find people*: this is
 * still onboarding, and a fork at the payoff is what made the social half optional in the
 * first place.
 */
function FirstFive({ onContinue }: { onContinue: () => void }) {
  const profile = useCurrentProfile();
  const { data } = useRankedCollection(profile.id, 'movies');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const entries = data ?? [];
  const sizes = bandSizes(entries);
  // Position is 1-based and ascending within the category, and every row here is the same
  // category, so this is the ranking itself rather than a proxy for it.
  const top = [...entries].sort((a, b) => a.position - b.position).slice(0, FIRST_FIVE);

  return (
    <>
      <ScrollView contentContainerStyle={styles.payoff}>
        <View style={styles.intro}>
          {/* The heading is the way in to Diagnostics from here, by long press: routing
              holds this account inside the flow, so a pushed route would be replaced. A
              gesture on something already on screen is the only entrance routing cannot
              take away. Beta and below only. */}
          <Text
            variant="title1"
            onLongPress={diagnosticsAvailable ? () => setDiagnosticsOpen(true) : undefined}
          >
            Your First Five
          </Text>
          <Text variant="body" tone="secondary">
            This is just the start. As you rank more, your favorites get clearer and bingd.
            gets a better read on your taste.
          </Text>
        </View>

        {top.map((entry, index) => (
          <View key={entry.mediaItemId} style={styles.rankRow}>
            <Text variant="title1" style={styles.ordinal}>
              {index + 1}
            </Text>
            <View style={styles.rankPoster}>
              <Poster uri={posterUri(entry.posterPath, 'card')} title={entry.title} size="sm" />
            </View>
            <View style={styles.rankTitle}>
              <Text variant="body" numberOfLines={2}>
                {entry.title}
              </Text>
              {entry.year ? (
                <Text variant="footnote" tone="secondary">
                  {entry.year}
                </Text>
              ) : null}
            </View>
            <Text variant="score" tone="secondary">
              {formatScore(scoreFor(entry.bucket, entry.position, sizes))}
            </Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Continue" onPress={onContinue} />
        <UseDifferentAccountButton />
      </View>

      <DiagnosticsSheet visible={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[4],
    gap: theme.space[3],
  },
  progress: { flexDirection: 'row', alignItems: 'center', gap: theme.space[2] },
  pip: { width: 28, height: 6, borderRadius: theme.radius.control },
  pipDone: { backgroundColor: theme.semantic.score },
  pipTodo: { backgroundColor: theme.border.hairline },
  progressLabel: { marginLeft: theme.space[2] },
  field: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2] },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.layout.posterGrid.gap,
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[8],
  },
  tile: { position: 'relative' },
  tileFrame: { borderRadius: theme.radius.control },
  status: { padding: theme.layout.gutter, gap: theme.space[3] },
  results: { paddingBottom: theme.space[8] },
  payoff: { paddingBottom: theme.space[6] },
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
  },
  ordinal: { width: 28, textAlign: 'center', color: theme.semantic.score },
  rankPoster: { width: theme.poster.sm.width },
  rankTitle: { flex: 1, gap: 2 },
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[3],
    gap: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },
});
