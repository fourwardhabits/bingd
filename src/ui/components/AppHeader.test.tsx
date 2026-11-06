import { render } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

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

/**
 * **One header on every main tab** (founder final polish, 2026-11-04): 4pt more below the
 * logo than above it, and the logo at the same height whether or not the tab has a bell.
 *
 * The lockup is centred in the bar, so the bar's height decides where it sits. The right
 * side reserves the bell's box on every tab; without that, Feed and Profile (which have a
 * bell) drew a taller bar than For You, Collection and Search, and their logo sat lower.
 */
describe('the header bar', () => {
  type Node = { props: { style?: StyleProp<ViewStyle> }; children?: Node[] };
  // The bar's two children are the lockup and the right side.
  const barOf = (view: Awaited<ReturnType<typeof render>>) => {
    const root = view.toJSON() as unknown as Node;
    return {
      bar: StyleSheet.flatten(root.props.style) ?? {},
      right: StyleSheet.flatten(root.children?.[1]?.props.style) ?? {},
    };
  };

  it('breathes below the logo and keeps the inset above it', async () => {
    const { bar } = barOf(await render(<AppHeader />));

    expect(bar.paddingTop).toBe(theme.space[2]);
    expect(bar.paddingBottom).toBe(theme.space[2] + 4);
  });

  it('reserves the same height on the right with a bell, a gear and bell, or nothing', async () => {
    const heights = [
      barOf(await render(<AppHeader />)).right.minHeight,
      barOf(await render(<AppHeader notifications={{ count: 0, onPress: () => {} }} />)).right.minHeight,
      barOf(
        await render(
          <AppHeader settings={{ onPress: () => {} }} notifications={{ count: 2, onPress: () => {} }} />,
        ),
      ).right.minHeight,
    ];

    expect(typeof heights[0]).toBe('number');
    expect(new Set(heights).size).toBe(1);
  });

  /**
   * **A 44pt box that takes 34pt of the row** (UI cohesion pass, 2026-11-06). Collection's
   * and For You's Movies | TV halves are 44pt presses, which must lie inside their parent
   * to answer on Android; the bleed into the header's padding keeps the row, and so the
   * logo, exactly where it was.
   */
  it('moves the right side to its own line rather than out of the header, at any text size', async () => {
    const { bar, right } = barOf(await render(<AppHeader right={<></>} />));

    expect(bar.flexWrap).toBe('wrap');
    // Its own width as the basis, so it wraps whole instead of being squeezed under its
    // control; it still grows into the rest of the row.
    expect(right.flexBasis).toBe('auto');
    expect(right.flexShrink).toBe(0);
    expect(right.flexGrow).toBe(1);
  });

  it('gives the right side a 44pt box that still lays out at 34pt', async () => {
    const { right } = barOf(await render(<AppHeader right={<></>} />));

    expect(right.minHeight).toBe(44);
    expect(right.marginVertical).toBe(-5);
    expect((right.minHeight as number) + 2 * (right.marginVertical as number)).toBe(34);
  });
});
