import { Ionicons } from '@expo/vector-icons';
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

import { useOperationIntent } from '@/lib/operation-intent';

import {
  outcomeUnknown,
  rankAgain,
  rankAnswer,
  rankBack,
  rankCancel,
  rankRebucket,
  rankSkip,
  rankStart,
  type SessionStep,
} from './session';
import { TitleRecallSheet } from './TitleRecallSheet';

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
   * "Finish your log" — closes this and hands the reader back to `LogSheet` in its
   * post-rank state, carrying the score the session just produced.
   *
   * **This is the seam the founder's central complaint was about.** Ranking used to end
   * here: a number, Rank another, Done, and the review you might have written or the
   * people you watched it with were behind a second, unprompted visit to a sheet you
   * had just been thrown out of. Ranking is a subflow of logging, so it returns to the
   * log — and it returns to the *same* `LogSheet`, not a Finish screen of its own, so
   * there is exactly one implementation of "the rest of your log" in the app.
   *
   * The placement travels with the call. The session already had all three from the
   * server's reply, and making the log sheet re-query for a number this screen is
   * holding would put a spinner in the middle of a finished act.
   *
   * Optional because the caller has to have a log sheet to return to. Every screen that
   * mounts this one does; the prop is optional so that adding a fourth cannot silently
   * break, and the reveal falls back to the two controls it has always had.
   */
  onFinishLog?: (placement: { score: number; position: number; category: string }) => void;
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
export function RankingSheet({
  subject,
  onClose,
  onRankAnother,
  onFinishLog,
  surface,
}: RankingSheetProps) {
  if (!subject) return null;

  // Keyed by the title, so moving to a different one starts a genuinely new component
  // rather than leaving one session's answers counted against the next.
  return (
    <Session
      key={subject.id}
      subject={subject}
      onClose={onClose}
      onRankAnother={onRankAnother}
      onFinishLog={onFinishLog}
      surface={surface}
    />
  );
}

function Session({
  subject,
  onClose,
  onRankAnother,
  onFinishLog,
  surface,
}: RankingSheetProps & { subject: NonNullable<RankingSheetProps['subject']> }) {
  const queryClient = useQueryClient();
  const profile = useCurrentProfile();

  const [step, setStep] = useState<SessionStep | null>(null);
  // Starts true: the session is already being opened by the time anything renders.
  const [busy, setBusy] = useState(true);

  /**
   * The attempt to run again if the reader asks, and **the reason the operation id is
   * worth threading through this component at all.**
   *
   * Every one of these thunks closes over a `withIntent` call with a fixed key, so
   * running one a second time reuses the id the first attempt carried — which, since
   * `20260825000200`, is what makes the server answer the retry with the stored result
   * instead of doing the work twice. Without it a retry of an opening would be a second
   * genuine `rank_again`, unranking the title the lost attempt had just re-ranked, and a
   * retry of an answer would record a second comparison.
   *
   * State rather than a ref, unlike `answeredCount` and `openSession` below, because
   * this one is *rendered from*: whether there is a Try again button on screen is
   * exactly the question of whether there is an attempt to repeat. Wrapped in an object
   * because `useState` calls a bare function argument as an initialiser rather than
   * storing it.
   */
  const [lastAttempt, setLastAttempt] = useState<{ run: () => Promise<SessionStep> } | null>(null);

  /**
   * One operation id per intent, for the ranking RPCs that gained one in
   * `20260825000200`.
   *
   * **What an intent is here, and why each key is shaped the way it is.** The rule
   * `lib/operation-intent.ts` states is that the id belongs to the intent and not to
   * the attempt — so the key has to name the thing the reader meant, and has to change
   * when they mean something else.
   *
   *   opening   `open:<mode>:<title>:<bucket>` — one intent per opening of this sheet.
   *             The mode is in the key because a rebucket and a rerank of the same
   *             title at the same bucket are different acts, and both destroy a
   *             position. Retrying an open under the id it already used is what stops
   *             a `rank_again` whose reply was lost from unranking a second time.
   *
   *   answering `answer:<session>:<winner>` — one intent per comparison answered.
   *             Picking the *other* title after a failure is a different judgement and
   *             gets a different key, which is correct: it is a new answer, not a
   *             retry of the old one.
   *
   *   skipping  `skip:<session>:<pivot>` and `back:<session>:<pivot>` — one intent per
   *             comparison declined or stepped back from. The pivot is in the key
   *             because it is what identifies the comparison on screen; the session id
   *             alone would make every skip in a session the same intent, and the
   *             second one would be answered with the first one's pivot.
   *
   * The hook holds an id only while the outcome is unknown, so an ordinary sequence of
   * answers mints a fresh id each time and nothing accumulates.
   */
  const withIntent = useOperationIntent();

  /**
   * How many comparisons the reader actually answered, for `ranking_completed`.
   *
   * A ref and not state, because the event needs it *now*: `act` calls `apply` in the
   * same tick it updates this, and a queued `setState` would leave `apply` closing over
   * the value from before the comparison that finished the session — so the placing
   * answer would be missing from every event. A ref is updated synchronously.
   *
   * Nothing renders from it. It was mirrored into state to feed a "Getting closer"
   * line under the posters, and that line is gone (see `Comparison`), so the mirror
   * went with it rather than being left as a re-render nobody reads.
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
    const attempt = () =>
      withIntent(
        `open:${subject.mode ?? 'start'}:${subject.id}:${subject.bucket}`,
        (operationId) => open(subject.id, subject.bucket, operationId),
        outcomeUnknown,
      );
    void attempt().then((next) => {
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
        // Recorded here rather than before the call, so that the effect body stays free
        // of a synchronous setState. It lands in the same batch as `apply` below, which
        // is what the Try again button reads — see `lastAttempt`.
        setLastAttempt({ run: attempt });
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
  }, [subject, apply, profile.id, queryClient, opensDestructively, withIntent]);

  const act = async (run: () => Promise<SessionStep>, progress = 0) => {
    if (busy) return;
    setLastAttempt({ run });
    setBusy(true);
    const next = await run();
    setBusy(false);
    if (progress) {
      answeredCount.current = Math.max(0, answeredCount.current + progress);
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
            onFinishLog={
              onFinishLog
                ? () => {
                    // `close` is a no-op against the server at this point — `apply` cleared
                    // `openSession` the moment the placement landed, because the server
                    // deletes a session it has finished. It is still the way out, so the
                    // sheet unmounts through the same path every other exit uses.
                    void close();
                    onFinishLog({
                      score: step.score,
                      position: step.position,
                      category: step.category,
                    });
                  }
                : undefined
            }
          />
        ) : step?.state === 'comparing' ? (
          <Comparison
            subject={subject}
            pivotId={step.pivotId}
            skipped={step.skipped}

            busy={busy}
            onPick={(winnerId) =>
              void act(
                () =>
                  withIntent(
                    `answer:${step.sessionId}:${winnerId}`,
                    (op) => rankAnswer(step.sessionId, winnerId, subject.id, op),
                    outcomeUnknown,
                  ),
                1,
              )
            }
            onBack={() =>
              void act(
                () =>
                  withIntent(
                    `back:${step.sessionId}:${step.pivotId}`,
                    (op) => rankBack(step.sessionId, subject.id, op),
                    outcomeUnknown,
                  ),
                -1,
              )
            }
            onSkip={() =>
              void act(() =>
                withIntent(
                  `skip:${step.sessionId}:${step.pivotId}`,
                  (op) => rankSkip(step.sessionId, subject.id, op),
                  outcomeUnknown,
                ),
              )
            }
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
           * **It is idempotency now, and the offer of a retry is what changed.** The
           * ranking RPCs took no operation id until `20260825000200`, so nothing on the
           * server could recognise a replay and the only safe thing this screen could
           * say was "go and look". They take one now, `lastAttempt` re-runs under the
           * same one, and the server answers the retry with what the lost reply said —
           * so the button below cannot rank the title a second time, record a second
           * comparison, or write a second `title_ranked` event.
           *
           * The sentence stays honest about the uncertainty even so, because the
           * uncertainty is real: this reader genuinely does not know yet whether their
           * ranking landed. What has changed is that finding out no longer costs them a
           * trip to their collection.
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
                ? `We lost the connection before hearing back, so ${subject.title} may already be ranked. Try again — we will pick up where this left off rather than ranking it twice.`
                : step.message}
            </Text>
            {step.changed && lastAttempt ? (
              <Button
                label="Try again"
                disabled={busy}
                disabledReason="Still trying."
                onPress={() => {
                  // No progress: a retry is the same comparison, not another one, and
                  // counting it would inflate `ranking_completed`'s `comparisons`.
                  void act(lastAttempt.run);
                }}
              />
            ) : null}
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
  busy,
  onPick,
  onBack,
  onSkip,
  onClose,
}: {
  subject: { id: string; title: string; posterUri?: string | null };
  pivotId: string;
  skipped: boolean;
  busy: boolean;
  onPick: (winnerId: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  /**
   * Which title the reader asked to be reminded about, if any.
   *
   * Local to the comparison and deliberately not lifted: it is not session state, the
   * server knows nothing about it, and a comparison that ends while the reminder is
   * open takes the reminder with it — which is correct, because the title it was about
   * is no longer on screen.
   */
  const [recalling, setRecalling] = useState<string | null>(null);

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
          onRecall={() => setRecalling(subject.id)}
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
          onRecall={() => pivot && setRecalling(pivot.id)}
        />
      </View>

      {/**
       * One line, and only when it is saying something.
       *
       * It used to say "Getting closer" on every comparison after the first, and "A few
       * comparisons to go" on the first. Founder feedback, and it is right: neither is
       * information. "Getting closer" is encouragement with nothing behind it — the
       * binary search's remaining range is the server's and this screen has never known
       * it — and the count it *could* honestly give is one the algorithm cannot promise
       * either. A line that changes on every comparison while telling the reader nothing
       * is a moving object next to the two posters they are trying to compare.
       *
       * What survives is the one message that is not encouragement: after a skip the
       * pair changes, and without a word for it a poster silently becoming a different
       * poster looks like a bug. The slot keeps its height either way so the controls
       * below do not jump when the sentence appears.
       */}
      <View style={styles.note}>
        {skipped ? (
          <Text variant="footnote" tone="tertiary" style={styles.centre}>
            Try this one instead
          </Text>
        ) : null}
      </View>

      {/**
       * One row, and subordinate — but a row of *controls*.
       *
       * `sm` and a secondary tone, which is the founder's first note: at `md` these were
       * 48pt tall, `headline` weight and full ink — the same physical control the app
       * uses for the primary act of a screen, sitting directly under the two posters
       * that *are* the act. They read as the question. Compact and quieter puts them
       * back where they belong without making them hard to hit: 36pt plus `hitSlop`
       * clears the 44pt target, which is the rule `Button`'s own `sm` note states.
       *
       * **`secondary` rather than `tertiary`, which is the founder's second note.**
       * Quiet went one step too far: `tertiary` is a transparent box with no border, so
       * on the device these two words sat under the posters as loose text with nothing
       * to say they could be pressed. The reference the founder gave is the compact
       * Follow back in the notification inbox — `secondary`, `sm`, with `hitSlop` for
       * the target — and this is that control, so it is drawn as that control: a raised
       * fill and a hairline border, which is exactly what makes a button look like one.
       *
       * The tone stays `secondary`, so the pair gains a container without gaining the
       * ink weight that made them compete with the posters in the first place. Equal
       * halves of the row rather than hugging their labels, so "Undo" and "Skip" are
       * the same physical size — two controls of the same rank should not differ in
       * width because one word is longer than the other.
       */}
      <View style={styles.controls}>
        {/**
         * `Undo`, not `Back`.
         *
         * Checked against `rank_back` rather than assumed: it restores `lo`, `hi` and
         * `pivot` from the last history entry, pops that entry, and decrements the skip
         * count (20260813001600). It genuinely reverses the previous answer — the
         * search range returns to what it was before it — so `Back` was the weaker of
         * the two words, and on a screen with no navigation stack it also invited the
         * reading "leave this sheet", which is the X above.
         *
         * At the first comparison there is no answer to reverse and the server ends the
         * session instead. That is still the same promise kept: the last thing the
         * reader did was start ranking, and this undoes it. The title keeps its bucket
         * and stays Logged.
         */}
        <View style={styles.control}>
          <Button
            label="Undo"
            accessibilityLabel="Undo the last comparison"
            accessibilityHint="Puts the previous pair back."
            kind="secondary"
            size="sm"
            tone="secondary"
            // 36pt plus 4 either side is the 44 design-system.md §8 requires. `sm` is
            // deliberately shorter than that on its own and says so — slop is the right
            // tool for a compact control, and a taller box is not — but the slop has to
            // be passed, which is the half review 36 found missing.
            hitSlop={theme.space[1]}
            onPress={onBack}
            disabled={busy}
            disabledReason="Waiting for the last answer to save."
          />
        </View>
        {/**
         * `Skip`, which is one control for two reasons.
         *
         * It was "Too tough to call", which names only half of what `rank_skip` is for.
         * The founder's case is the other half: the poster is familiar and the memory is
         * not, and "too tough to call" is the wrong sentence for "I do not remember this
         * one well enough to say". Both want the same thing — a different opponent — and
         * both already got it, because this button has always called `rank_skip`.
         *
         * So the mechanism is unchanged and the word is the fix. `Skip` covers both
         * readings, and it is the shortest label in a row that had to fit under two
         * posters on a 375pt screen. The accessibility label spells out what is being
         * skipped, because "Skip" alone could be heard as skipping the whole ranking —
         * which is the X, and is a different thing.
         *
         * Still one control and not two. Beli offers "Too tough" and "Skip" separately
         * and both call the same thing; two buttons with one effect is a decision the
         * reader has to make for no reason.
         */}
        <View style={styles.control}>
          <Button
            label="Skip"
            accessibilityLabel="Skip this comparison"
            accessibilityHint="Compares against a different title instead."
            kind="secondary"
            size="sm"
            tone="secondary"
            hitSlop={theme.space[1]}
            onPress={onSkip}
            disabled={busy}
            disabledReason="Waiting for the last answer to save."
          />
        </View>
      </View>

      {/**
       * Mounted only while open, like every other sheet in the app, and *inside* the
       * comparison rather than beside it — so the session, the pivot and the answers
       * already given are all still standing behind it. Dismissing returns to the exact
       * same pair because nothing about the pair was ever unmounted.
       */}
      <TitleRecallSheet mediaItemId={recalling} onClose={() => setRecalling(null)} />
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
  onRecall,
}: {
  title: string;
  posterUri?: string | null;
  disabled: boolean;
  onPress: () => void;
  onRecall: () => void;
}) {
  return (
    <View style={styles.card}>
      {/**
       * Tap chooses, press-and-hold remembers.
       *
       * `Pressable` does not fire both: a press that runs long enough to call
       * `onLongPress` has its `onPress` suppressed on release, so holding a poster to
       * read about it cannot also register as picking it. That is the whole safety
       * property this gesture needed — a long press that also answered the comparison
       * would put a judgement on the server for a title the reader was still trying to
       * place.
       *
       * `delayLongPress` is React Native's default 500ms, left alone: shorter starts
       * catching deliberate taps, and this gesture is not one anybody is in a hurry to
       * complete.
       */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Choose ${title}`}
        disabled={disabled}
        onPress={onPress}
        onLongPress={onRecall}
        style={({ pressed }) => [styles.cardPress, pressed && styles.pressed]}
      >
        <Poster uri={posterUri} title={title} width="fill" size="md" />
        <View style={styles.cardTitleBox}>
          <Text variant="callout" numberOfLines={2} style={styles.centre}>
            {title}
          </Text>
        </View>
      </Pressable>

      {/**
       * The same thing again, as something you can reach.
       *
       * A long press is invisible and unreachable: VoiceOver and TalkBack have no
       * general gesture for it, and a reader who cannot hold steady has no way to
       * perform one at all. design-system.md §8's rule is that a hidden gesture may be
       * the *fast* path and never the only one, so the affordance is a real button with
       * its own label — small, under the poster it belongs to, and out of the way of
       * the two cards that are the actual question.
       */}
      {/**
       * **The word is `Details`, and it used to be "What is this?".**
       *
       * Founder feedback from physical testing. A question under both posters reads as
       * the screen being unsure rather than as an offer, and at 375pt three words wrap
       * to two lines under one title and one line under the other — so the pair stops
       * being symmetrical at the exact moment symmetry *is* the question. `Details` is
       * one word, cannot wrap, and names what is behind it.
       *
       * The glyph is what keeps it reading as a control at caption size; a bare word in
       * tertiary ink under a poster is the same "loose text" the founder objected to in
       * the row below. It is hidden from screen readers because the label on the
       * Pressable already says the whole sentence.
       */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Details about ${title}`}
        accessibilityHint="Shows the year, the runtime, the cast, and what it is about."
        hitSlop={theme.layout.minTapTarget / 2}
        onPress={onRecall}
        style={({ pressed }) => [styles.recall, pressed && styles.pressed]}
      >
        <Ionicons
          name="information-circle-outline"
          size={theme.layout.icon.sm}
          color={theme.text.tertiary}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text variant="caption" tone="tertiary">
          Details
        </Text>
      </Pressable>
    </View>
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
  onFinishLog,
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
  onFinishLog?: () => void;
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

      {/**
       * **Where the reveal stopped being the end.**
       *
       * It offered Rank another and Done, which are both ways out — so a reader who had
       * just formed an opinion strong enough to place a film had nowhere to put it. The
       * founder's report is that the writing and the watch date were effectively
       * unreachable at the one moment somebody wants them, and that later tapping Ranked
       * gave no obvious way back either.
       *
       * So the primary control now continues the log rather than leaving it, and the two
       * exits move into a row beneath. That row is the density decision: two `md`
       * buttons side by side occupy the height one of them used to, so the flow gains a
       * step without the screen gaining any.
       *
       * Done is still one tap and still writes nothing. Nothing here is required.
       */}
      {onFinishLog ? (
        <View style={styles.revealControls}>
          <Button label="Finish your log" onPress={onFinishLog} />
          <View style={styles.revealExits}>
            <View style={styles.revealExit}>
              <Button label="Rank another" kind="secondary" onPress={onRankAnother} />
            </View>
            <View style={styles.revealExit}>
              <Button label="Done" kind="secondary" onPress={onDone} />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.revealControls}>
          <Button label="Rank another" onPress={onRankAnother} />
          <Button label="Done" kind="secondary" onPress={onDone} />
        </View>
      )}
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
  // The poster and its name, which is the part that answers the comparison. Split out
  // from `card` so the recall affordance below can be its own control rather than a
  // second gesture on the same one.
  cardPress: { alignSelf: 'stretch', alignItems: 'center', gap: theme.space[2] },
  // Caption, tertiary, no border, no background. It has to be reachable and it must
  // not compete: the two things that look like buttons on this screen are the posters.
  // A row, so the glyph and the word read as one control rather than as an icon that
  // happens to sit above a caption.
  recall: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[1],
    paddingVertical: theme.space[1],
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
  // The skip explanation's slot. Fixed at one `footnote` line so the controls below do
  // not move when the sentence appears and disappears — a row of buttons that shifts
  // under the reader's thumb between comparisons is worse than the copy it saved.
  note: { minHeight: theme.typography.footnote.lineHeight, justifyContent: 'center' },
  // A row, not a stack. Two full-width buttons under the posters read as the primary
  // action on a screen whose primary action is tapping a poster.
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
  },
  // Equal halves. Two controls of the same rank should be the same size, and letting
  // each hug its own label makes "Skip" visibly smaller than "Undo" for no reason.
  control: { flex: 1 },
  // The reveal is an airy surface (PRD §5) and its two actions are the only thing to
  // do on it, so they stack full-width rather than sharing a row.
  revealControls: { gap: theme.space[3], alignSelf: 'stretch' },
  // The two ways out, side by side under the one way on. Equal halves, so neither
  // reads as the recommended exit.
  revealExits: { flexDirection: 'row', gap: theme.space[2] },
  revealExit: { flex: 1 },
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
