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

  it('reads as notification settings: a bell wearing a small gear', async () => {
    // The bell names the subject and the gear names the action. A bare gear in this
    // corner made the Profile control's claim — app settings — for a control that
    // opens the notification preferences alone.
    const view = await render(<NotificationSettingsButton />);

    // Walked over the rendered JSON: what is being checked is which glyphs compose
    // the control, and a glyph has no accessible role or label of its own. An icon's
    // `size` lands as the glyph's fontSize, which is the trace it leaves in the tree.
    type Node = { props?: Record<string, unknown>; children?: unknown[] } | string | null;
    const flatten = (style: unknown): Record<string, unknown> => {
      if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
      return (style ?? {}) as Record<string, unknown>;
    };
    const styles: Record<string, unknown>[] = [];
    const walk = (node: Node) => {
      if (!node || typeof node === 'string') return;
      styles.push(flatten(node.props?.style));
      for (const child of node.children ?? []) walk(child as Node);
    };
    walk(view.toJSON() as Node);

    const glyphSizes = styles
      .map((style) => style.fontSize)
      .filter((size): size is number => typeof size === 'number');
    // The bell at icon.md, and one smaller glyph — the gear annotation, not a
    // second subject.
    expect(glyphSizes).toContain(24);
    expect(glyphSizes).toContain(12);
    // The disc that lifts the gear off the bell's strokes.
    expect(
      styles.some(
        (style) => style.width === 16 && style.height === 16 && Boolean(style.backgroundColor),
      ),
    ).toBe(true);
  });

  it('pulls back exactly the box slack, so the glyph centres on the bar position', async () => {
    const view = await render(<NotificationSettingsButton />);
    const style = StyleSheet.flatten(
      view.getByRole('button', { name: 'Notification settings' }).props.style,
    );

    // (44 − 24) / 2. The old pull was a spacing token (12), which sat the glyph two
    // points past the bar edge and read as off-centre.
    expect(style.marginRight).toBe(-10);
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
