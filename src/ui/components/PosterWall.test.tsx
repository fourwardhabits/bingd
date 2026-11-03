import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { theme } from '../tokens';
import { PosterGrid, PosterShelf, type PosterTile } from './PosterWall';

const tiles: PosterTile[] = [
  { id: 'a', title: 'Inception', year: 2010, score: 9.4, bucket: 'loved' },
  { id: 'b', title: 'Dune', year: 2021 },
  { id: 'c', title: 'Alien', year: 1979, score: 4.2, bucket: 'fine' },
];

describe('PosterGrid', () => {
  it('names each tile, since the tile itself shows no text', async () => {
    // A grid of unlabelled images is the classic way to make a screen unusable
    // without sight. Everything the design leaves out has to be in the label.
    const view = await render(
      <PosterGrid tiles={tiles} onPressTile={() => {}} />,
    );

    expect(view.getByLabelText('Inception, 2010, scored 9.4 out of 10')).toBeTruthy();
    expect(view.getByLabelText('Dune, 2021')).toBeTruthy();
  });

  it('opens the title it was tapped on', async () => {
    const onPressTile = jest.fn();
    const view = await render(<PosterGrid tiles={tiles} onPressTile={onPressTile} />);

    await fireEvent.press(view.getByLabelText('Dune, 2021'));
    expect(onPressTile).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('renders nothing at all when there is nothing to show', async () => {
    // Rather than a header over an empty strip. A section that announces itself
    // and then shows nothing reads as a failed load.
    const view = await render(
      <PosterGrid title="Top ranked" tiles={[]} onPressTile={() => {}} />,
    );

    // Shelf titles print as given since Visual 2.0, so this looks for the real words.
    expect(view.queryByText('Top ranked')).toBeNull();
  });
});

describe('PosterGrid with a lead', () => {
  const ranked: PosterTile[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({
    id,
    title: `Film ${id.toUpperCase()}`,
    year: 2000 + i,
  }));

  it('keeps rank order, the first film leading', async () => {
    const view = await render(<PosterGrid lead tiles={ranked} onPressTile={() => {}} />);
    const order = view
      .getAllByRole('button')
      .map((node) => node.props.accessibilityLabel as string)
      .filter((label) => label?.startsWith('Film'));

    expect(order).toEqual(['Film A, 2000', 'Film B, 2001', 'Film C, 2002', 'Film D, 2003', 'Film E, 2004', 'Film F, 2005']);
  });

  it('gives the three lead tiles every handler the grid gives the rest', async () => {
    // The mosaic draws its first three tiles itself, and a tile drawn there once lost
    // its long press, save and dismiss. A caller's handlers must reach all six.
    const onLongPressTile = jest.fn();
    const onToggleSave = jest.fn();
    const onDismissTile = jest.fn();
    const view = await render(
      <PosterGrid
        lead
        tiles={ranked}
        onPressTile={() => {}}
        onLongPressTile={onLongPressTile}
        onToggleSave={onToggleSave}
        onDismissTile={onDismissTile}
      />,
    );

    await fireEvent(view.getByLabelText('Film A, 2000'), 'longPress');
    await fireEvent.press(view.getByLabelText('Save Film B to watchlist'));
    await fireEvent.press(view.getByLabelText('Not interested in Film C'));

    expect(onLongPressTile).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(onToggleSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(onDismissTile).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
});

describe('the watchlist control on a tile', () => {
  const saveable: PosterTile[] = [
    { id: 'a', title: 'Inception', year: 2010 },
    { id: 'b', title: 'Dune', year: 2021, saved: true },
  ];

  it('is absent unless the surface asked for it', async () => {
    // The collection walls show things already in the collection. Only For You, where
    // saving is the point of the screen, gets the control.
    const view = await render(<PosterGrid tiles={saveable} onPressTile={() => {}} />);

    expect(view.queryByLabelText('Save Inception to watchlist')).toBeNull();
  });

  it('saves without opening the title underneath it', async () => {
    // A Pressable inside a Pressable. If the outer one also fired, tapping the
    // bookmark would navigate away from the wall the user is browsing — which is
    // both wrong and the most annoying possible version of wrong.
    const onPressTile = jest.fn();
    const onToggleSave = jest.fn();
    const view = await render(
      <PosterGrid tiles={saveable} onPressTile={onPressTile} onToggleSave={onToggleSave} />,
    );

    await fireEvent.press(view.getByLabelText('Save Inception to watchlist'));

    expect(onToggleSave).toHaveBeenCalledWith(saveable[0]);
    expect(onPressTile).not.toHaveBeenCalled();
  });

  it('says which way it will go', async () => {
    const view = await render(
      <PosterGrid tiles={saveable} onPressTile={() => {}} onToggleSave={() => {}} />,
    );

    expect(view.getByLabelText('Save Inception to watchlist')).toBeTruthy();
    expect(view.getByLabelText('Remove Dune from watchlist')).toBeTruthy();
  });

  it('tells a screen reader the tile is saved, not only the button', async () => {
    // A sighted reader gets it from a filled glyph without touching anything.
    const view = await render(
      <PosterGrid tiles={saveable} onPressTile={() => {}} onToggleSave={() => {}} />,
    );

    expect(view.getByLabelText('Dune, 2021, saved')).toBeTruthy();
  });
});

describe('the dismiss control on a tile (founder, 2026-08-27 §12)', () => {
  const suggestions: PosterTile[] = [
    { id: 'a', title: 'Inception', year: 2010 },
    { id: 'b', title: 'Dune', year: 2021 },
  ];

  it('is absent unless the surface asked for it', async () => {
    // Only a wall of *suggestions* earns a way to refuse one. A collection wall
    // shows things the reader chose, and an X there would offer to un-choose them.
    const view = await render(
      <PosterGrid tiles={suggestions} onPressTile={() => {}} onToggleSave={() => {}} />,
    );

    expect(view.queryByLabelText('Not interested in Inception')).toBeNull();
  });

  it('says the act, not the glyph', async () => {
    // "X" tells a screen reader nothing. The label is the sentence; the hint is
    // the consequence.
    const view = await render(
      <PosterGrid tiles={suggestions} onPressTile={() => {}} onDismissTile={() => {}} />,
    );

    expect(view.getByLabelText('Not interested in Inception')).toBeTruthy();
    expect(view.getByLabelText('Not interested in Dune')).toBeTruthy();
  });

  it('dismisses without opening the title underneath it', async () => {
    // The bookmark's nested-Pressable rule, applied to the exit: mis-navigating on
    // the tap that was supposed to remove a suggestion would be the worst reading
    // of "not interested".
    const onPressTile = jest.fn();
    const onDismissTile = jest.fn();
    const view = await render(
      <PosterGrid tiles={suggestions} onPressTile={onPressTile} onDismissTile={onDismissTile} />,
    );

    await fireEvent.press(view.getByLabelText('Not interested in Dune'));

    expect(onDismissTile).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(onPressTile).not.toHaveBeenCalled();
  });
});

/**
 * **Bookmark and Not interested together, stacked on the corner** (founder, Visual 2.1,
 * 2026-11-03). Each is its own 44pt press, and neither sits inside the poster's press: a
 * native `hitSlop` cannot reach past a parent, so a smaller box nested in the poster would
 * leave the rest of its target opening the title.
 */
describe('the two corner actions together', () => {
  const tile: PosterTile = { id: 'a', title: 'Inception', year: 2010 };
  const renderBoth = (handlers: Partial<Record<'onPressTile' | 'onToggleSave' | 'onDismissTile' | 'onLongPressTile', jest.Mock>> = {}) =>
    render(
      <PosterGrid
        tiles={[tile]}
        onPressTile={handlers.onPressTile ?? jest.fn()}
        onToggleSave={handlers.onToggleSave ?? jest.fn()}
        onDismissTile={handlers.onDismissTile ?? jest.fn()}
        onLongPressTile={handlers.onLongPressTile ?? jest.fn()}
      />,
    );
  type Node = { parent: Node | null; props: Record<string, unknown> };
  const ancestors = (node: Node) => {
    const out: Node[] = [];
    for (let at = node.parent; at; at = at.parent) out.push(at);
    return out;
  };

  it('gives each a 44pt box of its own, one above the other, neither inside the poster', async () => {
    const view = await renderBoth();
    const poster = view.getByLabelText('Inception, 2010');
    const save = view.getByLabelText('Save Inception to watchlist');
    const dismiss = view.getByLabelText('Not interested in Inception');

    for (const action of [save, dismiss]) {
      const box = StyleSheet.flatten(action.props.style) as ViewStyle;
      expect(box.width).toBe(theme.layout.minTapTarget);
      expect(box.height).toBe(theme.layout.minTapTarget);
      expect(ancestors(action as unknown as Node)).not.toContain(poster);
    }

    // Siblings in one column pinned to the corner, bookmark first: two whole boxes that
    // stack edge to edge, so no point on the poster belongs to both.
    const column = (save as unknown as Node).parent!;
    expect(ancestors(dismiss as unknown as Node)).toContain(column);
    const corner = StyleSheet.flatten(column.props.style as ViewStyle);
    expect(corner).toMatchObject({ position: 'absolute', top: 0, right: 0 });
    expect(corner.flexDirection ?? 'column').toBe('column');
    expect(view.getAllByRole('button').indexOf(save)).toBeLessThan(
      view.getAllByRole('button').indexOf(dismiss),
    );
  });

  it('fires only the action that was pressed', async () => {
    const handlers = {
      onPressTile: jest.fn(),
      onToggleSave: jest.fn(),
      onDismissTile: jest.fn(),
      onLongPressTile: jest.fn(),
    };
    const view = await renderBoth(handlers);

    await fireEvent.press(view.getByLabelText('Save Inception to watchlist'));
    expect(handlers.onToggleSave).toHaveBeenCalledTimes(1);
    expect(handlers.onDismissTile).not.toHaveBeenCalled();

    await fireEvent.press(view.getByLabelText('Not interested in Inception'));
    expect(handlers.onDismissTile).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleSave).toHaveBeenCalledTimes(1);

    expect(handlers.onPressTile).not.toHaveBeenCalled();
    expect(handlers.onLongPressTile).not.toHaveBeenCalled();
  });

  it('keeps the long press on the poster for the reason, and never for dismissing', async () => {
    const handlers = { onDismissTile: jest.fn(), onLongPressTile: jest.fn() };
    const view = await renderBoth(handlers);

    await fireEvent(view.getByLabelText('Inception, 2010'), 'longPress');

    expect(handlers.onLongPressTile).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(handlers.onDismissTile).not.toHaveBeenCalled();
    // Holding the X is not asserted here: RNTL's `fireEvent` walks up to the `Tile`
    // component's own `onLongPress` prop, which a native touch on the X's sibling press
    // never reaches. That the X is outside the poster's press is the first test above.
  });
});

describe('PosterShelf', () => {
  it('carries its reason as the header', async () => {
    const view = await render(
      <PosterShelf title="Because you loved Inception" tiles={tiles} onPressTile={() => {}} />,
    );

    expect(view.getByText('Because you loved Inception')).toBeTruthy();
  });

  it('offers the full list only when there is somewhere to go', async () => {
    const plain = await render(
      <PosterShelf title="New this month" tiles={tiles} onPressTile={() => {}} />,
    );
    expect(plain.queryByRole('button', { name: 'All' })).toBeNull();

    const onPressAll = jest.fn();
    const linked = await render(
      <PosterShelf
        title="New this month"
        tiles={tiles}
        onPressTile={() => {}}
        onPressAll={onPressAll}
      />,
    );
    await fireEvent.press(linked.getByRole('button', { name: 'All' }));
    expect(onPressAll).toHaveBeenCalled();
  });
});
