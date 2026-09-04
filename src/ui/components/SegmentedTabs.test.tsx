import { fireEvent } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { SegmentedTabs } from './SegmentedTabs';

/**
 * The tab row, and the one behaviour it did not have.
 *
 * This is a flex row with a fixed 20pt gap and no wrap. A row wider than the screen
 * ran off the right edge and took its last tab with it, silently — nothing clips
 * visibly in React Native and nothing warns. That was survivable while the longest
 * row was four tabs; a season page carries five, and any row at all can outgrow a
 * 320pt phone once a reader raises their system text size.
 *
 * The fix is a horizontal `ScrollView`, and the tests that matter are the ones
 * asserting it changed nothing else: every other screen using this component was
 * drawn against a row that fits, and a row that fits must look and behave exactly as
 * it did.
 */

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: (Node | string)[] | null;
};

/** Every node in the rendered tree, so a structural prop can be found by search. */
const nodes = (node: Node | string | null): Node[] => {
  if (!node || typeof node === 'string') return [];
  return [node, ...(node.children ?? []).flatMap(nodes)];
};

/** Every tab's label, in render order. */
const labelsInOrder = (root: Node) =>
  nodes(root)
    .filter((node) => node.props?.accessibilityRole === 'tab')
    .flatMap((tab) =>
      nodes(tab)
        .flatMap((node) => node.children ?? [])
        .filter((child): child is string => typeof child === 'string'),
    );

const TABS = [
  { id: 'episodes' as const, label: 'Episodes' },
  { id: 'cast' as const, label: 'Cast' },
  { id: 'reviews' as const, label: 'Reviews' },
  { id: 'videos' as const, label: 'Videos' },
  { id: 'details' as const, label: 'Details' },
];

const renderTabs = (value: string = 'episodes', onChange = jest.fn()) =>
  renderWithProviders(
    <SegmentedTabs options={TABS} value={value as 'episodes'} onChange={onChange} />,
  );

describe('the tab row', () => {
  it('renders every option as a tab, in the order it was given', async () => {
    const view = await renderTabs();

    expect(view.getAllByRole('tab')).toHaveLength(5);
    // Order matters and is not implied by the count: the tab row's first entry is the
    // one `activeTab` falls back to, which is how Episodes becomes a season's default.
    expect(labelsInOrder(view.toJSON() as Node)).toEqual([
      'Episodes',
      'Cast',
      'Reviews',
      'Videos',
      'Details',
    ]);
  });

  it('reports the selected tab to a screen reader, and only that one', async () => {
    const view = await renderTabs('reviews');

    const selected = view
      .getAllByRole('tab')
      .filter((tab) => tab.props.accessibilityState?.selected);

    expect(selected).toHaveLength(1);
    expect(view.getByRole('tab', { name: 'Reviews' }).props.accessibilityState.selected).toBe(true);
  });

  it('keeps the tablist role, so the group is still announced as a set of tabs', async () => {
    // The role stays on the inner row rather than moving to the scroll view. A reader
    // on a screen reader should meet a list of tabs, not a scroll area containing one.
    //
    // Asserted structurally rather than with `getByRole`, which only matches nodes
    // that are accessibility elements in their own right; the row is a container and
    // is deliberately not one.
    const view = await renderTabs();

    const tablist = nodes(view.toJSON() as Node).filter(
      (node) => node.props?.accessibilityRole === 'tablist',
    );

    expect(tablist).toHaveLength(1);
    expect(view.getAllByRole('tab')).toHaveLength(5);
  });

  it('reports a press as the tab id rather than its label', async () => {
    const onChange = jest.fn();
    const view = await renderTabs('episodes', onChange);

    await fireEvent.press(view.getByRole('tab', { name: 'Details' }));

    expect(onChange).toHaveBeenCalledWith('details');
  });

  it('scrolls sideways, so a row too wide for the screen keeps its last tab', async () => {
    // Five tabs at 15pt plus four 20pt gaps and two 16pt gutters is past a 320pt
    // phone. Without this the row overflowed and Details was simply not reachable.
    const view = await renderTabs();

    const scroller = nodes(view.toJSON() as Node).find((node) => node.props?.horizontal);

    expect(scroller).toBeTruthy();
    expect(scroller?.props?.horizontal).toBe(true);
  });

  it('shows no scrollbar and does not bounce, so a row that fits is unchanged', async () => {
    // The appearance-preserving half. A visible indicator or an iOS rubber-band would
    // be new behaviour on the four screens that were fine before this change.
    const view = await renderTabs();

    const scroller = nodes(view.toJSON() as Node).find((node) => node.props?.horizontal);

    expect(scroller?.props?.showsHorizontalScrollIndicator).toBe(false);
    expect(scroller?.props?.alwaysBounceHorizontal).toBe(false);
  });

  it('takes its height from the tabs rather than from the space offered', async () => {
    // A ScrollView expands into a flexible parent unless told not to. On the title
    // page that parent is the rest of the screen, which would push the content of
    // every tab below the fold.
    const view = await renderTabs();

    const scroller = nodes(view.toJSON() as Node).find((node) => node.props?.horizontal);
    const style = [scroller?.props?.style].flat().filter(Boolean) as Record<string, unknown>[];

    expect(style.some((entry) => entry.flexGrow === 0)).toBe(true);
  });

  it('draws two tabs the same way it always did', async () => {
    // The narrow case, which is what collection and profile use. Nothing about a
    // short row should have moved.
    const view = await renderWithProviders(
      <SegmentedTabs
        options={[
          { id: 'a' as const, label: 'Ranked' },
          { id: 'b' as const, label: 'Unranked' },
        ]}
        value="a"
        onChange={jest.fn()}
      />,
    );

    expect(view.getAllByRole('tab')).toHaveLength(2);
    expect(view.getByRole('tab', { name: 'Ranked' }).props.accessibilityState.selected).toBe(true);
  });
});
