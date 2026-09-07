import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { theme } from '@/ui/tokens';

import { GenreRow } from './GenreRow';

/**
 * Lay the row out at `rowWidth`, with candidate chip `i` reporting `chipWidth(i)`.
 *
 * RNTL runs no layout engine, so `onLayout` never fires on its own — the widths a real
 * device measures are supplied here instead. That is the whole mechanism under test: the
 * component must decide the count from what it was told, not from a constant.
 */
const layout = async (rowWidth: number, chipWidth: (index: number) => number) => {
  /**
   * The measuring layer first: it is what decides how many chips the row can hold, and
   * on a device it lays out in the same pass as the row itself.
   *
   * `includeHiddenElements` because that layer is deliberately hidden from assistive
   * technology, and RNTL's queries honour that by default — the nodes are there, and a
   * plain `queryByTestId` will not see them.
   */
  let index = 0;
  for (;;) {
    const node = screen.queryByTestId(`genre-measure-${index}`, { includeHiddenElements: true });
    if (!node) break;
    await fireEvent(node, 'layout', {
      nativeEvent: { layout: { width: chipWidth(index), height: 32 } },
    });
    index += 1;
  }

  const row = screen.getByTestId('genre-row');
  await fireEvent(row, 'layout', { nativeEvent: { layout: { width: rowWidth, height: 32 } } });
};

/** The genres actually on the row, in order. */
const shown = () =>
  screen
    .getAllByRole('button')
    .map((node) => String(node.props.accessibilityLabel ?? ''))
    .filter((label) => !label.startsWith('And '))
    .map((label) => label.replace('. See all genres', ''));

const marker = () => screen.queryByLabelText(/^And \d+ more genres?\. See all genres$/);

/**
 * **`+N` never wraps to a line of its own** (founder, physical Android, 2026-09-07).
 *
 * The page drew a fixed three chips and then the count, in a wrapping container: at some
 * widths the third chip fitted and the marker did not, so the thing that exists to save a
 * row cost one. Dan Da Dan is the founder's example and the first case here.
 *
 * The row is `nowrap`, so a wrap is structurally impossible; what these test is the other
 * half — that the count is measured, so the row does not simply clip the marker out of
 * sight instead.
 */
describe('one row of genres', () => {
  it('drops the third chip rather than wrapping the count — the Dan Da Dan case', async () => {
    await renderWithProviders(
      <GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi & Fantasy']} />,
    );
    // Anime and Action & Adventure fit; Comedy plus the reserved marker does not.
    await layout(360, (index) => [70, 160, 80, 80][index] ?? 80);

    expect(shown()).toEqual(['Anime', 'Action & Adventure']);
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('fits three short genres and states the fourth', async () => {
    // 60pt chips in a 260pt row: three fit alongside the reserved marker and the fourth
    // does not. Nothing here is a fixed count — widen the row and the fourth appears.
    await renderWithProviders(<GenreRow genres={['Drama', 'Crime', 'Thriller', 'Mystery']} />);
    await layout(260, () => 60);

    expect(shown()).toEqual(['Drama', 'Crime', 'Thriller']);
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('fits all four in a row wide enough for them', async () => {
    await renderWithProviders(<GenreRow genres={['Drama', 'Crime', 'Thriller', 'Mystery']} />);
    await layout(360, () => 60);

    expect(shown()).toEqual(['Drama', 'Crime', 'Thriller', 'Mystery']);
    expect(marker()).toBeNull();
  });

  it('draws no marker when every genre is on the row', async () => {
    await renderWithProviders(<GenreRow genres={['Drama', 'Crime']} />);
    await layout(360, () => 60);

    expect(shown()).toEqual(['Drama', 'Crime']);
    expect(marker()).toBeNull();
  });

  it('shows fewer on a narrow screen than on a wide one', async () => {
    await renderWithProviders(<GenreRow genres={['Drama', 'Crime', 'Thriller', 'Mystery']} />);
    await layout(200, () => 80);

    expect(shown()).toHaveLength(1);
    expect(screen.getByText('+3')).toBeTruthy();
  });

  it('keeps one chip even when a single genre overflows the row', async () => {
    // A truncated chip says more than an empty line does.
    await renderWithProviders(<GenreRow genres={['Action & Adventure', 'Comedy']} />);
    await layout(100, () => 400);

    expect(shown()).toEqual(['Action & Adventure']);
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('counts the genres it never mounted, not just the ones it hid', async () => {
    // Six genres, four candidates, two shown: the marker says +4, not +2.
    await renderWithProviders(
      <GenreRow genres={['A', 'B', 'C', 'D', 'E', 'F']} />,
    );
    await layout(360, () => 150);

    expect(shown()).toHaveLength(2);
    expect(screen.getByText('+4')).toBeTruthy();
  });

  it('opens the full list from a genre chip', async () => {
    await renderWithProviders(<GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']} />);
    await layout(360, () => 70);

    await fireEvent.press(screen.getByLabelText('Anime. See all genres'));

    expect(screen.getByLabelText('All genres')).toBeTruthy();
    // Every genre is in the sheet, including the ones the row could not fit.
    for (const genre of ['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']) {
      expect(screen.getAllByText(genre).length).toBeGreaterThan(0);
    }
  });

  it('opens the same list from the count', async () => {
    await renderWithProviders(<GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']} />);
    await layout(360, () => 150);

    await fireEvent.press(screen.getByLabelText(/^And \d+ more genres\. See all genres$/));

    expect(screen.getByLabelText('All genres')).toBeTruthy();
  });

  it('says one genre in the singular', async () => {
    await renderWithProviders(<GenreRow genres={['Anime', 'Action & Adventure']} />);
    await layout(200, () => 150);

    expect(screen.getByLabelText('And 1 more genre. See all genres')).toBeTruthy();
  });

  it('draws nothing for a title with no genres', async () => {
    await renderWithProviders(<GenreRow genres={[]} />);

    expect(screen.queryByTestId('genre-row')).toBeNull();
  });

  it('is one unwrapped row, which is what makes a wrap impossible', async () => {
    await renderWithProviders(<GenreRow genres={['Drama', 'Crime', 'Thriller', 'Mystery']} />);
    const style = [screen.getByTestId('genre-row').props.style].flat(3).filter(Boolean);
    const flat = Object.assign({}, ...(style as Record<string, unknown>[]));

    expect(flat.flexWrap).toBe('nowrap');
    expect(flat.flexDirection).toBe('row');
  });
});

/**
 * **The target each chip offers** (pre-GTM audit, 2026-09-07). A 32pt chip and the
 * `+N` marker beside it both answer a 44pt thumb, through the slop every chip row shares.
 */
describe('the target each chip offers', () => {
  it('lifts every chip and the marker to the target with the shared chip slop', async () => {
    await renderWithProviders(
      <GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Drama']} />,
    );
    await layout(300, () => 90);

    expect(marker()).toBeTruthy();
    const controls = screen.getAllByRole('button');
    expect(controls.length).toBeGreaterThan(1);
    for (const control of controls) {
      expect(control.props.hitSlop).toEqual(theme.layout.chipHitSlop);
    }
  });
});
