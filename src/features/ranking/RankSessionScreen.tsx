import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import type { RankingCategory } from '@/features/collection/use-collection';
import { track } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { useOperationIntent } from '@/lib/operation-intent';
import { queryKeys } from '@/lib/query';
import { BucketChoices, Button, Poster, Screen, Text, type BucketId } from '@/ui/components';
import { theme } from '@/ui/tokens';

import {
  atBacklogCheckpoint,
  backlogProgress,
  rankBacklogStart,
  rankingBacklog,
  type BacklogTarget,
} from './backlog';
import { refineCandidates } from './refine';
import { RefineScreen } from './RefineScreen';
import { Comparison as ComparisonView } from './RankingSheet';
import { outcomeUnknown, rankAnswer, rankBack, rankSkip, type SessionStep } from './session';

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
      void queryClient.invalidateQueries({ queryKey: ['ranking-backlog', profile.id] });
      void queryClient.invalidateQueries({ queryKey: ['refine-availability', profile.id] });
    },
    [analyticsMedium, profile.id, queryClient],
  );

  const caughtUp = useCallback(async () => {
    let offerRefine = false;
    try {
      const refine = await refineCandidates(medium, { limit: 1 });
      offerRefine = refine.status === 'ready' && refine.cta.show;
    } catch {
      offerRefine = false;
    }
    setPhase({ kind: 'caughtUp', offerRefine });
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
      invalidateAfterCollectionChange(queryClient, profile.id, target.mediaItemId, {
        category: step.category,
      });
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
    [loadNext, mediaKind, profile.id, queryClient],
  );

  const applyStep = useCallback(
    (target: BacklogTarget, next: SessionStep) => {
      if (next.state === 'comparing') {
        if (next.pivotCard) {
          queryClient.setQueryData(queryKeys.comparisonCard(next.pivotId), next.pivotCard);
        }
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
    [loadNext, onPlaced, queryClient],
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

  const target =
    phase.kind === 'ask' || phase.kind === 'comparing' || phase.kind === 'failed'
      ? phase.target
      : null;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={theme.space[3]}
          onPress={close}
        >
          <Ionicons name="close" size={theme.layout.icon.md} color={theme.text.secondary} />
        </Pressable>
        <Text variant="headline" accessibilityRole="header" style={styles.headerTitle}>
          Rank · {medium === 'movies' ? 'Movies' : 'TV'}
        </Text>
        {total !== null && total > 0 ? (
          <Text variant="footnote" tone="secondary" testID="backlog-progress">
            {backlogProgress(placed, total)}
          </Text>
        ) : null}
      </View>

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
          <View style={styles.askPoster} testID="backlog-ask-poster">
            <Poster
              uri={posterUri(phase.target.posterPath, 'card')}
              title={phase.target.title}
              size="md"
            />
          </View>
          <Text variant="callout" style={styles.centre} numberOfLines={2}>
            {phase.target.title}
          </Text>
          <Text variant="title2" style={styles.centre}>
            How was it?
          </Text>
          <BucketChoices
            selected={null}
            onSelect={(bucket) => void open(phase.target, bucket)}
            testID="backlog-bucket-choices"
          />
          <SkipLink
            title={phase.target.title}
            disabled={busy}
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
          <SkipLink
            title={phase.target.title}
            disabled={busy}
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

function SkipLink({
  title,
  disabled,
  onPress,
}: {
  title: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Skip ${title}`}
      accessibilityHint="Leaves it unranked for now. It stays in Unranked."
      disabled={disabled}
      hitSlop={theme.space[2]}
      style={styles.skip}
      onPress={onPress}
    >
      {/**
       * **`Skip title`, since 2026-09-22** (founder QA). It was "Skip this one", which
       * beside the comparison's own escape read as the same act twice. The two are
       * different and both stay: `Can't decide` declines the comparison on screen and
       * keeps placing this title; this leaves the TITLE for another sitting.
       */}
      <Text variant="footnote" tone="secondary" style={styles.centre}>
        Skip title
      </Text>
    </Pressable>
  );
}

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
  body: { flex: 1 },
  skip: { paddingVertical: theme.space[3], paddingHorizontal: theme.layout.gutter },
  askPoster: { alignItems: 'center' },
  centred: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  centre: { textAlign: 'center' },
});
