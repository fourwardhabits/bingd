import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { GoalsSection } from './GoalsSection';

/**
 * Independent review, 2026-08-16: **opening Edit and saving deleted both goals.**
 *
 * `GoalSheet` seeds its draft with a `useState` initializer, which runs on mount and
 * never again. The sheet was mounted alongside the section — while the goals query
 * was still in flight — so it seeded itself from `{}`. By the time the user could
 * press Edit the fields were already blank, and an empty field is how that sheet says
 * "remove this goal". Saving an untouched form destroyed the data it was showing.
 *
 * The fix is to mount the sheet only while it is open. The test that proves it is
 * therefore about *timing*: the goals must arrive after the first render, exactly as
 * they do in the app, or the bug does not reproduce.
 */

const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const mockTables: Record<string, unknown[]> = {};
/** When set, reads never settle — the state the screen is in on a cold open. */
let mockNeverSettles = false;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table: string) => {
      const answer = (): Promise<unknown> =>
        mockNeverSettles
          ? new Promise(() => {})
          : Promise.resolve({ data: mockTables[table] ?? [], error: null });
      const chain = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        lte: () => chain,
        then: (resolve: (value: unknown) => unknown) => answer().then(resolve),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

beforeEach(() => {
  mockRpcCalls.length = 0;
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockNeverSettles = false;
});

describe('editing a goal that arrived after the first render', () => {
  beforeEach(() => {
    mockTables.watch_goals = [{ category: 'movies', target: 52 }];
    mockTables.user_media = [];
  });

  it('opens the sheet on the stored target rather than on a blank field', async () => {
    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit'));

    expect(screen.getByDisplayValue('52')).toBeTruthy();
  });

  it('writes nothing when the user saves without changing anything', async () => {
    // The destructive path. Under the old shape the draft was blank, so Save sent
    // `set_watch_goal(2026, 'movies', null)` — the clear.
    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit'));
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
    expect(mockRpcCalls).toEqual([]);
  });

  it('forgets an abandoned draft', async () => {
    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit'));
    await fireEvent.changeText(screen.getByDisplayValue('52'), '');
    await fireEvent.press(screen.getByText('Cancel'));
    await fireEvent.press(screen.getByText('Edit'));

    // Cleared, cancelled, reopened. The field must show the goal that is still set,
    // not the removal the user walked away from.
    expect(screen.getByDisplayValue('52')).toBeTruthy();
  });

  it('still writes a change the user actually made', async () => {
    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit'));
    await fireEvent.changeText(screen.getByDisplayValue('52'), '60');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]).toEqual({
      name: 'set_watch_goal',
      args: { p_year: 2026, p_category: 'movies', p_target: 60 },
    });
  });

  it('clears a goal when the user empties the field on purpose', async () => {
    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());

    await fireEvent.press(screen.getByText('Edit'));
    await fireEvent.changeText(screen.getByDisplayValue('52'), '');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]?.args).toEqual({
      p_year: 2026,
      p_category: 'movies',
      p_target: null,
    });
  });
});

describe('when the goals change on the server while the sheet is open', () => {
  /**
   * The second finding from the same review. The draft was seeded from the targets at
   * open, but Save compared it against the *live* prop — so a refetch bringing 60 in
   * behind an open sheet made an untouched Save conclude the user had changed 60 to
   * 52, reverting a change made on another device from a form nobody typed into.
   */
  beforeEach(() => {
    mockTables.watch_goals = [{ category: 'movies', target: 52 }];
    mockTables.user_media = [];
  });

  const openThenRefetchTo = async (target: number) => {
    const { client } = await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());
    await fireEvent.press(screen.getByText('Edit'));

    mockTables.watch_goals = [{ category: 'movies', target }];
    await client.invalidateQueries({ queryKey: ['goals', 'user-1', 2026] });
    // `includeHiddenElements`, because the open sheet is a modal and everything
    // behind it — the bar this is waiting on — is hidden from the accessibility
    // tree by `accessibilityViewIsModal`, which is exactly right of the sheet and
    // exactly wrong for a query that wants to know the refetch landed.
    await waitFor(() =>
      expect(screen.getByText(`0 of ${target} movies`, { includeHiddenElements: true })).toBeTruthy(),
    );
  };

  it('leaves the draft where the user left it', async () => {
    await openThenRefetchTo(60);

    // An editor that rewrote the field under the user's hands would be worse than
    // the bug. The draft is theirs until they close it.
    expect(screen.getByDisplayValue('52')).toBeTruthy();
  });

  it('writes nothing when the user saves without having touched it', async () => {
    await openThenRefetchTo(60);
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(screen.queryByText('Save')).toBeNull());
    expect(mockRpcCalls).toEqual([]);
  });

  it('still writes what the user actually typed', async () => {
    await openThenRefetchTo(60);
    await fireEvent.changeText(screen.getByDisplayValue('52'), '75');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]?.args).toEqual({
      p_year: 2026,
      p_category: 'movies',
      p_target: 75,
    });
  });
});

describe('before the goals have arrived', () => {
  it('offers no Edit control at all', async () => {
    // The other half of the same defect: "Edit" over an unknown current value opens a
    // sheet that can only guess. It appears once the read has landed.
    mockNeverSettles = true;

    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);

    expect(screen.queryByText('Edit')).toBeNull();
  });
});

describe('with no goal set', () => {
  it('offers to take one', async () => {
    mockTables.watch_goals = [];
    mockTables.user_media = [];

    await renderWithProviders(<GoalsSection userId="user-1" year={2026} />);

    await waitFor(() => expect(screen.getByText('Set a goal')).toBeTruthy());
    expect(screen.queryByText('Edit')).toBeNull();
  });
});
