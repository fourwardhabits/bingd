import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { resetStepViewedForTests, trackStepViewed, useStepViewed } from './step-viewed';

const mockTrack = jest.fn();
jest.mock('@/lib/analytics', () => ({
  track: (event: unknown) => mockTrack(event),
}));

beforeEach(() => {
  mockTrack.mockReset();
  resetStepViewedForTests();
});

function Step({ step, ready = true }: { step: 'people' | 'payoff'; ready?: boolean }) {
  useStepViewed('user-1', step, ready);
  return <Text>{step}</Text>;
}

const views = () =>
  mockTrack.mock.calls.filter(([event]) => event.name === 'onboarding_step_viewed');

describe('onboarding_step_viewed (OB-1)', () => {
  it('fires once across a re-render and a remount of the same step', async () => {
    const first = await render(<Step step="people" />);
    await first.rerender(<Step step="people" />);
    await first.unmount();
    await render(<Step step="people" />);

    expect(views()).toEqual([[{ name: 'onboarding_step_viewed', props: { step: 'people' } }]]);
  });

  it('waits for the step to be ready, so a loading frame is not a view', async () => {
    const view = await render(<Step step="people" ready={false} />);
    expect(views()).toHaveLength(0);

    await view.rerender(<Step step="people" ready />);
    expect(views()).toHaveLength(1);
  });

  it('counts each step on its own', async () => {
    await render(<Step step="people" />);
    await render(<Step step="payoff" />);

    expect(views().map(([event]) => event.props.step)).toEqual(['people', 'payoff']);
  });

  it('is a new run for a different account on the same phone', () => {
    trackStepViewed('user-1', 'profile');
    trackStepViewed('user-1', 'profile');
    trackStepViewed('user-2', 'profile');

    expect(views()).toHaveLength(2);
  });

  it('carries the step and nothing else', () => {
    trackStepViewed('user-1', 'notifications');

    expect(Object.keys(mockTrack.mock.calls[0][0].props)).toEqual(['step']);
  });
});
