import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import { NotificationSettingsButton } from '../../../app/settings/notifications';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  Stack: { Screen: () => null },
}));

beforeEach(() => mockPush.mockReset());

/**
 * The control the founder found still spelling itself out.
 *
 * "Settings" as a word in the navigation bar reads as a second destination competing
 * with the title beside it. A gear says the same thing and says it smaller — but only
 * to somebody who can see it, which is the half a glyph gets wrong by default.
 */
describe('the notifications gear', () => {
  it('goes to notification preferences', async () => {
    const view = await render(<NotificationSettingsButton />);

    await fireEvent.press(view.getByRole('button', { name: 'Notification settings' }));

    expect(mockPush).toHaveBeenCalledWith('/settings/notification-preferences');
  });

  it('carries the name the word used to carry', async () => {
    // The one thing an icon cannot do on its own. Without this the control announces
    // as "button" and nothing else.
    const view = await render(<NotificationSettingsButton />);

    expect(view.getByLabelText('Notification settings')).toBeTruthy();
    // And the word itself is gone from it — no text pill beside the glyph.
    expect(view.queryByText('Settings')).toBeNull();
  });

  it('is a full touch target rather than a glyph with slop around it', async () => {
    // Android clips touches falling outside a parent's box, so `hitSlop` on an icon is
    // a target that measures 44 on iOS and taps at 24 on Android (review 29a).
    const view = await render(<NotificationSettingsButton />);
    const style = StyleSheet.flatten(
      view.getByRole('button', { name: 'Notification settings' }).props.style,
    );

    expect(style).toMatchObject({ width: 44, height: 44 });
  });
});
