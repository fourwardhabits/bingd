import { act, fireEvent, screen } from '@testing-library/react-native';

import { renderWithProviders as render } from '@/test-utils/render';

import { theme } from '../tokens';
import { MediumSelector, menuPosition } from './MediumSelector';

/**
 * The anchored menu of MediumSelector's `heading` and `filter` sizes (nav cohesion sprint,
 * 2026-11-06): For You's Recommended / Top Rated and the Leaderboard's time range. It
 * opens under its control and must always be inside the window (independent review 1).
 */

const WINDOW = { width: 360, height: 780 };
const INSETS = { top: 24, bottom: 48 };
const GAP = theme.space[1];

describe('where the menu goes', () => {
  it('opens just under the control, on its left edge', () => {
    const at = menuPosition({ x: 16, y: 300, height: 44 }, WINDOW, INSETS, 100);
    expect(at).toMatchObject({ top: 344 + GAP, left: 16, width: 220 });
  });

  it('opens above the control when it would run past the window foot', () => {
    const bottomBound = WINDOW.height - INSETS.bottom - GAP;
    const at = menuPosition({ x: 16, y: 650, height: 44 }, WINDOW, INSETS, 100);
    expect(at.top).toBe(650 - GAP - 100);
    expect(at.top + 100).toBeLessThanOrEqual(bottomBound);
  });

  it('is pinned to the foot and capped, to scroll, when it fits neither way', () => {
    const short = { width: 360, height: 220 };
    const at = menuPosition({ x: 16, y: 90, height: 44 }, short, INSETS, 400);
    const topBound = INSETS.top + GAP;
    const bottomBound = short.height - INSETS.bottom - GAP;
    expect(at.maxHeight).toBe(bottomBound - topBound);
    expect(at.top).toBe(topBound);
    expect(at.top + at.maxHeight).toBe(bottomBound);
  });

  it('stays inside the gutters on a narrow window and near a right edge', () => {
    const narrow = { width: 240, height: 640 };
    const at = menuPosition({ x: 200, y: 100, height: 44 }, narrow, INSETS, 100);
    expect(at.width).toBe(240 - theme.layout.gutter * 2);
    expect(at.left).toBe(theme.layout.gutter);
  });

  it('opens near the top, still inside the window, when the control could not be measured', () => {
    const at = menuPosition(null, WINDOW, INSETS, 100);
    expect(at.top).toBeGreaterThanOrEqual(INSETS.top + GAP);
    expect(at.top + 100).toBeLessThanOrEqual(WINDOW.height - INSETS.bottom - GAP);
  });
});

let mockWindow = { width: 360, height: 780, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

const TIMEFRAMES = [
  { id: 'month', label: 'This month' },
  { id: 'all_time', label: 'All time' },
] as const;

describe('the menu', () => {
  beforeEach(() => {
    mockWindow = { width: 360, height: 780, scale: 2, fontScale: 1 };
  });

  it('closes when the window changes size under it', async () => {
    const view = await render(
      <MediumSelector size="filter" value="month" onChange={() => {}} options={TIMEFRAMES} />,
    );
    await fireEvent.press(screen.getByLabelText('Showing This month'));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);

    mockWindow = { ...mockWindow, width: 780, height: 360 };
    await act(async () => {
      view.rerender(
        <MediumSelector size="filter" value="month" onChange={() => {}} options={TIMEFRAMES} />,
      );
    });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  /**
   * **The Android hypothesis for the self-closing marquee, pinned rather than fixed**
   * (2026-11-11). If a `statusBarTranslucent` Modal on edge-to-edge Android reports a window
   * a status bar taller once it opens, the rule above sees "a size change" and closes the
   * menu it just opened. This shows the rule does close on a height-only change of that
   * size. Whether Android really reports one is a device question no test here can answer,
   * so the rule is unchanged: if the founder's device check reproduces it, the fix is to
   * close on a width change (or a height change larger than the system bars) only, and
   * this expectation flips.
   */
  it('closes today on a height-only change the size of a status bar (hypothesis)', async () => {
    const view = await render(
      <MediumSelector size="marquee" value="month" onChange={() => {}} options={TIMEFRAMES} />,
    );
    await fireEvent.press(screen.getByLabelText('Showing This month'));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);

    mockWindow = { ...mockWindow, height: mockWindow.height + 24 };
    await act(async () => {
      view.rerender(
        <MediumSelector size="marquee" value="month" onChange={() => {}} options={TIMEFRAMES} />,
      );
    });
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('stays open across a re-render that changes nothing about the window', async () => {
    const view = await render(
      <MediumSelector size="marquee" value="month" onChange={() => {}} options={TIMEFRAMES} />,
    );
    await fireEvent.press(screen.getByLabelText('Showing This month'));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);

    mockWindow = { ...mockWindow };
    await act(async () => {
      view.rerender(
        <MediumSelector size="marquee" value="month" onChange={() => {}} options={TIMEFRAMES} />,
      );
    });
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('chooses, and reports only a change', async () => {
    const onChange = jest.fn();
    await render(
      <MediumSelector size="filter" value="month" onChange={onChange} options={TIMEFRAMES} />,
    );
    await fireEvent.press(screen.getByLabelText('Showing This month'));
    await fireEvent.press((await screen.findAllByRole('menuitem'))[0]!);
    expect(onChange).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText('Showing This month'));
    await fireEvent.press(await screen.findByRole('menuitem', { name: 'All time' }));
    expect(onChange).toHaveBeenCalledWith('all_time');
  });
});
