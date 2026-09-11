import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

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
  type BucketId,
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
 *     handoff            the bucket sheet dismissing, nothing presented yet
 *       | iOS onDismiss, or immediately on Android
 *     ranking            RankingSheet over that title
 *       | placed                               | dismissed -> back to picking
 *     picking            progress is now n of 5
 *
 * `step` is one value, so the sheets are mutually exclusive *by construction* rather than
 * by two conditions that have to agree. There is no arrangement of state in which both
 * are non-null, which is the invariant the founder's dead end was the absence of.
 *
 * **`handoff` is the 2026-09-10 fix and it is about UIKit rather than about React.**
 * One value stopped the two sheets being *visible* together; it did not stop them being
 * swapped in one commit, which unmounts one `<Modal>` and mounts another while the first
 * is still animating out. UIKit refuses to present over a dismissing controller, React
 * believes it presented, and the transparent window that survives eats every touch — the
 * picker draws correctly underneath and is dead. `RunStep` carries the full account.
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
   * The current step, readable from a callback that fired after an awaited request.
   * onPlaced is that callback, and its closure can be several transitions old.
   */
  const stepRef = useRef(step);
  // Assigned in an effect rather than during render: React 19 forbids touching a ref
  // while rendering, and the ordering is right anyway — child effects run before this
  // one, and the placement it serves lands a round trip later.
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

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

  /**
   * Which movies are placed: the ones the query has come back with, **union the ones this
   * screen watched the server place**.
   *
   * ---------------------------------------------------------------------------
   * WHY THE SECOND HALF IS NOT BOOKKEEPING (independent review, P1)
   *
   * A placement invalidates `queryKeys.rankings`; it does not synchronously put the new
   * row in the cache. So between `onPlaced` and the refetch landing there is a window —
   * one round trip — in which the picker is back on screen and the count behind it is one
   * short. A quick reader can pick a sixth movie in it and rank it, and the flow's central
   * promise, *exactly five*, is broken by a race rather than by a decision. `Math.min`
   * would then hide the overrun, which is worse than the overrun.
   *
   * The set is the fix and it is the smallest one available: a placement is a fact this
   * component was told directly, so remembering it costs nothing and cannot disagree with
   * the query — the two are unioned, so a row appearing in both is one movie, and an id
   * added twice is one entry. It converges the moment the refetch lands and is discarded
   * with the screen.
   *
   * It is deliberately *not* a counter. A counter would have to be reconciled against the
   * query when it arrives; a set of ids is idempotent, so there is nothing to reconcile.
   *
   * The same union is what the picker filters on, so the sixth movie cannot be offered
   * either — the count and the supply are answered by one fact rather than two.
   */
  const [confirmed, setConfirmed] = useState<readonly string[]>([]);
  const rankedIds = new Set([
    ...(rankedMovies.data ?? []).map((entry) => entry.mediaItemId),
    ...confirmed,
  ]);
  /**
   * How many of the five are done.
   *
   * The ranked movies themselves, not a stored selection. An account only reaches this
   * screen with an empty collection — `readState` admits `ranked === 0 && logged === 0` —
   * so every ranked movie on it is one this run placed, and there is no second list that
   * could disagree.
   */
  const placed = Math.min(rankedIds.size, PICK_TARGET);
  const payoff = placed >= PICK_TARGET;

  /**
   * `handoff` -> `ranking`, once the bucket sheet's presentation is actually gone.
   *
   * A functional update and a `kind` check, so it is idempotent: iOS firing `onDismiss`
   * more than once costs nothing and cannot build a second subject. Nothing here is
   * recomputed — the pick and the bucket were carried through the `handoff` state
   * precisely so this is an assignment rather than a derivation.
   *
   * Only iOS reaches it. Android never enters `handoff` at all; the branch is at the
   * call site in `onChosen`, which is where its reasoning lives.
   */
  const handOver = useCallback(() => {
    setStep((current) => {
      if (current.kind !== 'handoff') return current;
      // No bucket means the question was closed rather than answered, so the dismissal
      // was all there was to wait for.
      return current.bucket ? rankingStepFor({ pick: current.pick, bucket: current.bucket }) : { kind: 'picking' };
    });
  }, []);

  /**
   * iOS has finished *presenting* the comparison sheet, so a dismissal asked for from
   * here will actually complete. If the placement already landed, this is what releases
   * the run — see `leaveRankingFor`.
   */
  const sheetShown = useCallback(() => {
    setStep((current) =>
      current.kind === 'ranking' ? leaveRankingFor({ ...current, shown: true }) : current,
    );
  }, []);

  /** iOS has finished *dismissing* the comparison sheet; the picker is live again. */
  const finishReturn = useCallback(() => {
    setStep((current) => (current.kind === 'returning' ? { kind: 'picking' } : current));
  }, []);

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
    setStep((current) => {
      // Picked while the comparison sheet is still dismissing: held rather than acted on,
      // so the bucket sheet is not presented over a dismissing controller. `returning`
      // carries the reasoning.
      /**
       * A dismissing sheet still covers the screen — its window is up until UIKit takes
       * it down — so a poster is not reachable during `returning` any more than during
       * `handoff`, and RNTL models that faithfully through `accessibilityViewIsModal`.
       * Left alone rather than queued: machinery for a state nobody can reach is
       * machinery no test can hold to account.
       */
      if (current.kind === 'returning') return current;
      /**
       * During `handoff` the bucket sheet is still on screen, so a poster is not
       * reachable and this should not be possible — but replacing the step if it ever
       * were would discard a `set_bucket` that has already committed, leaving a title
       * bucketed and never ranked with nothing left to fire `handOver` (independent
       * review). Left alone rather than overwritten.
       */
      if (current.kind === 'handoff') return current;
      /**
       * And not while the comparison sheet is presenting either. Between the bucket
       * sheet's `onDismiss` and that presentation completing there is a window with
       * nothing covering the picker, and a pick taken in it would unmount a `<Modal>`
       * mid-presentation to mount another — the same swap, narrower.
       */
      if (current.kind === 'ranking') return current;
      return { kind: 'bucket', pick };
    });
  };

  /**
   * The bucket question was closed rather than answered.
   *
   * Serialised like every other exit (independent review): unmounting it here would leave
   * a presented `<Modal>` dismissing with the picker live behind it, so a poster tapped
   * inside that window presents a *second* bucket sheet over the first. Same class as the
   * bug this file is about, reached by Close instead of by a placement. Nothing has been
   * written, so `handoff` carries no bucket and lands on the picker.
   */
  const backToPicker = () =>
    setStep((current) =>
      current.kind === 'bucket' && Platform.OS === 'ios'
        ? { kind: 'handoff', pick: current.pick }
        : { kind: 'picking' },
    );

  /**
   * The comparison sheet was dismissed — placed, or abandoned mid-comparison.
   *
   * iOS keeps it mounted through the slide-out so nothing presents over it; Android has
   * no presentation to serialise against and goes straight back to the picker.
   */
  const returnToPicker = () =>
    setStep((current) => {
      if (current.kind === 'ranking') {
        return Platform.OS === 'ios'
          ? { kind: 'returning', subject: current.subject }
          : { kind: 'picking' };
      }
      /**
       * Already dismissing, so this is a second `onClose` and it must do nothing.
       *
       * `Session.close()` awaits `rankCancel` before calling back, so two taps on Close
       * produce two calls — and the second used to force `picking`, unmounting the
       * `<Modal>` mid-dismissal with `finishReturn` never firing. That is the freeze,
       * reached through the fix for it (independent review).
       */
      if (current.kind === 'returning') return current;
      return { kind: 'picking' };
    });

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
            {/* ---------------------------------------------------------------
                **The import exists, said once, in words, going nowhere.**

                Contract V3 §9 makes importing a Letterboxd history optional and available
                at any time, and the founder's instruction was to make it discoverable
                without making it a step — with a minimal treatment if placing it in
                onboarding looked risky. It does: this flow ends in `Stack.Protected`
                behind a stage machine that has stranded people twice (#131, #133), and a
                route push from the middle of it would leave an account half-way through
                first-run on a screen with no way back into it. A modal would be worse
                still: two presented view controllers is the 2026-09-10 freeze.

                So this is a sentence. It appears on the first title and not on the other
                four, because it answers a thought somebody has exactly once — *I have
                already done all of this somewhere else* — and a line that repeats for
                five screens becomes an instruction rather than a note. It names where to
                find the importer and does not offer to go there, so the skip path is
                simply carrying on, which is what the person is already doing.

                The real entry point is Settings ▸ Import from Letterboxd, which is
                reachable the moment this flow is over and forever afterwards.
                --------------------------------------------------------------- */}
            {placed === 0 ? (
              <Text variant="footnote" tone="tertiary">
                Coming from Letterboxd? You can bring your whole history across later, from
                Settings.
              </Text>
            ) : null}
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

          {idle && starters.isPending ? (
            /**
             * **The starter list alone decides whether this is still loading**
             * (independent review, P1).
             *
             * It was `starters.isPending || trending.isPending`, which made a healthy
             * community list wait on the shelf that exists only to stand in for it. A slow
             * Trending request would hold skeletons over a grid that was ready — the first
             * screen of the product, with movies in hand and nothing drawn. Bounded by
             * `REQUEST_DEADLINE_MS` rather than unbounded, and still wrong.
             *
             * The fallback is a fallback: when it is late, the grid draws without it and
             * fills in when it arrives. The one visible cost is on a backend with neither
             * source — the actionable "search for a movie" line for a moment before the
             * shelf lands — and that line is a place somebody can act, which skeletons over
             * a stalled request are not.
             *
             * Outside the grid's own ScrollView: its content container is a wrapping row,
             * and a skeleton laid out inside one is a row of stripes rather than a
             * placeholder for a grid.
             */
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
        // Mounted through `handoff` as well, so the dismissal it is in the middle of has
        // a component to finish against. `visible` is what actually closes it.
        subject={
          step.kind === 'bucket' ? step.pick : step.kind === 'handoff' ? step.pick : null
        }
        visible={step.kind === 'bucket'}
        // Dismissing the question returns to the picker rather than leaving the title
        // hanging as a cursor nothing can clear. Nothing has been written yet.
        onClose={backToPicker}
        onChosen={(bucket) => {
          /**
           * **A functional update, because this closure outlives the render it came
           * from** (independent review, verified experimentally).
           *
           * `set_bucket` is awaited before `onChosen` fires, so somebody can press Close
           * in between. `step` captured here still says `bucket`, so the guarded version
           * of this read as "still on the question" when the sheet had already been
           * closed and unmounted — and moved the run into `handoff`. A modal that was
           * never presented never dismisses, so `onDismiss` never came and the step was
           * terminal: the title bucketed, never ranked, and the picker showing a number
           * that would not move. Android, which does not enter `handoff`, carried on
           * ranking — so the two platforms disagreed about the same tap.
           *
           * Reading the current state closes it: a run that is no longer on the question
           * is left exactly where it is, which is what pressing Close asked for.
           */
          setStep((current) => {
            if (current.kind !== 'bucket') return current;
            const handoff = { kind: 'handoff', pick: current.pick, bucket } as const;
          /**
           * iOS waits; Android does not, and the branch is here rather than in an effect.
           *
           * On iOS, going straight to `ranking` asks UIKit to present the comparison
           * sheet while this one is still dismissing — see `RunStep`'s `handoff`.
           *
           * On Android there is nothing to wait for: a modal is a view in the same
           * window, `onDismiss` is iOS-only in React Native, and parking in `handoff`
           * would strand the flow on the platform that never had the bug. Deciding it
           * here keeps that a branch on one value instead of an effect that sets state
           * as soon as it runs — which is a cascading render, and which lint refuses.
           *
           * **No timeout on the iOS side, and the reason is not an escape hatch.**
           *
           * An earlier version of this note claimed a missed `onDismiss` would cost only
           * a tap, because the picker is mounted underneath. That is wrong and an
           * independent review said so: if the callback never came, the dismissal never
           * completed, so the window is still there and the picker is exactly as
           * untappable as it was before this fix. There is no degraded mode to fall back
           * on.
           *
           * It carries no watchdog because the callback is not best-effort. React
           * Native's modal dismisses on `visible=false` while mounted and calls
           * `onDismiss` from the completion on both the legacy and Fabric renderers —
           * checked in `Modal.js`, `RCTModalHostView.m` and
           * `RCTModalHostViewComponentView.mm` rather than assumed. A timer here would be
           * a guess at an animation length in front of every ranking, guarding a path
           * that fires or does not fire for reasons a delay cannot influence.
           */
            return Platform.OS === 'ios' ? handoff : rankingStepFor(handoff);
          });
        }}
        onDismissed={handOver}
      />

      <RankingSheet
        /**
         * Mounted through `returning` as well, so the dismissal it is in the middle of
         * has a component to finish against — the return half of `handoff`.
         *
         * Without this the loop still had one unserialised swap left in it (independent
         * review): the comparison sheet dismissed by unmounting, so a poster tapped
         * inside that ~300ms would present the bucket sheet over a dismissing controller
         * and strand the screen exactly as before. Once per turn of the loop rather than
         * once per run.
         */
        subject={
          step.kind === 'ranking'
            ? step.subject
            : step.kind === 'returning'
              ? step.subject
              : null
        }
        visible={step.kind === 'ranking'}
        onShown={sheetShown}
        onDismissed={finishReturn}
        // Dismissed mid-comparison. The session is cancelled by the sheet itself, the
        // title is not ranked, and the picker is where somebody can act — including on
        // the same film again, which is why the run holds no cursor to be confused by it.
        onClose={returnToPicker}
        /**
         * The placement, with no reveal and no log sheet. This is the founder's
         * "transition directly to the next picker", and it is one assignment because the
         * progress it moves is `rankings` rather than anything held here.
         *
         * The starter list is invalidated with it: the movie just ranked is excluded by
         * `starter_movies` server-side, so the grid has to ask again to stop offering it.
         */
        onPlaced={() => {
          /**
           * Read through the ref, not through the closure (independent review).
           *
           * This fires from an effect after an awaited RPC, so the `step` it closed over
           * may be several transitions old — and acting on a stale one could drop the
           * `confirmed` record for a placement the server had already made.
           *
           * A ref rather than a functional `setStep`, because two pieces of state move
           * here and a state updater must stay pure: calling `setConfirmed` from inside
           * one is a side effect in a function React is free to run twice, and it cost a
           * placement that never reached the count.
           */
          const current = stepRef.current;
          if (current.kind !== 'ranking') return;
          const subject = current.subject;
          note('onboarding', 'placed', String(placed + 1));
          // Before the step changes, so the picker cannot draw one frame with the old
          // count. See `confirmed` for the sixth-ranking race this closes.
          setConfirmed((was) => (was.includes(subject.id) ? was : [...was, subject.id]));
          /**
           * `returning` rather than `picking` on iOS: the picker is revealed either way,
           * but the sheet stays mounted until its dismissal is acknowledged, so the next
           * pick cannot present over it.
           *
           * **And only once the sheet has actually appeared.** On the first title the
           * placement can land inside the sheet's own 350ms presentation, and a dismissal
           * asked for then is refused by UIKit with its completion never run — so
           * `onDismiss` would never arrive and `returning` would be terminal. If the
           * entrance has not finished, the placement is recorded on the step and
           * `sheetShown` makes the move when it does.
           */
          /**
           * Functional, so a `sheetShown` that landed in the same batch is not undone.
           *
           * `stepRef` is updated in a parent effect and so lags a commit; writing the
           * object it holds straight back would discard a concurrent `shown: true` and
           * leave the run in `ranking` for ever — an empty sheet with no Close control,
           * over a dead picker. That is the freeze once more, reached through the state
           * added to prevent it (independent review).
           *
           * The ref is still right for the *subject*, which does not change for the life
           * of the step, and `setConfirmed` above is outside the updater — so this one
           * stays pure.
           */
          setStep((live) =>
            live.kind === 'ranking' ? leaveRankingFor({ ...live, placed: true }) : live,
          );
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
  /**
   * The bucket sheet is dismissing and the comparison sheet has not been asked for yet.
   *
   * **This state is the 2026-09-10 freeze fix and it exists for iOS's benefit alone.**
   * `bucket` and `ranking` are two different `<Modal>`s, so moving straight between them
   * unmounted one and mounted the other *in the same commit* — and UIKit cannot present a
   * view controller while it is still dismissing another from the same presenter. The
   * presentation is refused, React believes it succeeded, and the transparent window left
   * behind swallows every touch: the picker underneath draws correctly and is dead, which
   * is exactly what the founder photographed. Force-quitting clears it because the window
   * belongs to the process.
   *
   * Why the **first** title and not the others: `rank_start` "places it outright when its
   * band is empty" (`20260825000200`), so film one on a new account has no comparisons at
   * all. The comparison sheet presents and is dismissed again within one round trip,
   * while the bucket sheet's 300ms slide-out is still running. Films two to five are held
   * open by a person answering comparisons, so the dismissal has long finished.
   *
   * The subject is carried through so nothing has to be recomputed on the far side.
   */
  | { kind: 'handoff'; pick: TasteSubject; bucket?: BucketId }
  /**
   * The comparison sheet is up.
   *
   * `shown` and `placed` are both here because **the exit has to wait for the entrance**
   * (independent review). UIKit refuses a dismissal issued while the presentation is
   * still animating and never runs its completion — and the first title on a new account
   * has an empty band, so `rank_start` places it outright and the placement can land
   * inside the sheet's own 350ms appearance. Flipping `visible` there would ask for a
   * dismissal that never completes, `onDismiss` would never arrive, and `returning` would
   * be terminal: the freeze again, on the way out.
   *
   * So the run leaves for `returning` only once both are true, whichever order they
   * arrive in.
   */
  | { kind: 'ranking'; subject: RankingSubject; shown: boolean; placed: boolean }
  /**
   * The comparison sheet dismissing, with the picker already live behind it.
   *
   * The return half of `handoff`, and the second unserialised swap in this loop
   * (independent review). The comparison sheet used to dismiss by unmounting, so a poster
   * tapped inside its ~300ms slide-out presented the bucket sheet over a dismissing
   * controller — the same freeze, once per turn rather than once per run.
   *
   * Nothing is queued across it: the dismissing sheet's window still covers the screen,
   * so no poster is reachable until it is gone. What this state buys is the invariant
   * itself — the comparison sheet is never *unmounted while presented*, on the placement
   * path or on a dismissal mid-comparison.
   */
  | { kind: 'returning'; subject: RankingSubject };

/**
 * The comparison step for a title and the bucket it was just given.
 *
 * One function because two callers build it — iOS after the dismissal is acknowledged,
 * Android immediately — and two copies of a subject is how the two platforms would come
 * to rank slightly different things.
 */
const rankingStepFor = (from: { pick: TasteSubject; bucket: BucketId }): RunStep => ({
  kind: 'ranking',
  shown: false,
  placed: false,
  subject: {
    id: from.pick.id,
    title: from.pick.title,
    bucket: from.bucket,
    posterUri: from.pick.posterUri ?? null,
    kind: 'movie',
    mode: 'start',
  },
});

/**
 * Where a comparison step goes once something about it changes.
 *
 * It leaves for `returning` only when the sheet has both **appeared** and **been placed**,
 * whichever order those arrive in — see `RunStep`. Android never waits: it has no
 * presentation to serialise against, so a placement goes straight back to the picker.
 *
 * **Redundant with `Sheet`, deliberately.** The same rule is enforced in the primitive,
 * which holds the presentation rather than let a dismissal be asked for mid-entrance, so
 * dropping `step.shown` here changes nothing observable: an independent review proved it
 * by mutation, and no test can tell the two apart because at the Modal boundary there is
 * nothing to tell apart. It stays because this machine should be correct on its own terms
 * rather than correct because of what a component it renders happens to do internally.
 */
const leaveRankingFor = (step: Extract<RunStep, { kind: 'ranking' }>): RunStep => {
  if (!step.placed) return step;
  if (Platform.OS !== 'ios') return { kind: 'picking' };
  return step.shown ? { kind: 'returning', subject: step.subject } : step;
};

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
