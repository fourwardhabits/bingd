import { fireEvent, render, screen } from '@testing-library/react-native';

import { TitleRowActions } from './TitleRowActions';

/**
 * `rankable` (2026-11-13): a surface that cannot yet tell whether a title is ranked draws
 * the bookmark without the `+`. Every caller that does not pass it is unchanged.
 */
describe('TitleRowActions', () => {
  const props = {
    name: 'Heat',
    kind: 'movie' as const,
    score: null,
    saved: false,
    onRank: jest.fn(),
    onToggleWatchlist: jest.fn(),
  };

  it('draws + and the bookmark by default', async () => {
    await render(<TitleRowActions {...props} />);
    expect(screen.getByRole('button', { name: 'Log Heat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Heat to Watchlist' })).toBeTruthy();
  });

  it('draws only the bookmark when the title is not rankable yet, and it still saves', async () => {
    const onToggleWatchlist = jest.fn();
    await render(<TitleRowActions {...props} rankable={false} onToggleWatchlist={onToggleWatchlist} />);
    expect(screen.queryByRole('button', { name: 'Log Heat' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Add Heat to Watchlist' }));
    expect(onToggleWatchlist).toHaveBeenCalledTimes(1);
  });
});
