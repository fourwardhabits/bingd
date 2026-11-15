import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '@/ui/tokens';

import {
  FLOW_STEPS,
  OnboardingHeader,
  SEGMENTS,
  flowProgress,
  segmentsFilled,
  type FlowStep,
} from './OnboardingHeader';

/**
 * The 4-segment header (Onboarding 2.0, OB-2, 2026-11-14): Profile, First Five, History,
 * Friends, with screens mapped onto parts and the notification step as the full finale.
 */
describe('the onboarding header', () => {
  it('has four segments, in the founder’s order', () => {
    expect(SEGMENTS).toEqual(['Profile', 'First Five', 'History', 'Friends']);
  });

  it.each([
    ['profile', 1],
    ['rank', 2],
    ['payoff', 2],
    ['letterboxd', 3],
    ['people', 4],
    ['notifications', 4],
  ] as const)('fills %s to %i of 4', (step, filled) => {
    expect(segmentsFilled(step)).toBe(filled);
  });

  it('maps every step the header can be drawn on, and never goes backwards', () => {
    const filled = FLOW_STEPS.map((step) => segmentsFilled(step));
    expect(filled.every((n) => n >= 1 && n <= SEGMENTS.length)).toBe(true);
    for (let i = 1; i < filled.length; i += 1)
      expect(filled[i]).toBeGreaterThanOrEqual(filled[i - 1]!);
  });

  it('is full on the finale', () => {
    expect(flowProgress('notifications')).toBe(1);
  });

  const segments = async (step: FlowStep) => {
    const view = await render(<OnboardingHeader step={step} />);
    const hidden = { includeHiddenElements: true };
    return {
      view,
      filled: view.queryAllByTestId('onboarding-segment-filled', hidden),
      empty: view.queryAllByTestId('onboarding-segment-empty', hidden),
    };
  };

  it.each(FLOW_STEPS)('draws the %s step as filled and empty segments', async (step) => {
    const { filled, empty } = await segments(step);
    expect(filled).toHaveLength(segmentsFilled(step));
    expect(filled.length + empty.length).toBe(4);
  });

  it('draws segments from the tokens: score when filled, hairline when not', async () => {
    const { filled, empty } = await segments('letterboxd');
    const style = (node: (typeof filled)[number]) => StyleSheet.flatten(node.props.style);

    expect(style(filled[0]!)).toMatchObject({
      backgroundColor: theme.semantic.score,
      borderRadius: theme.radius.control,
      height: 3,
      flex: 1,
    });
    expect(style(empty[0]!)).toMatchObject({ backgroundColor: theme.border.hairline });
  });

  it('keeps the bar hidden from assistive technology, labelled with the count', async () => {
    const { view } = await segments('people');
    const bar = view.getByTestId('onboarding-progress', { includeHiddenElements: true });

    expect(bar.props.accessibilityLabel).toBe('Step 4 of 4');
    expect(bar.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(view.queryByTestId('onboarding-progress')).toBeNull();
    expect(StyleSheet.flatten(bar.props.style)).toMatchObject({
      gap: theme.space[1],
      paddingHorizontal: theme.layout.gutter,
    });
  });
});
