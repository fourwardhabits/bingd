import { Stack, useRouter } from 'expo-router';
import { useRef } from 'react';

import { useCurrentProfile } from '@/features/auth';
import { NotificationStep } from '@/features/onboarding/NotificationStep';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import {
  FIRST_FIVE,
  useCompleteTasteOnboarding,
  useTasteOnboarding,
} from '@/features/onboarding/use-taste-onboarding';
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
  const state = useTasteOnboarding(profile.id);

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

    // Recorded before anything that can fail, and before the destination is read: the
    // decision that ends the flow is state the router depends on. `advance` and `complete`
    // both write memory synchronously and dispatch their disk writes.
    advance('done');
    void complete({ skipped: (state.data?.ranked ?? 0) < FIRST_FIVE });

    const destination = (await opensOnFeed()) ? TAB_ROUTES.feed : TAB_ROUTES.forYou;
    router.replace(destination);
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <NotificationStep onDone={() => void finish()} />
    </>
  );
}
