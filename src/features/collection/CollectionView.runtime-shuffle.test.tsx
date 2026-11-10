import { Ionicons } from '@expo/vector-icons';
import { fireEvent, waitFor, within } from '@testing-library/react-native';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { CollectionView, initialViewState, type CollectionViewState } from './CollectionView';
import type { CollectionItem, CollectionSegment } from './filters';

/**
 * **Runtime sorting and the Shuffle UX** (approved spec, 2026-11-10), through the real
 * `CollectionView` and its Filters & Sort sheet, in both Poster (grid) and List.
 *
 *   · Runtime: first press Shortest first ↑, second Longest first ↓, and alternating; the
 *     maroon selected style with the arrow; unusable runtimes last; filters respected;
 *     not offered on a TV list made only of seasons.
 *   · Shuffle: every press — from another axis or from Shuffle itself — a new seed and a
 *     new order, applied at once with the sheet closed; no toolbar reshuffle button; the
 *     order stable through re-renders, refetches and Grid/List switches.
 */

const film = (n: number, overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  mediaItemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Film ${String(n).padStart(2, '0')}`,
  seriesTitle: null,
  kind: 'movie',
  year: 2000 + n,
  posterPath: null,
  genres: n % 2 === 0 ? ['Drama'] : ['Comedy'],
  language: 'en',
  runtimeMinutes: 60 + n * 10,
  score: 10 - n * 0.5,
  bucket: 'loved',
  watchedOn: null,
  addedAt: new Date(Date.UTC(2020, 0, n)).toISOString(),
  ...overrides,
});

/** Runtimes 130, 80, 110, none, 70, zero — out of order on purpose. */
const LIBRARY = [
  film(7),
  film(2),
  film(5),
  film(3, { runtimeMinutes: null }),
  film(1),
  film(4, { runtimeMinutes: 0 }),
];

function Harness({
  items,
  segment = 'watched',
  initial,
  onState,
}: {
  items: CollectionItem[];
  segment?: CollectionSegment;
  initial?: Partial<CollectionViewState>;
  onState?: (state: CollectionViewState) => void;
}) {
  const [state, setState] = useState<CollectionViewState>({
    ...initialViewState(),
    ...initial,
  });
  return (
    <CollectionView
      items={items}
      segment={segment}
      state={state}
      onChange={(next) => {
        onState?.(next);
        setState(next);
      }}
      onPressItem={() => {}}
      empty={<Text>Empty here</Text>}
    />
  );
}

type View = Awaited<ReturnType<typeof renderWithProviders>>;

const BEHIND = { includeHiddenElements: true } as const;

/** The titles drawn, in order, whichever mode draws them. */
const drawn = (view: View) => {
  const names = view
    .queryAllByRole('button', BEHIND)
    .map((node) => node.props.accessibilityLabel as string | undefined)
    .map((label) => /^(Film \d\d)/.exec(label ?? '')?.[1])
    .filter((name): name is string => Boolean(name));
  // One entry per title even if a row announces its name on more than one control.
  return names.filter((name, index) => names.indexOf(name) === index);
};

const openSheet = async (view: View) => {
  await fireEvent.press(view.getByTestId('collection-filter-sort', BEHIND));
  await waitFor(() => expect(view.getByTestId('collection-sort-section')).toBeTruthy());
};

const sortRadio = (view: View, name: RegExp | string) =>
  within(view.getByTestId('collection-sort-section')).getByRole('radio', { name });

const styleOf = (node: { props: { style: unknown } }) =>
  StyleSheet.flatten(
    typeof node.props.style === 'function'
      ? (node.props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : node.props.style,
  ) as { backgroundColor?: string };

/**
 * **The order a state draws, read from a fresh mount.**
 *
 * FlashList recycles its cells: after a re-sort it moves the mounted cells to their new
 * positions by layout rather than reordering them in the tree, so the tree order of an
 * already-mounted list is not the order on screen. A fresh mount lays the cells out in
 * data order, which is what a reader sees — so every "what order is drawn after this
 * press" assertion reads the state the press produced through a new `CollectionView`.
 */
const orderOf = async (
  items: CollectionItem[],
  state: CollectionViewState,
  segment: CollectionSegment = 'watched',
) => {
  const fresh = await renderWithProviders(
    <Harness items={items} segment={segment} initial={state} />,
  );
  const order = drawn(fresh);
  await fresh.unmount();
  return order;
};

type Node = { props?: Record<string, unknown>; children?: (Node | string)[] };

/** The Ionicons glyph a name draws: the jest renderer prints the glyph, not the name. */
const glyph = (name: 'arrow-up-outline' | 'arrow-down-outline') =>
  String.fromCodePoint(Ionicons.glyphMap[name] as number);

/** Every icon glyph drawn inside a node. */
const glyphsIn = (root: Node): string[] => {
  const found: string[] = [];
  const stack: (Node | string)[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node === 'string') continue;
    const style = StyleSheet.flatten(node.props?.style as never) as
      { fontFamily?: string } | undefined;
    if (style?.fontFamily === 'ionicons') {
      found.push(
        ...(node.children ?? []).filter((child): child is string => typeof child === 'string'),
      );
    }
    stack.push(...(node.children ?? []));
  }
  return found;
};

describe.each(['poster', 'list'] as const)('in %s view', (mode) => {
  const draw = (props: Partial<React.ComponentProps<typeof Harness>> = {}) =>
    renderWithProviders(
      <Harness items={LIBRARY} {...props} initial={{ mode, ...props.initial }} />,
    );

  describe('Runtime', () => {
    it('is offered beside Release year in Filters & Sort', async () => {
      const view = await draw();
      await openSheet(view);
      const labels = within(view.getByTestId('collection-sort-section'))
        .getAllByRole('radio')
        .map((radio) => radio.props.accessibilityLabel.split(',')[0]);
      expect(labels).toEqual([
        'Rating',
        'Recently watched',
        'Release year',
        'Runtime',
        'Title',
        'Shuffle',
      ]);
    });

    it('goes Shortest first, then Longest first, then alternates, with the sheet open', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({ onState: (state) => seen.push(state) });
      await openSheet(view);

      await fireEvent.press(sortRadio(view, /^Runtime/));
      expect(view.getByTestId('collection-sort-section')).toBeTruthy();
      const first = sortRadio(view, /^Runtime/);
      expect(first.props.accessibilityLabel).toBe('Runtime, shortest first');
      expect(first.props.accessibilityState).toMatchObject({ selected: true });
      // The existing maroon selected style, with the up arrow beside the label.
      expect(styleOf(first).backgroundColor).toBe(theme.semantic.action);
      expect(glyphsIn(first)).toEqual([glyph('arrow-up-outline')]);

      await fireEvent.press(sortRadio(view, /^Runtime/));
      const second = sortRadio(view, /^Runtime/);
      expect(second.props.accessibilityLabel).toBe('Runtime, longest first');
      expect(glyphsIn(second)).toEqual([glyph('arrow-down-outline')]);

      await fireEvent.press(sortRadio(view, /^Runtime/));
      await fireEvent.press(sortRadio(view, /^Runtime/));
      expect(seen.map((state) => state.sort)).toEqual([
        { axis: 'runtime', direction: 'asc' },
        { axis: 'runtime', direction: 'desc' },
        { axis: 'runtime', direction: 'asc' },
        { axis: 'runtime', direction: 'desc' },
      ]);
      expect(
        view.getByTestId('collection-filter-sort', BEHIND).props.accessibilityLabel,
      ).toMatch(/Sorted by Runtime, longest first/);

      // What each press draws. Missing (Film 03) and zero (Film 04) runtimes are last in
      // both directions.
      await view.unmount();
      expect(await orderOf(LIBRARY, seen[0]!)).toEqual([
        'Film 01',
        'Film 02',
        'Film 05',
        'Film 07',
        'Film 03',
        'Film 04',
      ]);
      expect(await orderOf(LIBRARY, seen[1]!)).toEqual([
        'Film 07',
        'Film 05',
        'Film 02',
        'Film 01',
        'Film 03',
        'Film 04',
      ]);
    });

    it('starts Shortest first even when coming from a descending axis', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({
        initial: { sort: { axis: 'year', direction: 'desc' } },
        onState: (state) => seen.push(state),
      });
      await openSheet(view);
      await fireEvent.press(sortRadio(view, /^Runtime/));
      expect(seen.at(-1)?.sort).toEqual({ axis: 'runtime', direction: 'asc' });
    });

    it('sorts only what the filters in force leave', async () => {
      const view = await draw({
        initial: {
          sort: { axis: 'runtime', direction: 'asc' },
          filters: { ...initialViewState().filters, genres: ['Drama'] },
        },
      });
      // Dramas are the even films: 2 (80m), 4 (zero → last).
      expect(drawn(view)).toEqual(['Film 02', 'Film 04']);
      expect(view.getByTestId('collection-count').props.children).toBe('2 of 6');
    });

    it('orders a TV watchlist by episode length, seasons last', async () => {
      const tv = [
        film(1, { kind: 'series', runtimeMinutes: 58, score: null, bucket: null }),
        film(2, {
          kind: 'season',
          seriesTitle: 'Show',
          runtimeMinutes: null,
          score: null,
          bucket: null,
        }),
        film(3, { kind: 'series', runtimeMinutes: 22, score: null, bucket: null }),
      ];
      const view = await draw({
        items: tv,
        segment: 'watchlist',
        initial: { sort: { axis: 'runtime', direction: 'desc' } },
      });
      expect(drawn(view).filter((name) => name !== 'Film 02')).toEqual(['Film 01', 'Film 03']);
      await openSheet(view);
      expect(sortRadio(view, /^Runtime/).props.accessibilityState).toMatchObject({
        selected: true,
      });
    });

    it('is not offered on a TV list of seasons, which have no runtime', async () => {
      const seasons = [1, 2, 3].map((n) =>
        film(n, { kind: 'season', seriesTitle: `Show ${n}`, runtimeMinutes: null }),
      );
      const view = await draw({
        items: seasons,
        initial: { sort: { axis: 'runtime', direction: 'asc' } },
      });
      await openSheet(view);
      const labels = within(view.getByTestId('collection-sort-section'))
        .getAllByRole('radio')
        .map((radio) => radio.props.accessibilityLabel.split(',')[0]);
      expect(labels).not.toContain('Runtime');
      // A Runtime carried over from Movies falls back to the segment's first axis.
      expect(sortRadio(view, /^Rating/).props.accessibilityState).toMatchObject({
        selected: true,
      });
    });
  });

  describe('Shuffle', () => {
    it('has no reshuffle button in the toolbar, before or after shuffling', async () => {
      const view = await draw({ initial: { sort: { axis: 'shuffle', direction: 'desc' } } });
      expect(view.queryByTestId('collection-reshuffle', BEHIND)).toBeNull();
      expect(view.queryByLabelText('Shuffle again', BEHIND)).toBeNull();
      const bar = view.getByTestId('collection-toolbar');
      expect(within(bar).getAllByRole('button')).toHaveLength(1);

      await openSheet(view);
      await fireEvent.press(sortRadio(view, 'Shuffle'));
      expect(view.queryByTestId('collection-reshuffle', BEHIND)).toBeNull();
    });

    it('applies at once from another axis, with a new seed, and closes the sheet', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({ onState: (state) => seen.push(state) });
      const before = drawn(view);
      await openSheet(view);

      await fireEvent.press(sortRadio(view, 'Shuffle'));
      await waitFor(() => expect(view.queryByTestId('collection-sort-section')).toBeNull());
      expect(seen.at(-1)?.sort.axis).toBe('shuffle');
      expect(seen.at(-1)?.seed).toBeGreaterThan(initialViewState().seed);
      // No Apply was pressed, and the filters are untouched.
      expect(seen.at(-1)?.filters).toEqual(initialViewState().filters);
      await view.unmount();
      const after = await orderOf(LIBRARY, seen.at(-1)!);
      expect(after).not.toEqual(before);
      expect([...after].sort()).toEqual([...before].sort());
    });

    it('reshuffles on every press while selected, never repeating the order on screen', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({
        initial: { sort: { axis: 'shuffle', direction: 'desc' } },
        onState: (state) => seen.push(state),
      });
      const first = drawn(view);
      for (let press = 0; press < 6; press += 1) {
        await openSheet(view);
        const radio = sortRadio(view, 'Shuffle');
        // Selected, still enabled, and says what pressing it again does.
        expect(radio.props.accessibilityState).toMatchObject({ selected: true });
        expect(radio.props.accessibilityState?.disabled).toBeFalsy();
        expect(radio.props.accessibilityHint).toBe('Tap again to reshuffle');
        await fireEvent.press(radio);
        await waitFor(() => expect(view.queryByTestId('collection-sort-section')).toBeNull());
      }
      await view.unmount();
      // Each press's order differs from the one on screen when it was pressed.
      let current = first;
      for (const state of seen) {
        const next = await orderOf(LIBRARY, state);
        expect(next).not.toEqual(current);
        current = next;
      }
      const seeds = seen.map((state) => state.seed);
      expect(seeds).toHaveLength(6);
      expect(new Set(seeds).size).toBe(seeds.length);
      expect([...seeds].sort((a, b) => a - b)).toEqual(seeds);
    });

    it('deals a new hand when chosen again after another axis', async () => {
      const seeds: number[] = [];
      const view = await draw({ onState: (state) => seeds.push(state.seed) });
      await openSheet(view);
      await fireEvent.press(sortRadio(view, 'Shuffle'));
      await openSheet(view);
      await fireEvent.press(sortRadio(view, /^Title/));
      await fireEvent.press(sortRadio(view, 'Shuffle'));
      const shuffleSeeds = seeds.filter((_, i) => i !== 1);
      expect(shuffleSeeds[1]).toBeGreaterThan(shuffleSeeds[0]!);
    });

    it('gives the hint only to the selected Shuffle row', async () => {
      const view = await draw();
      await openSheet(view);
      expect(sortRadio(view, 'Shuffle').props.accessibilityHint).toBeUndefined();
      expect(sortRadio(view, /^Rating/).props.accessibilityHint).toBeUndefined();
    });

    it('keeps the filters in force and leaves unapplied drafts unapplied', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({
        initial: { filters: { ...initialViewState().filters, genres: ['Drama'] } },
        onState: (state) => seen.push(state),
      });
      await openSheet(view);
      // A draft change, never applied.
      await fireEvent.press(view.getByRole('checkbox', { name: /^Comedy/ }));
      await fireEvent.press(sortRadio(view, 'Shuffle'));
      expect(seen.at(-1)?.filters.genres).toEqual(['Drama']);
      await view.unmount();
      expect((await orderOf(LIBRARY, seen.at(-1)!)).sort()).toEqual(['Film 02', 'Film 04']);
    });

    it('holds its order through re-renders, a refetch and Grid/List switches', async () => {
      const shuffled: Partial<CollectionViewState> = {
        mode,
        sort: { axis: 'shuffle', direction: 'desc' },
        seed: 11,
      };
      const seen: CollectionViewState[] = [];
      const view = await renderWithProviders(
        <Harness items={LIBRARY} initial={shuffled} onState={(state) => seen.push(state)} />,
      );
      const order = drawn(view);
      expect(order).toHaveLength(LIBRARY.length);

      // A re-render with the same rows, then a refetch: equal rows, new objects, arriving
      // in another order.
      const refetched = [...LIBRARY].reverse().map((row) => ({ ...row }));
      await view.rerender(
        <Harness items={LIBRARY} initial={shuffled} onState={(state) => seen.push(state)} />,
      );
      await view.rerender(
        <Harness items={refetched} initial={shuffled} onState={(state) => seen.push(state)} />,
      );
      expect(drawn(view)).toEqual(order);

      // Grid → List → Grid (or the reverse).
      const other = mode === 'poster' ? 'List view' : 'Poster view';
      const back = mode === 'poster' ? 'Poster view' : 'List view';
      await fireEvent.press(view.getByRole('radio', { name: other }));
      await fireEvent.press(view.getByRole('radio', { name: back }));

      // Nothing but the mode moved: the seed and the sort are where the reader left them.
      expect(seen.map((state) => state.mode)).toEqual([
        other === 'List view' ? 'list' : 'poster',
        mode,
      ]);
      for (const state of seen) {
        expect(state.seed).toBe(11);
        expect(state.sort).toEqual({ axis: 'shuffle', direction: 'desc' });
      }
      // And the order those states draw — over the refetched rows, in either mode — is
      // the one the reader had.
      await view.unmount();
      expect(await orderOf(refetched, seen.at(0)!)).toEqual(order);
      expect(await orderOf(refetched, seen.at(-1)!)).toEqual(order);
    });

    it('works on a single title, and the toolbar is absent on none', async () => {
      const seen: CollectionViewState[] = [];
      const one = await draw({ items: [film(1)], onState: (state) => seen.push(state) });
      await openSheet(one);
      await fireEvent.press(sortRadio(one, 'Shuffle'));
      expect(seen.at(-1)?.sort.axis).toBe('shuffle');
      expect(seen.at(-1)?.seed).toBe(initialViewState().seed + 1);
      expect(drawn(one)).toEqual(['Film 01']);
      await one.unmount();

      const none = await draw({ items: [] });
      expect(none.getByText('Empty here')).toBeTruthy();
      expect(none.queryByTestId('collection-filter-sort')).toBeNull();
    });
  });

  describe('the other sorts', () => {
    it('still apply on the press and reverse on a second, with the sheet open', async () => {
      const seen: CollectionViewState[] = [];
      const view = await draw({ onState: (state) => seen.push(state) });
      await openSheet(view);
      for (const name of [
        /^Title/,
        /^Title/,
        /^Release year/,
        /^Rating/,
        /^Recently watched/,
      ]) {
        await fireEvent.press(sortRadio(view, name));
        expect(view.getByTestId('collection-sort-section')).toBeTruthy();
      }
      expect(seen.map((state) => state.sort)).toEqual([
        { axis: 'title', direction: 'asc' },
        { axis: 'title', direction: 'desc' },
        { axis: 'year', direction: 'desc' },
        { axis: 'rating', direction: 'desc' },
        { axis: 'watched', direction: 'desc' },
      ]);
      // None of them moved the shuffle seed.
      expect(new Set(seen.map((state) => state.seed))).toEqual(
        new Set([initialViewState().seed]),
      );
    });
  });
});
