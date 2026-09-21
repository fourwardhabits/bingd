import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { theme } from '@/ui/tokens';

import { OnboardingFooter } from './OnboardingFooter';

/**
 * The onboarding CTA clears the system's own navigation (founder QA, Android, 2026-09-21).
 *
 * The real `SafeAreaView` is native and pads nothing under jest, so the inset is supplied
 * directly: the stable-inset hook is the one input the footer reads, and these are the
 * values each Android navigation mode reports under edge-to-edge.
 */
let mockInset = 0;
jest.mock('@/ui/components/use-stable-bottom-inset', () => ({
  useStableBottomInset: () => mockInset,
}));

const bottomPadding = async (inset: number) => {
  mockInset = inset;
  const view = await render(
    <OnboardingFooter>
      <Text>Continue</Text>
    </OnboardingFooter>,
  );
  return StyleSheet.flatten(view.getByTestId('onboarding-footer').props.style).paddingBottom;
};

describe('the onboarding footer', () => {
  it('keeps the spacing it always had on a device that reports no bottom inset', async () => {
    // `space[3]` under the last control, exactly as the old `paddingVertical` gave — no floor
    // added on top, which is what `Screen`'s `includeBottomInset` would have done.
    expect(await bottomPadding(0)).toBe(theme.space[3]);
  });

  it('clears the gesture handle strip', async () => {
    expect(await bottomPadding(24)).toBe(theme.space[3] + 24);
  });

  it('clears the whole three-button navigation bar', async () => {
    // The founder's device: Back / Home / Recents under the Continue button.
    expect(await bottomPadding(48)).toBe(theme.space[3] + 48);
  });

  it('clears an iPhone home indicator the same way', async () => {
    expect(await bottomPadding(34)).toBe(theme.space[3] + 34);
  });
});
