import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

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
    const node = screen.queryByTestId(`genre-measure-${index}`, {
      includeHiddenElements: true,
    });
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
    await renderWithProviders(<GenreRow genres={['A', 'B', 'C', 'D', 'E', 'F']} />);
    await layout(360, () => 150);

    expect(shown()).toHaveLength(2);
    expect(screen.getByText('+4')).toBeTruthy();
  });

  it('opens the full list from a genre chip', async () => {
    await renderWithProviders(
      <GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']} />,
    );
    await layout(360, () => 70);

    await fireEvent.press(screen.getByLabelText('Anime. See all genres'));

    expect(screen.getByLabelText('All genres')).toBeTruthy();
    // Every genre is in the sheet, including the ones the row could not fit.
    for (const genre of ['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']) {
      expect(screen.getAllByText(genre).length).toBeGreaterThan(0);
    }
  });

  it('opens the same list from the count', async () => {
    await renderWithProviders(
      <GenreRow genres={['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']} />,
    );
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

/**
 * **`TypeError: Cannot read property 'layout' of null`** — the title-page crash, finally
 * named off the founder's device on 2026-09-07 after weeks of a boundary with no message.
 *
 * React Native's renderer **pools synthetic events**. Once the handlers for an event have
 * run, `e.isPersistent() || e.constructor.release(e)` returns it to the pool, and
 * `SyntheticEvent.destructor()` sets `this.nativeEvent = null`
 * (`ReactFabric-prod.js`). Anything that reads `event.nativeEvent` *after the handler has
 * returned* reads null.
 *
 * The measuring layer did exactly that. It read `event.nativeEvent.layout.width` inside a
 * functional `setWidths` updater — and React runs an updater later, during render, whenever
 * it cannot compute it eagerly, which is the moment another update is already queued on the
 * same component. So the first chip's width was read while the event was alive and the
 * second chip's was read off a destroyed one: a title with one genre never crashed, a title
 * with two or more crashed whenever their layouts landed in one batch. Thrown during render
 * rather than in the handler, it reached the error boundary instead of the red box — which
 * is the "loads for a moment, then the apology" the founder saw, on the titles that had
 * genres and not on the ones that did not.
 *
 * This test is the failure's own shape. Every chip reports in one `act`, and each event is
 * destroyed the way the renderer destroys it before React applies the updaters.
 */
describe('the measuring pass and the event it is handed', () => {
  it('survives the renderer releasing the layout event before the update is applied', async () => {
    await renderWithProviders(<GenreRow genres={['Crime', 'Drama', 'Comedy']} />);

    const measures = [0, 1, 2].map((index) =>
      screen.getByTestId(`genre-measure-${index}`, { includeHiddenElements: true }),
    );

    await act(async () => {
      const events = measures.map((node, index) => {
        const event = {
          nativeEvent: { layout: { x: 0, y: 0, width: [60, 70, 80][index], height: 32 } },
        };
        (node.props as { onLayout: (e: unknown) => void }).onLayout(event);
        return event as { nativeEvent: unknown };
      });
      // What `SyntheticEvent.destructor()` does to every released event, before React has
      // rendered and run the stored updaters.
      for (const event of events) event.nativeEvent = null;
    });

    await fireEvent(screen.getByTestId('genre-row'), 'layout', {
      nativeEvent: { layout: { width: 400, height: 32 } },
    });

    // All three widths were captured while the events were alive, so all three chips fit
    // and the row is whole. With the deferred read, this render threw.
    expect(shown()).toEqual(['Crime', 'Drama', 'Comedy']);
    expect(marker()).toBeNull();
  });
});

describe('the full list', () => {
  const openSheet = async (genres: string[]) => {
    await renderWithProviders(<GenreRow genres={genres} />);
    await layout(360, () => 70);
    await fireEvent.press(screen.getByLabelText(`${genres[0]}. See all genres`));
    return screen.getByLabelText('All genres');
  };

  type HostNode = { props: Record<string, unknown>; parent: HostNode | null };

  /**
   * **The sheet's content sits in the gutter** (founder, physical QA, 2026-09-14: "Genres"
   * and the chips were flush against the left edge). `Sheet` pads nothing horizontally, so
   * the heading and the chips must share a body that does.
   */
  it('puts the heading and every chip inside the sheet gutter, under the handle', async () => {
    await openSheet(['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi']);

    // The nearest ancestor that pads horizontally, as a style or a content container.
    const padded = (node: HostNode) => {
      for (let at: HostNode | null = node.parent; at; at = at.parent) {
        for (const key of ['style', 'contentContainerStyle']) {
          const style = StyleSheet.flatten(at.props?.[key] as never) as {
            paddingHorizontal?: number;
          };
          if (style?.paddingHorizontal !== undefined) return { at, style };
        }
      }
      return null;
    };
    const heading = padded(screen.getByText('Genres') as unknown as HostNode);
    const chips = padded(screen.getByTestId('genre-sheet-chips') as unknown as HostNode);
    expect(heading?.style.paddingHorizontal).toBe(theme.layout.gutter);
    // One body for both, so the chips cannot drift off the heading's edge.
    expect(chips?.at).toBe(heading?.at);

    // Top spacing below the handle, from the wrapper the body scrolls inside.
    let at: HostNode | null = heading!.at.parent;
    let wrapperPaddingTop: number | undefined;
    for (; at; at = at.parent) {
      const style = StyleSheet.flatten(at.props?.style as never) as { paddingTop?: number };
      if (style?.paddingTop !== undefined) {
        wrapperPaddingTop = style.paddingTop;
        break;
      }
    }
    expect(wrapperPaddingTop).toBe(theme.space[2]);
  });

  it('wraps several chips with the canonical gaps', async () => {
    await openSheet(['Anime', 'Action & Adventure', 'Comedy', 'Sci-Fi', 'Drama', 'Mystery']);

    const chips = screen.getByTestId('genre-sheet-chips');
    expect(StyleSheet.flatten(chips.props.style)).toMatchObject({
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.space[2],
    });
    expect(screen.getAllByText('Mystery').length).toBeGreaterThan(0);
  });

  it('caps a long genre at the content width, so it wraps rather than leaving the screen', async () => {
    const long = 'Documentary About Very Long Genre Names That Keep Going';
    await openSheet(['Anime', long]);

    const label = screen.getAllByText(long).at(-1) as unknown as HostNode;
    let at: HostNode | null = label.parent;
    let capped = false;
    for (; at; at = at.parent) {
      const style = StyleSheet.flatten(at.props?.style as never) as { maxWidth?: unknown };
      if (style?.maxWidth === '100%') {
        capped = true;
        break;
      }
    }
    expect(capped).toBe(true);
  });

  it('scrolls inside the sheet at large text sizes instead of growing past it', async () => {
    await openSheet(['Anime', 'Comedy']);

    let at = (screen.getByText('Genres') as unknown as HostNode).parent;
    while (at && at.props?.contentContainerStyle === undefined) at = at.parent;
    expect(at).toBeTruthy();
    expect(StyleSheet.flatten(at!.props.style as never)).toMatchObject({
      flexGrow: 0,
      flexShrink: 1,
    });
  });
});
