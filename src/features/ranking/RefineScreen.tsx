import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import type { RankingCategory } from '@/features/collection/use-collection';
import { movementDirection, movementSentence } from '@/features/watch-history/watch-history';
import { track } from '@/lib/analytics';
import { useOperationIntent } from '@/lib/operation-intent';
import { posterUri } from '@/lib/images';
import { queryKeys } from '@/lib/query';
import { Button, Poster, Screen, ScoreBadge, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { Comparison as ComparisonView, SkipTitleLink } from './RankingSheet';
import {
  atCheckpoint,
  markShown,
  mayContinue,
  newSitting,
  nextRound,
  recordFinished,
  refineCandidates,
  ROUND_TARGETS,
  type RefinedTitle,
  type RefineStatus,
  type RefineTarget,
  type Sitting,
} from './refine';
import {
  outcomeUnknown,
  rankAnswer,
  rankBack,
  rankCancel,
  rankSkip,
  refineStart,
  type SessionStep,
} from './session';
import { applyRefineNotNow } from './use-refine';

/**
 * Refine your rankings (T5; calibration epic §H).
 *
 * The Refine source of the ranking session (`app/rank-session.tsx?start=refine`). It holds
 * ONE target at a time — the title being re-checked stays pinned while its comparisons
 * change (§H.2 flow C) — and runs the ordinary comparison view against it. Each target is a provisional `refine`
 * session on the server, so closing at any point moves nothing that an answer did not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT SAY
 *
 * No percentage, no "accuracy", no count of what is left in the library. The progress is
 * this round's five dots, which is a promise the screen can keep, and the result of each
 * title is the exact ordinal fact (`Moved from #118 → #72`, `Still #33`), which is private
 * and true. The server's ordering is never shown as a number (§G.3).
 */
export function RefineScreen({
  medium,
  onExit,
}: {
  medium: RankingCategory;
  /** Leave the screen. The caller owns navigation, so a test can observe it. */
  onExit: () => void;
}) {
  const profile = useCurrentProfile();
  const queryClient = useQueryClient();
  const withIntent = useOperationIntent();
  const analyticsMedium = medium === 'movies' ? 'movies' : 'tv';

  /** Varies the order among equally useful titles, per sitting (never per answer). */
  const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [sitting, setSitting] = useState<Sitting>(newSitting);
  /** The same sitting, readable synchronously inside the async steps below. */
  const sittingRef = useRef<Sitting>(sitting);
  const update = useCallback((next: Sitting) => {
    sittingRef.current = next;
    setSitting(next);
  }, []);

  type Phase =
    | { kind: 'loading' }
    | { kind: 'empty'; status: Exclude<RefineStatus, 'ready'> }
    | {
        kind: 'comparing';
        target: RefineTarget;
        step: Extract<SessionStep, { state: 'comparing' }>;
      }
    | { kind: 'checkpoint'; exhausted: boolean }
    | { kind: 'failed'; message: string; changed: boolean };

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const openSession = useRef<string | null>(null);
  const answers = useRef(0);
  const ended = useRef(false);
  /**
   * A finished target wants the next one. `finish` is declared before `loadNext`, and an
   * effect that called it would be a cascading render, so the flag is read by `act`
   * below — the only path a placement can arrive by.
   */
  const advance = useRef(false);
  /** A round has just ended and its checkpoint wants fresh server state. Read by `act`. */
  const probe = useRef(false);
  /** The medium's placement total at the last read, which Done records (unified §6). */
  const placementsTotal = useRef(0);
  /**
   * **What the server says AFTER the round** (founder QA, 2026-09-22), or null while it
   * is still being asked. Keep going is offered off this and nothing else: the count the
   * round opened on is by then several placements out of date, and offering another
   * round that opens onto nothing is the one thing the checkpoint must not do.
   */
  const [fresh, setFresh] = useState<{ strong: number; ready: boolean } | null>(null);
  /** The batch this round opened on; null until the first answer, and again per round. */
  const [batchAtStart, setBatchAtStart] = useState<number | null>(null);

  const endSitting = useCallback(
    (endedBy: 'done' | 'exhausted' | 'close') => {
      if (ended.current) return;
      ended.current = true;
      const { totals } = sittingRef.current;
      track({
        name: 'refine_session_ended',
        props: {
          targets: totals.targets,
          moved: totals.moved,
          comparisons: totals.answers,
          ended_by: endedBy,
          medium: analyticsMedium,
        },
      });
      /**
       * **Done means done for now** (founder QA, 2026-09-22).
       *
       * A finished sitting quiets the card exactly as Not now does: until the reader has
       * made enough new placements AND the server says the batch is strong again. It is
       * not a rest on the server — the titles the round revealed are genuinely still
       * candidates, and Keep going is the way to have them — it is the card declining to
       * ask again on its own. No time-based return (unified design §6, replacing T5's
       * seven-day rest).
       *
       * `applyRefineNotNow` writes the cache before the preference, so the card behind
       * this screen is already right when it reappears rather than on the next cold
       * start, which is the defect this replaced.
       */
      if (totals.targets > 0) {
        void applyRefineNotNow(queryClient, profile.id, medium, placementsTotal.current);
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.refineAvailability(profile.id, medium),
      });
    },
    [analyticsMedium, medium, profile.id, queryClient],
  );

  /** Settles one finished target: the ledger's outcome, the caches it touched, the event. */
  const finish = useCallback(
    (target: RefineTarget, step: Extract<SessionStep, { state: 'placed' }>) => {
      openSession.current = null;
      const title: RefinedTitle = {
        mediaItemId: target.mediaItemId,
        title: target.title,
        position: step.position,
        movement: step.movement ?? null,
        answers: answers.current,
        // For the round's summary: the poster it was compared under, and the score this
        // placement earned — the server's number, the one now in the collection.
        posterPath: target.posterPath,
        score: step.score,
        bucket: step.bucket,
      };
      const advanced = recordFinished(sittingRef.current, title);
      update(advanced);

      if (step.movement?.outcome === 'moved') {
        // A move shifts every title between the two ordinals, so it is a collection change.
        invalidateAfterCollectionChange(queryClient, profile.id, target.mediaItemId, {
          category: step.category,
        });
      } else {
        // Nothing moved; only the ledger gained a row, which Watch History reads.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.watchHistory(profile.id, target.mediaItemId),
        });
      }

      const outcome = step.movement?.outcome;
      if (outcome === 'moved' || outcome === 'unchanged' || outcome === 'kept') {
        track({
          name: 'refine_target_outcome',
          props: {
            outcome,
            reason: target.reason,
            comparisons: answers.current,
            medium: analyticsMedium,
            // Why it qualified, so the thresholds can be tuned from real use (§5).
            signal_gap: target.signals.gap,
            signal_contradicted: target.signals.contradicted,
            signal_crossed: target.signals.crossed,
            signal_strong: target.signals.strong,
          },
        });
      }
      // **No result page** (founder, 2026-09-22): a later target in the same round can
      // move this one again, so a per-title "Moved from #7 → #6" interrupts a batch to
      // state something that is not durable yet. The count goes up and the next target
      // opens. The round still ends on its checkpoint, which lists what moved.
      if (atCheckpoint(advanced)) {
        // The summary is drawn at once — the round IS over — and what is still worth
        // refining is asked of the server from `act`, which is what decides whether
        // Keep going is offered at all (founder QA, 2026-09-22).
        setFresh(null);
        probe.current = true;
        setPhase({ kind: 'checkpoint', exhausted: false });
      } else advance.current = true;
    },
    [analyticsMedium, profile.id, queryClient, update],
  );

  const applyStep = useCallback(
    (target: RefineTarget, next: SessionStep) => {
      if (next.state === 'comparing') {
        openSession.current = next.sessionId;
        if (next.pivotCard) {
          queryClient.setQueryData(queryKeys.comparisonCard(next.pivotId), next.pivotCard);
        }
        setPhase({ kind: 'comparing', target, step: next });
      } else if (next.state === 'placed') {
        finish(target, next);
      } else if (next.state === 'ended') {
        // Undo at the first comparison: this title is set aside, nothing moved. `act`
        // deals the next one; an opening never answers `ended`.
        openSession.current = null;
      } else {
        if (next.restart) openSession.current = null;
        setPhase({ kind: 'failed', message: next.message, changed: Boolean(next.changed) });
      }
    },
    [finish, queryClient],
  );

  const loadNext = useCallback(async () => {
    setPhase({ kind: 'loading' });
    answers.current = 0;
    let found;
    try {
      found = await refineCandidates(medium, {
        limit: 1,
        seed,
        recent: sittingRef.current.shown,
      });
    } catch {
      setPhase({
        kind: 'failed',
        message: 'Check your connection and try again.',
        changed: false,
      });
      return;
    }
    placementsTotal.current = found.placementsTotal;
    setFresh({
      strong: found.cta.strong,
      ready: found.status === 'ready' && Boolean(found.targets[0]),
    });
    setBatchAtStart((current) =>
      current ??
      Math.max(
        1,
        Math.min(
          found.cta.count || found.cta.strong || found.cta.qualifying || ROUND_TARGETS,
          ROUND_TARGETS,
        ),
      ),
    );
    const target = found.targets[0];
    if (found.status !== 'ready' || !target) {
      if (sittingRef.current.finished.length > 0) {
        setPhase({ kind: 'checkpoint', exhausted: true });
      } else {
        setPhase({
          kind: 'empty',
          status: found.status === 'ready' ? 'nothing_waiting' : found.status,
        });
      }
      return;
    }
    update(markShown(sittingRef.current, target.mediaItemId));
    const next = await withIntent(
      `refine:start:${target.mediaItemId}`,
      (op) => refineStart(target.mediaItemId, op),
      outcomeUnknown,
    );
    applyStep(target, next);
  }, [applyStep, medium, seed, update, withIntent]);

  /**
   * What is left, asked once the round is over. It costs one read and it is the only
   * honest basis for Keep going: the round just changed the very evidence the selection
   * is made from. `recent` keeps the titles this sitting already showed out of it, so
   * "another round" means another round of titles, not the same five again.
   */
  const probeAfterRound = useCallback(async () => {
    try {
      const found = await refineCandidates(medium, {
        limit: 1,
        seed,
        recent: sittingRef.current.shown,
      });
      placementsTotal.current = found.placementsTotal;
      setFresh({
        strong: found.cta.strong,
        ready: found.status === 'ready' && Boolean(found.targets[0]),
      });
    } catch {
      // No fresh evidence is not a reason to invite another round.
      setFresh({ strong: 0, ready: false });
    }
  }, [medium, seed]);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void loadNext();
  }, [loadNext]);

  /** One step in flight, decided synchronously — the RankingSheet rule (2026-09-16). */
  const act = async (
    target: RefineTarget,
    run: () => Promise<SessionStep>,
    progress: number,
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
    if (next.state !== 'failed') answers.current = Math.max(0, answers.current + progress);
    applyStep(target, next);
    // Undo at a target's first comparison ended its session; or the target was placed and
    // the round has room. Either way the next target is dealt from here.
    if (next.state === 'ended' || advance.current) {
      advance.current = false;
      void loadNext();
    } else if (probe.current) {
      probe.current = false;
      void probeAfterRound();
    }
  };

  /**
   * Leave this title for this sitting. The session is provisional, so cancelling it
   * moves nothing; `shown` keeps it out of the rest of the sitting, and the server may
   * offer it again another day.
   */
  const skipTitle = async (target: RefineTarget) => {
    const sessionId = openSession.current;
    openSession.current = null;
    update(markShown(sittingRef.current, target.mediaItemId));
    if (sessionId) await rankCancel(sessionId);
    await loadNext();
  };

  const close = async () => {
    const sessionId = openSession.current;
    openSession.current = null;
    // Provisional: cancelling leaves the title exactly where it was.
    if (sessionId) await rankCancel(sessionId);
    endSitting(phase.kind === 'checkpoint' && phase.exhausted ? 'exhausted' : 'close');
    onExit();
  };

  const round = sitting.finished.length;
  /**
   * **How many this round is asking for** (founder, 2026-09-22): the batch the server
   * offered when the round opened, capped at the round size, and then held — the same
   * convention the backlog uses, so "2 of 5 refined" counts toward a number that does
   * not move under the reader as candidates are used up.
   */
  const batchTotal = Math.min(batchAtStart ?? 0, ROUND_TARGETS);

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={theme.space[3]}
          onPress={() => void close()}
        >
          <Ionicons name="close" size={theme.layout.icon.md} color={theme.text.secondary} />
        </Pressable>
        <Text variant="headline" accessibilityRole="header" style={styles.headerTitle}>
          Refine · {medium === 'movies' ? 'Movies' : 'TV'}
        </Text>
        {batchTotal > 0 ? (
          <Text variant="footnote" tone="secondary" testID="refine-progress">
            {`${Math.min(round, batchTotal)} of ${batchTotal} refined`}
          </Text>
        ) : null}
      </View>

      {phase.kind === 'loading' ? (
        <Centred>
          <Text variant="body" tone="tertiary">
            Finding a title worth a second look…
          </Text>
        </Centred>
      ) : phase.kind === 'empty' ? (
        <Centred>
          <Text variant="title2" style={styles.centre}>
            {EMPTY_TITLE[phase.status]}
          </Text>
          <Text variant="body" tone="secondary" style={styles.centre}>
            {emptyBody(phase.status, medium)}
          </Text>
          <Button
            label="Done"
            onPress={() => {
              endSitting('exhausted');
              onExit();
            }}
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
            onClose={() => void close()}
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
              )
            }
          />
          {/**
           * **The backlog's title skip, in the backlog's own component** (founder QA,
           * 2026-09-22).
           *
           * It was *I don't remember <title> well*, which snoozed the title for 180 days —
           * a second, invisible memory state beside the ordinary skip. One act now: leave
           * this title for this sitting, exactly as the backlog does, and drawn by the
           * same `SkipTitleLink` so the two screens cannot drift apart again.
           * `refine_snooze` stays in the schema, unused, rather than being dropped in a
           * UI pass.
           */}
          <SkipTitleLink
            title={phase.target.title}
            disabled={busy}
            side
            hint="Leaves it for another time. Its ranking does not change."
            onPress={() => void skipTitle(phase.target)}
          />
        </View>
      ) : phase.kind === 'checkpoint' ? (
        <ScrollView contentContainerStyle={styles.checkpoint}>
          <Text variant="title2" accessibilityRole="header">
            {sitting.finished.length === 1
              ? '1 title checked'
              : `${sitting.finished.length} titles checked`}
          </Text>
          <View style={styles.results}>
            {sitting.finished.map((title) => (
              <RefinedRow key={title.mediaItemId} title={title} />
            ))}
          </View>
          {phase.exhausted || (fresh !== null && !fresh.ready) ? (
            <Text variant="footnote" tone="secondary">
              Nothing else needs a look right now.
            </Text>
          ) : null}
          <View style={styles.checkpointActions}>
            <Button
              label="Done"
              onPress={() => {
                endSitting(phase.exhausted ? 'exhausted' : 'done');
                onExit();
              }}
            />
            {/**
             * **Keep going waits for the server** (founder QA, 2026-09-22). It appears
             * only once `probeAfterRound` has answered, and only when what is left is
             * card-quality and there are rounds in the sitting still (§7) — so a sitting
             * never drifts on into titles the card itself would not have invited, and
             * never opens a round on evidence the last round has already spent.
             */}
            {!phase.exhausted && mayContinue(sitting) && fresh?.ready && fresh.strong > 0 ? (
              <Button
                label="Keep going"
                kind="secondary"
                onPress={() => {
                  update(nextRound(sittingRef.current));
                  setBatchAtStart(null);
                  void loadNext();
                }}
              />
            ) : null}
          </View>
        </ScrollView>
      ) : (
        <Centred>
          <Text variant="title2" style={styles.centre}>
            {phase.changed ? 'Not sure that landed' : 'Could not refine'}
          </Text>
          <Text variant="body" tone="secondary" style={styles.centre}>
            {phase.changed
              ? 'We lost the connection before hearing back. Your list is safe either way: nothing moves unless you answered.'
              : phase.message}
          </Text>
          <Button label="Try another" onPress={() => void loadNext()} />
          <Button label="Close" kind="secondary" onPress={() => void close()} />
        </Centred>
      )}
    </Screen>
  );
}

const EMPTY_TITLE: Record<Exclude<RefineStatus, 'ready'>, string> = {
  nothing_waiting: 'Nothing needs a look right now',
  too_small: 'Not yet',
  rested: 'That’s plenty for today',
  disabled: 'Not available',
};

function emptyBody(status: Exclude<RefineStatus, 'ready'>, medium: RankingCategory) {
  const noun = medium === 'movies' ? 'movies' : 'seasons';
  switch (status) {
    case 'nothing_waiting':
      return 'Your rankings are already well compared. Rank more and this will have something to check.';
    case 'too_small':
      return `Refining helps once you have ranked 20 ${noun}.`;
    case 'rested':
      return 'Your rankings are saved. Come back another day.';
    default:
      return 'Refining is not available right now.';
  }
}

/**
 * **One checked title, in the app's own row** (founder, 2026-09-22).
 *
 * The round's summary was a bare list: a name on the left and a sentence on the right,
 * in a screen otherwise made of posters and score circles. This is the row every other
 * list in the app draws — poster, title, and the score in `ScoreBadge` — with the
 * movement underneath as the secondary line.
 *
 * **The hierarchy is deliberate and it is the founder's.** What the reader earned is the
 * CURRENT bingd score, so that is the badge, at full strength, on the right where a score
 * always is. Where it came from is muted footnote text under the title. The old value is
 * never given the same weight as the new one.
 *
 * **And the old value is an ordinal, not a score.** A refine session reports the position
 * it moved from; nothing anywhere captures what the score used to be. Rather than compute
 * a plausible number — which would be a made-up fact stated next to a real one — the row
 * says `#12 → #11`, which is exactly what is known. `movementSentence` is the same
 * function Watch History uses, so the two surfaces word it identically.
 *
 * Not pressable. It is a receipt for something the reader just did, not a way into
 * anything, and a row that navigates out of a summary loses the rest of the summary.
 */
function RefinedRow({ title }: { title: RefinedTitle }) {
  const movement = title.movement ?? { outcome: 'unchanged' as const, fromPosition: null };
  const sentence = movementSentence(movement, title.position) ?? `#${title.position}`;
  // "Moved from #118 → #72" is the Watch History sentence; in a column of five it is the
  // arrow that reads, so the row keeps the pair and drops the preamble.
  const line = sentence.replace('Moved from ', '');
  const direction = movementDirection(movement, title.position);

  return (
    <View style={styles.row} accessible accessibilityRole="text">
      <Poster uri={posterUri(title.posterPath ?? null, 'card')} title={title.title} size="row" />
      <View style={styles.rowText}>
        <Text variant="callout" numberOfLines={2}>
          {title.title}
        </Text>
        <View style={styles.rowMovement}>
          <Text variant="footnote" tone="tertiary" numberOfLines={1}>
            {line}
          </Text>
          {direction ? (
            <Ionicons
              name={direction === 'up' ? 'arrow-up' : 'arrow-down'}
              size={theme.layout.icon.sm}
              color={theme.text.tertiary}
              accessibilityLabel={direction === 'up' ? 'Moved up' : 'Moved down'}
            />
          ) : null}
        </View>
      </View>
      {typeof title.score === 'number' ? (
        <ScoreBadge score={title.score} bucket={bucketOf(title.bucket)} size="sm" />
      ) : null}
    </View>
  );
}

/** The server's band name, only when it is one the badge can speak. */
function bucketOf(bucket: string | null | undefined) {
  return bucket === 'loved' || bucket === 'fine' || bucket === 'not_for_me' ? bucket : null;
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
  /**
   * **Centred, exactly as the backlog is** (founder QA, 2026-09-22). It was `flex: 1`
   * alone, which pinned the pair to the top of the screen — so the same comparison sat
   * at two different heights depending on which queue had dealt it, and moving between
   * the two read as two different screens.
   */
  body: { flex: 1, justifyContent: 'center' },
  centred: {
    flex: 1,
    justifyContent: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  centre: { textAlign: 'center' },
  checkpoint: {
    padding: theme.layout.gutter,
    gap: theme.space[3],
  },
  // The rows carry their own vertical padding, like every other list in the app.
  results: { gap: theme.space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[1],
  },
  rowText: { flex: 1, gap: 2 },
  rowMovement: { flexDirection: 'row', alignItems: 'center', gap: theme.space[1] },
  checkpointActions: { gap: theme.space[2], paddingTop: theme.space[2] },
});
