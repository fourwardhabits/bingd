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
import { DiagnosticsSheet } from '@/features/diagnostics/DiagnosticsSheet';
import { diagnosticsAvailable } from '@/features/diagnostics/availability';
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
 * How long an exit will wait to know whether the notification question is owed, before
 * leaving without asking it.
 *
 * It bounds local reads that settle in milliseconds when the platform is healthy; the
 * bound is only ever felt on the hangs review 47 named, where the alternative is the
 * build-4 dead buttons. There was a second grace beside this one, for the completion
 * write — `finish` records why it is gone rather than shortened.
 */
const OFFER_DECISION_GRACE_MS = 3000;

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
  /**
   * That somebody has asked to leave — which the flow's own state stops being able to say.
   *
   * **This is the founder's build-4 "Explore For You put me back into Build your taste".**
   * `done` below is derived from `needed`, and `complete()` sets `needed: false`
   * *synchronously*, before its first await, deliberately — routing has to see the
   * decision immediately or it would send the person back here. The cost, which nothing
   * caught, is that this screen reads the same flag: the instant the button is pressed the
   * summary stops qualifying, so it unmounts and the **ranking step renders in its place**,
   * with `ranked` still 5 and the search box empty. That is where `5 of 5` and "The first
   * one needs no comparison." appear together — not a navigation backwards and not
   * contradictory state, but the wrong branch of this ternary drawn over the right one.
   *
   * Held for the rest of the mount, because there is no way back from an exit: the only
   * thing after it is the navigation.
   */
  const [exiting, setExiting] = useState(false);

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
  //
  // `|| exiting` is what keeps the summary on screen from the button press until the
  // navigation, rather than letting `complete()`'s synchronous write pull it out from
  // under the person who pressed it. See `exiting`.
  const done = ranked >= FIRST_FIVE && (state.data?.needed === true || exiting);

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
   * Finish the flow and go, in that order and without waiting in between.
   *
   * `complete` records the flow-ending decision **synchronously** — the intent map and
   * the query cache both, before its first await — and everything after that first await
   * is one best-effort SecureStore write that already swallows its own rejection. So by
   * the time this function has a promise in its hand there is nothing left worth waiting
   * for: routing already sees `needed: false`, and the disk is only how the decision
   * outlives the process.
   *
   * It used to wait anyway, bounded at three seconds. That bound was the right instinct
   * about the wrong thing — SecureStore really can hang, which is why review 47 put a
   * grace here — but bounding a wait nobody needs still spends up to three seconds of a
   * person's time between pressing "Explore For You" and arriving anywhere, on top of the
   * three the offer decision may already have spent. Six seconds of a screen that is not
   * responding to the button they pressed is most of what "the app is slow" meant.
   *
   * Not awaited, therefore, and deliberately not `await`-able: there is no outcome a
   * caller could act on.
   *
   * ---------------------------------------------------------------------------
   * **THE DURABILITY QUESTION, WHICH INDEPENDENT REVIEW 48 RAISED AND THIS ANSWERS**
   *
   * The objection: not awaiting means the `done`/`skipped` write can be lost, and a lost
   * `skipped` is an account offered the flow again — an onboarding loop, which is the
   * thing this whole tranche exists to remove.
   *
   * It does not follow, and the reason is *when* the write is dispatched rather than when
   * it resolves. `complete` is an async function whose body runs synchronously to its
   * first await, and that first await **is** the `writePref` call — so the Keychain write
   * has already been handed to the platform before `complete()` returns, which is before
   * the line below runs. Unmounting this screen does not cancel it; a native module call
   * is not tied to the React tree that started it.
   *
   * So awaiting would not make the write happen, it would only make *this screen* watch
   * it happen. The single case the two differ on is the process being killed inside that
   * window — and navigating is not something that kills a process. What awaiting reliably
   * did cost was up to three seconds of a screen not responding to the button somebody
   * had just pressed, on every exit, which is a defect the founder actually hit.
   *
   * The remaining exposure is a force-quit in the milliseconds between the dispatch and
   * the Keychain returning. That account reopens on the summary with its five films
   * intact, which is the documented resume behaviour rather than a loop.
   */
  const finish = ({ skipped, to }: { skipped: boolean; to: TabRoute }) => {
    void complete({ skipped });
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

  /**
   * The exit, which has one step in front of it.
   *
   * **Both ways out pass through the notification step**, and that is deliberate rather
   * than incidental: PRD §15 forbids asking at first launch and this is the last moment
   * before the app opens, so it is the one place the question can be put to *everybody*
   * exactly once. Routing it through here rather than hanging it off the summary means
   * the person who taps "Not now" on the films is offered it too — they are, if anything,
   * the reader most worth reaching later.
   *
   * `complete({ skipped })` is still called with the answer the *films* got. The
   * notification step has no bearing on whether taste onboarding was skipped, and folding
   * the two would make a flag about the collection mean something about a permission.
   *
   * (This paragraph sat above `finish` until now, which is not where any of it happens —
   * `finish` neither offers the step nor decides whether it is owed. Moved rather than
   * rewritten.)
   */
  const leave = async ({ skipped, to }: { skipped: boolean; to: TabRoute }) => {
    if (departing.current) return;
    departing.current = true;
    // Before the first await, so the summary is still the summary for the whole of the
    // offer decision below rather than only until `complete` writes. See `exiting`.
    setExiting(true);
    try {
      // Resolved now rather than on mount: the OS state can change while somebody is
      // ranking five films — they may have granted it from a system prompt elsewhere —
      // and an answer cached at the start of the flow would ask a question already
      // settled.
      if (await shouldOfferNotifications()) {
        setLeaving({ skipped, to });
        return;
      }
      finish({ skipped, to });
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
              Rank five films you have seen. bingd. learns from how they compare to each other,
              not from stars.
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
              {/* The copy follows the *count*, not the search box.
                  Both of these say the same thing — "type something" — but the first
                  one also says it is the first one, and this branch's only real
                  condition is that the field is empty. Somebody who has placed three
                  films and cleared the box was being told to start, and at five of five
                  the app was promising a comparison-free first pick underneath a
                  progress bar reading `5 of 5`. That pairing is what the founder
                  photographed on build 4 and reasonably read as contradictory state; the
                  branch was right and the sentence was a lie. */}
              <EmptyState
                kind="nothingYet"
                compact
                title={ranked === 0 ? 'Start with one you love' : 'Add another'}
                body={
                  ranked === 0
                    ? 'Anything you have ever seen. The first one needs no comparison.'
                    : 'Anything you have ever seen. bingd. will ask how it compares.'
                }
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
  // Owned here, like the one in Settings, and for the same reason: a sheet mounted
  // anywhere but inside the screen that opens it cannot be presented reliably. See
  // `DiagnosticsSheet`.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  return (
    <View style={styles.summary}>
      {/* The heading is the way in to Diagnostics from here, by long press.

          This screen is the one the founder cannot get past, and it is also the one
          Settings is unreachable from — `useAuthRouting` sends this account back here from
          any other group, so a route would be pushed and immediately replaced. A gesture on
          something already on screen is the only entrance that routing cannot take away.
          Beta and below only; the control is absent in a release build. */}
      <Text
        variant="title1"
        style={styles.centre}
        onLongPress={diagnosticsAvailable ? () => setDiagnosticsOpen(true) : undefined}
      >
        That is a start
      </Text>
      <Text variant="body" tone="secondary" style={styles.centre}>
        Five films is enough to rank against, so everything you log from here finds its place by
        comparison. For You gets better the more you add.
      </Text>

      <View style={styles.summaryActions}>
        <Button label="Explore For You" onPress={onExplore} />
        <Button label="See my collection" kind="secondary" onPress={onCollection} />
        {/* The summary is as far from Settings as the flow above it, and the build-4
            stranding happened exactly here — so the way out for a wrong account is
            offered on this branch too, under the real actions rather than beside them. */}
        <UseDifferentAccountButton />
      </View>

      {/* The same component Settings renders, with the same content. */}
      <DiagnosticsSheet visible={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
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
