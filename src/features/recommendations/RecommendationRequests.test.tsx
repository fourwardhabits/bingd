import { Alert } from 'react-native';
import { act, fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

// Not colocated with the screen: everything under app/ is pulled into the bundle by
// expo-router's require.context, which has no exclusion for test files. See
// app-directory.test.ts.
import RecommendationsScreen from '../../../app/(tabs)/recommendations';

/**
 * Recommendation requests, end to end on the client (20260826000400).
 *
 * The screen rather than the sheet in isolation, because the two halves of this feature
 * are a **count above the filters** and a **list inside a sheet**, and the thing that
 * would actually break is those two disagreeing. Rendering the sheet alone would test
 * the list and prove nothing about the row that opens it.
 */

// `expo-crypto` has no native module under jest and `randomUUID` answers undefined
// without this — which would make the Dismiss all operation id a literal undefined.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${(issued += 1)}` }));

const mockPush = jest.fn();
const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, unknown> = {};

/**
 * RPCs whose reply is held open, and the resolvers that let a test end them.
 *
 * A sweep that is genuinely still in flight is the only way to test the overlap guard —
 * a promise that resolves in the same tick cannot overlap with anything.
 */
let mockRpcHeld: string[] = [];
let mockRelease: (() => void)[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      const error = mockRpcErrors[name] ?? null;
      const answer = { data: error ? null : (mockRpcResults[name] ?? null), error };
      if (mockRpcHeld.includes(name)) {
        return new Promise((resolve) => mockRelease.push(() => resolve(answer)));
      }
      return Promise.resolve(answer);
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        gt: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));

jest.mock('expo-router', () => ({
  useFocusEffect: () => {},
  useRouter: () => ({ push: mockPush, replace: () => {}, back: () => {} }),
  Stack: { Screen: () => null },
}));

jest.mock('@/features/auth', () => ({
  useCurrentProfile: () => ({
    id: 'user-1',
    username: 'sai',
    display_name: 'Sai',
    avatar_path: null,
    avatarUri: null,
  }),
}));

/** The For You engine is not what any of this is about. */
jest.mock('@/features/recommendations/use-for-you', () => ({
  useForYou: () => ({
    data: { items: [], candidatePool: [], anchorsUsed: 0, lowData: true, taste: null },
    isPending: false,
    isError: false,
    refetch: () => Promise.resolve(),
  }),
}));

/**
 * One pending request row, in the shape `recommendation_requests` returns.
 *
 * `total_pending` is repeated on every row by design — the server counts before its own
 * limit, so a capped list still reports a true total.
 */
const request = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  sender_id: 'user-2',
  sender_username: 'sarah',
  sender_display_name: 'Sarah Chen',
  sender_avatar_path: null,
  media_item_id: 'film-1',
  media_kind: 'movie',
  media_title: 'Arrival',
  series_title: null,
  poster_path: null,
  release_date: '2016-11-11',
  genres: ['Science Fiction'],
  runtime_minutes: 116,
  recommended_at: '2026-08-20T10:00:00Z',
  total_pending: 1,
  ...over,
});

/**
 * The first match, or a failure that names what was missing.
 *
 * `getAllByText(…)[0]` is `T | undefined` under `noUncheckedIndexedAccess`, and a
 * non-null assertion would turn "the control is not there" into a null-pointer stack
 * trace three lines later. This says which control.
 */
const first = <T,>(matches: T[], what: string): T => {
  const match = matches[0];
  if (!match) throw new Error(`expected at least one "${what}" control`);
  return match;
};

const openSheet = async () => {
  const view = await renderWithProviders(<RecommendationsScreen />);
  await waitFor(() => expect(view.getByTestId('recommendation-requests-alert')).toBeTruthy());
  await fireEvent.press(view.getByTestId('recommendation-requests-alert'));
  await waitFor(() => expect(view.getByText('Recommendation requests')).toBeTruthy());
  return view;
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockPush.mockReset();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockRpcHeld = [];
  mockRelease = [];
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the compact alert row', () => {
  it('is absent when nothing is waiting', async () => {
    mockRpcResults.recommendation_requests = [];

    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByText('Sent to you')).toBeTruthy());
    expect(view.queryByTestId('recommendation-requests-alert')).toBeNull();
  });

  /**
   * The count is **items**, not senders, and it is the server's own — not the length of
   * a list that may have been capped.
   */
  it('counts pending items across senders, not senders', async () => {
    mockRpcResults.recommendation_requests = [
      request({ id: 'a', total_pending: 3 }),
      request({ id: 'b', media_item_id: 'film-2', media_title: 'The Bear', total_pending: 3 }),
      request({
        id: 'c',
        sender_id: 'user-3',
        sender_username: 'mike',
        sender_display_name: 'Mike Patel',
        media_item_id: 'film-3',
        media_title: 'Oppenheimer',
        total_pending: 3,
      }),
    ];

    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByText('Recommendation requests')).toBeTruthy());
    expect(view.getByText(' · 3')).toBeTruthy();
    expect(view.getByLabelText('3 recommendation requests')).toBeTruthy();
  });

  it('carries no dismiss control of its own', async () => {
    mockRpcResults.recommendation_requests = [request()];

    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByTestId('recommendation-requests-alert')).toBeTruthy());
    // The only way to clear it is to decide about the recommendations. An X here would
    // be a way to lose them without deciding.
    expect(view.queryByLabelText(/dismiss/i)).toBeNull();
  });

  /**
   * §19: the request signal lives here and nowhere else. The bell reads
   * `my_notifications`, and a pending request files no notification at all — so the
   * screen must not be reaching for one either.
   */
  it('does not put requests anywhere near the notifications bell', async () => {
    mockRpcResults.recommendation_requests = [request({ total_pending: 5 })];
    mockRpcResults.my_notifications = [];

    const view = await renderWithProviders(<RecommendationsScreen />);

    await waitFor(() => expect(view.getByTestId('recommendation-requests-alert')).toBeTruthy());
    expect(view.queryByLabelText(/5 unread/i)).toBeNull();
    expect(view.queryByLabelText(/Notifications, 5/i)).toBeNull();
  });
});

describe('the requests sheet', () => {
  beforeEach(() => {
    mockRpcResults.recommendation_requests = [
      request({ id: 'req-1', total_pending: 3 }),
      request({
        id: 'req-2',
        media_item_id: 'film-2',
        media_title: 'The Bear',
        release_date: '2023-06-22',
        genres: ['Comedy', 'Drama'],
        total_pending: 3,
      }),
      request({
        id: 'req-3',
        sender_id: 'user-3',
        sender_username: 'mike',
        sender_display_name: 'Mike Patel',
        media_item_id: 'film-3',
        media_title: 'Oppenheimer',
        release_date: '2023-07-21',
        genres: ['Drama'],
        total_pending: 3,
      }),
    ];
    mockRpcResults.follow_state_with = [];
  });

  it('groups titles under the person who sent them, with one Follow each', async () => {
    const view = await openSheet();

    expect(view.getByText('Sarah Chen')).toBeTruthy();
    expect(view.getByText('@sarah')).toBeTruthy();
    expect(view.getByText('Mike Patel')).toBeTruthy();

    expect(view.getByText('Arrival')).toBeTruthy();
    expect(view.getByText('The Bear')).toBeTruthy();
    expect(view.getByText('Oppenheimer')).toBeTruthy();

    // Two senders, two Follow controls — not one per recommendation.
    expect(view.getAllByText('Follow')).toHaveLength(2);
    // But a decision per recommendation, because that is what is being decided.
    expect(view.getAllByText('Add')).toHaveLength(3);
    expect(view.getAllByText('Dismiss')).toHaveLength(3);
  });

  it('adds one recommendation without touching the others', async () => {
    const view = await openSheet();

    await fireEvent.press(first(view.getAllByText('Add'), 'Add'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('add_recommendation', {
        p_recommendation_id: 'req-1',
      }),
    );
    // One call, for one row. Add is not Accept and is not Add all.
    expect(mockRpc.mock.calls.filter(([name]) => name === 'add_recommendation')).toHaveLength(1);
    expect(mockRpc).not.toHaveBeenCalledWith('follow', expect.anything());
  });

  it('dismisses one recommendation and follows nobody', async () => {
    const view = await openSheet();

    await fireEvent.press(first(view.getAllByText('Dismiss'), 'Dismiss'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('dismiss_recommendation', {
        p_recommendation_id: 'req-1',
      }),
    );
    expect(mockRpc).not.toHaveBeenCalledWith('unfollow', expect.anything());
    expect(mockRpc).not.toHaveBeenCalledWith('block', expect.anything());
  });

  /**
   * Following is the bulk action, and it is the server that performs the release. The
   * client's job is one RPC and then believing the database — see `use-social.ts`.
   */
  it('follows the sender from the group header', async () => {
    const view = await openSheet();

    await fireEvent.press(first(view.getAllByText('Follow'), 'Follow'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'follow',
        expect.objectContaining({ p_followee_id: 'user-2' }),
      ),
    );
  });

  it('says Requested, inert, once a private sender has been asked', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'user-2', following: 'pending', followed_by: 'approved', blocked: false },
    ];

    const view = await openSheet();

    // Present rather than hidden — a control that disappears reads as one that failed.
    // Only Sarah has been asked; Mike still offers Follow, which is what keeps this an
    // assertion about one relationship rather than about the sheet.
    await waitFor(() => expect(view.getByText('Requested')).toBeTruthy());
    expect(view.getAllByText('Follow')).toHaveLength(1);

    // And inert: pressing it must not file a second follow.
    await fireEvent.press(view.getByText('Requested'));
    expect(mockRpc).not.toHaveBeenCalledWith('follow', expect.anything());
  });

  it('opens the sender’s real profile rather than drawing one', async () => {
    const view = await openSheet();

    await fireEvent.press(view.getByLabelText('Sarah Chen, @sarah'));

    expect(mockPush).toHaveBeenCalledWith('/u/sarah');
  });
});

describe('dismiss all', () => {
  beforeEach(() => {
    mockRpcResults.recommendation_requests = [request()];
    mockRpcResults.follow_state_with = [];
  });

  it('lives behind the overflow rather than beside the heading', async () => {
    const view = await openSheet();

    expect(view.queryByText('Dismiss all')).toBeNull();
    await fireEvent.press(view.getByLabelText('More options'));
    expect(view.getByText('Dismiss all')).toBeTruthy();
  });

  it('asks before clearing, and names what happens', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await openSheet();

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));

    expect(alert).toHaveBeenCalledWith(
      'Dismiss all recommendation requests?',
      'This removes all pending recommendations. New recommendations can still arrive later.',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel' }),
        expect.objectContaining({ text: 'Dismiss all', style: 'destructive' }),
      ]),
    );
    // Nothing has been swept yet: the confirmation is the gate, not a formality.
    expect(mockRpc).not.toHaveBeenCalledWith(
      'dismiss_all_recommendation_requests',
      expect.anything(),
    );
  });

  it('sweeps only when confirmed, and carries an operation id', async () => {
    let confirm: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      confirm = (buttons ?? []).find((button) => button.text === 'Dismiss all')?.onPress as
        | (() => void)
        | undefined;
    });
    const view = await openSheet();

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'dismiss_all_recommendation_requests',
        expect.objectContaining({ p_operation_id: expect.any(String) }),
      ),
    );
  });

  /**
   * The operation id is **held** across a retry whose outcome nobody established, and
   * released once the server has actually answered.
   *
   * This is the one way this feature could still lose a recommendation silently: a
   * sweep commits, its reply is lost, the reader is told it failed and presses again,
   * and a fresh id walks past `_claim_operation` and takes away whatever arrived in
   * between — requests they never saw. Found by Codex on the first version, which
   * cleared the ref unconditionally.
   */
  it('reuses the operation id after a lost reply, and a fresh one after a real answer', async () => {
    let confirm: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      confirm = (buttons ?? []).find((button) => button.text === 'Dismiss all')?.onPress as
        | (() => void)
        | undefined;
    });

    const sweep = async () => {
      await fireEvent.press(view.getByLabelText('More options'));
      await fireEvent.press(view.getByText('Dismiss all'));
      confirm?.();
    };
    const idsSent = () =>
      mockRpc.mock.calls
        .filter(([name]) => name === 'dismiss_all_recommendation_requests')
        .map(([, args]) => (args as { p_operation_id: string }).p_operation_id);

    // A dropped socket: nothing proves the transaction did not commit.
    mockRpcErrors.dismiss_all_recommendation_requests = { code: '08007' };
    const view = await openSheet();

    await sweep();
    await waitFor(() => expect(idsSent()).toHaveLength(1));

    await sweep();
    await waitFor(() => expect(idsSent()).toHaveLength(2));
    expect(idsSent()[0]).toBe(idsSent()[1]);

    // Now the server answers. The intent is spent, so a later sweep is a new one —
    // holding the id would have it met with `already_applied` and dismiss nothing.
    mockRpcErrors = {};
    await sweep();
    await waitFor(() => expect(idsSent()).toHaveLength(3));
    expect(idsSent()[2]).toBe(idsSent()[1]);

    await sweep();
    await waitFor(() => expect(idsSent()).toHaveLength(4));
    expect(idsSent()[3]).not.toBe(idsSent()[2]);
  });

  /**
   * The retry path a reader actually takes, and the one the first fix missed.
   *
   * A sweep fails, and the obvious recovery is not to press the same menu item again —
   * it is to close the sheet, look at the list, and try once more. The sheet is
   * unmounted while closed, so an intent ref belonging to it would be gone by then and
   * the retry would carry a fresh id. Codex found exactly this; the ref lives on the
   * screen for exactly this.
   */
  it('keeps the operation id across closing and reopening the sheet', async () => {
    let confirm: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      confirm = (buttons ?? []).find((button) => button.text === 'Dismiss all')?.onPress as
        | (() => void)
        | undefined;
    });
    const idsSent = () =>
      mockRpc.mock.calls
        .filter(([name]) => name === 'dismiss_all_recommendation_requests')
        .map(([, args]) => (args as { p_operation_id: string }).p_operation_id);

    mockRpcErrors.dismiss_all_recommendation_requests = { code: '08007' };
    const view = await openSheet();

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();
    await waitFor(() => expect(idsSent()).toHaveLength(1));

    // Out of the sheet and back in, which unmounts and remounts it.
    await fireEvent.press(view.getByText('Done'));
    await waitFor(() => expect(view.queryByText('Recommendation requests')).toBeTruthy());
    await fireEvent.press(view.getByTestId('recommendation-requests-alert'));
    await waitFor(() => expect(view.getByLabelText('More options')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();

    await waitFor(() => expect(idsSent()).toHaveLength(2));
    expect(idsSent()[1]).toBe(idsSent()[0]);
  });

  /**
   * Two sweeps cannot be in flight at once.
   *
   * The server is safe either way — both would carry the held id and the second would be
   * answered `already_applied` — but the *ref* is not: whichever answers first clears
   * it, and if the other then loses its reply there is nothing left to hold. Codex found
   * that tail; refusing the overlap closes it, and a second destructive sweep queued
   * behind the first is not something anybody asked for.
   */
  it('refuses a second sweep while one is still in flight', async () => {
    let confirm: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      confirm = (buttons ?? []).find((button) => button.text === 'Dismiss all')?.onPress as
        | (() => void)
        | undefined;
    });
    const sweeps = () =>
      mockRpc.mock.calls.filter(([name]) => name === 'dismiss_all_recommendation_requests');

    const view = await openSheet();
    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));

    // Both confirmations before either can settle.
    confirm?.();
    confirm?.();

    await waitFor(() => expect(sweeps()).toHaveLength(1));
  });

  /**
   * The overlap that survives closing the sheet.
   *
   * A guard belonging to the sheet is reset when it unmounts, so confirming a sweep,
   * closing before its reply lands, reopening and confirming again gets two calls
   * through. They share the held id, so the server is safe — but the first to answer
   * clears the id, and if the second then loses its reply there is nothing left to hold
   * and the next retry mints a fresh one. Codex found this after the first overlap fix;
   * the guard lives beside the id, on the screen, for exactly this.
   */
  it('refuses a second sweep even across closing and reopening the sheet', async () => {
    let confirm: (() => void) | undefined;
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
      confirm = (buttons ?? []).find((button) => button.text === 'Dismiss all')?.onPress as
        | (() => void)
        | undefined;
    });
    const sweeps = () =>
      mockRpc.mock.calls.filter(([name]) => name === 'dismiss_all_recommendation_requests');

    // The reply is held open, so the first sweep is genuinely still in flight.
    mockRpcHeld = ['dismiss_all_recommendation_requests'];
    const view = await openSheet();

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();
    await waitFor(() => expect(sweeps()).toHaveLength(1));

    // Out and back in while it is still out there.
    await fireEvent.press(view.getByText('Done'));
    await fireEvent.press(view.getByTestId('recommendation-requests-alert'));
    await waitFor(() => expect(view.getByLabelText('More options')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();

    // Flushed before asserting: the call goes out through `mutateAsync`, so a guard
    // that had let it through would issue the RPC a microtask later and an immediate
    // assertion would pass without proving anything.
    await act(async () => {});
    expect(sweeps()).toHaveLength(1);

    // And once it lands, the next one is allowed again.
    mockRelease.forEach((release) => release());
    await waitFor(() => expect(view.getByLabelText('More options')).toBeTruthy());
    mockRpcHeld = [];
    await fireEvent.press(view.getByLabelText('More options'));
    await fireEvent.press(view.getByText('Dismiss all'));
    confirm?.();
    await waitFor(() => expect(sweeps()).toHaveLength(2));
  });
});
