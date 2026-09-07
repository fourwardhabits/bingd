import { useCallback } from 'react';
import { useRouter } from 'expo-router';

/** One thing worth celebrating. Awards first, then the streak — see `drain`. */
export type Celebration =
  { kind: 'award'; awardKey: string; tierKey: string } | { kind: 'streak'; weeks: number };

/**
 * What a finished ranking earned, waiting for the flow to end.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT COMPONENT STATE
 *
 * The celebration shipped attached to one exit — the Reveal's **Done** — and the founder
 * physically ranked something, earned an award, and never saw it. That is the whole
 * defect and the cause is structural rather than a bug in the detection: ranking has
 * three exits, and *Add details* is the one that continues into the log sheet. A reader
 * who takes it finishes their ranking somewhere `RankingSheet` no longer exists to
 * notice, so the payoff was held by a component that had already unmounted.
 *
 * A module-level queue is what survives that. `RankingSheet` detects and enqueues;
 * whichever surface the reader actually finishes on drains it. Nothing has to thread a
 * callback through three screens, and a fourth entry point gets this right by doing
 * nothing.
 *
 * **It holds nothing durable and grants nothing.** The award was written by a database
 * trigger inside the ranking's own transaction; this is a display hand-off. Losing it —
 * a reload, a crash, a cold start — costs a celebration and nothing else, and the
 * congratulations notification is the durable second door.
 * ---------------------------------------------------------------------------
 */
let pending: Celebration[] = [];

/** The key that makes one celebration the same as another, for de-duplication. */
const identity = (item: Celebration) =>
  item.kind === 'award' ? `award:${item.awardKey}:${item.tierKey}` : 'streak';

/**
 * Add to the queue, ignoring anything already in it.
 *
 * De-duplicated because two exits can enqueue the same detection: the ranking sheet
 * hands off to the log sheet, and both are places a reader can finish. Celebrating one
 * award twice in a row is the failure this makes impossible.
 *
 * **At most one streak entry**, whatever is passed. A streak is a state rather than an
 * event, and two of them in one queue would be the same fact counted twice.
 */
export function enqueueCelebrations(items: readonly Celebration[]) {
  const seen = new Set(pending.map(identity));
  for (const item of items) {
    const key = identity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(item);
  }
}

/** Everything waiting, removed from the queue. */
export function takeCelebrations(): Celebration[] {
  const items = pending;
  pending = [];
  return items;
}

/** Whether anything is waiting, without consuming it. */
export const hasCelebrations = () => pending.length > 0;

/** Empty it without showing anything — sign-out, and the tests. */
export const clearCelebrations = () => {
  pending = [];
};

/**
 * The route parameters for a queue, or null when there is nothing to show.
 *
 * Two parameters rather than one opaque blob, because the award half has to stay
 * exactly what the notification deep link already sends — `awards=lol-mode:giggle`
 * (`features/notifications/routing.ts`) — and a shape change there would strand every
 * notification already written.
 */
export function celebrationParams(
  items: readonly Celebration[],
): { awards?: string; streak?: string } | null {
  const awards = items
    .filter((item): item is Extract<Celebration, { kind: 'award' }> => item.kind === 'award')
    .map((item) => `${item.awardKey}:${item.tierKey}`);
  const streak = items.find((item) => item.kind === 'streak');

  if (!awards.length && !streak) return null;
  return {
    ...(awards.length ? { awards: awards.join(',') } : {}),
    ...(streak ? { streak: String(streak.weeks) } : {}),
  };
}

/**
 * Drain the queue into the celebration screen, if there is anything in it.
 *
 * Called from every place a post-ranking flow can end. Doing nothing when the queue is
 * empty is the ordinary case and the important one: a reader who earned nothing sees the
 * flow they have always seen, and this costs one array length check.
 */
export function useCelebrationHandoff() {
  const router = useRouter();

  return useCallback(() => {
    const params = celebrationParams(takeCelebrations());
    if (!params) return;
    router.push({ pathname: '/awards/celebrate', params });
  }, [router]);
}
