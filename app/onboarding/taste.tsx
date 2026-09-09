import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useCurrentProfile, UseDifferentAccountButton } from '@/features/auth';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import { useRankedCollection } from '@/features/collection/use-collection';
import { bandSizes, formatScore, scoreFor } from '@/features/collection/score';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import {
  PICK_TARGET,
  hydratePicks,
  setPicks,
  usePicks,
  type PickedTitle,
} from '@/features/onboarding/pick-five';
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
 * Steps 6, 7 and 8: choose five movies, rank them, and see the order that came out.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
 *
 * **Changed: selection and ranking are two acts.** `Build your taste` is gone — it named
 * an abstraction over a concrete task — and so is the paragraph that screen needed to
 * explain itself. All five are chosen first, then all five are ranked. `pick-five.ts`
 * records the founder's reasoning in full.
 *
 * **Not changed: the ranking.** The run is the real `TasteBucketSheet` and the real
 * `RankingSheet`, driving the real `rank_start` / `rank_answer` session, exactly as
 * before. Nothing here re-implements a comparison, a band, a score or a placement, and
 * the reveal is the sheet's own. The orchestration moved; the engine did not.
 *
 * **Not changed: no watch date.** The first five may be movies somebody saw fifteen years
 * ago, and `set_bucket` writes no date, so they do not land in this year's Goals.
 * `TasteBucketSheet` explains the mechanics.
 *
 * **Not changed: movies only.** A series cannot be ranked and a season is two navigations
 * deep, so neither is offered at the moment somebody is deciding whether this app works.
 * The strings say *movie* throughout, which is the founder's settled terminology.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `phase` STATE VARIABLE
 *
 * The phase is **derived**, from two facts that already exist:
 *
 * | condition | phase |
 * |---|---|
 * | fewer than five chosen | the picker |
 * | five chosen, fewer than five ranked | the run |
 * | five ranked | Your First Five |
 *
 * This is the old screen's own principle — *progress is the data, not a counter* — kept
 * across a flow that now has three parts. It is also what makes a resume free: the
 * selection comes back from a preference, the count comes back from `rankings`, and the
 * screen somebody returns to is a consequence of those two rather than of a third piece of
 * state that could disagree with either.
 *
 * A stored counter would disagree the first time a placement failed. The count cannot: a
 * ranking that did not commit leaves the number where it was, which is the truth.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE RUN OPENS ITS SHEETS WITHOUT AN EFFECT
 *
 * `TasteBucketSheet` renders nothing for a null subject, so the current title *is* the
 * subject whenever the run is live and no comparison is already open over it. No
 * `useEffect` opens a sheet, which means there is no window in which the run has advanced
 * but the sheet has not caught up, and no dependency array that could open one twice.
 */
export default function TasteOnboardingScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const { width } = useWindowDimensions();

  const state = useTasteOnboarding(profile.id);
  const begin = useBeginTasteOnboarding(profile.id);


  const chosen = usePicks(profile.id);
  /** False until the stored selection has been read, so the grid is not drawn empty first. */
  const [picksReady, setPicksReady] = useState(false);
  /** Whether the reader has pressed `Rank these 5`. See `running` below. */
  const [runStarted, setRunStarted] = useState(false);

  const [input, setInput] = useState('');
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  const [justRanked, setJustRanked] = useState<LoggableTitle | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);

  useEffect(() => {
    let active = true;
    void hydratePicks(profile.id).then(() => {
      if (active) setPicksReady(true);
    });
    return () => {
      active = false;
    };
  }, [profile.id]);

  /**
   * Enrol, or leave — the screen decides, because routing deliberately will not.
   *
   * Unchanged in substance from the old flow. Routing sends people into the group and
   * never takes them out, so this screen is the only thing standing between an established
   * account that reached `/onboarding/taste` from a deep link and being marked `active`
   * and held here.
   *
   * `begin` is also called by the motivation step, which is where the flow really starts
   * now. Calling it twice is free and intended: its whole design is a pair of guards that
   * refuse to write over a decision already taken, in memory or on disk.
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
  const trending = useTrending();
  /**
   * The account's ranked movies, which the run reads for its cursor and the payoff reads
   * for its order. One query serving both, and it is the same one the reveal already
   * warms: `apply` invalidates this key on every placement, so it follows the run without
   * anything here asking it to.
   */
  const rankedMovies = useRankedCollection(profile.id, 'movies');

  // Movies only, on every source this screen reads.
  const films = results.filter((result) => result.kind === 'movie');

  /**
   * Five chosen is not five *committed*, and the difference is one press.
   *
   * `Rank these 5` has to mean something. Deriving the run from the selection alone would
   * start the first comparison the instant the fifth poster was tapped, which is the
   * interleaving the two-phase design exists to remove — and it would do it without
   * warning, over a grid the reader was still looking at.
   *
   * `placed > 0` stands in for the press on a resume: somebody with placements already
   * made has plainly begun, and asking them to press it again would be the flow having
   * forgotten what it watched them do.
   */
  /**
   * **Which of the chosen five are actually placed**, read from the rankings themselves.
   *
   * This used to be the global ranked *count*, and independent review found what that
   * costs. The count is a fact about the account, not about this selection, and the two
   * come apart the moment the selection is lost: if the `pickFive` write fails after two
   * movies are ranked, the picker comes back empty, the reader chooses five *different*
   * movies, and a cursor of `chosen[2]` then silently skips the first two of the new five.
   * With all five previously ranked it was worse — any new selection satisfied the payoff
   * immediately and none of it was ever ranked.
   *
   * Membership cannot drift like that. It asks the only question that matters — *has this
   * particular movie been placed* — so a lost selection costs a re-selection and nothing
   * else, which is what `pick-five.ts` promises. It costs no extra request either: the
   * payoff already reads this list, and the ranking sheet invalidates its key on every
   * placement.
   */
  const placedIds = new Set((rankedMovies.data ?? []).map((entry) => entry.mediaItemId));
  const placed = chosen.filter((pick) => placedIds.has(pick.id)).length;

  const full = chosen.length >= PICK_TARGET;
  const payoff = full && placed >= PICK_TARGET;
  // `placed > 0` stands in for the press on a resume, and it is now specifically *these*
  // movies having been placed rather than any movie at all.
  const running = full && !payoff && (runStarted || placed > 0);
  const picking = !running && !payoff;

  /**
   * Which of the five is being ranked: the first one that has not been placed.
   *
   * The run walks them in the order they were chosen. A placement that failed leaves the
   * movie unplaced and it simply comes up again, which is correct and needs no code of its
   * own — and unlike an index, this cannot point at the wrong movie when the selection and
   * the ranking history disagree.
   */
  const current = running ? (chosen.find((pick) => !placedIds.has(pick.id)) ?? null) : null;

  const toggle = (title: PickedTitle) => {
    if (chosen.some((pick) => pick.id === title.id)) {
      void setPicks(
        profile.id,
        chosen.filter((pick) => pick.id !== title.id),
      );
      return;
    }
    // A sixth is not an error and not a replacement: the remaining cells have gone quiet
    // and the primary is live, so there is nothing sensible another tap could mean.
    if (chosen.length >= PICK_TARGET) return;
    void setPicks(profile.id, [...chosen, title]);
    setInput('');
  };

  const startRun = () => {
    track({ name: 'onboarding_step_completed', props: { step: 'pick', outcome: 'continued' } });
    setRunStarted(true);
  };

  const leavePayoff = () => {
    track({ name: 'onboarding_step_completed', props: { step: 'payoff', outcome: 'continued' } });
    advance('people');
    router.replace('/onboarding/people');
  };

  // Nothing until both answers are in. Drawing the picker first and then deciding shows the
  // grid for a beat to somebody who is about to be sent to the feed, which is the wrong
  // first thing to say to an account that has been in use for months.
  // The ranked list is waited on with the other two: without it `placedIds` is empty on
  // the first frame, and a resumed run would draw the picker for a beat before correcting
  // itself. For a genuinely new account it resolves empty and costs nothing.
  if (!state.data || !picksReady || rankedMovies.isPending) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingScreen />
      </Screen>
    );
  }

  const selectedIds = new Set(chosen.map((pick) => pick.id));
  const starters = (trending.data?.items ?? []).filter((item) => item.kind === 'movie');
  const tileWidth = Math.floor(
    (width - theme.layout.gutter * 2 - theme.layout.posterGrid.gap * 2) / 3,
  );

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <OnboardingHeader step={payoff ? 'payoff' : picking ? 'pick' : 'rank'} />

      {payoff ? (
        <FirstFive onContinue={leavePayoff} />
      ) : running ? (
        <RunBackdrop placed={placed} />
      ) : (
        <>
          <View style={styles.intro}>
            <Text variant="title1">Get started</Text>
            <Text variant="body" tone="secondary">
              Pick five movies you&apos;ve seen.
            </Text>
            <Progress chosen={chosen.length} />
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

          {idle ? (
            /**
             * The grid, which is load-bearing rather than decorative.
             *
             * Choosing five before ranking any of them needs something to choose *from*,
             * and a bare instruction over an empty search box asks the reader to already
             * know what they want. These are the movies TMDB is featuring today, read out
             * of `provider_list_cache` — one `select`, no provider quota, and real
             * catalogue ids, so a tap goes into the same bucket sheet a search result
             * would.
             *
             * **It is a starting point for the search field and claims nothing more.**
             * Trending is what is popular now, not what this reader has seen, and the
             * screen never says otherwise: the instruction above is the task, and the grid
             * is simply the first place to look.
             */
            <ScrollView
              contentContainerStyle={styles.grid}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            >
              {starters.length === 0 ? (
                <View style={styles.status}>
                  <Text variant="body" tone="tertiary">
                    Search for a movie you have seen.
                  </Text>
                </View>
              ) : (
                starters.map((item) => (
                  <PickTile
                    key={item.mediaItemId}
                    width={tileWidth}
                    title={item.title}
                    posterUri={posterUri(item.posterPath, 'card')}
                    selected={selectedIds.has(item.mediaItemId)}
                    // At five the rest go quiet: they are not removed, because a grid that
                    // shrank as it was used would move the tile under the reader's thumb,
                    // and they are not tappable, because nothing a sixth tap could mean is
                    // honest.
                    quiet={full && !selectedIds.has(item.mediaItemId)}
                    onPress={() =>
                      toggle({
                        id: item.mediaItemId,
                        title: item.title,
                        year: item.year,
                        posterUri: posterUri(item.posterPath, 'card'),
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
                    toggle({
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
            <Button
              label={`Rank these ${PICK_TARGET}`}
              onPress={startRun}
              disabled={chosen.length < PICK_TARGET}
            />
            {/**
             * **The way out, kept.**
             *
             * The founder's flow does not draw one, and every other step can be left, so
             * the picker is the only screen that could hold somebody indefinitely: five is
             * a hard requirement to reach the next control. The old screen carried this
             * button with a comment that has not stopped being true — *somebody who cannot
             * think of five movies they have seen must not be held on this screen forever*
             * — and that is a stranding this codebase has already paid for once.
             *
             * So it stays, and it is quiet: last in the footer, tertiary, and offered under
             * the action that makes the app work rather than beside it. It skips to the
             * People step rather than out of onboarding, because leaving the ranking is not
             * the same as leaving the flow, and the social half still has something to
             * offer somebody who declined the first half.
             */}
            <Button
              label="Not now"
              kind="tertiary"
              onPress={() => {
                track({
                  name: 'onboarding_step_completed',
                  props: { step: 'pick', outcome: 'skipped' },
                });
                advance('people');
                router.replace('/onboarding/people');
              }}
            />
            {/* This screen has no header and Settings is unreachable from it, so for the
                wrong account signed in on this phone it would otherwise be a locked room.
                See `UseDifferentAccountButton`. */}
            <UseDifferentAccountButton />
          </View>
        </>
      )}

      {/* The post-rank state, and nothing else: onboarding never opens this sheet to *log*
          something, so there is no `onRank` to give it. */}
      <LogSheet
        title={logging}
        surface="onboarding"
        postRank={placement}
        onDone={() => {
          setLogging(null);
          setPlacement(null);
          void state.refetch();
        }}
        onClose={() => {
          setLogging(null);
          setPlacement(null);
          void state.refetch();
        }}
      />

      <TasteBucketSheet
        // The current title *is* the subject while the run is live, unless a comparison is
        // already open over it. No effect opens this sheet. See the header.
        subject={ranking ? null : toSubject(current)}
        // Dismissing the bucket question leaves the run where it is: the same title comes
        // back, because `ranked` did not move.
        onClose={() => setRanking(null)}
        onChosen={(bucket) => {
          if (!current) return;
          setRanking({
            id: current.id,
            title: current.title,
            bucket,
            posterUri: current.posterUri,
            kind: 'movie',
            mode: 'start',
          });
          setJustRanked({
            id: current.id,
            title: current.title,
            year: current.year,
            posterUri: current.posterUri,
            kind: 'movie',
          });
        }}
      />

      <RankingSheet
        subject={ranking}
        onClose={() => {
          setRanking(null);
          // The count is the progress, so it is re-read rather than incremented. When it
          // moves, the next title becomes the bucket sheet's subject on the same render.
          void state.refetch();
        }}
        onFinishLog={(result) => {
          setRanking(null);
          if (!justRanked) return;
          setPlacement(result);
          setLogging(justRanked);
        }}
        surface="onboarding"
      />
    </Screen>
  );
}

const toSubject = (pick: PickedTitle | null): TasteSubject | null =>
  pick ? { id: pick.id, title: pick.title, year: pick.year, posterUri: pick.posterUri } : null;

/** Five dots and a count, not a percentage. The number is small enough to count. */
function Progress({ chosen }: { chosen: number }) {
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel={`${chosen} of ${PICK_TARGET} movies chosen`}
    >
      {Array.from({ length: PICK_TARGET }, (_, index) => (
        <View key={index} style={[styles.pip, index < chosen ? styles.pipDone : styles.pipTodo]} />
      ))}
      <Text variant="footnote" tone="secondary" style={styles.progressLabel}>
        {`${chosen} of ${PICK_TARGET}`}
      </Text>
    </View>
  );
}

/**
 * One poster in the grid, selectable.
 *
 * **A check and never a number.** A badge reading 1 to 5 while somebody is choosing would
 * state an order they have not chosen: selection order is not the ranking, and the ranking
 * is precisely what the next step exists to work out. The ring is Maroon and the check is
 * neutral, for the same reason.
 *
 * The state is spoken by `accessibilityState.checked`; the ring and the tick are how the
 * same fact is said to everybody else.
 */
function PickTile({
  width,
  title,
  posterUri: uri,
  selected,
  quiet,
  onPress,
}: {
  width: number;
  title: string;
  posterUri: string | null;
  selected: boolean;
  quiet: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={quiet}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: quiet }}
      accessibilityLabel={title}
      style={[{ width }, styles.tile, quiet && styles.tileQuiet]}
    >
      <View style={[styles.tileFrame, selected && styles.tileSelected]}>
        <Poster uri={uri} title={title} width={width} />
      </View>
      {selected ? (
        <View style={styles.tileCheck} accessibilityElementsHidden importantForAccessibility="no">
          <Ionicons name="checkmark-circle" size={22} color={theme.semantic.score} />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * What sits behind the run's sheets.
 *
 * Deliberately almost nothing. The sheets are the screen for the whole of step 7, and
 * anything drawn under them competes with the question being asked on top. What it does
 * say is how far along the run is, because the sheets cannot: a comparison is about two
 * movies and has no idea it is the fourth of five.
 */
function RunBackdrop({ placed }: { placed: number }) {
  return (
    <View style={styles.run}>
      {/* One interpolated string rather than text beside an expression: React Native
          renders the latter as two text nodes, which reads identically and is not
          findable by the sentence it spells. */}
      <Text variant="title1" style={styles.centre}>
        {`Ranking your ${PICK_TARGET}`}
      </Text>
      <Text variant="body" tone="secondary" style={styles.centre}>
        One quick comparison at a time.
      </Text>
      <Progress chosen={placed} />
    </View>
  );
}

/**
 * Step 8: Your First Five.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE PAYOFF
 *
 * The ordinal leads the row and the score follows it, one size down. Both are present and
 * there is no doubt which one the screen is about.
 *
 * **The scores are the real arithmetic**, `scoreFor` over `bandSizes`, which is the same
 * function the reveal and the collection use. Nothing is recomputed with a second model:
 * four movies in the loved band land on 10.0, 9.0, 8.0 and 7.0 because the band runs 10 to
 * 7 and the score interpolates across it.
 *
 * **Nothing here explains the algorithm.** The score is explained once, under the first
 * reveal. A second explanation on the payoff would turn a reward into a lesson.
 *
 * One primary action. There is no competing *Explore For You* or *Find people*: this is
 * still onboarding, and a fork at the payoff is exactly what made the social half optional
 * in the first place.
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
  tileQuiet: { opacity: 0.4 },
  tileFrame: { borderRadius: theme.radius.control, borderWidth: 2, borderColor: 'transparent' },
  tileSelected: { borderColor: theme.semantic.score },
  tileCheck: { position: 'absolute', top: theme.space[1], right: theme.space[1] },
  status: { padding: theme.layout.gutter, gap: theme.space[3] },
  results: { paddingBottom: theme.space[8] },
  run: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.space[3] },
  centre: { textAlign: 'center' },
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
