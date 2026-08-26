import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile, UseDifferentAccountButton } from '@/features/auth';
import { LogSheet, type LoggableTitle, type PostRank } from '@/features/collection/LogSheet';
import {
  NotificationStep,
  shouldShowNotificationStep,
} from '@/features/onboarding/NotificationStep';
import { pushAlreadyOffered } from '@/features/notifications/push-permission';
import { TasteBucketSheet, type TasteSubject } from '@/features/onboarding/TasteBucketSheet';
import {
  FIRST_FIVE,
  useBeginTasteOnboarding,
  useCompleteTasteOnboarding,
  useTasteOnboarding,
} from '@/features/onboarding/use-taste-onboarding';
import { RankingSheet, type RankingSubject } from '@/features/ranking/RankingSheet';
import { useTitleSearch, yearOf, type SearchResult } from '@/features/search/use-title-search';
import { withGrace } from '@/lib/grace';
import { posterUri } from '@/lib/images';
import { TAB_ROUTES, type TabRoute } from '@/lib/routes';
import { theme } from '@/ui/tokens';
import {
  Button,
  EmptyState,
  LoadingScreen,
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
/**
 * How long an exit will wait to know whether the notification question is owed, and for
 * the completion write, before leaving anyway. Both bound local reads and writes that
 * settle in milliseconds when the platform is healthy; the bound is only ever felt on
 * the hangs review 47 named, where the alternative is the build-4 dead buttons.
 */
const OFFER_DECISION_GRACE_MS = 3000;
const COMPLETE_GRACE_MS = 3000;

export default function TasteOnboardingScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const [input, setInput] = useState('');
  const [choosing, setChoosing] = useState<TasteSubject | null>(null);
  /**
   * The title an open ranking is about, and what it scored — the two halves of the
   * post-rank log state. Kept beside the ranking rather than inside `RankingSubject`,
   * which is about a comparison and not about a log entry.
   *
   * Onboarding is films only (a series cannot be ranked, so offering one here would be
   * offering a dead end), which is why `kind` is a constant below rather than a field
   * this screen has to carry.
   */
  const [justRanked, setJustRanked] = useState<LoggableTitle | null>(null);
  const [logging, setLogging] = useState<LoggableTitle | null>(null);
  const [placement, setPlacement] = useState<PostRank | null>(null);
  const [ranking, setRanking] = useState<RankingSubject | null>(null);
  /**
   * The exit somebody has asked for, held while the notification step is on screen.
   *
   * The destination is captured rather than recomputed, because the two buttons on the
   * summary mean two different places — "Explore For You" and "See my collection" — and
   * the founder's device pass found exactly this kind of destination getting lost when a
   * helper decided it instead of the button. Null means no step is showing.
   */
  const [leaving, setLeaving] = useState<{ skipped: boolean; to: TabRoute } | null>(null);

  const state = useTasteOnboarding(profile.id);
  const complete = useCompleteTasteOnboarding(profile.id);
  const begin = useBeginTasteOnboarding(profile.id);
  const ranked = state.data?.ranked ?? 0;
  // A ref, not state: the effect below only needs it to avoid enrolling twice, and
  // setting state inside an effect is what `react-hooks/set-state-in-effect` forbids.
  // Nothing renders from it — `done` reads the answer instead.
  const settled = useRef(false);
  // `needed` is true for the whole of an active flow and false for an account that does
  // not belong here, so it distinguishes "five placed just now" from "twelve placed over
  // six months" without a second flag.
  const done = state.data?.needed === true && ranked >= FIRST_FIVE;

  /**
   * Enrol, or leave — the screen decides, because routing deliberately will not.
   *
   * Routing sends people here and never takes them away again, which is what stopped
   * the flow ejecting somebody after their first film. The cost, which independent
   * review found, is that *this screen* is now the only thing standing between an
   * established account and enrolment: someone opening `/onboarding/taste` from a deep
   * link used to be sent to the feed by routing, and would otherwise now be marked
   * `active` and held here until they ranked five films or declined.
   *
   * So `begin` is gated on the answer rather than on arrival. An account that does not
   * need the flow is sent on to the feed by the screen itself.
   */
  useEffect(() => {
    if (settled.current || !state.data) return;
    settled.current = true;

    if (!state.data.needed) {
      router.replace(TAB_ROUTES.feed);
      return;
    }

    void begin();
  }, [state.data, begin, router]);

  const { results, idle, isPending, isError, retry, providerSearching } = useTitleSearch(input);
  // Films only. A series cannot be ranked at all, so offering one here is offering a
  // dead end at the exact moment somebody is deciding whether this app works.
  const films = results.filter((result) => result.kind === 'movie');

  /**
   * Finish the flow and go somewhere, where *somewhere* is the caller's to name.
   *
   * It used to be `/(tabs)/feed` for both callers, which is the founder's device
   * defect: "Explore For You" is a sentence naming a destination, and it landed on the
   * Feed. The root cause is that the destination was baked into `leave` rather than
   * chosen by the button — one helper served two buttons that mean two different
   * things, and the one whose label makes a promise was the one silently broken.
   *
   * `to` is a route rather than a tab index for the reason `TAB_ROUTES` states: the
   * order of the tabs is a layout decision and this is a navigation one, and an index
   * would re-break this the next time the bar is reordered.
   */
  /**
   * The exit, which now has one step in front of it.
   *
   * **Both ways out pass through the notification step**, and that is deliberate rather
   * than incidental: PRD §15 forbids asking at first launch and this is the last moment
   * before the app opens, so it is the one place the question can be put to *everybody*
   * exactly once. Routing it through `leave` rather than hanging it off the summary means
   * the person who taps "Not now" on the films is offered it too — they are, if anything,
   * the reader most worth reaching later.
   *
   * `complete({ skipped })` is still called with the answer the *films* got. The
   * notification step has no bearing on whether taste onboarding was skipped, and folding
   * the two would make a flag about the collection mean something about a permission.
   */
  const finish = async ({ skipped, to }: { skipped: boolean; to: TabRoute }) => {
    // `complete` records the flow-ending decision synchronously — memory and query cache
    // both, before its first await — so navigating at the deadline is safe: routing
    // already sees `needed: false`, and only the disk write may still be in flight. The
    // bound exists because that write is SecureStore, which review 47 was right to call
    // a promise the platform may never settle; `withGrace` also absorbs a rejection, so
    // this cannot throw into the `void` press handler. Leaving wins, always.
    await withGrace(complete({ skipped }), COMPLETE_GRACE_MS, undefined);
    router.replace(to);
  };

  /**
   * Whether to put the notification question on the way out — and `false` whenever the
   * answer cannot be established *or cannot be established in time*. The build-4
   * stranding taught the rule: every await on this path runs between a button press and
   * the navigation it promised, so none of them may reject upward (the press would die
   * silently) and none may hold the exit — a SecureStore read or a permissions call
   * that never settles is the same trap as the one being fixed (review 47's first
   * blocker). Not being able to decide is not a reason to keep somebody out of the
   * app; the contextual primer remains for anyone the offer never reached.
   */
  const shouldOfferNotifications = () =>
    withGrace(
      (async () => shouldShowNotificationStep(await pushAlreadyOffered()))(),
      OFFER_DECISION_GRACE_MS,
      false,
    );

  // A ref, not state: it exists to make a second press during the checks a no-op, and
  // nothing renders from it. The summary's two buttons stay visually live — the checks
  // are quick — but two presses must not race two navigations.
  const departing = useRef(false);

  const leave = async ({ skipped, to }: { skipped: boolean; to: TabRoute }) => {
    if (departing.current) return;
    departing.current = true;
    try {
      // Resolved now rather than on mount: the OS state can change while somebody is
      // ranking five films — they may have granted it from a system prompt elsewhere —
      // and an answer cached at the start of the flow would ask a question already
      // settled.
      if (await shouldOfferNotifications()) {
        setLeaving({ skipped, to });
        return;
      }
      await finish({ skipped, to });
    } finally {
      departing.current = false;
    }
  };

  // Nothing until the answer arrives. Rendering the flow first and then deciding shows
  // "Build your taste" for a beat to somebody who is about to be sent to the feed —
  // which is the wrong first thing to say to an account that has been in use for months.
  if (!state.data) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingScreen />
      </Screen>
    );
  }

  /**
   * The last step, and it replaces the screen rather than covering it.
   *
   * A sheet was the obvious alternative and is wrong here: everything behind it is the
   * flow the reader has just finished, so a translucent view of five ranked films under
   * a permission question reads as an interruption of something still in progress. This
   * is the handoff, and it should look like one.
   */
  if (leaving) {
    return <NotificationStep onDone={() => void finish(leaving)} />;
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />

      {done ? (
        <Summary
          // The button says For You, so it goes to For You. The tab is the route
          // `recommendations` — the label on the bar and the name of the file have
          // never matched, which is most of how this went wrong in the first place.
          onExplore={() => void leave({ skipped: false, to: TAB_ROUTES.forYou })}
          onCollection={() => void leave({ skipped: false, to: TAB_ROUTES.collection })}
        />
      ) : (
        <>
          <View style={styles.intro}>
            <Text variant="title1">Build your taste</Text>
            <Text variant="body" tone="secondary">
              Rank five films you have seen. bingd. learns from how they compare to each
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
              action={{ label: 'Try again', onPress: retry }}
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
            {/* Declining is not exploring, so this one keeps the Feed it always had:
                somebody who would not rank five films is being put where the app has
                something to show them that is not about their own taste yet. */}
            <Button
              label="Not now"
              kind="tertiary"
              onPress={() => void leave({ skipped: true, to: TAB_ROUTES.feed })}
            />
            {/* This screen has no header and Settings is unreachable from it, so for
                the wrong account signed in on this phone it would otherwise be a locked
                room — see `UseDifferentAccountButton`. */}
            <UseDifferentAccountButton />
          </View>
        </>
      )}

      {/* The post-rank state, and nothing else: onboarding never opens this sheet to
          *log* something — the bucket is chosen in `TasteBucketSheet` and goes straight
          into comparisons — so there is no `onRank` to give it. It appears only once a
          ranking has finished and the reader asked to finish their log. */}
      <LogSheet
        title={logging}
        surface="onboarding"
        postRank={placement}
        onDone={() => {
          setLogging(null);
          setPlacement(null);
          setInput('');
          void state.refetch();
        }}
        onClose={() => {
          setLogging(null);
          setPlacement(null);
          setInput('');
          void state.refetch();
        }}
      />

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
          setJustRanked({
            id: choosing.id,
            title: choosing.title,
            year: choosing.year ?? null,
            posterUri: choosing.posterUri ?? null,
            kind: 'movie',
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
        /**
         * **The same post-rank state the rest of the app gets, and deliberately not a
         * cut-down one.**
         *
         * The temptation here is to leave onboarding out of it: five films in a row is
         * the funnel that decides whether somebody keeps the app, and a form after each
         * one sounds like friction. But the reveal still offers Rank another and Done
         * side by side, so the fast path costs exactly the taps it always did — and the
         * person ranking their fifth favourite film is the single most likely person in
         * the product to have something to say about it. Offering the composer to
         * everybody except them would be an odd place to draw the line.
         *
         * It is also the same `LogSheet`, which is the rule this pass is holding to:
         * one implementation of the rest of your log, not an onboarding copy of it that
         * drifts.
         */
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
        {/* The summary is as far from Settings as the flow above it, and the build-4
            stranding happened exactly here — so the way out for a wrong account is
            offered on this branch too, under the real actions rather than beside them. */}
        <UseDifferentAccountButton />
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
