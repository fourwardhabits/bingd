import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { ProfileAwards } from './ProfileAwards';
import type { AwardProgress } from './progress';

/**
 * The awards shelf on a profile: three slots, above Goals.
 *
 * **The two queries are doubled, and the reason is worth stating.** The real
 * `useAwards` reads eight tables to evaluate twenty tracks, and `useAwardUnlocks` reads
 * a ninth; neither is what this file is about. What it is about is the shelf's own
 * rules — three slots always, only earned awards on it, the owner's empty slots brighter
 * than a visitor's, and See all opening the sheet. `featured.test.ts` owns the selection
 * order and `awards.test.ts` owns the evaluation.
 *
 * The unlock double also carries the fact that matters most about it: it is only ever
 * *asked* on the owner's own profile, because `award_unlocks` is owner-read-only and a
 * visitor's empty answer is indistinguishable from "nothing earned".
 */

let mockAwards: { data?: { awards: AwardProgress[] }; isPending: boolean; isError: boolean };
let mockUnlocksEnabled: boolean | undefined;

jest.mock('./use-awards', () => ({
  useAwards: () => mockAwards,
}));

jest.mock('./use-award-unlocks', () => ({
  useAwardUnlocks: (_userId: string | null, options: { enabled?: boolean } = {}) => {
    mockUnlocksEnabled = options.enabled;
    return { data: undefined };
  },
  unlockTimes: () => undefined,
}));

const award = (trackKey: string, earnedTierIndex: number, title: string): AwardProgress =>
  ({
    trackKey,
    displayName: title,
    title,
    earnedTierIndex,
    earnedTier:
      earnedTierIndex >= 0
        ? { key: ['bronze', 'silver', 'gold'][earnedTierIndex], label: 'Gold', threshold: 1 }
        : null,
    nextTier: null,
    value: 1,
    detailLine: '',
    countLabel: '',
    unavailable: false,
    withheld: false,
    fraction: 1,
    badgeTierLabel: 'Gold',
    badge: { kind: 'emoji', emoji: '🏆' },
  }) as AwardProgress;

const settled = (awards: AwardProgress[]) => ({
  data: { awards },
  isPending: false,
  isError: false,
});

const open = (over: { viewerId?: string; userId?: string; onSeeAll?: () => void } = {}) =>
  renderWithProviders(
    <ProfileAwards
      viewerId={over.viewerId ?? 'me'}
      userId={over.userId ?? 'me'}
      onSeeAll={over.onSeeAll ?? (() => {})}
    />,
  );

beforeEach(() => {
  mockAwards = settled([]);
  mockUnlocksEnabled = undefined;
});

describe('the shelf', () => {
  it('spells the brand exactly, which is the one section that is not upper-cased', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());
  });

  it('draws the awards that were earned', async () => {
    mockAwards = settled([award('a', 2, 'Wheeze'), award('b', 0, 'Giggle')]);
    const view = await open();

    await waitFor(() => expect(view.getByText('Wheeze')).toBeTruthy());
    expect(view.getByText('Giggle')).toBeTruthy();
  });

  it('shows at most five, however many were earned', async () => {
    mockAwards = settled(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key, i) => award(key, 2, `Award ${i}`)),
    );
    const view = await open();

    await waitFor(() => expect(view.getByText('Award 0')).toBeTruthy());
    expect(view.getByText('Award 4')).toBeTruthy();
    // The sixth and seventh are behind See all, which is where a list belongs.
    expect(view.queryByText('Award 5')).toBeNull();
    expect(view.queryByText('Award 6')).toBeNull();
  });

  it('leaves a locked track off the shelf entirely', async () => {
    // Progress is not an achievement, and a shelf of things somebody has not done is
    // the participation-trophy problem the thresholds were raised to avoid.
    mockAwards = settled([award('locked', -1, 'LOL Mode')]);
    const view = await open();

    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());
    expect(view.queryByText('LOL Mode')).toBeNull();
  });
});

describe('the empty slots', () => {
  it('says nothing at all, rather than inventing copy for an absence', async () => {
    // No "Locked", no "Keep watching", no name of an award nobody has. Naming what is
    // missing is how a shelf becomes a scoreboard of what somebody has not done.
    const view = await open();

    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());
    expect(view.queryByText(/Locked/i)).toBeNull();
    expect(view.queryByText(/Keep watching/i)).toBeNull();
  });

  /**
   * The composition does not collapse for a new account and does not grow for a full
   * one. A row that changed width with achievement would make one look broken and the
   * other look like a different design.
   *
   * One render per case, deliberately: a second `render` in the same test replaces the
   * screen, and assertions against the first view then read a tree that is gone.
   */
  it('draws five empty slots for an account that has earned nothing', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());

    expect(
      view.getAllByTestId('award-slot-empty', { includeHiddenElements: true }),
    ).toHaveLength(5);
    expect(view.queryAllByTestId('award-slot')).toHaveLength(0);
  });

  it('fills what it has and leaves the rest of the five empty', async () => {
    mockAwards = settled([award('a', 2, 'Wheeze')]);
    const view = await open();
    await waitFor(() => expect(view.getByText('Wheeze')).toBeTruthy());

    expect(view.getAllByTestId('award-slot')).toHaveLength(1);
    expect(
      view.getAllByTestId('award-slot-empty', { includeHiddenElements: true }),
    ).toHaveLength(4);
  });

  it('draws no empty slot at all once five are earned', async () => {
    mockAwards = settled(
      ['a', 'b', 'c', 'd', 'e'].map((key, i) => award(key, 2, `Award ${i}`)),
    );
    const view = await open();
    await waitFor(() => expect(view.getByText('Award 0')).toBeTruthy());

    expect(view.getAllByTestId('award-slot')).toHaveLength(5);
    expect(
      view.queryAllByTestId('award-slot-empty', { includeHiddenElements: true }),
    ).toHaveLength(0);
  });

  it('is announced to nobody, because there is no fact in it', async () => {
    // "Empty award slot" is the interface describing itself, and three of them read out
    // before Goals is the worst version of this section for the readers least able to
    // skip it.
    const view = await open();
    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());

    for (const slot of view.getAllByTestId('award-slot-empty', {
      includeHiddenElements: true,
    })) {
      expect(slot.props.accessibilityElementsHidden).toBe(true);
      expect(slot.props.importantForAccessibility).toBe('no-hide-descendants');
    }
  });

  /**
   * On your own profile an unfilled slot is a reasonable thing to want to fill. On
   * somebody else's it is not the visitor's business, and a row of conspicuous holes
   * makes their profile read as half-built.
   */
  const wellOpacity = (view: Awaited<ReturnType<typeof open>>) => {
    const [slot] = view.getAllByTestId('award-slot-empty', { includeHiddenElements: true });
    // The ring inside the slot is where the treatment lives; the slot itself only
    // positions it. `unknown` first, because the tree's node type says nothing about
    // which props a given host component carries.
    const well = slot?.children[0] as unknown as { props: { style: object } };
    return (StyleSheet.flatten(well.props.style) as { opacity?: number }).opacity;
  };

  it('leaves your own empty slots at full strength, visibly aspirational', async () => {
    const view = await open({ viewerId: 'me', userId: 'me' });
    await waitFor(() =>
      expect(
        view.getAllByTestId('award-slot-empty', { includeHiddenElements: true }),
      ).toHaveLength(5),
    );

    expect(wellOpacity(view)).toBeUndefined();
  });

  it('subdues somebody else’s, so their profile does not read as half-built', async () => {
    const view = await open({ viewerId: 'me', userId: 'anna' });
    await waitFor(() =>
      expect(
        view.getAllByTestId('award-slot-empty', { includeHiddenElements: true }),
      ).toHaveLength(5),
    );

    expect(wellOpacity(view)).toBeLessThan(1);
  });
});

describe('whose profile it is', () => {
  it('asks the unlock ledger on the owner’s own profile', async () => {
    await open({ viewerId: 'me', userId: 'me' });
    await waitFor(() => expect(mockUnlocksEnabled).toBe(true));
  });

  it('does not ask it on somebody else’s, where the policy returns a misleading empty', async () => {
    // `award_unlocks_own` is `user_id = auth.uid()`: asking about another account
    // returns zero rows *and no error*, which is exactly the shape that gets read as
    // "they have earned nothing". Refusing to ask is the guard.
    await open({ viewerId: 'me', userId: 'anna' });
    await waitFor(() => expect(mockUnlocksEnabled).toBe(false));
  });
});

describe('See all', () => {
  it('opens the sheet rather than a second catalogue', async () => {
    const onSeeAll = jest.fn();
    const view = await open({ onSeeAll });

    await waitFor(() => expect(view.getByText('See all')).toBeTruthy());
    await fireEvent.press(view.getByText('See all'));

    expect(onSeeAll).toHaveBeenCalled();
  });

  it('is offered even with an empty shelf, because "what could I earn" is a real question', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('See all')).toBeTruthy());
  });
});

describe('when the read does not land', () => {
  it('draws a skeleton while it is in flight, not an empty shelf', async () => {
    mockAwards = { isPending: true, isError: false };
    const view = await open();

    await waitFor(() => expect(view.getByText('bingd. AWARDS')).toBeTruthy());
    // Three empty wells would be a claim that the person has earned nothing.
    expect(
      view.queryAllByTestId('award-slot-empty', { includeHiddenElements: true }),
    ).toHaveLength(0);
    expect(view.queryAllByTestId('award-slot')).toHaveLength(0);
  });

  it('draws nothing at all when it failed, rather than an apology above Goals', async () => {
    /**
     * A profile whose awards could not be read is not broken — it is a profile without a
     * shelf on it this time. An error block here would give a failed secondary read more
     * of the page than the feature has when it works, and the sheet behind See all has
     * its own error state with its own retry, which is where somebody who wants the
     * answer is going anyway. The Watchlist shelf on this page follows the same rule.
     */
    mockAwards = { isPending: false, isError: true };
    const view = await open();

    expect(view.queryByText('bingd. AWARDS')).toBeNull();
    expect(view.queryByText(/Could not load/i)).toBeNull();
  });
});
