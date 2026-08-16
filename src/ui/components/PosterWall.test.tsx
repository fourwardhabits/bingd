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
