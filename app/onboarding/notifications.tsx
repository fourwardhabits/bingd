import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useCurrentProfile } from '@/features/auth';
import { useCelebrationHandoff } from '@/features/awards/celebration-queue';
import { NotificationStep } from '@/features/onboarding/NotificationStep';
import { canReceivePush, pushPermission } from '@/features/notifications/push';
import { pushAlreadyOffered, shouldOfferPush } from '@/features/notifications/push-permission';
import {
  useAdvanceStage,
  useOnboardingStage,
} from '@/features/onboarding/use-onboarding-stage';
import { rankingOutcome } from '@/features/onboarding/pick-five';
import { useCompleteTasteOnboarding } from '@/features/onboarding/use-taste-onboarding';
import { track } from '@/lib/analytics';
import { withGrace } from '@/lib/grace';
import { TAB_ROUTES } from '@/lib/routes';
import { supabase } from '@/lib/supabase';
import { Screen } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Step 10, and the end of the flow.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION IS UNCHANGED AND STILL LAST
 *
 * `NotificationStep` is rendered exactly as it was. PRD §15 forbids asking at first
 * launch, because the operating system dialog can be presented once and spending it on a
 * cold start asks somebody who has met nobody to agree to hear from them. It is stronger
 * here than it has ever been: "know when friends follow you" describes something concrete
 * to a reader who followed three people ninety seconds ago.
 *
 * Nothing is required. Both buttons continue, and the step returns `done` either way.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE APP OPENS, AND WHY A PENDING REQUEST DOES NOT COUNT
 *
 * | at the end of onboarding | opens on | why |
 * |---|---|---|
 * | one or more approved follows | Feed | it has something in it, and the follow just made is the first row |
 * | requests only, or nothing | For You | an empty Feed offers `Find your people`, which is the step they just left. Sending them there is a loop |
 *
 * **A pending request is not a connection.** It is not an edge, it may never be approved,
 * and treating a maybe as a yes puts somebody on an empty screen — which is precisely the
 * loop the rule exists to avoid. `approvedFollow` asks for `approved` and nothing else.
 *
 * An unreadable answer resolves to **For You**, deliberately. The failure modes are not
 * symmetric: For You has content for everybody, and the Feed is empty for anybody this
 * query would have been wrong about.
 *
 * ---------------------------------------------------------------------------
 * AND THIS IS WHERE THE FLOW IS RECORDED AS FINISHED
 *
 * `complete` is called here and nowhere else, so `onboarding_completed` fires once, at the
 * real end, rather than at the end of the ranking run. `skipped` is read from the data
 * rather than tracked through six screens: an account that reaches this step with fewer
 * than five rankings did not complete the ranking half, and the count is the only honest
 * witness to that.
 */
const CONNECTION_GRACE_MS = 3000;

/**
 * How long the step waits to learn whether it should ask at all before it asks anyway.
 * Both reads are local (a preference and the OS permission), so this only bounds a device
 * that is somehow stuck; asking is the fallback because it is the one that strands nobody.
 */
const ELIGIBILITY_GRACE_MS = 1500;

/**
 * **Whether this account should meet "Stay in the loop" at all** (founder QA, 2026-11-16).
 *
 * The question is the shared one (`shouldOfferPush`, as `shouldShowNotificationStep` asks it): only
 * while the OS permission is undetermined and bingd has never put it. A follow on the
 * People step offers the same permission in context and records `push.offered` whatever
 * the answer, so somebody who just turned notifications on — or said Not now — is not
 * asked the same thing again one screen later. Granted, blocked and unavailable are the OS
 * having decided, and a question it cannot act on is not put.
 *
 * Granted here is not taken to mean a token is registered: this only decides whether to
 * ask. Registration stays the contextual prompt's, best effort, and nothing on the skip
 * path claims it succeeded. A read that fails or does not answer in time asks, as before.
 *
 * **A failed read is not "no push here".** `pushPermission` never throws: a native read
 * that rejects is reported and comes back as `unavailable`, the same word a simulator
 * gets. On a device that can receive push, `unavailable` can only mean the read failed,
 * so it is treated as not knowing — and not knowing asks, unless bingd has already put
 * the question (`push.offered`), which is the one thing this step exists not to repeat.
 * The shared `shouldOfferPush` is left as it is: the contextual primer is right to stay
 * quiet on a failed read, because it interrupts something else.
 */
async function eligibility(): Promise<boolean> {
  const [offered, permission] = await Promise.all([pushAlreadyOffered(), pushPermission()]);
  if (permission === 'unavailable' && canReceivePush()) return !offered;
  return shouldOfferPush({ permission, offered });
}

async function shouldAsk(): Promise<boolean> {
  try {
    return await withGrace(eligibility(), ELIGIBILITY_GRACE_MS, true);
  } catch {
    return true;
  }
}

/**
 * One approved outgoing follow is enough, so the query asks for one.
 *
 * `head: true` with an exact count: this is a yes-or-no question and counting somebody's
 * entire follow list to answer it would be a page of rows thrown away. `null` when it could
 * not be answered — an error or a throw — so each caller decides what not knowing means.
 *
 * An async function rather than `.then` on the builder: PostgREST's builder is a
 * `PromiseLike` and not a `Promise`, so it does not satisfy `withGrace`'s parameter. The
 * same shape `taste.tsx` uses for its own bounded pre-exit read.
 */
async function approvedFollow(profileId: string): Promise<boolean | null> {
  try {
    const { count, error } = await supabase
      .from('follows')
      .select('followee_id', { count: 'exact', head: true })
      .eq('follower_id', profileId)
      .eq('state', 'approved');
    return error ? null : (count ?? 0) > 0;
  } catch {
    return null;
  }
}

export default function NotificationsStepScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const complete = useCompleteTasteOnboarding(profile.id);
  /** Drains what the ranking run earned, at the very end. See the end of `finish`. */
  const celebrate = useCelebrationHandoff();

  // A second press must not race a second navigation. A ref, because nothing renders from
  // it: the button stays live because the checks are quick.
  const departing = useRef(false);

  /**
   * **This screen owns the exit from a finished flow, so it also owns the stray visit.**
   *
   * `nextRoute` leaves this screen alone once the stage is `done`, so the router's replace
   * cannot land behind `finish`'s own navigation (see the `group === 'onboarding'` note in
   * `session.tsx`). The cost of that is a link opening this screen on a flow that already
   * ended, which the router used to send on. It is sent on here instead, to the Feed as the
   * router did. `departing` is what tells the two apart: `finish` sets it before it writes
   * `done`, so its own write never triggers this.
   */
  const stage = useOnboardingStage(profile.id);
  useEffect(() => {
    if (stage !== 'done' || departing.current) return;
    departing.current = true;
    router.replace(TAB_ROUTES.feed);
  }, [stage, router]);

  /**
   * **Asked twice, and each answer has one reader** (OB-1, 2026-11-14; corrected after
   * review, 2026-11-15).
   *
   * *At mount, for the analytics.* `notification_permission_result` reports `had_follow`,
   * and the question settles *before* `finish` runs, so a query first asked from `finish`
   * could never have answered it. The mount read is cached for the life of the screen and
   * handed to the step; that is all it is for.
   *
   * *At the press, for the landing.* The mount answer cannot pick the destination, because
   * it can be stale in the one direction that matters. People's Continue does not wait for
   * a Follow it has just sent (`FollowControl`'s mutation is still in flight when `leave`
   * navigates), so this screen can mount and count before that follow is written — a
   * connected reader would be sent to For You. And a mount read that failed would stay
   * `false` for good, even once the connection came back. So `opensOnFeed` asks again, at
   * the press, the way `finish` asked before OB-1, bounded by `CONNECTION_GRACE_MS`.
   *
   * If the press-time read fails or outlasts the grace, the mount answer is used **only if
   * it was a landed `true`**: a known follow is not downgraded to For You because the
   * second read was slow (nothing on this screen can unfollow). Anything else is For You,
   * for the asymmetry above. A press-time read that *answers* is believed either way.
   */
  const followAnswer = useRef<Promise<boolean> | null>(null);
  /** The mount answer once it has landed, for `opensOnFeed`'s fallback. */
  const mountAnswer = useRef<boolean | undefined>(undefined);
  const askFollow = useCallback(() => {
    followAnswer.current ??= approvedFollow(profile.id).then((answer) => answer ?? false);
    return followAnswer.current;
  }, [profile.id]);

  /**
   * The answer as far as it is known, for `notification_permission_result.had_follow`.
   * `undefined` until it lands; the step reports that as `false` (see `NotificationStep`).
   */
  const [hadFollow, setHadFollow] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void askFollow().then((answer) => {
      mountAnswer.current = answer;
      if (live) setHadFollow(answer);
    });
    return () => {
      live = false;
    };
  }, [askFollow]);

  const opensOnFeed = async () => {
    const fresh = await withGrace(approvedFollow(profile.id), CONNECTION_GRACE_MS, null);
    return fresh ?? mountAnswer.current === true;
  };

  /**
   * `shown`: the step was drawn and left. A step that was never shown is neither viewed
   * nor completed in the funnel — `viewed − completed` stays a count of people who saw it.
   */
  const finish = async ({ shown }: { shown: boolean }) => {
    if (departing.current) return;
    departing.current = true;

    if (shown) {
      track({
        name: 'onboarding_step_completed',
        props: { step: 'notifications', outcome: 'continued' },
      });
    }

    /**
     * **Everything that has to be awaited is awaited first, and then the flow ends in one
     * synchronous breath.**
     *
     * This used to write `done` before reading either of them, on the build-4 rule that
     * the decision ending the flow is recorded before anything that can fail. The rule is
     * right and the ordering it produced here was not, for two reasons that are really
     * one — a window between `done` and the navigation it belongs to.
     *
     * The app closing inside that window persisted `done` with nobody moved, and the next
     * launch routes every finished account to the Feed: somebody with no approved follow
     * therefore reopened onto the empty Feed, which is the single thing the destination
     * below exists to avoid. And now that the router ejects a finished flow out of the
     * onboarding group, the same window is one the router could answer in, replacing this
     * screen with the Feed a moment before it replaced itself with For You.
     *
     * Both close by moving the two reads in front. Neither can hang — `opensOnFeed` is
     * bounded by `withGrace` and `rankingOutcome` is a preference read behind its own
     * catch — so the flow-ending write is still reached, and it is now adjacent to the
     * navigation it authorises. Dying before it costs a second press of one button, which
     * is the cheapest failure available here.
     */
    const destination = (await opensOnFeed()) ? TAB_ROUTES.feed : TAB_ROUTES.forYou;

    /**
     * **The outcome is read, not re-derived**, and that is a correctness fix rather than a
     * tidy-up.
     *
     * This used to be `(state.data?.ranked ?? 0) < FIRST_FIVE`. The taste count is a query,
     * and this screen can mount before it answers — on a relaunch straight onto the
     * notification step it always does. An unanswered query became zero, zero is below
     * five, and an account that had ranked all five reported itself as a **skip**. CI
     * caught it; the direction is the bad one, because it under-counts the flow's central
     * success. `taste.tsx` now records the answer at the two exits that know it.
     *
     * The read has three answers, not two, and the third is passed through rather than
     * collapsed here. An account with no recorded outcome — mid-flow before this shipped,
     * or a lost disk write — is `unknown`, the flow still ends, and the event omits
     * `skipped` instead of guessing the likelier of the two. See `rankingOutcome`.
     */
    const outcome = await rankingOutcome(profile.id);

    // The end of the flow, in one breath: memory is written synchronously by both of
    // these, and the navigation is on the next line, so nothing — not a relaunch, not the
    // router's own effect — gets to run between the decision and the destination.
    advance('done');
    void complete({ outcome });
    router.replace(destination);

    /**
     * **What the ranking run earned, celebrated now that the flow is over** (independent
     * review 83b).
     *
     * The five rankings go through `RankingSheet`, which detects a new award or streak and
     * enqueues it (`celebration-queue.ts`). Onboarding passes `onPlaced`, and whatever the
     * comparison sheet shows before it goes away, no exit in the ranking run drains that
     * queue the way an ordinary ranking's Done does (`closeAndCelebrate`). Nothing in the
     * flow drained it, and the queue is process-local, so an award earned on film three was
     * simply lost. It cannot be drained earlier either: `/awards/celebrate` is outside the
     * onboarding group, so `nextRoute` would replace it straight back to the step while the
     * stage is unfinished.
     *
     * So it drains here, once, and in `closeAndCelebrate`'s order: the navigation that ends
     * the flow first, then the hand-off. Both are queued in expo-router's routing queue and
     * dispatched in that order by one effect. **Nothing else joins that queue in between**:
     * `nextRoute` returns null for this screen once the stage is `done` (see `session.tsx`),
     * so the router's own effect, which runs in the same commit, adds no replace behind the
     * push. Nothing on this screen is a sheet, so it never presents over one. An empty queue
     * does nothing.
     */
    celebrate();
  };

  /**
   * Unknown until `shouldAsk` answers, so the question is never drawn and then pulled away.
   * When it is not to be asked, the flow ends through `finish` — the same `advance('done')`,
   * completion, landing rule and celebration as Continue — with nothing to press.
   */
  const [ask, setAsk] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void shouldAsk().then((answer) => {
      if (!live) return;
      setAsk(answer);
      if (!answer) void finish({ shown: false });
    });
    return () => {
      live = false;
    };
    // Once per mount: `finish` is guarded by `departing`, and the answer cannot change
    // underneath a screen that is about to leave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      {ask ? (
        <NotificationStep onDone={() => void finish({ shown: true })} hadFollow={hadFollow} />
      ) : (
        <Screen>
          <View style={styles.resolving} testID="notifications-resolving">
            <ActivityIndicator color={theme.semantic.action} />
          </View>
        </Screen>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  resolving: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
