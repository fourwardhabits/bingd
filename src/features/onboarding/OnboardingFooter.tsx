import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '@/ui/tokens';
import { useStableBottomInset } from '@/ui/components/use-stable-bottom-inset';

/**
 * The fixed call to action at the foot of an onboarding step, held above the system's own
 * navigation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (founder QA, Android, 2026-09-21)
 *
 * On *Start your Feed* the Continue button sat partly **behind Android's three-button
 * navigation bar**. The onboarding steps render `<Screen>` with its default of no bottom
 * inset — the right default for a tab screen, whose tab bar owns that inset, and the wrong
 * one here, where there is no tab bar and Android draws edge-to-edge. The same footer shape
 * was on three screens: *Start your Feed* and both of the taste run's footers (the picker's
 * *Not now* and the payoff's *Continue*).
 *
 * The inset is added **to the footer's own bottom padding**, and nothing else:
 *
 *   - a device that reports no bottom inset (older Android, a simulator) keeps exactly the
 *     spacing it had, `space[3]` under the last button — `Screen`'s `includeBottomInset`
 *     would have added a 16px floor on top, which is not what those devices looked like;
 *   - three-button navigation reports its full bar height and the button clears it;
 *   - gesture navigation reports the handle's strip and the button clears that;
 *   - an iPhone's home indicator is cleared the same way, which it was not before either.
 *
 * `useStableBottomInset` rather than the live inset: the live value moves when a keyboard
 * opens, and a footer that jumps while somebody types a search is the page-jump defect this
 * app has already fixed once (`use-stable-bottom-inset.ts`).
 *
 * The footer is a sibling *after* the step's `ScrollView`, never inside it, so on a short
 * screen or with a large system font the content above scrolls and the CTA stays put.
 */
export function OnboardingFooter({ children }: { children: ReactNode }) {
  const bottomInset = useStableBottomInset();

  return (
    <View
      testID="onboarding-footer"
      style={[styles.footer, { paddingBottom: theme.space[3] + bottomInset }]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    gap: theme.space[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border.hairline,
  },
});
