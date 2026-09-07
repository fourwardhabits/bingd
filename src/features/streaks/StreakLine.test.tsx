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

describe('what the second line says', () => {
  it('confirms a week that is already safe', async () => {
    mockStreak = settled(streak({ rankedThisWeek: true }));
    const view = await open();

    await waitFor(() => expect(view.getByText(/Ranked this week ✓/)).toBeTruthy());
  });

  /**
   * The clock is pinned for these two, and it has to be: the copy branches on how much
   * of the week is left, so an unpinned test asserts whichever sentence the day it ran
   * on happened to produce — and passes six days in seven while proving nothing about
   * the seventh.
   */
  it('says how many days are left when a live streak is still open', async () => {
    // A Wednesday: five days left, counting today.
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 2, 12));
    try {
      const view = await open();

      // A fact, not a countdown: "5 days left!" is pressure and this is not.
      await waitFor(() =>
        expect(
          view.getByText(/Rank something in the next 5 days to keep it going./),
        ).toBeTruthy(),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('says today on the last day of the week, rather than "1 days"', async () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 6, 12));
    try {
      const view = await open();

      await waitFor(() =>
        expect(view.getByText(/Rank something today to keep it going./)).toBeTruthy(),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('invites a new one rather than mourning the old one', async () => {
    // No "you lost your streak", no loss animation. The run is over; the sentence is
    // about the week that is still available.
    mockStreak = settled(streak({ weeks: 0, best: 6 }));
    const view = await open();

    await waitFor(() =>
      expect(view.getByText(/Rank something this week to start a new one./)).toBeTruthy(),
    );
  });

  it('agrees with itself about one week', async () => {
    mockStreak = settled(streak({ weeks: 1, best: 1 }));
    const view = await open();

    await waitFor(() => expect(view.getByLabelText(/^A one week streak/)).toBeTruthy());
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

    // The run and its state in one spoken sentence, so neither the flame nor the middle
    // dot that joins them is ever read out as punctuation.
    await waitFor(() =>
      expect(view.getByLabelText(/^A 4 week streak\. Rank something/)).toBeTruthy(),
    );
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
