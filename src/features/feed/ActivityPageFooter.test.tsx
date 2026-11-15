import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { theme } from '@/ui/tokens';

import { ActivityPageFooter } from './ActivityPageFooter';

/**
 * **Try again answers 44pt inside the footer** (design-system v3 A.2 #7). The `sm` button is
 * 36pt with `Button`'s default 4pt of vertical slop, and slop only answers inside the parent's
 * bounds, so the footer itself must leave at least that much room above and below the button.
 */
describe('ActivityPageFooter Try again', () => {
  it('has room in its footer for the sm button’s slop', async () => {
    await render(
      <ActivityPageFooter
        isFetchingNextPage={false}
        isError
        hasNextPage
        count={3}
        onRetry={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Try again' });
    const slop = button.props.hitSlop as { top: number; bottom: number };
    const drawn = StyleSheet.flatten(button.props.style);

    expect(drawn.minHeight + slop.top + slop.bottom).toBeGreaterThanOrEqual(
      theme.layout.minTapTarget,
    );

    // The nearest host View above the button is the footer it sits in.
    let parent = button.parent;
    while (parent && (parent.type !== 'View' || parent === button)) parent = parent.parent;
    const footer = StyleSheet.flatten(parent!.props.style);

    // Below: the button is the footer's last child, so the footer's own padding is the room.
    expect(footer.paddingVertical).toBeGreaterThanOrEqual(slop.bottom);
    // Above: the gap to the message line sits inside the footer too.
    expect(footer.gap).toBeGreaterThanOrEqual(slop.top);
  });
});
