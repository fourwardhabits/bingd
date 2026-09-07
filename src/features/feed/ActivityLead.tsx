import type { ReactNode } from 'react';

import { AwardActivityLead } from '@/features/awards/AwardActivityLead';
import { GoalActivityLead } from '@/features/goals/GoalActivityLead';

import type { FeedItem } from './use-feed';

/**
 * The leading artwork for one activity row, wherever that row is drawn.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION RATHER THAN THREE COPIES OF AN EXPRESSION
 *
 * The founder's physical-QA pass found the same earned award wearing two faces: "Suraj
 * Kandukuri earned the Spark award" led with the Spark artwork in the Feed and with a
 * beige tile reading **S** on their own profile. One event, two surfaces, two pictures.
 *
 * The cause was not missing data. All three surfaces read the *same* `FeedItem` from the
 * *same* `activityPage` call — `event.award` was populated on the profile exactly as it
 * was in the feed. Only the feed passed `lead`, so `ActivityRow` fell back to
 * `<Poster uri={null}>`, and `MissingArtwork` did what it is supposed to do with a title
 * and no artwork: drew the initial. An award row has no poster and never will, so that
 * fallback was always going to be wrong there.
 *
 * The fix is not "give the profile an award icon". It is to stop three call sites each
 * deciding what leads a row, because that decision is a property of the *activity*, not
 * of the screen it is on. A fourth surface gets this right by construction now, and
 * `ActivityLead.test.tsx` asserts that the feed and the profile resolve to the same
 * component for the same event.
 * ---------------------------------------------------------------------------
 *
 * `undefined` — not null — for an ordinary row, because `ActivityRow` reads
 * `lead ?? <Poster …>` and only `undefined` and `null` reach that fallback identically;
 * returning nothing is the clearer statement of "this row leads with its poster".
 *
 * **The order is award, then goal, then poster, and it cannot be ambiguous**: an event
 * carries `award` only when it is `award_earned` and `goal` only when it is
 * `goal_completed` (20260828000100, 20260829000200), so at most one is ever present.
 */
export function activityLead(event: FeedItem): ReactNode | undefined {
  if (event.award) {
    return <AwardActivityLead awardKey={event.award.key} tierKey={event.award.tierKey} />;
  }
  if (event.goal) return <GoalActivityLead />;
  return undefined;
}
