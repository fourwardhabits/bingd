import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';
import { BrandLockup } from '@/ui/components';

/**
 * The chrome every step of the first-run flow shares, from step 3 onward.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE COMPONENT AND NOT A HEADER PER SCREEN
 *
 * Six screens draw it. A copy each is six places for the progress line to be given a
 * different height, or for one screen to quietly keep a back button the flow no longer
 * has. The flow's chrome rules are short enough to state once and are stated here
 * (`01-screen-map.md` §4):
 *
 * - **No bottom tab bar anywhere in onboarding.** The tabs belong to the app, and a
 *   person who has not finished signing up has nowhere to go with them.
 * - **No notification bell**, before step 10 or after it. The bell belongs to the app too.
 * - **The mark and the wordmark, centred.** Steps 1 and 2 carry the lockup in their
 *   content instead, at the top left, because both are brand moments rather than chrome
 *   moments, and neither of them renders this.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROGRESS IS A LINE AND NOT A COUNT
 *
 * A flow this long has to say that it ends. What it must not do is say *how far away* the
 * end is in units somebody can dread: "step 3 of 10" turns an introduction into a form
 * with nine more pages, and it is wrong the moment a step is added or removed.
 *
 * A two-pixel line under the status bar makes the same promise without the arithmetic. It
 * is deliberately not the app's five-pip control: those count something real and countable
 * — five chosen, then five placed — and steps 6 and 7 draw them *as well*, which only
 * reads correctly because the two look nothing alike.
 *
 * The line is hidden from assistive technology. A bar with no label is noise to a screen
 * reader, and each step already announces itself by its own heading; a spoken "40 percent"
 * with no unit attached would be less informative than the silence.
 */

/**
 * The steps the line measures, in order.
 *
 * The opening and sign in are absent: this component is not drawn on either, and a
 * fraction that started counting before the account existed would be a promise the flow
 * had already broken by the time anybody could see it move.
 *
 * `notifications` is last and is what makes the bar full. Nothing follows it: onboarding
 * ends by opening the app, and there is no closing screen whose job is to announce that.
 */
export const FLOW_STEPS = [
  'motivations',
  'answers',
  'profile',
  'pick',
  'rank',
  'payoff',
  'people',
  'notifications',
] as const;

export type FlowStep = (typeof FLOW_STEPS)[number];

/**
 * How full the line is on a given step, as a fraction from just-started to complete.
 *
 * The step being *drawn* is counted as done, so the first screen already shows movement.
 * A bar that is empty on the screen somebody is looking at reads as broken rather than as
 * early, and the reader has in fact already done something to reach it.
 *
 * Exported so the arithmetic can be asserted without a render.
 */
export function flowProgress(step: FlowStep): number {
  return (FLOW_STEPS.indexOf(step) + 1) / FLOW_STEPS.length;
}

export type OnboardingHeaderProps = {
  /** Which step is being drawn, which is all the progress line needs. */
  step: FlowStep;
};

export function OnboardingHeader({ step }: OnboardingHeaderProps) {
  return (
    <View>
      <View
        style={styles.track}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {/* A percentage width rather than a measured one: the track is the full width of
            the screen, so there is nothing to measure and nothing to re-measure on a
            rotation or a font-size change. */}
        <View style={[styles.fill, { width: `${flowProgress(step) * 100}%` }]} />
      </View>
      <View style={styles.brand}>
        <BrandLockup size="sm" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 2, backgroundColor: theme.border.hairline, width: '100%' },
  fill: { height: 2, backgroundColor: theme.semantic.score },
  brand: { alignItems: 'center', paddingVertical: theme.space[3] },
});
