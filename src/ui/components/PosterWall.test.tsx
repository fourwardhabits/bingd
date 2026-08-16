import { fireEvent, render } from '@testing-library/react-native';

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

    expect(view.queryByText('TOP RANKED')).toBeNull();
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

describe('PosterShelf', () => {
  it('carries its reason as the header', async () => {
    const view = await render(
      <PosterShelf title="Because you loved Inception" tiles={tiles} onPressTile={() => {}} />,
    );

    expect(view.getByText('BECAUSE YOU LOVED INCEPTION')).toBeTruthy();
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
