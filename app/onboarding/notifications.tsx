import { Stack, useRouter } from 'expo-router';
import { useRef } from 'react';

import { useCurrentProfile } from '@/features/auth';
import { NotificationStep } from '@/features/onboarding/NotificationStep';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { rankingOutcome } from '@/features/onboarding/pick-five';
import { useCompleteTasteOnboarding } from '@/features/onboarding/use-taste-onboarding';
import { track } from '@/lib/analytics';
import { withGrace } from '@/lib/grace';
import { TAB_ROUTES } from '@/lib/routes';
import { supabase } from '@/lib/supabase';

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
 * loop the rule exists to avoid. The count below asks for `approved` and nothing else.
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

export default function NotificationsStepScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);
  const complete = useCompleteTasteOnboarding(profile.id);


  // A second press must not race a second navigation. A ref, because nothing renders from
  // it: the button stays live because the checks are quick.
  const departing = useRef(false);

  /**
   * One approved outgoing follow is enough, so the query asks for one.
   *
   * `head: true` with an exact count and a limit of one: this is a yes-or-no question and
   * counting somebody's entire follow list to answer it would be a page of rows thrown
   * away. Bounded, because it sits between a button press and the navigation it promised,
   * and the build-4 stranding is what happens when something on that path does not settle.
   */
  const opensOnFeed = () =>
    withGrace(
      // An async wrapper rather than `.then` on the builder: PostgREST's builder is a
      // `PromiseLike` and not a `Promise`, so it does not satisfy `withGrace`'s parameter.
      // The same shape `taste.tsx` uses for its own bounded pre-exit read.
      (async () => {
        const { count, error } = await supabase
          .from('follows')
          .select('followee_id', { count: 'exact', head: true })
          .eq('follower_id', profile.id)
          .eq('state', 'approved');
        return !error && (count ?? 0) > 0;
      })(),
      CONNECTION_GRACE_MS,
      false,
    );

  const finish = async () => {
    if (departing.current) return;
    departing.current = true;

    track({
      name: 'onboarding_step_completed',
      props: { step: 'notifications', outcome: 'continued' },
    });

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
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <NotificationStep onDone={() => void finish()} />
    </>
  );
}
