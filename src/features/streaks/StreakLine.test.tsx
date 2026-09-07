import { waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { StreakLine } from './StreakLine';
import type { WeeklyStreak } from './streak';

/**
 * The streak on the profile.
 *
 * `streak.test.ts` owns the arithmetic against pure inputs; what is asserted here is the
 * product decision on top of it — when the section appears at all, what its second line
 * says, and the restraint the founder asked for by name.
 */

let mockStreak: { data?: WeeklyStreak; isPending: boolean; isError: boolean };
const mockTrack = jest.fn();

jest.mock('./use-streak', () => ({ useStreak: () => mockStreak }));
jest.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }));

const streak = (over: Partial<WeeklyStreak> = {}): WeeklyStreak => ({
  weeks: 4,
  rankedThisWeek: false,
  best: 4,
  hasHistory: true,
  ...over,
});

const settled = (data: WeeklyStreak) => ({ data, isPending: false, isError: false });

const open = () => renderWithProviders(<StreakLine userId="user-1" />);

beforeEach(() => {
  mockTrack.mockReset();
  mockStreak = settled(streak());
});

describe('when the section appears at all', () => {
  it('draws nothing for an account that has never ranked anything', async () => {
    /**
     * "🔥 0 weeks" on a new account is the app telling somebody they are failing at
     * something they have not started. A streak is a reward for a habit, and there is
     * no habit to describe yet.
     */
    mockStreak = settled(streak({ hasHistory: false, weeks: 0, best: 0 }));
    const view = await open();

    expect(view.queryByLabelText(/week streak/)).toBeNull();
    expect(view.queryByText(/0 weeks/)).toBeNull();
  });

  it('draws nothing while the read is in flight', async () => {
    mockStreak = { data: undefined, isPending: true, isError: false };
    const view = await open();

    expect(view.queryByText(/WEEKLY STREAK/)).toBeNull();
  });

  it('draws nothing when the read failed, rather than an apology on the profile', async () => {
    // The same rule the awards shelf and the watchlist shelf on this page follow: a
    // failed secondary read must not take more of the profile than the feature does
    // when it works.
    mockStreak = { data: undefined, isPending: false, isError: true };
    const view = await open();

    expect(view.queryByText(/WEEKLY STREAK/)).toBeNull();
    expect(view.queryByText(/Could not load/i)).toBeNull();
  });

  it('appears with a run to show', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/week streak/)).toBeTruthy());
    expect(view.getByLabelText(/^A 4 week streak/)).toBeTruthy();
  });
});

/**
 * **The row says the run, and a state only when there is one** (founder, physical
 * Android, 2026-09-07).
 *
 * It used to append a sentence in every case: `Ranked this week ✓` when the week was
 * earned, and otherwise a nudge — "Rank something in the next 2 days to keep it going."
 * The nudge is the row turning into a task the moment somebody has not done it, and the
 * founder cut it: an open week is not a lost one, and does not need announcing.
 *
 * What survives is `🔥 4 week streak`, with `· This week ✓` after it once the week is
 * genuinely earned. Nothing here is a countdown, and there is still no loss state.
 */
describe('what the row says', () => {
  it('names the run as a streak, not as a bare count of weeks', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByText(/🔥 4 week streak/)).toBeTruthy());
  });

  it('confirms a week that is already earned, in two words', async () => {
    mockStreak = settled(streak({ rankedThisWeek: true }));
    const view = await open();

    await waitFor(() => expect(view.getByText(/This week ✓/)).toBeTruthy());
    // Not "Ranked this week": three words to restate the verb the feature is about.
    expect(view.queryByText(/Ranked this week/)).toBeNull();
  });

  it('appends nothing at all while the week is still open', async () => {
    // The founder’s rule: no status, no dot, no check unless there is a real one. A
    // clock is pinned because the old copy branched on how much of the week was left,
    // and the point is that nothing branches now.
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 2, 12));
    try {
      const view = await open();

      await waitFor(() => expect(view.getByText(/🔥 4 week streak/)).toBeTruthy());
      expect(view.queryByText(/keep it going/)).toBeNull();
      expect(view.queryByText(/·/)).toBeNull();
      expect(view.queryByText(/✓/)).toBeNull();
      expect(view.queryByText(/days/)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says nothing whatever about a run that is over', async () => {
    // No "you lost your streak", no loss animation — and no "🔥 0 week streak", which
    // is the app telling somebody they are failing at something.
    mockStreak = settled(streak({ weeks: 0, best: 6 }));
    const view = await open();

    expect(view.queryByText(/week streak/)).toBeNull();
    expect(view.queryByText(/start a new one/)).toBeNull();
  });

  it('agrees with itself about one week', async () => {
    mockStreak = settled(streak({ weeks: 1, best: 1 }));
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/^A one week streak/)).toBeTruthy());
    expect(view.getByText(/🔥 1 week streak/)).toBeTruthy();
  });
});

describe('the restraint the founder asked for', () => {
  it('offers no points, coins or level of any kind', async () => {
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/week streak/)).toBeTruthy());
    for (const word of [/points?/i, /coins?/i, /\bXP\b/, /level/i, /freeze/i]) {
      expect(view.queryByText(word)).toBeNull();
    }
  });

  it('offers no landing page to open', async () => {
    // Two lines under the awards shelf is the whole surface. A page nobody visits
    // answers nothing about whether streaks are worth keeping.
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/week streak/)).toBeTruthy());
    expect(view.queryByRole('button')).toBeNull();
  });

  it('reads the streak out in words, so the flame is decoration', async () => {
    const view = await open();

    // The run in words, so the flame is never read out as "fire". With nothing to
    // report about the open week, the spoken label is the run and only the run.
    await waitFor(() => expect(view.getByLabelText('A 4 week streak')).toBeTruthy());
  });
});

describe('what it reports', () => {
  it('records the state a reader was actually shown', async () => {
    // The distribution is the question: how many people are looking at a live streak
    // versus a zero is the difference between a mechanic that works and decoration.
    await open();

    await waitFor(() => expect(mockTrack).toHaveBeenCalled());
    expect(mockTrack).toHaveBeenCalledWith({
      name: 'streak_state_viewed',
      props: { weeks: 4, ranked_this_week: false, days_left: expect.any(Number) },
    });
  });

  it('reports once, not once per render', async () => {
    // The profile is a tab and stays mounted. An event per render would count
    // scrolling as viewing.
    const view = await open();

    await waitFor(() => expect(mockTrack).toHaveBeenCalledTimes(1));
    view.rerender(<StreakLine userId="user-1" />);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for an account with no history, because there was nothing to see', async () => {
    mockStreak = settled(streak({ hasHistory: false }));
    await open();

    expect(mockTrack).not.toHaveBeenCalled();
  });
});
