import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { GenreLine, genresThatFit } from './GenreLine';

/**
 * The genre line (Cinematic Editorial brief, §2): one line, whole genres only, and a `+N`
 * that opens the rest. The arithmetic is tested pure; the component is tested by feeding it
 * the layouts a device would report.
 */
describe('genresThatFit', () => {
  const plus = (hidden: number) => 10 * String(hidden).length + 14;

  it('shows everything when everything fits, with no plus', () => {
    expect(genresThatFit([100, 60], 200, 12, plus)).toBe(2);
  });

  it('keeps room for +N when some genres do not fit', () => {
    // 100 + 12 + 60 = 172 fits 180, but then there is no room for " · +2" (12 + 24).
    expect(genresThatFit([100, 60, 80, 90], 180, 12, plus)).toBe(1);
    expect(genresThatFit([100, 60, 80, 90], 220, 12, plus)).toBe(2);
  });

  it('always shows at least one genre, even one too long for the line', () => {
    expect(genresThatFit([400, 60], 200, 12, plus)).toBe(1);
  });

  it('handles none and one', () => {
    expect(genresThatFit([], 200, 12, plus)).toBe(0);
    expect(genresThatFit([500], 200, 12, plus)).toBe(1);
  });
});

describe('GenreLine', () => {
  const genres = ['Science Fiction', 'Action & Adventure', 'Mystery', 'Thriller'];
  const widths = [110, 130, 60, 62];
  const hidden = { includeHiddenElements: true };

  /** RNTL runs no layout engine, so the widths a device would measure are supplied here. */
  const layout = async (available: number) => {
    for (let index = 0; index < genres.length; index += 1) {
      await fireEvent(screen.getByTestId(`genre-line-measure-${index}`, hidden), 'layout', {
        nativeEvent: { layout: { width: widths[index], height: 18 } },
      });
    }
    await fireEvent(screen.getByTestId('genre-line-measure-sep', hidden), 'layout', {
      nativeEvent: { layout: { width: 12, height: 18 } },
    });
    await fireEvent(screen.getByTestId('genre-line-measure-plus', hidden), 'layout', {
      nativeEvent: { layout: { width: 20, height: 18 } },
    });
    await fireEvent(screen.getByTestId('genre-line'), 'layout', {
      nativeEvent: { layout: { width: available, height: 18 } },
    });
  };

  it('draws nothing without genres', async () => {
    await renderWithProviders(<GenreLine genres={[]} titleName="Film" />);
    expect(screen.queryByTestId('genre-line')).toBeNull();
  });

  it('shows whole genres, then +N, on a narrow line', async () => {
    await renderWithProviders(<GenreLine genres={genres} titleName="Film" />);
    await layout(300);

    expect(screen.getByTestId('genre-line-text')).toHaveTextContent('Science Fiction · Action & Adventure ·');
    expect(screen.getByTestId('genre-line-more')).toHaveTextContent('+2');
    expect(screen.getByTestId('genre-line-text')).toHaveProp('numberOfLines', 1);
  });

  it('opens every genre from +N', async () => {
    await renderWithProviders(<GenreLine genres={genres} titleName="Film" />);
    await layout(300);
    await fireEvent.press(screen.getByLabelText('Show all 4 genres'));
    await waitFor(() => expect(screen.getByTestId('genre-sheet')).toBeTruthy());
    expect(screen.getByText('Science Fiction · Action & Adventure · Mystery · Thriller')).toBeTruthy();

    // A labelled way out, for a screen reader that cannot reach the scrim.
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('genre-sheet')).toBeNull());
  });

  it('shows no plus when everything fits', async () => {
    await renderWithProviders(<GenreLine genres={genres} titleName="Film" />);
    await layout(600);
    expect(screen.getByTestId('genre-line-text')).toHaveTextContent(
      'Science Fiction · Action & Adventure · Mystery · Thriller',
    );
    expect(screen.queryByTestId('genre-line-more')).toBeNull();
  });
});
