import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import AwardCelebrationScreen from '../../../app/awards/celebrate';

/**
 * The award payoff screen.
 *
 * **What is doubled and why.** `useAwards` reads eight tables to evaluate twenty
 * tracks; that read decides which posters appear and nothing else on this screen, and
 * `celebration-posters.test.ts` owns the selection rules against pure inputs. What is
 * asserted here is the screen: which award is named, what happens with two of them, that
 * Done always works, and — the load-bearing one — that a failed or absent fact read
 * still produces a complete, dismissible celebration.
 */

const mockBack = jest.fn();
let mockParams: { awards?: string } = {};
let mockAwards: { data?: unknown; isPending: boolean; isError: boolean };

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({ id: 'user-1', username: 'sai', display_name: 'Sai' }),
}));

jest.mock('./use-awards', () => ({ useAwards: () => mockAwards }));
jest.mock('./use-award-unlocks', () => ({
  useAwardUnlocks: () => ({ data: [] }),
  unlockTimes: () => undefined,
}));

beforeEach(() => {
  mockBack.mockReset();
  mockParams = {};
  // The ordinary case for these tests: the facts have not arrived, so there is no wall.
  // The card is the message and does not depend on one.
  mockAwards = { data: undefined, isPending: true, isError: false };
});

const open = () => renderWithProviders(<AwardCelebrationScreen />);

describe('one award', () => {
  it('names the tier that was earned and what earned it', async () => {
    mockParams = { awards: 'movie-muncher:bronze' };
    const view = await open();

    // The metal tracks are titled by the family name — `awardAnnouncement`'s rule, and
    // the same one the feed post and the inbox congratulations use.
    await waitFor(() => expect(view.getByText('Movie Muncher')).toBeTruthy());
    expect(view.getByText('Watched 50 movies')).toBeTruthy();
  });

  it('names the tier itself on a creative track', async () => {
    mockParams = { awards: 'lol-mode:giggle' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Giggle')).toBeTruthy());
  });

  it('offers no pagination for a single award', async () => {
    // "1 of 1" under one award is the interface counting to one out loud.
    mockParams = { awards: 'lol-mode:giggle' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Giggle')).toBeTruthy());
    expect(view.queryByText(/1 of 1/)).toBeNull();
  });

  it('offers nothing to react with', async () => {
    /**
     * The founder was explicit, and the reason is the same one that keeps a profile's
     * own Recent activity from being a place to react to yourself: this is the reader's
     * own achievement shown to them alone. The feed post the same unlock produced is
     * where other people react, and it already exists.
     */
    mockParams = { awards: 'lol-mode:giggle' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Giggle')).toBeTruthy());
    expect(view.queryByLabelText(/react/i)).toBeNull();
    expect(view.queryByLabelText(/comment/i)).toBeNull();
  });
});

describe('several awards from one ranking', () => {
  /**
   * One ranking can cross a Movies threshold and a combined Movies-and-TV threshold in
   * the same breath — `_maybe_award_unlocks` loops over every named track — and two
   * modals stacked on each other is two things to dismiss for one accomplishment.
   */
  it('holds them all in one flow', async () => {
    mockParams = { awards: 'movie-muncher:bronze,two-screen-life:tourist' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Movie Muncher')).toBeTruthy());
    expect(view.getByText('Tourist')).toBeTruthy();
  });

  it('says where the reader is in it', async () => {
    mockParams = { awards: 'movie-muncher:bronze,two-screen-life:tourist' };
    const view = await open();

    await waitFor(() => expect(view.getByText('1 of 2')).toBeTruthy());
  });

  it('says Next until the last page, then Done', async () => {
    /**
     * A reader with two awards and a streak is never told the flow has ended before it
     * has. One control that advances and then finishes, rather than a Done on every page
     * that would dismiss the rest of what they just earned.
     */
    mockParams = { awards: 'movie-muncher:bronze,two-screen-life:tourist' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Next')).toBeTruthy());
    expect(view.queryByText('Done')).toBeNull();

    await fireEvent.press(view.getByText('Next'));
    await waitFor(() => expect(view.getByText('Done')).toBeTruthy());
  });
});

describe('Done', () => {
  it('goes back, and is the only thing it does', async () => {
    mockParams = { awards: 'lol-mode:giggle' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Done')).toBeTruthy());
    await fireEvent.press(view.getByText('Done'));

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('still works when the facts could not be read at all', async () => {
    // The celebration is downstream of a ranking that already succeeded. A read that
    // failed costs the wall behind the card; it must not cost the way out.
    mockAwards = { data: undefined, isPending: false, isError: true };
    mockParams = { awards: 'lol-mode:giggle' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Giggle')).toBeTruthy());
    await fireEvent.press(view.getByText('Done'));

    expect(mockBack).toHaveBeenCalled();
  });
});

describe('a parameter that names nothing', () => {
  /**
   * An award celebration with no award is not a state worth rendering, and it is
   * reachable: a truncated deep link, a push from a future sender, a hand-typed URL.
   * What it must never be is a screen with no way out.
   */
  it('offers a way out when the parameter is missing', async () => {
    mockParams = {};
    const view = await open();

    await waitFor(() => expect(view.getByText('Done')).toBeTruthy());
    await fireEvent.press(view.getByText('Done'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('offers a way out when the parameter is malformed', async () => {
    mockParams = { awards: 'not-a-pair,,:' };
    const view = await open();

    await waitFor(() => expect(view.getByText('Done')).toBeTruthy());
    await fireEvent.press(view.getByText('Done'));
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('an award this bundle has never heard of', () => {
  it('draws an honest card rather than a blank one', async () => {
    /**
     * A track added by a future migration, opened from a notification on an older
     * client. `badgeFor` falls back to the 🏅 emoji and `awardAnnouncement` to a neutral
     * name, so the reader gets a real celebration with a vaguer noun in it — which is
     * the right degradation for a client that is behind the database.
     */
    mockParams = { awards: 'a-track-from-the-future:tier-1' };
    const view = await open();

    await waitFor(() => expect(view.getByText('a new Award')).toBeTruthy());
    expect(view.getByText('Done')).toBeTruthy();
  });
});
