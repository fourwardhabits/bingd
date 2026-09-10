import { withGrace } from '@/lib/grace';
import { readPref, writePref } from '@/lib/prefs';

/**
 * How many movies the first run asks for, and how that run ended.
 *
 * ---------------------------------------------------------------------------
 * THE SELECTION STORE THAT USED TO LIVE HERE IS GONE (2026-09-09)
 *
 * This file was written for a flow that chose five movies and *then* ranked all five, so
 * the five choices were a decision the reader had made that the database had no record of
 * until each one was ranked. Losing them meant somebody who closed the app after ranking
 * two came back to an empty grid, two of which they had already done. The list was
 * therefore written to the device, with an ordered, coalesced write chain to stop a
 * deselect landing after the replacement that followed it.
 *
 * The founder's rebuild of the flow removed the thing being protected. Choosing and
 * ranking are one loop now — pick, rank, pick, rank — so at most **one** movie is ever
 * chosen and not yet ranked, and the honest thing to do with it on a relaunch is to
 * offer the picker again. Progress is `rankings`, which survives anything a preference
 * could, and `app/onboarding/taste.tsx` records why reopening on the picker is the only
 * resume that cannot strand anybody.
 *
 * So the store, its write chain and its sequence counter are deleted rather than left
 * unread. What remains is the target and the outcome — the two facts about the run that
 * outlive the screen.
 */
export const PICK_TARGET = 5;

/**
 * Whether the reader finished the ranking half or left it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS RECORDED RATHER THAN DERIVED AT THE END
 *
 * `onboarding_completed.skipped` used to be computed on the notification step, from the
 * taste query's ranked count: `(state.data?.ranked ?? 0) < FIRST_FIVE`. CI caught what
 * that costs, and it is a reporting defect rather than a test one.
 *
 * The count is a *query*, and the notification step can mount before it has answered — on a relaunch
 * straight onto the notification step it always does. An unanswered query is `undefined`,
 * `?? 0` turns that into zero, and zero is below five, so **an account that ranked all
 * five reports itself as a skip**. The direction matters: the flow's most important
 * success metric would have been systematically under-counted, and the failure is silent
 * because the event still fires and still looks well formed.
 *
 * So the outcome is written where it is actually known — by the screen that watched it
 * happen, at the two exits that are the only ways past the ranking run — and read back as
 * a fact. Memory-first like every other preference here, so within one session the write
 * and the read are the same process and there is no race at all.
 *
 * ---------------------------------------------------------------------------
 * AND UNKNOWN STAYS UNKNOWN
 *
 * There is a third answer and it is a real one: a relaunch onto the notification step for an account
 * whose outcome was never written, or whose preference cannot be read. It covers the
 * accounts that were already mid-flow when this shipped, and any device where the disk
 * write lost.
 *
 * The first version of this fix resolved that to `completed`, on the reasoning that
 * somebody who finished is the likelier explanation. That reasoning is sound as a *prior*
 * and wrong as a *record*. It replaces the previous silent bias with a quieter one in the
 * opposite direction — the flow's central success metric would count completions nobody
 * observed — and it is worse than the bug it replaces in one specific way: an
 * under-count is visible as a gap, while a manufactured completion is indistinguishable
 * from a real one and can never be subtracted back out afterwards.
 *
 * So this returns `unknown`, and `useCompleteTasteOnboarding` **omits** `skipped` rather
 * than guessing it — `sanitize` drops an undefined property, and an absent property is
 * already this file's convention for "not known" (see `PeopleStepVariant.could_not_load`,
 * which is an unreadable list given its own name rather than folded into an empty one).
 * A dashboard then sees three groups, one of which is honestly labelled.
 *
 * The *product* decision is separate and unchanged: an unknown outcome still ends the
 * flow as `done`, because the cost of the other mistake is putting somebody who has
 * already finished back through it. What is refused here is only the claim about what
 * happened, not the behaviour.
 */
const OUTCOME_PREF = 'onboarding.rankingOutcome';

/**
 * How long the last button of the flow may wait to learn how the ranking half ended.
 *
 * Shorter than the write grace beside it, because this one is in front of a person: it is
 * read between a press and a navigation, where the other two are behind one.
 */
const OUTCOME_READ_GRACE_MS = 2000;

export type RankingOutcome = 'completed' | 'skipped';

/** What a *read* can answer, which is the two above plus the honest third. */
export type RankingOutcomeRead = RankingOutcome | 'unknown';

const outcomeKey = (userId: string) => `${userId}.${OUTCOME_PREF}`;

const outcomes = new Map<string, RankingOutcome>();

/** Exported for tests, which must not inherit an outcome from the previous one. */
export function resetRankingOutcome() {
  outcomes.clear();
}

/** Records how the ranking half ended, in memory first and then on disk. */
export async function setRankingOutcome(
  userId: string,
  outcome: RankingOutcome,
): Promise<void> {
  outcomes.set(userId, outcome);
  await writePref<RankingOutcome>(outcomeKey(userId), outcome).catch(() => {});
}

/**
 * How the ranking half ended, or `unknown` when nothing recorded it.
 *
 * Only the two written words are believed. Anything else — absent, unreadable, or a value
 * from some future version this build does not know — is `unknown`, and the caller reports
 * it as unknown rather than picking the likelier of the two. See the header.
 */
export async function rankingOutcome(userId: string): Promise<RankingOutcomeRead> {
  const remembered = outcomes.get(userId);
  if (remembered) return remembered;

  /**
   * **Bounded, and the fallback is the honest word rather than a convenient one.**
   *
   * This sits between the last button of the flow and the navigation that button
   * promised, which is exactly the position the build-4 stranding occupied: three awaits
   * on promises the platform is allowed to never settle, each holding a screen shut for
   * good. `.catch` covers a read that *fails* and says nothing about one that hangs, and
   * a hung Keychain here would leave the reader pressing a dead button at the end of the
   * flow with the flow not yet marked finished.
   *
   * The grace costs nothing in the ordinary case, because the ordinary case never reaches
   * the disk at all: the write and the read are the same process, so `outcomes` has
   * already answered above. And a read that will not settle **is** an unknown outcome —
   * which is a sentence this function can now say, so the deadline does not have to be
   * paid for with a guess.
   */
  const stored = await withGrace(
    readPref<RankingOutcome>(outcomeKey(userId)),
    OUTCOME_READ_GRACE_MS,
    null,
  );
  if (stored === 'skipped' || stored === 'completed') return stored;
  return 'unknown';
}
