import { render } from '@testing-library/react-native';

import { EmptyState } from './EmptyState';

/**
 * **The error state's lines break balanced** (founder QA, 2026-11-12: *Check your connection
 * and try* / *again.*).
 *
 * Asserted as the props each platform reads, because neither layout engine runs under Jest:
 * Android's `textBreakStrategy="balanced"` and iOS's `lineBreakStrategyIOS="push-out"`, both
 * React Native's own Text props. Only the error state; the copy is untouched.
 */
const ERROR = {
  title: 'Could not load your notification settings',
  body: 'Check your connection and try again.',
};

describe('the shared error state', () => {
  it('balances the title and body lines on both platforms', async () => {
    const view = await render(<EmptyState kind="couldNotLoad" {...ERROR} />);
    for (const text of [ERROR.title, ERROR.body]) {
      const node = view.getByText(text);
      expect(node.props.textBreakStrategy).toBe('balanced');
      expect(node.props.lineBreakStrategyIOS).toBe('push-out');
    }
  });

  it('does so in the compact form too', async () => {
    const view = await render(<EmptyState kind="couldNotLoad" compact {...ERROR} />);
    expect(view.getByText(ERROR.body).props.textBreakStrategy).toBe('balanced');
    expect(view.getByText(ERROR.title).props.lineBreakStrategyIOS).toBe('push-out');
  });

  it('keeps the copy and the action exactly as given', async () => {
    const view = await render(
      <EmptyState
        kind="couldNotLoad"
        {...ERROR}
        action={{ label: 'Try again', onPress: jest.fn() }}
      />,
    );
    expect(view.getByText(ERROR.title)).toBeTruthy();
    expect(view.getByText(ERROR.body)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('leaves the two empty states as they were', async () => {
    for (const kind of ['nothingYet', 'nothingMatches'] as const) {
      const view = await render(
        <EmptyState kind={kind} title="Nothing here yet" body="Add one." />,
      );
      expect(view.getByText('Add one.').props.textBreakStrategy).toBeUndefined();
      expect(view.getByText('Nothing here yet').props.lineBreakStrategyIOS).toBeUndefined();
      await view.unmount();
    }
  });
});
