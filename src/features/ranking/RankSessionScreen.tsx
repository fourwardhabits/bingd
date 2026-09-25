import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import type { RankingCategory } from '@/features/collection/use-collection';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { useOperationIntent } from '@/lib/operation-intent';
import { BucketChoices, Button, Poster, Screen, Text, type BucketId } from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  atBacklogCheckpoint,
  backlogProgress,
  finalizeBatchRanking,
  noteBatchRanking,
  rankBacklogStart,
  rankingBacklog,
  type BacklogTarget,
} from './backlog';
import { refineCandidates } from './refine';
import { RefineScreen } from './RefineScreen';
import {
  RankedSummary,
  rankedHeading,
  SessionHeader,
  type RankedSummaryTitle,
} from './RankedSummary';
import { Comparison as ComparisonView, SkipTitleLink } from './RankingSheet';
import { outcomeUnknown, rankAnswer, rankBack, rankSkip, type SessionStep } from './session';
import { seedPivotCard } from './pivot-card';

export type RankSessionSource = 'backlog' | 'refine';

/**
 * **One ranking session, two sources** (unified Backlog + Refine, founder-approved
 * 2026-09-21). `app/rank-session.tsx` opens it as `?medium=…&start=backlog|refine`.
 *
 *   backlog  titles seen and not yet ranked, one at a time — incomplete native
 *            placements first, straight back into their comparisons; otherwise "How was
 *            it?" and then the comparisons (`BacklogSession`).
 *   refine   titles already ranked whose evidence is thin (`RefineScreen`, T5).
 *
 * Both run the same comparison view over the same `rank_*` calls; there is no second
 * ranking algorithm. A backlog sitting that empties the queue may offer Refine — only on
 * an explicit tap, and only when the server says the batch is worth it.
 */
export function RankSessionScreen({
  medium,
  start,
  onExit,
}: {
  medium: RankingCategory;
  start: RankSessionSource;
  onExit: () => void;
}) {
  const [source, setSource] = useState<RankSessionSource>(start);
  return source === 'refine' ? (
    <RefineScreen medium={medium} onExit={onExit} />
  ) : (
    <BacklogSession medium={medium} onExit={onExit} onRefine={() => setSource('refine')} />
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ask'; target: BacklogTarget }
  | {
      kind: 'comparing';
      target: BacklogTarget;
      step: Extract<SessionStep, { state: 'comparing' }>;
    }
  | { kind: 'checkpoint' }
  /**
   * **The payoff** (founder addendum, 2026-09-24), reached two ways and no others: the
   * reader taps Done, or the queue runs out. `remaining` is what the backlog still held
   * at that moment, which decides whether the foot offers Keep ranking or the caught-up
   * transition — a sitting ended early must not claim the backlog is finished.
   */
  | { kind: 'summary'; remaining: boolean; offerRefine: boolean }
  | { kind: 'caughtUp'; offerRefine: boolean }
  | { kind: 'failed'; target: BacklogTarget | null; message: string; changed: boolean };

/**
 * A backlog sitting (unified design §2, §7; founder decisions 3 and 4).
 *
 * - **Progress is exact here** — "7 of 18 ranked", the total fixed when the sitting began —
 *   because the reader chose to start the job from Unranked. (The Watched card never
 *   names a count.)
 * - **Skip and Done are always there.** Skip lasts for this sitting only.
 * - **A soft checkpoint** after every ten placed (`ranking.backlog_checkpoint`): "10 titles
 *   ranked." with Keep going and Done. Not a limit: Keep going carries on.
 * - **Closing keeps what was answered.** A placement left mid-comparison stays open on
 *   the server (#196's first-placement rule), so + / Rank or the next sitting resumes it.
 * - **Nothing here posts to the feed** — the server opens backlog placements silently.
 */
function BacklogSession({
  medium,
  onExit,
  onRefine,
}: {
  medium: RankingCategory;
  onExit: () => void;
  onRefine: () => void;
}) {
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const withIntent = useOperationIntent();
  const analyticsMedium = medium === 'movies' ? 'movies' : 'tv';
  const mediaKind = medium === 'movies' ? 'movie' : 'tv_season';

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [placed, setPlaced] = useState(0);
  const placedRef = useRef(0);
  /** Fixed at the first read, so "7 of 18" counts toward a number that does not move. */
  const [total, setTotal] = useState<number | null>(null);
  /**
   * What this sitting placed, for the summary. Only titles whose placement **completed**
   * — a skip never reaches `onPlaced`, and a title abandoned mid-comparison stays an
   * open server session rather than a finished one, so neither can appear here.
   */
  const [ranked, setRanked] = useState<RankedSummaryTitle[]>([]);
  /**
   * **This sitting, for the feed** (founder, 2026-09-24). Minted once when the screen
   * opens and passed with every completed placement, so the server can group them into
   * one post. A later sitting is a later uuid and a second post, which is the whole of
   * the grouping rule — no time windows.
   */
  const [sitting] = useState(() => Crypto.randomUUID());
  const skipped = useRef<string[]>([]);
  const checkpointEvery = useRef(10);
  const answers = useRef(0);
  const skips = useRef(0);
  const ended = useRef(false);
  /**
   * `open`, reached from `loadNext` — whose own result loops back into it, because a
   * placement deals the next title. Read through a ref so the two need not depend on each
   * other; it is reassigned every render, so it is always the current one.
   */
  const openRef = useRef<(target: BacklogTarget, bucket: BucketId | null) => Promise<void>>(
    async () => {},
  );

  const endSitting = useCallback(
    (endedBy: 'done' | 'caught_up' | 'close') => {
      if (ended.current) return;
      ended.current = true;
      track({
        name: 'backlog_session_ended',
        props: {
          placed: placedRef.current,
          skipped: skipped.current.length,
          ended_by: endedBy,
          medium: analyticsMedium,
        },
      });
      /**
       * **The sitting ends here, and so does its draft** (2026-09-25). `endSitting` is the
       * one place every deliberate exit passes through — Done, the queue emptying, Close —
       * so publishing from it means the post appears exactly when the reader stopped, and
       * on no other path. A force-kill never reaches this and publishes nothing, which is
       * the accepted trade rather than an oversight.
       */
      void finalizeBatchRanking(sitting);
      void queryClient.invalidateQueries({ queryKey: ['ranking-backlog', profile.id] });
      void queryClient.invalidateQueries({ queryKey: ['refine-availability', profile.id] });
    },
    [analyticsMedium, profile.id, queryClient, sitting],
  );

  const caughtUp = useCallback(async () => {
    let offerRefine = false;
    try {
      const refine = await refineCandidates(medium, { limit: 1 });
      offerRefine = refine.status === 'ready' && refine.cta.show;
    } catch {
      offerRefine = false;
    }
    /**
     * A reader who placed nothing gets the plain caught-up screen: a summary of zero
     * titles is a page that says "you did nothing", which is worse than the sentence.
     */
    if (placedRef.current > 0) setPhase({ kind: 'summary', remaining: false, offerRefine });
    else setPhase({ kind: 'caughtUp', offerRefine });
  }, [medium]);

  const loadNext = useCallback(async () => {
    setPhase({ kind: 'loading' });
    answers.current = 0;
    skips.current = 0;
    let found;
    try {
      found = await rankingBacklog(medium, { limit: 1, skip: skipped.current });
    } catch {
      setPhase({
        kind: 'failed',
        target: null,
        message: 'Check your connection and try again.',
        changed: false,
      });
      return;
    }
    checkpointEvery.current = found.checkpointEvery;
    setTotal((current) => current ?? found.total);
    const target = found.targets[0];
    if (found.status !== 'ready' || !target) {
      await caughtUp();
      return;
    }
    if (target.bucket) {
      // A bucket chosen in bingd, or a session left open: no "How was it?" again.
      void openRef.current(target, null);
    } else {
      setPhase({ kind: 'ask', target });
    }
  }, [caughtUp, medium]);

  const onPlaced = useCallback(
    (target: BacklogTarget, step: Extract<SessionStep, { state: 'placed' }>) => {
      placedRef.current += 1;
      setPlaced(placedRef.current);
      setRanked((was) => [
        ...was,
        {
          mediaItemId: target.mediaItemId,
          title: target.title,
          posterPath: target.posterPath,
          position: step.position,
          score: step.score,
          bucket: step.bucket,
        },
      ]);
      invalidateAfterCollectionChange(queryClient, profile.id, target.mediaItemId, {
        category: step.category,
      });
      // The sitting's one grouped story, extended by each completed placement. Never a
      // watch, and never called from Refine or the ordinary single-title flow.
      void noteBatchRanking(sitting, target.mediaItemId);
      track({
        name: 'ranking_completed',
        props: {
          media_kind: mediaKind,
          surface: 'collection',
          comparisons: answers.current,
          rebucket: false,
          mode: 'backlog',
          skips: skips.current,
        },
      });
      if (atBacklogCheckpoint(placedRef.current, checkpointEvery.current)) {
        setPhase({ kind: 'checkpoint' });
      } else {
        void loadNext();
      }
    },
    [loadNext, mediaKind, profile.id, queryClient, sitting],
  );

  const applyStep = useCallback(
    (target: BacklogTarget, next: SessionStep) => {
      if (next.state === 'comparing') {
        // The card, from the answer where there is one and from the reader's own band at
        // the start of a session, where `rank_start` sends none. See `seedPivotCard`.
        seedPivotCard(queryClient, profile.id, next);
        setPhase({ kind: 'comparing', target, step: next });
      } else if (next.state === 'placed') {
        onPlaced(target, next);
      } else if (next.state === 'ended') {
        // Undo at the first comparison closed the session. The bucket stays (it is the
        // reader's), so the title is an incomplete placement for another sitting.
        skipped.current = [...skipped.current, target.mediaItemId];
        void loadNext();
      } else {
        setPhase({
          kind: 'failed',
          target,
          message: next.message,
          changed: Boolean(next.changed),
        });
      }
    },
    [loadNext, onPlaced, profile.id, queryClient],
  );

  async function open(target: BacklogTarget, bucket: BucketId | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let next: SessionStep;
    try {
      next = await withIntent(
        `backlog:start:${target.mediaItemId}:${bucket ?? 'chosen'}`,
        (op) => rankBacklogStart(target.mediaItemId, bucket, op),
        outcomeUnknown,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (next.state === 'comparing' || next.state === 'placed') {
      track({
        name: 'ranking_started',
        props: { media_kind: mediaKind, surface: 'collection', mode: 'backlog' },
      });
    }
    applyStep(target, next);
  }

  // Declared before the effect below that deals the first title, so it runs first.
  useEffect(() => {
    openRef.current = open;
  });

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void loadNext();
  }, [loadNext]);

  /** One step in flight, decided synchronously — the RankingSheet rule (2026-09-16). */
  const act = async (
    target: BacklogTarget,
    run: () => Promise<SessionStep>,
    progress: number,
    skip = false,
  ) => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let next: SessionStep;
    try {
      next = await run();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (next.state !== 'failed') {
      answers.current = Math.max(0, answers.current + progress);
      if (skip) skips.current += 1;
    }
    applyStep(target, next);
  };

  const skipTitle = (target: BacklogTarget) => {
    // Only this sitting. An open session is left as it is, answers and all.
    skipped.current = [...skipped.current, target.mediaItemId];
    void loadNext();
  };

  const close = () => {
    endSitting(phase.kind === 'caughtUp' ? 'caught_up' : 'close');
    onExit();
  };

  const done = (endedBy: 'done' | 'caught_up') => {
    endSitting(endedBy);
    onExit();
  };

  /**
   * **Done, from the header** (founder addendum, 2026-09-24).
   *
   * Ends the sitting and shows what it placed. Everything the reader answered is already
   * on the server — each placement committed as it finished — so this writes nothing and
   * cancels nothing: a title left mid-comparison stays an open session and resumes, which
   * is the existing rule and the reason Done is safe to offer at any moment.
   *
   * **Nothing placed, nothing to show.** Done before a single title finished exits
   * exactly as it always did, rather than presenting an empty list as an achievement.
   *
   * What is left is *asked*, not inferred from the count this sitting started with: a
   * reader may have ranked elsewhere since, and a summary that says the queue is finished
   * when it is not is the one wrong thing this screen could say. An unknown answer is
   * treated as "there is more", because that offers Keep ranking rather than falsely
   * claiming completion.
   */
  const finishSitting = async () => {
    if (placedRef.current === 0) {
      done('done');
      return;
    }
    let remaining = true;
    let offerRefine = false;
    try {
      const left = await rankingBacklog(medium, { limit: 1, skip: skipped.current });
      remaining = left.status === 'ready' && left.targets.length > 0;
    } catch {
      remaining = true;
    }
    if (!remaining) {
      try {
        const refine = await refineCandidates(medium, { limit: 1 });
        offerRefine = refine.status === 'ready' && refine.cta.show;
      } catch {
        offerRefine = false;
      }
    }
    setPhase({ kind: 'summary', remaining, offerRefine });
  };

  const target =
    phase.kind === 'ask' || phase.kind === 'comparing' || phase.kind === 'failed'
      ? phase.target
      : null;

  return (
    <Screen includeBottomInset>
      {/* The summary draws its own foot; a Done in the header there would be two. */}
      {phase.kind === 'summary' ? null : (
        <SessionHeader
          title={`Rank · ${medium === 'movies' ? 'Movies' : 'TV'}`}
          progress={
            total !== null && total > 0 ? (
              <Text variant="footnote" tone="secondary" testID="backlog-progress">
                {backlogProgress(placed, total)}
              </Text>
            ) : null
          }
          // Only while there is ranking to leave. Every terminal phase draws its own.
          onDone={
            phase.kind === 'ask' || phase.kind === 'comparing' || phase.kind === 'loading'
              ? () => void finishSitting()
              : undefined
          }
        />
      )}

      {phase.kind === 'loading' ? (
        <Centred>
          <Text variant="body" tone="tertiary" style={styles.centre}>
            Finding the next title…
          </Text>
        </Centred>
      ) : phase.kind === 'ask' ? (
        <Centred>
          {/**
           * **The poster stays** (founder QA, 2026-09-22). Without it this read as a
           * different flow from the comparison that follows, where two posters are the
           * whole screen. One `Poster`, the same component and treatment the comparison
           * cards use, then the title, then the question — so bucketing is visibly one
           * state of the same ranking flow rather than a form in front of it.
           */}
          {/**
           * **The same rhythm as the comparison** (founder QA, 2026-09-22): question at
           * the top, poster under it, name under the poster. The comparison screen reads
           * *Which did you like more?* over two `md` posters with their names beneath; this
           * is that screen with one card instead of two, so nothing jumps vertically when
           * the reader answers and the pair slides in.
           */}
          <Text variant="headline" style={styles.centre} accessibilityRole="header">
            How was it?
          </Text>
          <View style={styles.askPoster} testID="backlog-ask-poster">
            <Poster
              uri={posterUri(phase.target.posterPath, 'card')}
              title={phase.target.title}
              size="md"
            />
            <Text variant="callout" style={styles.centre} numberOfLines={2}>
              {phase.target.title}
            </Text>
          </View>
          <BucketChoices
            selected={null}
            onSelect={(bucket) => void open(phase.target, bucket)}
            testID="backlog-bucket-choices"
          />
          <SkipTitleLink
            title={phase.target.title}
            disabled={busy}
            hint="Leaves it unranked for now. It stays in Unranked."
            onPress={() => skipTitle(phase.target)}
          />
        </Centred>
      ) : phase.kind === 'comparing' ? (
        <View style={styles.body}>
          <ComparisonView
            subject={{
              id: phase.target.mediaItemId,
              title: phase.target.title,
              posterUri: posterUri(phase.target.posterPath, 'card'),
              kind: phase.target.kind,
            }}
            pivotId={phase.step.pivotId}
            skipped={phase.step.skipped}
            busy={busy}
            surface="collection"
            topBar={false}
            onClose={close}
            onPick={(winnerId) =>
              void act(
                phase.target,
                () =>
                  withIntent(
                    `answer:${phase.step.sessionId}:${winnerId}`,
                    (op) =>
                      rankAnswer(phase.step.sessionId, winnerId, phase.target.mediaItemId, op),
                    outcomeUnknown,
                  ),
                1,
              )
            }
            onBack={() =>
              void act(
                phase.target,
                () =>
                  withIntent(
                    `back:${phase.step.sessionId}:${phase.step.pivotId}`,
                    (op) => rankBack(phase.step.sessionId, phase.target.mediaItemId, op),
                    outcomeUnknown,
                  ),
                -1,
              )
            }
            onSkip={() =>
              void act(
                phase.target,
                () =>
                  withIntent(
                    `skip:${phase.step.sessionId}:${phase.step.pivotId}`,
                    (op) => rankSkip(phase.step.sessionId, phase.target.mediaItemId, op),
                    outcomeUnknown,
                  ),
                0,
                true,
              )
            }
          />
          <SkipTitleLink
            title={phase.target.title}
            disabled={busy}
            side
            hint="Leaves it unranked for now. It stays in Unranked."
            onPress={() => skipTitle(phase.target)}
          />
        </View>
      ) : phase.kind === 'checkpoint' ? (
        <Centred>
          <Text variant="title2" style={styles.centre}>
            {placed === 1 ? '1 title ranked.' : `${placed} titles ranked.`}
          </Text>
          <Button label="Keep going" onPress={() => void loadNext()} />
          <Button label="Done" kind="secondary" onPress={() => done('done')} />
        </Centred>
      ) : phase.kind === 'summary' ? (
        <RankedSummary
          heading={rankedHeading(ranked.length, 'ranked')}
          titles={ranked}
          medium={medium}
          actions={
            <>
              <Button label="Done" onPress={() => done(phase.remaining ? 'done' : 'caught_up')} />
              {phase.remaining ? (
                /* The same queue, not a new one: `loadNext` reads the server again with
                   this sitting's skips still applied, so nothing is dealt twice. */
                <Button label="Keep ranking" kind="secondary" onPress={() => void loadNext()} />
              ) : phase.offerRefine ? (
                <Button
                  label="Refine a few rankings"
                  kind="secondary"
                  onPress={() => {
                    endSitting('caught_up');
                    onRefine();
                  }}
                />
              ) : null}
            </>
          }
        />
      ) : phase.kind === 'caughtUp' ? (
        <Centred>
          <Text variant="title2" style={styles.centre}>
            You’re caught up.
          </Text>
          {phase.offerRefine ? (
            <>
              <Text variant="body" tone="secondary" style={styles.centre}>
                Refine a few rankings?
              </Text>
              <Button
                label="Keep going"
                onPress={() => {
                  endSitting('caught_up');
                  onRefine();
                }}
              />
              <Button label="Done" kind="secondary" onPress={() => done('caught_up')} />
            </>
          ) : (
            <Button label="Done" onPress={() => done('caught_up')} />
          )}
        </Centred>
      ) : (
        <Centred>
          <Text variant="title2" style={styles.centre}>
            {phase.changed ? 'Not sure that landed' : 'Could not rank'}
          </Text>
          <Text variant="body" tone="secondary" style={styles.centre}>
            {phase.changed
              ? 'We lost the connection before hearing back. Nothing is lost: an answer that landed is kept.'
              : phase.message}
          </Text>
          <Button label="Try again" onPress={() => void loadNext()} />
          {target ? (
            <Button label="Skip it" kind="secondary" onPress={() => skipTitle(target)} />
          ) : null}
          <Button label="Close" kind="secondary" onPress={close} />
        </Centred>
      )}
    </Screen>
  );
}

/**
 * **`Skip title`, since 2026-09-22** (founder QA). It was "Skip this one", which beside
 * the comparison's own escape read as the same act twice. The two are different and both
 * stay: `Can't decide` declines the comparison on screen and keeps placing this title;
 * this leaves the TITLE for another sitting. The link itself is `SkipTitleLink`, shared
 * with Refine — see `RankingSheet`.
 */

function Centred({ children }: { children: React.ReactNode }) {
  return <View style={styles.centred}>{children}</View>;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.minTapTarget,
  },
  headerTitle: { flex: 1 },
  // Centred like the bucket screen, so the posters sit at the same height on both and
  // the flow does not jump between states (founder QA, 2026-09-22).
  body: { flex: 1, justifyContent: 'center' },
  // Poster then name, the way a comparison card stacks them.
  askPoster: { alignItems: 'center', gap: theme.space[2] },
  centred: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  centre: { textAlign: 'center' },
});
