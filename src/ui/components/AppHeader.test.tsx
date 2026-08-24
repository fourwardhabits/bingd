import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { AppHeader } from './AppHeader';

/**
 * **The unread badge, after the founder's correction.**
 *
 * It was a solid Maroon disc carrying Parchment — the score badge's treatment, which is
 * the loudest mark the app has, spent on a number that is subordinate to the bell it
 * sits on. Turning the pair around keeps the same certified contrast (design-system.md
 * §3: Maroon and Parchment, 7.4:1, whichever way round) and lets the bell stay the
 * thing the eye lands on.
 *
 * Asserted against the tokens rather than against hex, because the point is that the
 * badge draws from the palette and not from a colour somebody typed.
 */

const badgeOf = (view: Awaited<ReturnType<typeof render>>) => {
  // The badge is the only absolutely-positioned view inside the bell, and it carries no
  // text of its own to query by — the count inside it does.
  const number = view.getByText('1');
  return StyleSheet.flatten(number.parent?.props?.style);
};

describe('the notification badge', () => {
  it('is Parchment behind a Maroon number, ringed in Maroon', async () => {
    const view = await render(<AppHeader notifications={{ count: 1, onPress: () => {} }} />);

    const badge = badgeOf(view);
    expect(badge.backgroundColor).toBe(theme.surface.sunken);
    expect(badge.borderColor).toBe(theme.semantic.action);
    expect(badge.borderWidth).toBeGreaterThan(0);

    const number = StyleSheet.flatten(view.getByText('1').props.style);
    expect(number.color).toBe(theme.semantic.action);
  });

  it('stays a circle at one digit', async () => {
    const view = await render(<AppHeader notifications={{ count: 1, onPress: () => {} }} />);

    const badge = badgeOf(view);
    expect(badge.height).toBe(badge.minWidth);
    expect(badge.borderRadius).toBe(theme.radius.full);
  });

  it('keeps the existing two-character convention past nine', async () => {
    const view = await render(<AppHeader notifications={{ count: 12, onPress: () => {} }} />);

    expect(view.getByText('9+')).toBeTruthy();
    expect(view.queryByText('12')).toBeNull();
  });

  it('draws no badge at zero, and says so', async () => {
    const view = await render(<AppHeader notifications={{ count: 0, onPress: () => {} }} />);

    expect(view.queryByText('0')).toBeNull();
    expect(view.getByLabelText('Notifications')).toBeTruthy();
  });

  it('counts in the spoken label when there is something waiting', async () => {
    const view = await render(<AppHeader notifications={{ count: 3, onPress: () => {} }} />);

    expect(view.getByLabelText('Notifications, 3 waiting')).toBeTruthy();
  });
});
