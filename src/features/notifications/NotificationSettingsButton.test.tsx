import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import {
  NOTIFICATIONS_HEADER,
  NotificationSettingsButton,
} from '../../../app/settings/notifications';

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

  it('is a bell wearing a gear, not a bare settings glyph', async () => {
    /**
     * **Decided three times, and this is the third** (founder, 2026-09-25).
     *
     *   #61   the composite arrived — a bell for the subject, a gear for the action.
     *   #62   the Paper disc behind the gear came off; the founder's device read it as
     *         a badge background on a control that carries no count.
     *   #111  the whole composite came off, on a physical Android pass: the glyphs were
     *         read as overlapping into one shape, the gear punched through the bell.
     *   now   the composite is back, because a bare gear on the Notifications screen
     *         says *settings* rather than *notification settings*.
     *
     * What is asserted is **#62's geometry**, which is what was restored: the bell at
     * `icon.md` and the gear at 12pt riding its shoulder. This test previously pinned
     * the opposite — `[24]` and never 12 — and it is inverted rather than deleted so
     * the next reader can see the decision moved rather than that a rule vanished.
     *
     * Walked over the rendered JSON because a glyph has no role or label of its own —
     * an icon's `size` lands as the glyph's fontSize, which is the trace it leaves.
     */
    const view = await render(<NotificationSettingsButton />);

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

    // Two glyphs: the bell at the app's icon size, the gear annotating it at 12.
    expect(glyphSizes).toEqual([24, 12]);
  });

  it('rides the bell bare, with no disc behind it', async () => {
    // #62's correction, and the one thing about this control that has never been
    // reversed: a filled circle behind the gear reads as a count badge.
    const view = await render(<NotificationSettingsButton />);

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

    expect(styles.some((style) => typeof style.backgroundColor === 'string')).toBe(false);
    expect(styles.some((style) => typeof style.borderRadius === 'number')).toBe(false);
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

/**
 * **The bubble the founder saw on iOS was UIKit's, not this component's**
 * (device pass, 2026-08-29; Android drew the bare icon).
 *
 * Audited rather than guessed at: the tests above already assert there is no disc in the
 * component, and `rootStackScreenOptions` sets no header background or blur. What draws
 * it is iOS 26 — a custom `headerRight` element reaches `ScreenStackHeaderRightView` as a
 * `UIBarButtonItem` `customView`, and from iOS 26 those items are given a shared glass
 * background in the navigation bar.
 *
 * `hidesSharedBackground` is UIKit's own opt-out for exactly that, and the only way to
 * reach it is the items form: `headerRight` renders the view with no props, while
 * `unstable_headerRightItems` passes the flag per item. So the screen hands the same
 * component over twice — as an item on iOS, where the flag lands, and as `headerRight`
 * everywhere else. That is what this asserts, because a screen option is invisible to a
 * render test and would otherwise be a change nothing could see.
 */
describe('the header option that carries it', () => {
  it('offers the same control both ways, and opts the iOS one out of the glass', () => {
    const items = NOTIFICATIONS_HEADER.unstable_headerRightItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'custom', hidesSharedBackground: true });

    // The same component in both, so the two platforms cannot drift into two controls.
    expect((items[0]?.element as { type: unknown }).type).toBe(NotificationSettingsButton);
    expect((NOTIFICATIONS_HEADER.headerRight() as { type: unknown }).type).toBe(
      NotificationSettingsButton,
    );
  });

  it('still names the screen and the way back', () => {
    // The rest of the option object, so the items form cannot arrive by deleting them.
    expect(NOTIFICATIONS_HEADER).toMatchObject({
      headerShown: true,
      title: 'Notifications',
      headerBackTitle: 'Back',
    });
  });
});
