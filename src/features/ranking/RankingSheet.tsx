import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { formatGenreRank, genreRanksFor } from '@/features/collection/genre-rank';
import { formatScore, revealFloor, type Bucket } from '@/features/collection/score';
import { useRankedCollection, type RankingCategory } from '@/features/collection/use-collection';
import { track, type Surface } from '@/lib/analytics';
import { posterUri } from '@/lib/images';
import { invalidateAfterCollectionChange } from '@/features/collection/invalidate';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { useReducedMotion } from '@/ui/motion';
import { theme } from '@/ui/tokens';
import { Button, Poster, Sheet, Text, type BucketId } from '@/ui/components';

import {
  rankAgain,
  rankAnswer,
  rankBack,
  rankCancel,
  rankRebucket,
  rankSkip,
  rankStart,
  type SessionStep,
} from './session';

export type RankingSubject = {
  id: string;
  title: string;
  bucket: BucketId;
  posterUri?: string | null;
  /**
   * How this session begins, which is three different calls.
   *
   * `start` — the default — is a first ranking. `rebucket` is a title that had a
   * position and is changing band: `rank_rebucket` unranks, moves the bucket and
   * re-opens in one call. `rerank` is a title that had a position and is keeping its
   * band: `rankAgain` drops the position and re-opens in the same one, because
   * `rank_rebucket` refuses a bucket that is not moving.
   *
   * The last two both destroy the position before a single comparison is answered,
   * which is why they share everything below that `start` does not get.
   */
  mode?: 'start' | 'rebucket' | 'rerank';
};

export type RankingSheetProps = {
  /** The title being placed, with the bucket the user already chose for it. */
  subject: RankingSubject | null;
  onClose: () => void;
  /** "Rank another" — closes this and sends the user back to search. */
  onRankAnother?: () => void;
  /**
   * Which screen opened this, for `ranking_completed` alone.
   *
   * Passed in rather than inferred from the route: the sheet is mounted by three
   * different screens and the route it happens to be over is not the same question as
   * where the person decided to rank something.
   */
  surface: Surface;
};

/**
 * Comparison and reveal (screens.md §4).
 *
 * Two posters, one question, three controls. Deliberately bare: no year, no runtime, no
 * genre, because everything else is something the user reads instead of deciding.
 *
 * **The opponent's position is never shown.** Beli displays the incumbent's score and
 * Bingd does not display the equivalent ordinal — "this is my #2" is an anchor that
 * invites agreement rather than a judgement, and unanchored preference is the whole value
 * of the mechanic. Decided by the founder, 2026-08-13. The position is visible everywhere
 * else in the app, which is why this component fetches only titles.
 */
export function RankingSheet({ subject, onClose, onRankAnother, surface }: RankingSheetProps) {
  if (!subject) return null;

  // Keyed by the title, so moving to a different one starts a genuinely new component
  // rather than leaving one session's answers counted against the next.
  return (
    <Session
      key={subject.id}
      subject={subject}
      onClose={onClose}
      onRankAnother={onRankAnother}
      surface={surface}
    />
  );
}

function Session({
  subject,
  onClose,
  onRankAnother,
  surface,
}: RankingSheetProps & { subject: NonNullable<RankingSheetProps['subject']> }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();

  const [step, setStep] = useState<SessionStep | null>(null);
  // Starts true: the session is already being opened by the time anything renders.
  const [busy, setBusy] = useState(true);
  const [answered, setAnswered] = useState(0);
  /**
   * The same count, kept in a ref because `ranking_completed` needs it *now*.
   *
   * `act` queues `setAnswered` and then calls `apply` in the same tick, so the state
   * `apply` closes over is the value from before the comparison that finished the
   * session — the placing answer would be missing from every event. A ref is updated
   * synchronously, so the number in the event is the number of comparisons the person
   * actually answered.
   */
  const answeredCount = useRef(0);

  // The session the server is still holding, if any — what closing owes a rank_cancel to.
  // A ref because it has to be right in the same tick as the press, and because it has to
  // outlive the states that render nothing from it.
  const openSession = useRef<string | null>(null);

  const apply = useCallback(
    (next: SessionStep) => {
      if (next.state === 'comparing') openSession.current = next.sessionId;
      // placed and ended mean the server deleted the session itself; a failure asking for
      // a restart means it was already gone. A failure that does not — a dropped
      // connection, a suspension mid-session — leaves it standing, so the id is kept.
      else if (next.state !== 'failed' || next.restart) openSession.current = null;

      setStep(next);
      if (next.state === 'placed') {
        // Everything a finished ranking changes, named in one place so the two
        // writers cannot drift. This used to be three keys inline, and the feed was
        // not among them — which is why a just-ranked film did not appear in it.
        invalidateAfterCollectionChange(queryClient, profile.id, subject.id, {
          category: next.category,
        });
        /**
         * `ranking_completed`, and **only here**.
         *
         * `placed` is the server saying the title has a position — the one answer that
         * proves the ranking finished. The `failed && changed` branch below is the
         * lost-reply case, where the ranking *may* have landed, and it deliberately
         * emits nothing: an event on a maybe is how a retry becomes two rankings. The
         * cost is a small undercount in a known direction, which is the trade this
         * app has taken everywhere else (`lib/write-outcome.ts`).
         *
         * `next.category` is the server's own vocabulary, so the media kind comes from
         * what was actually written rather than from what the client thought it sent.
         */
        track({
          name: 'ranking_completed',
          props: {
            media_kind: next.category === 'tv_seasons' ? 'tv_season' : 'movie',
            surface,
            comparisons: answeredCount.current,
            rebucket: subject.mode === 'rebucket',
          },
        });
        /**
         * `invite_activated`, from the same answer and under the same rule.
         *
         * The flag is the server's: `_maybe_activate_invite` returns true only for the
         * transaction whose guarded UPDATE flipped `activated_at`, so this fires at most
         * once for an account, never for one that was not invited, and never on the
         * `failed && changed` branch below — where the ranking may have landed and the
         * client cannot tell. Emitting there would put a growth number on a maybe.
         *
         * No properties. The inviter is another person and is not this event's subject;
         * who was activated by whom is a join on `invite_attributions`.
         */
        if (next.activated) track({ name: 'invite_activated' });
      } else if (next.state === 'failed' && next.changed) {
        /**
         * **A failed answer can still have placed the title.**
         *
         * `rank_answer` finalises inside its own transaction, so one that commits and
         * loses its reply reaches here as a failure over a collection that has already
         * moved. No category, because a failure carries none and a rebucket can move a
         * title between them — `invalidate.ts` refreshes both when it is not told.
         */
        invalidateAfterCollectionChange(queryClient, profile.id, subject.id);
      }
    },
    [profile.id, queryClient, subject.id, subject.mode, surface],
  );

  /**
   * Whether opening this session has already changed the collection.
   *
   * True of both re-ranking modes and of neither first ranking. It used to be spelled
   * `mode === 'rebucket'` in the two places below, and adding a third mode that also
   * unranks before it opens is exactly how that spelling goes wrong — so it is one
   * name asked once.
   */
  const opensDestructively = subject.mode === 'rebucket' || subject.mode === 'rerank';

  useEffect(() => {
    let live = true;
    const open =
      subject.mode === 'rebucket' ? rankRebucket : subject.mode === 'rerank' ? rankAgain : rankStart;
    void open(subject.id, subject.bucket).then((next) => {
      /**
       * **A rebucket has already happened by the time this resolves**, and that is the
       * whole reason this is here rather than only in `apply`.
       *
       * `rank_rebucket` calls `rank_unrank` and updates `user_media.bucket` before it
       * opens a session (`20260813000700`). Both are committed. So a reader who moves a
       * film from Loved to Fine and then closes the sheet without answering a single
       * comparison has changed their collection — the ranking is gone, the bucket has
       * moved — while the ranked list, the score denominators and Rating Rascal all still
       * describe the ranking that no longer exists. Invalidating only on `placed` left
       * that standing for the full one-minute `staleTime`. Independent review 21c.
       *
       * `rank_start` is not a mutation and needs none of this: it opens a session and
       * writes nothing else.
       *
       * **On every resolution, including `failed`.** A Postgres exception does roll the
       * whole `rank_rebucket` transaction back — but a transaction can commit and its
       * HTTP response can then be lost, and the client maps that to `failed` too. There
       * is no answer here that distinguishes "refused" from "committed, reply dropped",
       * so the only safe reading is that it may have landed. A definite rollback costs a
       * redundant refetch; the other way costs a screen describing a ranking that is
       * gone. Independent review 21d.
       */
      if (opensDestructively) {
        invalidateAfterCollectionChange(queryClient, profile.id, subject.id);
      }

      if (live) {
        setBusy(false);
        apply(next);
        return;
      }

      // Dismissed while the session was still opening, so nothing on screen ever learned
      // its id. Cancelling it here is the only chance: leave it and the next rank_start
      // for this title resumes it mid-search, with no explanation for why the user is
      // being asked again.
      if (next.state === 'comparing') void rankCancel(next.sessionId);
    });

    return () => {
      live = false;
    };
  }, [subject, apply, profile.id, queryClient, opensDestructively]);

  const act = async (run: () => Promise<SessionStep>, progress = 0) => {
    if (busy) return;
    setBusy(true);
    const next = await run();
    setBusy(false);
    if (progress) {
      answeredCount.current = Math.max(0, answeredCount.current + progress);
      setAnswered(answeredCount.current);
    }
    apply(next);
  };

  const close = async () => {
    const sessionId = openSession.current;
    openSession.current = null;
    // Already gone reads as success, so this is safe when the server finalised the session
    // under a request that was still in flight.
    if (sessionId) await rankCancel(sessionId);
    onClose();
  };

  return (
    <Sheet visible onClose={() => void close()} label={`Rank ${subject.title}`}>
      <View style={styles.sheet}>
        {step?.state === 'placed' ? (
          <Reveal
            score={step.score}
            position={step.position}
            category={step.category}
            bucket={step.bucket}
            adjustable={step.adjustable}
            subjectId={subject.id}
            title={subject.title}
            onDone={() => void close()}
            onRankAnother={() => {
              void close();
              onRankAnother?.();
            }}
          />
        ) : step?.state === 'comparing' ? (
          <Comparison
            subject={subject}
            pivotId={step.pivotId}
            skipped={step.skipped}
            answered={answered}
            busy={busy}
            onPick={(winnerId) =>
              void act(() => rankAnswer(step.sessionId, winnerId, subject.id), 1)
            }
            onBack={() => void act(() => rankBack(step.sessionId, subject.id), -1)}
            onSkip={() => void act(() => rankSkip(step.sessionId, subject.id))}
            onClose={() => void close()}
          />
        ) : step?.state === 'failed' ? (
          /**
           * Three failures, and the third one is not a failure.
           *
           * `changed` is `session.ts` saying it cannot prove this was a refusal — the
           * request may have committed and lost its reply, in which case the title is
           * ranked, the score is written and the feed event exists. Saying “Could not
           * rank” over that is not a small inaccuracy: it is the app telling somebody
           * nothing happened and inviting them to do it again, and doing it again is
           * what turns one intent into two `title_ranked` events on the same title.
           *
           * Independent review 30 found the route that made this matter. Re-ranking
           * inside the same bucket has no server-side refusal standing in front of it
           * — a first ranking is stopped by 23505 and a rebucket by 22023, and both of
           * those were doing retry protection by accident. This path has neither, so
           * the protection has to be the sentence: a reader who is told the outcome is
           * unknown checks before they repeat it.
           *
           * **It is not idempotency and does not claim to be.** The ranking RPCs carry
           * no operation id, so nothing on the server can recognise a replay. That is a
           * migration and it is recorded in the deferred roadmap under rewatch history,
           * which is the same problem asked from the other end.
           */
          <Centred>
            <Text variant="title2" style={styles.centre}>
              {step.changed
                ? 'Not sure that landed'
                : step.restart
                  ? 'That session ended'
                  : 'Could not rank'}
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              {step.changed
                ? `We lost the connection before hearing back, so ${subject.title} may already be ranked. Check your collection before you rank it again.`
                : step.message}
            </Text>
            <Button label="Close" kind="secondary" onPress={() => void close()} />
          </Centred>
        ) : step?.state === 'ended' ? (
          <Centred>
            <Text variant="title2" style={styles.centre}>
              Still in your collection
            </Text>
            <Text variant="body" tone="secondary" style={styles.centre}>
              {subject.title} stays logged. You can rank it whenever you like.
            </Text>
            <Button label="Done" onPress={() => void close()} />
          </Centred>
        ) : (
          <Centred>
            <Text variant="body" tone="tertiary">
              Working out what to ask…
            </Text>
            {/* A way out while the first request is in flight. Without it the only exit is
                the hardware back button, which is not an exit a person can see. */}
            <Button label="Close" kind="secondary" onPress={() => void close()} />
          </Centred>
        )}
      </View>
    </Sheet>
  );
}

function Comparison({
  subject,
  pivotId,
  skipped,
  answered,
  busy,
  onPick,
  onBack,
  onSkip,
  onClose,
}: {
  subject: { id: string; title: string; posterUri?: string | null };
  pivotId: string;
  skipped: boolean;
  answered: number;
  busy: boolean;
  onPick: (winnerId: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const {
    data: pivot,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    // Its own key, not queryKeys.title: this is three columns, and a title screen caching a
    // whole row under the same key would hand whichever ran first to the other.
    queryKey: queryKeys.comparisonCard(pivotId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('media_items')
        .select('id, title, poster_path')
        .eq('id', pivotId)
        .single();
      if (error) throw error;
      return data as { id: string; title: string; poster_path: string | null };
    },
  });

  if (isError) {
    // The alternative is a card reading "…" that the user can still tap, which records a
    // preference over something they were never shown.
    return (
      <View style={styles.comparison}>
        <TopBar onClose={onClose} />
        <Centred>
          <Text variant="title2" style={styles.centre}>
            Could not load the other title
          </Text>
          <Text variant="body" tone="secondary" style={styles.centre}>
            Comparing needs a connection. The answers you have given are saved.
          </Text>
          <Button label="Try again" onPress={() => void refetch()} disabled={isFetching} />
          <Button label="Close" kind="secondary" onPress={onClose} />
        </Centred>
      </View>
    );
  }

  // Both cards wait for it, not just the pivot's. Leaving the subject tappable meant a user
  // could answer a comparison whose other side was still an ellipsis.
  const waiting = busy || !pivot;

  return (
    <View style={styles.comparison}>
      <TopBar onClose={onClose} />
      <Text variant="headline" style={styles.centre} accessibilityRole="header">
        Which did you like more?
      </Text>

      <View style={styles.cards}>
        <Card
          title={subject.title}
          posterUri={subject.posterUri ?? null}
          disabled={waiting}
          onPress={() => onPick(subject.id)}
        />
        {/* Beli's device (beli-252). It turns two pictures side by side into a
            question, and it costs one 32pt circle. */}
        <View style={styles.or} accessibilityElementsHidden importantForAccessibility="no">
          <Text variant="caption" tone="secondary">
            OR
          </Text>
        </View>
        <Card
          title={pivot?.title ?? '…'}
          posterUri={posterUri(pivot?.poster_path, 'card')}
          disabled={waiting}
          onPress={() => pivot && onPick(pivot.id)}
        />
      </View>

      {/* Progress as a line of text, not a bar. The remaining count is an estimate from a
          binary search whose range only the server knows, and a bar would imply a
          precision the algorithm does not have (screens.md §4). */}
      <Text variant="footnote" tone="tertiary" style={styles.centre}>
        {skipped
          ? 'Try this one instead'
          : answered === 0
            ? 'A few comparisons to go'
            : 'Getting closer'}
      </Text>

      {/* One row, and subordinate. Two stacked full-width buttons read as the main
          event on a screen whose main event is the two posters. */}
      <View style={styles.controls}>
        <Button
          label="Back"
          kind="tertiary"
          onPress={onBack}
          disabled={busy}
          disabledReason="Waiting for the last answer to save."
        />
        {/* Beli offers "Too tough" and "Skip" as separate controls and both call the same
            thing. One control, because two buttons that do the same thing is a choice the
            user has to think about for no reason. */}
        <Button
          label="Too tough to call"
          kind="tertiary"
          onPress={onSkip}
          disabled={busy}
          disabledReason="Waiting for the last answer to save."
        />
      </View>
    </View>
  );
}

function TopBar({ onClose }: { onClose: () => void }) {
  return (
    <View style={styles.topBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        hitSlop={theme.space[3]}
      >
        <Text variant="headline" tone="secondary">
          Close
        </Text>
      </Pressable>
    </View>
  );
}

function Card({
  title,
  posterUri,
  disabled,
  onPress,
}: {
  title: string;
  posterUri?: string | null;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose ${title}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Poster uri={posterUri} title={title} width="fill" size="md" />
      <View style={styles.cardTitleBox}>
        <Text variant="callout" numberOfLines={2} style={styles.centre}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The reveal (design-system.md §9): a deep Maroon panel with the **score** in Parchment
 * at display size, then the title, then rank context.
 *
 * Maroon since 2026-08-16, on the founder's device report. It was Amber, which is the
 * milestone colour — so the one moment the app states a score at its largest was the
 * one place that did not use the score system. `ScoreBadge` has been Maroon in every
 * list and on every title page for weeks; a reveal in a different colour reads as a
 * different kind of number, and then the badge the user meets a second later looks
 * like a demotion. Both are now `semantic.score`, and the pair is asserted at 7.4:1.
 *
 * The number keeps carrying the meaning. There is deliberately still no red/yellow/green
 * grading here — that reasoning is in `color.ts` and survives the colour change intact.
 *
 * The score is the hero, not the ordinal — founder decision, 2026-08-15. This screen
 * had not caught up: it rendered `#{position}` at `reveal` size while `score.ts` sat
 * unused. The reasoning for the swap is worth keeping: `#4` counting up from zero
 * passes through three numbers that are each a lie about a different film, and `#118`
 * is an anticlimax where `9.1` is not — and the reveal fires most often for the
 * people who have ranked the most.
 *
 * Share is absent because share cards are not built. An action that does nothing would be
 * worse than one that is not offered yet.
 */
function Reveal({
  score,
  position,
  category,
  bucket,
  adjustable,
  subjectId,
  title,
  onDone,
  onRankAnother,
}: {
  score: number;
  position: number;
  category: string;
  bucket: string;
  adjustable: boolean;
  subjectId: string;
  title: string;
  onDone: () => void;
  onRankAnother: () => void;
}) {
  const profile = useCurrentProfile();
  const readableCategory = category === 'tv_seasons' ? 'TV seasons' : 'Movies';
  const shown = useCountUp(score, bucket);

  // The ranked list for this category, which the collection already caches under the
  // key `apply` invalidated when the title was placed — so this resolves to the list
  // *including* it, and no new query or endpoint is needed to derive a genre rank.
  const { data: ranked } = useRankedCollection(profile.id, category as RankingCategory);
  const genres = ranked ? genreRanksFor(subjectId, ranked) : [];

  const context = [
    `#${position} ${readableCategory}`,
    ...genres.map(formatGenreRank),
  ].join('  ·  ');

  return (
    <View style={styles.reveal}>
      <View
        style={styles.panel}
        accessibilityRole="summary"
        accessibilityLabel={`${title} scored ${formatScore(score)} out of 10. ${context}`}
      >
        <Text variant="reveal" tone="inverse" accessibilityElementsHidden>
          {formatScore(shown)}
        </Text>
      </View>

      <Text variant="title2" style={styles.centre}>
        {title}
      </Text>

      {/* Secondary by construction: footnote, tertiary, one line. The ordinal is
          still true and still useful, it is just no longer the claim. */}
      <Text
        variant="footnote"
        tone="tertiary"
        style={styles.centre}
        accessibilityElementsHidden
      >
        {context}
      </Text>

      {adjustable ? (
        // Only when the server says so. It means the title landed at the midpoint after
        // too many skips rather than by comparison, and saying it otherwise would invite
        // people to distrust positions that were earned.
        <Text variant="footnote" tone="secondary" style={styles.centre}>
          You skipped a few, so this is an estimate. You can move it from Rankings.
        </Text>
      ) : null}

      <View style={styles.revealControls}>
        <Button label="Rank another" onPress={onRankAnother} />
        <Button label="Done" kind="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

/**
 * Counts from the low end of the title's own band up to its score.
 *
 * Not from zero: a *I didn’t like it* title would sprint through the whole scale to land at
 * 1.2, which reads as the app deciding the film was better than it was and then
 * correcting itself. Starting inside the band makes the animation say what actually
 * happened — the user chose a bucket, and this is where the title landed inside it
 * (design-system.md §9, `revealFloor` in score.ts).
 *
 * Plain state on a timer rather than Reanimated: the value is *text*, and a worklet
 * cannot drive a string through the JS bridge without re-rendering anyway.
 */
function useCountUp(target: number, bucket: string) {
  const reduced = useReducedMotion();
  const floor = revealFloor((bucket as Bucket) ?? 'loved');

  // Progress rather than the value itself, so the reduced-motion case is a plain
  // branch on the way out instead of a state write. Nothing is set during the
  // effect body — only from the timer — which keeps the render pass clean.
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (reduced) return;

    const started = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - started;
      const next = Math.min(1, elapsed / theme.duration.revealCount);
      setProgress(next);
      if (next >= 1) clearInterval(id);
    }, 16);

    return () => clearInterval(id);
  }, [reduced]);

  if (reduced) return target;

  // Ease out, so it decelerates into the number rather than stopping dead.
  const eased = 1 - (1 - progress) ** 3;
  return floor + (target - floor) * eased;
}

function Centred({ children }: { children: React.ReactNode }) {
  return <View style={styles.centredBox}>{children}</View>;
}

const styles = StyleSheet.create({
  // No flex: 1. The Sheet sizes itself to its content, which is the whole point of
  // moving off a full-height page sheet — a comparison is a small question.
  sheet: { paddingBottom: theme.space[2] },
  // No flex anywhere in here. Both halves of the old layout stretched: the screen was
  // a full-height page sheet, and the card row inside it was `flex: 1` with the posters
  // pinned to its top — so a tall device reserved ~500pt for ~330pt of content and put
  // the surplus underneath as blank Paper. The sheet now sizes to this block, and this
  // block sizes to the posters.
  comparison: {
    padding: theme.layout.gutter,
    gap: theme.space[5],
  },
  // In flow, not absolute. Absolute put it over the question once the sheet stopped
  // being full height and the content moved up to meet it.
  topBar: { alignItems: 'flex-end' },
  cards: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[2],
  },
  card: {
    flex: 1,
    alignItems: 'center',
    // poster.md, not poster.xl. At 180×270 two cards plus their gutters overflow a
    // 375pt screen and the mechanic starts to feel like an event; at 88×132 both
    // posters stay legible and the answer feels quick, which is the point.
    maxWidth: theme.poster.md.width,
    gap: theme.space[2],
  },
  or: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.sunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitleBox: {
    minHeight: 36,
    justifyContent: 'flex-start',
  },
  pressed: { opacity: 0.85 },
  // A row, not a stack. Two full-width buttons under the posters read as the primary
  // action on a screen whose primary action is tapping a poster.
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[4],
  },
  // The reveal is an airy surface (PRD §5) and its two actions are the only thing to
  // do on it, so they stack full-width rather than sharing a row.
  revealControls: { gap: theme.space[3], alignSelf: 'stretch' },
  centre: { textAlign: 'center' },
  centredBox: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
    padding: theme.space[8],
  },
  reveal: {
    alignItems: 'center',
    gap: theme.space[6],
    padding: theme.layout.gutter,
  },
  panel: {
    backgroundColor: theme.semantic.score,
    borderRadius: theme.radius.card,
    paddingVertical: theme.space[8],
    paddingHorizontal: theme.space[12],
    alignItems: 'center',
    gap: theme.space[2],
  },
});
