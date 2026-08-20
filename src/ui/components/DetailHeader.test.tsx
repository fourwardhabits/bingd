import { act } from '@testing-library/react-native';

import { renderHookWithProviders } from '@/test-utils/render';

import { useDetailHeader } from './DetailHeader';

/**
 * The founder's report: Movie, Series, Season and Person disagreed about their headers.
 * Title pages blanked the bar forever, so scrolling past the hero left no answer to
 * "what am I looking at"; person pages printed the name in the bar directly above the
 * same name in `title1`.
 *
 * These assert the shared rule that replaced both — the bar is empty exactly while the
 * page names itself, and carries the name exactly when it does not.
 *
 * The test metrics in `render.tsx` put the top inset at 47, and
 * `layout.control.headerHeight` is 44, so the bar covers the first **91** points of the
 * page. That number is what makes the reveal fire late enough: the title-page header is
 * transparent, so an identity block whose bottom is at 200 is still legible until the
 * scroll offset passes 109, not 0.
 */

const HEADER = 47 + 44;

const layout = (y: number, height: number) => ({
  nativeEvent: { layout: { x: 0, y, width: 390, height } },
}) as never;

const scroll = (y: number) => ({
  nativeEvent: { contentOffset: { x: 0, y } },
}) as never;

describe('useDetailHeader', () => {
  it('says nothing before a layout has been reported', async () => {
    const { result } = await renderHookWithProviders(() => useDetailHeader());

    // A page that has not yet measured its identity might be showing it. Naming the
    // page in the bar on the guess that it is not is the defect being fixed, so the
    // undecided state resolves to silence.
    await act(async () => result.current.onScroll(scroll(4000)));
    expect(result.current.revealed).toBe(false);
  });

  it('stays silent while the identity is still under the bar', async () => {
    const { result } = await renderHookWithProviders(() => useDetailHeader());
    await act(async () => result.current.onIdentityLayout(layout(0, 200)));

    // Scrolled, but the bottom of the identity is at 200 and the bar reaches 91 + 100.
    // The title is still on screen, so the bar must not repeat it.
    await act(async () => result.current.onScroll(scroll(100)));
    expect(result.current.revealed).toBe(false);
  });

  it('names the page once the identity has passed under the bar', async () => {
    const { result } = await renderHookWithProviders(() => useDetailHeader());
    await act(async () => result.current.onIdentityLayout(layout(0, 200)));

    await act(async () => result.current.onScroll(scroll(200 - HEADER + 1)));
    expect(result.current.revealed).toBe(true);
  });

  it('does not flicker for a hand held still on the boundary', async () => {
    const { result } = await renderHookWithProviders(() => useDetailHeader());
    await act(async () => result.current.onIdentityLayout(layout(0, 200)));

    const crossing = 200 - HEADER;
    await act(async () => result.current.onScroll(scroll(crossing + 1)));
    expect(result.current.revealed).toBe(true);

    // Drifting back a few points does not put it away again: the dead band is what
    // stops a resting finger strobing the title in and out.
    await act(async () => result.current.onScroll(scroll(crossing - 6)));
    expect(result.current.revealed).toBe(true);

    // Genuinely scrolling back up does.
    await act(async () => result.current.onScroll(scroll(crossing - 40)));
    expect(result.current.revealed).toBe(false);
  });

  it('re-decides when the identity moves under a reader who is already scrolled', async () => {
    const { result } = await renderHookWithProviders(() => useDetailHeader());
    await act(async () => result.current.onIdentityLayout(layout(0, 200)));
    await act(async () => result.current.onScroll(scroll(300)));
    expect(result.current.revealed).toBe(true);

    // The hero image arrives and everything below it moves down by 400, which puts the
    // title back on screen without the user having scrolled at all. Deciding only on
    // scroll would leave the bar claiming a title the reader can already see.
    await act(async () => result.current.onIdentityLayout(layout(400, 200)));
    expect(result.current.revealed).toBe(false);
  });
});
