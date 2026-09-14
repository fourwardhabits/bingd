import { Stack, useRouter } from 'expo-router';
import { useRef } from 'react';

import { useCurrentProfile } from '@/features/auth';
import { ImportScreen } from '@/features/import/ImportScreen';
import { OnboardingHeader } from '@/features/onboarding/OnboardingHeader';
import { useAdvanceStage } from '@/features/onboarding/use-onboarding-stage';
import { track } from '@/lib/analytics';

/**
 * The optional Letterboxd step: *Already use Letterboxd?*, between *Your First Five* and
 * People (founder, preview QA Round 3, 2026-09-13).
 *
 * ---------------------------------------------------------------------------
 * WHY A STEP, AND NOT THE CARD IT REPLACES
 *
 * Round 2 put a card under the five that named Settings. The founder finished onboarding
 * without noticing it, which is the failure a passive pointer has: it can only be found by
 * somebody already looking. So the question gets a screen of its own, after the payoff
 * rather than on it. The ranking loop still ends on *Your First Five* with one action, and
 * this is what Continue opens.
 *
 * **Never required.** *Not now* is on the screen from the first frame and on every state
 * short of an accepted import, and it carries on to People exactly as Continue does.
 *
 * ---------------------------------------------------------------------------
 * THE REAL IMPORTER, DRAWN HERE
 *
 * `ImportScreen` in its `onboarding` mode: the same `useImport` machine, picker, reader,
 * preview, upload and job as Settings, with no second parsing path. It is drawn inside this
 * route because it cannot be navigated to: `nextRoute` answers any group other than
 * `onboarding` with the current stage's route while the flow is unfinished, so a push to
 * `/settings/import` from here would be replaced straight back.
 *
 *   question -> picker -> reading -> preview -> uploading -> accepted (Continue)
 *        \          \ cancelled: back to the question, both answers live
 *         Not now    \ refused file: the importer's own explanation, plus Not now
 *
 * **The step lets go at acceptance, not at completion.** Once `import_ready` succeeds the
 * work is a server job on a cron tick, so the screen says it carries on in the background
 * and that we will say when it is done, and offers Continue. Nothing on the way out touches
 * the job: `leave` below is analytics, a dispatched stage write and a `replace`. Unmounting
 * cancels only this screen's poll. `import_discard` is reachable only through the
 * importer's own *Start over*, and the server refuses it for any job past `pending`.
 *
 * **No await between a press and the navigation.** `advance` records the stage in memory
 * synchronously and dispatches the Keychain write (`use-onboarding-stage.ts`), so there is
 * nothing here for `withGrace` to bound.
 *
 * ---------------------------------------------------------------------------
 * RELAUNCH, AND AN IMPORT ALREADY RUNNING
 *
 * The stage is `letterboxd` from the moment this screen is reached, so a relaunch comes
 * back here. `useImport` looks for the account's live job on open (`findLiveJob`), so a
 * running import is shown as running with Continue, rather than as a question inviting a
 * second one — and if somebody picks a file anyway, `import_create` hands back the open
 * job and the importer says one is already running instead of staging onto it.
 *
 * The lost-stage fallback in `nextRoute` still resumes at **People**, not here. It exists to
 * stop the social half being skipped when the stage preference is lost; an optional step
 * being passed over in that already-degraded case costs nothing, and Settings still has it.
 *
 * ---------------------------------------------------------------------------
 * BACK
 *
 * The same as every other step of the flow: nothing is intercepted. The screen is reached
 * by `replace`, so there is nothing behind it in the stack; Android's hardware back leaves
 * the app the way it would on People, and the next launch resumes on this step with any
 * import still running. Intercepting it to walk the importer backwards would put a second
 * meaning on one gesture mid-upload, which `ImportScreen`'s header already refuses.
 *
 * ---------------------------------------------------------------------------
 * A NOTIFICATION TAPPED BEFORE ONBOARDING IS FINISHED
 *
 * An import's lifecycle push opens `/settings/import?job=<id>` (`routing.ts`, via
 * `usePush`, which acts on a tap once and clears it). While the stage is unfinished,
 * `nextRoute` answers the `settings` group with `STAGE_ROUTES[stage]` — this step or a later
 * one — and answers the onboarding group with `null`. So the tap costs one `replace` back
 * into the flow and ends there: the destination is a fixed point, the response has been
 * cleared so nothing pushes again, and there is no loop (`routing.test.tsx` pins both
 * halves). If the stage is this one, the step then finds the job itself. Once onboarding is
 * `done` the same link opens Settings ▸ Import on that job, as it always has.
 */
export default function LetterboxdStepScreen() {
  const router = useRouter();
  const profile = useCurrentProfile();
  const advance = useAdvanceStage(profile.id);

  /**
   * One exit per visit. `Button` has no press guard, and two taps in a frame would count
   * the step twice; the second `replace` would be harmless, the second event would not.
   */
  const left = useRef(false);

  const leave = (outcome: 'continued' | 'skipped') => {
    if (left.current) return;
    left.current = true;
    track({ name: 'onboarding_step_completed', props: { step: 'letterboxd', outcome } });
    advance('people');
    router.replace('/onboarding/people');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ImportScreen
        surface="onboarding"
        onboarding={{ header: <OnboardingHeader step="letterboxd" />, onLeave: leave }}
      />
    </>
  );
}
