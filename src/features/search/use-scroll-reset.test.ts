import { renderHook } from '@testing-library/react-native';

import { useScrollReset, type ScrollsToOffset } from './use-scroll-reset';

describe('useScrollReset', () => {
  const mount = async (key: string) => {
    const scrollToOffset = jest.fn();
    const view = await renderHook(
      ({ current }: { current: string }) => useScrollReset<ScrollsToOffset>(current),
      {
        initialProps: { current: key },
      },
    );
    view.result.current.current = { scrollToOffset };
    return { ...view, scrollToOffset };
  };

  it('does not move a list on its first render, or on renders of the same dataset', async () => {
    const { rerender, scrollToOffset } = await mount('all|leo');
    await rerender({ current: 'all|leo' });
    await rerender({ current: 'all|leo' });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('returns to the top, without animation, when the dataset changes', async () => {
    const { rerender, scrollToOffset } = await mount('all|leo');
    await rerender({ current: 'movies|leo' });
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });

    await rerender({ current: 'movies|leonardo' });
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
    // And not again for a render that changes nothing about what is listed.
    await rerender({ current: 'movies|leonardo' });
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('tolerates a list that is not mounted', async () => {
    const view = await renderHook(
      ({ current }: { current: string }) => useScrollReset(current),
      {
        initialProps: { current: 'a' },
      },
    );
    await expect(view.rerender({ current: 'b' })).resolves.not.toThrow();
  });
});
