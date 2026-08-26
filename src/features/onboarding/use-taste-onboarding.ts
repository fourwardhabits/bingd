import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { track } from '@/lib/analytics';
import { readPref, writePref } from '@/lib/prefs';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/**
 * Whether this account should be shown the first-run taste flow, and how far it got.
 *
 * **The progress is the data, not a counter.** How many films someone has ranked is a
 * fact about `rankings`, so closing the app halfway through leaves nothing to restore:
 * reopening asks the same question and gets the same answer. A local step counter would
 * be a second copy of that fact, free to disagree with it — and it would disagree the
 * first time somebody ranked a film from the Log tab instead.
 *
 * **An account with anything in it never enters.** The test is any ranking or any logged
 * title at all, not zero rankings alone: somebody who logged four films without ranking
 * them has a collection, and dropping them into "build your taste" would be the app
 * telling an existing user it has never met them.
 */
export const FIRST_FIVE = 5;

/**
 * How long the first-run check may hold the whole app before it is answered for.
 *
 * Four seconds because this is a *local* decision about one account, not a page of
 * content: two indexed counts and a Keychain lookup. Anything past this is not slow, it
 * is stuck — and the cost of it being stuck is the entire app, not this one question.
 */
const FIRST_RUN_GRACE_MS = 4000;

/**
 * What the app assumes about an account it could not ask about in time.
 *
 * The same answer a failure already routes to, for the reason `useTasteOnboarding`
 * records: a genuinely new account loses a suggestion, and the alternative is every
 * account losing the app.
 */
const UNKNOWN: TasteOnboarding = { ranked: 0, needed: false };

/**
 * The read, with a deadline — and **a rejection is still a rejection**.
 *
 * Deliberately not `withGrace`, which is the house helper for this shape and is wrong
 * here by exactly one case: it resolves a *failure* to the fallback as well as a hang.
 * That would quietly convert "could not find out" into "found out: not needed", and this
 * query is pinned for the session (`staleTime: Infinity`), so the lie would last as long
 * as the process. Routing already handles the error state correctly — an undefined
 * `needed` is falsy and sends the person to the feed — so there is nothing to gain by
 * hiding it, and an error is the only signal anything upstream has that the backend is
 * unreachable.
 *
 * Only the *silence* is answered for, which is the case nothing else can recover from.
 */
function withDeadline(work: Promise<TasteOnboarding>): Promise<TasteOnboarding> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(UNKNOWN), FIRST_RUN_GRACE_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Which phase of the first-run flow this device believes the account is in.
 *
 * This exists because "is this account new" stops being true the moment the flow does
 * its job. The first film bucketed writes a `user_media` row, so a test of "has nothing
 * in it" answers *no* from film one onward — and independent review found exactly what
 * that costs: the router saw an account that no longer needed onboarding, sitting on the
 * onboarding route, and sent it to the feed at 1 of 5. Closing the app after the first
 * film had the same effect on reopening, which is the resume requirement failing.
 *
 * So the *entry* decision is taken once and then remembered, and only progress is read
 * live afterwards:
 *
 * | phase | meaning |
 * |---|---|
 * | absent | never decided — ask the collection, once |
 * | `active` | in the flow; stay until five are placed or they leave |
 * | `done` | finished |
 * | `skipped` | said not now |
 *
 * Device-local, like the skip it replaces, and with the same trade recorded at
 * `useCompleteTasteOnboarding`: on a second device an account halfway through is read as
 * established and is not offered the rest. That is a worse outcome than a column would
 * give and a much smaller one than a schema change to the account table at this stage.
 */
const PHASE_PREF = 'onboarding.taste.phase';

export type TastePhase = 'active' | 'done' | 'skipped';

export type TasteOnboarding = {
  /**
   * Ranked movies, which is what the flow counts toward `FIRST_FIVE`.
   *
   * **Only meaningful while `needed` is true.** An account that has finished or declined
   * the flow is answered from the device without asking the server anything, so this
   * reads zero for them — see `readState`. Nothing displays it in that state: the screen
   * that draws the progress bar is not reachable once the flow has ended.
   */
  ranked: number;
  /** True when this account belongs in the flow — see `PHASE_PREF`. */
  needed: boolean;
};

const phaseKey = (userId: string) => `${userId}.${PHASE_PREF}`;

async function readState(userId: string): Promise<TasteOnboarding> {
  /**
   * Whether *this process* has already been in the flow, which is a different question
   * from what the disk says and the difference is load-bearing below.
   *
   * `begin()` puts `active` here on arrival, so it is set for the whole of a live flow and
   * absent on every fresh launch. That is exactly the seam needed to tell "somebody is
   * ranking films right now" from "an account was left marked as ranking films, once,
   * some time ago".
   */
  const remembered = intent.get(userId);

  // Memory first: a decision taken in this process outranks whatever the disk holds,
  // because the write that would have updated the disk may have failed.
  const phase = remembered ?? (await readPref<TastePhase>(phaseKey(userId)));

  /**
   * **Already decided, and the decision is the whole answer — so nothing is asked.**
   *
   * This ordering is the fix for independent review 48's blocker, and the old order is
   * what made it one. The counts used to be awaited *first*, unconditionally, and only
   * then was the phase consulted — so every launch of every established account spent two
   * PostgREST round trips proving something the Keychain already knew. `nextRoute` blocks
   * on this query, so those two requests sat between a cold start and the first screen of
   * the app, on the overwhelmingly common path where their answer could not change
   * anything. Bounding that wait made it survivable; taking the network out of it is what
   * makes it not a wait.
   *
   * What remains on the critical path is one local preference read, and it stays there
   * because it is not optional: it is the answer to *which screen this person belongs
   * on*, and there is no useful UI to show somebody until that is known.
   */
  if (phase === 'done' || phase === 'skipped') return { ranked: 0, needed: false };

  const [
    { count: rankedCount, error: rankedError },
    { count: loggedCount, error: loggedError },
  ] = await Promise.all([
    supabase
      .from('rankings')
      .select('media_item_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('category', 'movies'),
    supabase
      .from('user_media')
      .select('media_item_id', { count: 'exact', head: true })
      .eq('user_id', userId),
  ]);

  if (rankedError) throw rankedError;
  if (loggedError) throw loggedError;

  const ranked = rankedCount ?? 0;
  const logged = loggedCount ?? 0;

  /**
   * **What the flow decided while these two counts were in the air.**
   *
   * Independent review 50's blocker, and it is a race this function acquired the moment it
   * gained a side effect. `phase` was captured before the awaits above; two PostgREST
   * round trips later it may be a fact about the past. In that window somebody can press
   * "Not now" — `complete()` records `skipped` in `intent` synchronously and dispatches its
   * write — and this read would then resume on its stale `active`, publish `needed: true`
   * over the `needed: false` completion just put in the cache, and dispatch a `done` that
   * lands *after* the `skipped` and wins, because same-key storage writes are serialized in
   * call order. The person's own answer, overwritten by a read that started before they
   * gave it.
   *
   * The same window is reachable after `withDeadline` has already answered `UNKNOWN` and
   * routing has moved on: nothing cancels this work, so it returns to a process that has
   * gone somewhere else.
   *
   * So the decision is re-read here, after the awaits and before anything is written or
   * returned. A flow that has ended since is simply ended — which is both the right answer
   * and the one the cache already holds.
   */
  const decidedSince = intent.get(userId);
  if (decidedSince === 'done' || decidedSince === 'skipped') {
    return { ranked, needed: false };
  }

  if (phase === 'active') {
    /**
     * **In it, in this process: stay until they leave, which is an explicit act and not a
     * count.**
     *
     * Deliberately not `ranked < FIRST_FIVE`. Tying it to the count gives the fifth
     * placement two jobs — completing the flow and dismissing it — and the second one
     * fires first: the screen would be sent to the feed at the moment it had a summary to
     * show. That is the same shape as the blocker review found in routing, one layer down,
     * and it is why leaving is `complete()` and nothing else.
     */
    if (remembered === 'active') return { ranked, needed: true };

    /**
     * **Resumed with the work already done: show the summary once more, and make sure it
     * is the last time.**
     *
     * The founder's device, 2026-08-26: five films ranked, a full collection, and *every*
     * launch landing on "That is a start". `active` is written on arrival and cleared only
     * by one of the screen's own exits — so every other way out leaves it set, and on
     * build 4 every other way out was the only one available: the exits hung, the account
     * switch did not clear it, and a force-quit does not either. The account was pinned to
     * a first-run flow it had already finished, with the one door out being a button that
     * had already failed it once.
     *
     * The resume itself is not the bug and is deliberately kept. A crash during the
     * notification step is supposed to land back on a summary whose buttons can finish the
     * job — that is a recovery path with its own tests, and removing it would trade one
     * stranding for another. What was missing is that the recovery had no way to *end*: if
     * the exit fails again, or is never pressed, the next launch is identical, forever.
     *
     * So the phase is settled here, on arrival, rather than only by the button. This
     * launch is unchanged — the summary draws, both buttons work, and pressing one records
     * the same `done` it always did. The next launch opens the app. One repeat, never two,
     * whatever happens to the press.
     *
     * **`intent` is set as well, and that half is not bookkeeping.** The screen refetches
     * this query to move its progress bar, so without it the very next read would find the
     * `done` just written, answer `needed: false`, and the summary would unmount with the
     * ranking step drawn in its place — five of five placed, under "The first one needs no
     * comparison". That is precisely the defect `exiting` was added to `taste.tsx` to
     * prevent, reintroduced from underneath. Marking the flow live for the rest of the
     * process pins this session's answer to the one it has already given, while the disk
     * carries the decision to the next launch.
     *
     * The disk write is not awaited and cannot reject: a repair that does not land is a
     * launch that repeats it, which is the state this branch already handles.
     */
    if (ranked >= FIRST_FIVE) {
      intent.set(userId, 'active');
      void writePref<TastePhase>(phaseKey(userId), 'done').catch(() => {});
    }

    return { ranked, needed: true };
  }

  // Never decided. This is the only place the collection decides, and it decides once:
  // any ranking or any logged title at all means an account that has been used, and
  // dropping that person into "build your taste" is the app telling somebody with a
  // collection that it has never met them.
  return { ranked, needed: ranked === 0 && logged === 0 };
}

/**
 * Read once and then left alone for the session.
 *
 * `staleTime: Infinity` is doing real work here rather than saving a round trip. The
 * flow's own ranking writes invalidate the collection keys, and if this query followed
 * them it would answer "no longer needed" the moment the first film was placed — which
 * would evict the user from the screen they were halfway through. The decision to be
 * *in* the flow is taken once, on arrival; `ranked` is refetched deliberately by the
 * screen to move the progress bar.
 *
 * A failure stays a failure, and `nextRoute` is what turns it into "not needed": an
 * undefined `needed` is falsy there, so a broken connection sends somebody to the feed
 * rather than into a five-step flow they have already completed. Deliberately *not*
 * resolved to a value here, which is what this used to say — under `staleTime: Infinity`
 * that would pin "I asked and the answer was no" for the whole session, and an error is
 * the only signal anything upstream has that the backend is unreachable.
 *
 * **A wait that has stopped being a wait is a different case**, and it is half of the
 * founder's blank startup. `nextRoute` deliberately moves nobody while this is pending —
 * `if (tastePending) return null` — so until it settles the only route the navigator has
 * is `/`. That is right when the check costs the ~170ms it costs against a healthy
 * backend, and unrecoverable when it costs forever: `readState` awaits two PostgREST
 * counts and a Keychain read, none of which the platform promises to ever settle, and
 * `retry: false` means nothing asks again. One hung Keychain call and the app never
 * routes anywhere for the life of the process.
 *
 * The bound is `withDeadline` rather than the house `withGrace`, because a failure must
 * stay a failure — see there. Nothing is cancelled at the deadline either; a late answer
 * simply finds nobody waiting on it, and the only thing given up is holding the navigator
 * hostage to it.
 */
export function useTasteOnboarding(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasteOnboarding(userId ?? 'none'),
    enabled: Boolean(userId) && enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: () => withDeadline(readState(userId!)),
  });
}

/**
 * What this process has decided, whatever storage managed to record.
 *
 * `writePref` is SecureStore and can fail. Independent review found what that cost when
 * the decision lived only on disk: "Not now" wrote nothing, the query refetched, the
 * account still looked new, and routing sent the user straight back to the screen they
 * had just declined — a loop produced by a failure to persist a preference.
 *
 * So an intent recorded here is authoritative for the life of the process, and the write
 * is how it *outlives* the process. A failed write no longer breaks the current session;
 * it only means the flow may be offered once more on a future launch, which is the same
 * class of limitation as the device-local storage itself.
 *
 * Module-level rather than a ref, because `complete` and `begin` are called from
 * different components and both must see it. Keyed by account, so two accounts on one
 * device cannot read each other's.
 */
const intent = new Map<string, TastePhase>();

/** Exported for tests, which must not inherit a decision from the previous one. */
export function resetTasteIntent() {
  intent.clear();
}

/**
 * Ends the flow, from either exit: five films placed, or "not now".
 *
 * The phase is recorded on the device rather than in the database, which is a real
 * limitation and a deliberate one. A column would be the durable answer and would cost a
 * migration, an RLS write path and a review, for a flag whose only job is to stop one
 * screen reappearing. The consequence of getting it wrong on this side is small and
 * recoverable: somebody who skipped and then reinstalls is offered the flow once more,
 * and can skip it again. The consequence on the other side — a schema change to the
 * account table this late — is not proportionate to that.
 */
export function useCompleteTasteOnboarding(userId: string) {
  const queryClient = useQueryClient();

  return useCallback(
    async ({ skipped }: { skipped: boolean }) => {
      const phase: TastePhase = skipped ? 'skipped' : 'done';

      /**
       * `onboarding_completed`, from the one function all three exits go through.
       *
       * The screen has three of them — the summary's two buttons and "Not now" — and an
       * event per button is three places for a fourth exit to be forgotten later.
       *
       * **Guarded on the flow having already *ended*, not on `intent` being set at all.**
       * `begin()` puts `active` in that map on arrival, so `intent.has` is true for the
       * whole of a normal flow and testing it would suppress every real completion. What
       * has to be excluded is a second *ending*: two of the three exits are buttons
       * sitting side by side on the summary, and one person pressing both must not report
       * two completions.
       *
       * `titles_ranked` is read from the cache rather than refetched. It is what the
       * progress bar was showing when they left, which is the number the event is about.
       */
      const ended = intent.get(userId);

      // Synchronously, and before the write is awaited. `begin` checks this immediately
      // before its own write, which is what closes the race review found: begin reads an
      // absent phase, the user presses "Not now", complete writes `skipped`, and begin's
      // in-flight write then puts `active` back on top of it.
      //
      // And before the analytics call, which is the build-4 hotfix's ordering rule: the
      // decision that ends the flow is state the router depends on, so it is recorded
      // before anything that can fail. An exit that died between the button and this
      // line was an exit that never happened — the person stayed "active" and was held
      // on the screen they had just left.
      intent.set(userId, phase);

      // The session honours the choice whether or not the disk does.
      queryClient.setQueryData(
        queryKeys.tasteOnboarding(userId),
        (previous?: TasteOnboarding) => ({
          ranked: previous?.ranked ?? 0,
          needed: false,
        }),
      );

      /**
       * **The durable write is dispatched here, before the analytics call, and that
       * ordering is the point rather than tidiness.**
       *
       * The rule this function already states two comments up — "the decision that ends
       * the flow is state the router depends on, so it is recorded before anything that
       * can fail" — was applied to the *memory* copy and not to the disk one. `track`
       * reaches a third-party SDK, and a synchronous throw there landed between the
       * decision and the only copy of it that survives a launch: the person exits, the
       * exit works, and the next launch puts them back on "That is a start" because the
       * Keychain was never told.
       *
       * Dispatched rather than awaited, for the reason `taste.tsx` records at `finish`:
       * the write is handed to the platform before this returns, and awaiting it would
       * only make the screen watch it happen while somebody waits on a button press.
       */
      const written = writePref<TastePhase>(phaseKey(userId), phase).catch(() => {});

      if (ended !== 'done' && ended !== 'skipped') {
        track({
          name: 'onboarding_completed',
          props: {
            skipped,
            titles_ranked:
              queryClient.getQueryData<TasteOnboarding>(queryKeys.tasteOnboarding(userId))
                ?.ranked ?? 0,
          },
        });
      }

      await written;
    },
    [queryClient, userId],
  );
}

/**
 * Marks the account as in the flow, on arrival.
 *
 * Written from the screen rather than from `readState`, so the query stays a read. It is
 * what makes the rest of the flow — and a resume after the app is closed — independent of
 * the "has nothing in it" test that the first film invalidates.
 *
 * It refuses to write over a decision that has already been taken, in memory or on disk.
 * Both checks are needed: disk is what survives a launch, and memory is what survives the
 * gap between this function's own read and its own write.
 */
export function useBeginTasteOnboarding(userId: string) {
  return useCallback(async () => {
    if (intent.has(userId)) return;

    const stored = await readPref<TastePhase>(phaseKey(userId)).catch(() => null);
    if (stored || intent.has(userId)) return;

    intent.set(userId, 'active');
    await writePref<TastePhase>(phaseKey(userId), 'active').catch(() => {});
  }, [userId]);
}
