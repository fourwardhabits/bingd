import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';
import { BrandLockup } from '@/ui/components';

/**
 * The chrome every step of the first-run flow shares, from the profile form onward.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE COMPONENT AND NOT A HEADER PER SCREEN
 *
 * Every step draws it, the notification question included. A copy each is six places for
 * the progress to be given a different height, or for one screen to quietly keep a back
 * button the flow no longer has. The flow's chrome rules are short enough to state once and are stated here
 * (`01-screen-map.md` §4):
 *
 * - **No bottom tab bar anywhere in onboarding.** The tabs belong to the app, and a
 *   person who has not finished signing up has nowhere to go with them.
 * - **No notification bell**, before the last step or after it. The bell belongs to the
 *   app too.
 * - **The mark and the wordmark, centred.** Sign in carries the lockup in its content
 *   instead, at the top left, because it is a brand moment rather than a chrome moment,
 *   and it does not render this.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROGRESS IS FOUR SEGMENTS AND NOT A COUNT (Onboarding 2.0, OB-2, 2026-11-14)
 *
 * A flow this long has to say that it ends. What it must not do is say *how far away* the
 * end is in units somebody can dread: "step 2 of 5" turns an introduction into a form
 * with three more pages, and it is wrong the moment a screen is added or removed — which
 * has now happened twice.
 *
 * The founder's approved mockup replaces the single 2pt line over six screens with **four
 * equal segments over the four parts of the flow** — Profile, First Five, History, Friends
 * — so the promise is made in parts a reader can picture, still without a number on
 * screen. Screens map onto parts (`segmentsFilled`), so a part with two screens does not
 * move the bar twice, and the notification step fills the last segment: the finale. It is
 * deliberately not the picker's five pips: those count something real — five movies
 * placed — and only read correctly beside this because the two look nothing alike.
 *
 * The bar is hidden from assistive technology. Each step already announces itself by its
 * own heading; see the note in `OnboardingHeader` on the label it carries.
 */

/**
 * The steps a header can be drawn on, in flow order.
 *
 * Unchanged by Onboarding 2.0, so no call site moves: `rank` is the picker, `payoff` is
 * Your First Five, and `letterboxd` keeps the stored stage's name for the optional import.
 * What changed is what they are measured *against* — see `SEGMENTS`.
 *
 * ---------------------------------------------------------------------------
 * **THREE STEPS LEFT IN 2026-09-09** (founder, physical iOS 1.0.1 build 9)
 *
 * `motivations` and `answers` were the two screens that explained the product before the
 * product had done anything, and both are gone with their stages — the flow teaches
 * itself by ranking. `pick` went for a different reason: choosing and ranking are no
 * longer two halves of the run, they are one loop repeated five times
 * (`app/onboarding/taste.tsx`).
 *
 * `letterboxd` (2026-09-13) is the optional import step after the payoff.
 */
export const FLOW_STEPS = [
  'profile',
  'rank',
  'payoff',
  'letterboxd',
  'people',
  'notifications',
] as const;

export type FlowStep = (typeof FLOW_STEPS)[number];

/**
 * The four parts of the flow the header shows, in order (Onboarding 2.0, OB-2, 2026-11-14).
 *
 * The founder's approved mockup: four equal segments named for what each part is for —
 * Profile, First Five, History, Friends — rather than one line divided by six screens. The
 * names are for this file and the tests; nothing draws them, for the reason the header's
 * note gives about counts.
 */
export const SEGMENTS = ['Profile', 'First Five', 'History', 'Friends'] as const;

/**
 * How many of the four segments are filled on a step.
 *
 * The step being drawn counts as done, so the first screen already shows movement — an
 * empty bar on the screen somebody is looking at reads as broken rather than as early.
 * The picker and the payoff are both the First Five; the import is History; People and
 * the notification question are both Friends, and the notification step is the **finale**:
 * the bar is full there, which is the visible end of the flow.
 *
 * Exported so the mapping can be asserted without a render.
 */
export function segmentsFilled(step: FlowStep): number {
  switch (step) {
    case 'profile':
      return 1;
    case 'rank':
    case 'payoff':
      return 2;
    case 'letterboxd':
      return 3;
    case 'people':
    case 'notifications':
      return 4;
  }
}

/**
 * How full the header is on a step, as a fraction. Kept for the callers and tests that
 * read progress as a number; it is `segmentsFilled` over the four segments.
 */
export function flowProgress(step: FlowStep): number {
  return segmentsFilled(step) / SEGMENTS.length;
}

/**
 * The segments' thickness. Local and named, the way the single line's 2 was: there is no
 * token for a progress-bar height, and one sized for a bar of four parts (3pt, so each
 * segment reads as a shape rather than a hairline) is not a value anything else should
 * borrow.
 */
const SEGMENT_HEIGHT = 3;

export type OnboardingHeaderProps = {
  /** Which step is being drawn, which is all the progress needs. */
  step: FlowStep;
};

export function OnboardingHeader({ step }: OnboardingHeaderProps) {
  const filled = segmentsFilled(step);
  return (
    <View>
      {/**
       * **Hidden from assistive technology, as the line was, and labelled anyway.**
       *
       * Every step announces itself by its own title, and "Step 4 of 4" spoken on both
       * People and the notification question would be a second, competing heading — and a
       * wrong one on the finale, which is not a step of its own. So the row stays hidden;
       * the label is on the wrapper so the count is stated in one place should a later
       * pass decide to expose it.
       */}
      <View
        style={styles.segments}
        accessibilityLabel={`Step ${filled} of ${SEGMENTS.length}`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="onboarding-progress"
      >
        {SEGMENTS.map((name, index) => (
          <View
            key={name}
            testID={index < filled ? 'onboarding-segment-filled' : 'onboarding-segment-empty'}
            style={[styles.segment, index < filled ? styles.filled : styles.empty]}
          />
        ))}
      </View>
      <View style={styles.brand}>
        <BrandLockup size="sm" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    gap: theme.space[1],
    paddingHorizontal: theme.layout.gutter,
  },
  segment: { flex: 1, height: SEGMENT_HEIGHT, borderRadius: theme.radius.control },
  filled: { backgroundColor: theme.semantic.score },
  empty: { backgroundColor: theme.border.hairline },
  brand: { alignItems: 'center', paddingVertical: theme.space[3] },
});
