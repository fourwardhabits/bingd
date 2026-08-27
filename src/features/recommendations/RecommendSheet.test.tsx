import { fireEvent, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RecommendSheet } from './RecommendSheet';
import { filterRecipients, type Recipient } from './use-recommend';

// A fresh id every call, so a module-level constant cannot pass for a generator — and so
// the retry assertions below are about two real ids rather than two undefineds.
// `expo-crypto` has no native module under jest and `randomUUID` answers undefined without this.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `share-${(issued += 1)}` }));

const mockRpc = jest.fn();
let mockRpcResults: Record<string, unknown> = {};
let mockRpcErrors: Record<string, { code?: string; message: string } | null> = {};

/** Rows the client would get back from `follows`, embedded profile and all. */
let mockOutgoing: unknown[] = [];
let mockIncoming: unknown[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    // Writes that create a notification nudge push-sender afterwards
    // (notifications/push.ts). It chooses nothing and this suite asserts nothing about
    // it; the stub is here so the nudge is exercised rather than swallowed by its own
    // guard.
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: (name: string, args: unknown) => {
      mockRpc(name, args);
      // A result may be a function of the arguments, because a multi-recipient send is
      // one press making N calls — a partial failure is only expressible if the
      // stand-in can answer each recipient differently.
      const result = mockRpcResults[name];
      return Promise.resolve({
        data: (typeof result === 'function' ? result(args) : result) ?? null,
        error: mockRpcErrors[name] ?? null,
      });
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        order: () => chain,
        // The direction filter and the keyset cursor share one `or`, which is what keeps
        // each page a single request (`use-recommend.ts`). The read pages to exhaustion;
        // one page is enough for these fixtures, but the calls have to exist.
        or: () => chain,
        limit: () => chain,
        gt: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (table !== 'follows') return resolve({ data: [], error: null });
          /**
           * **The direction filter is honoured, and that is the whole point of this
           * stand-in** (20260826000400).
           *
           * The read asks for `follower_id = viewer`: the people the viewer follows, and
           * nobody else. A fixture that answered with every edge regardless would pass
           * whether the query filtered or not — and the defect this tranche exists to fix
           * was a picker assembled from the wrong direction, so the fixture has to be
           * able to tell them apart.
           *
           * Incoming edges are therefore still offered here and are simply never asked
           * for, which is what lets the test below assert that somebody who follows the
           * viewer without being followed back does not appear.
           */
          const VIEWER = { id: 'user-1', username: 'me', display_name: 'Me', avatar_path: null, status: 'active' };
          const edges = [
            ...mockOutgoing.map((profile) => ({
              follower_id: 'user-1',
              followee_id: (profile as { id: string }).id,
              follower: VIEWER,
              followee: profile,
            })),
            ...mockIncoming.map((profile) => ({
              follower_id: (profile as { id: string }).id,
              followee_id: 'user-1',
              follower: profile,
              followee: VIEWER,
            })),
          ];

          const data = edges.filter(
            (row) =>
              (filters.follower_id === undefined || row.follower_id === filters.follower_id) &&
              (filters.followee_id === undefined || row.followee_id === filters.followee_id),
          );
          return resolve({ data, error: null });
        },
      };
      return chain;
    },
  },
}));

/**
 * One profile. `mockOutgoing` is who the viewer follows, `mockIncoming` is who follows
 * the viewer; the stand-in above turns each into the `follows` row it would arrive on.
 */
const person = (id: string, username: string, name: string, status = 'active') => ({
  id,
  username,
  display_name: name,
  avatar_path: null,
  status,
});

/** The operation ids sent to one RPC, in order. */
const idsSentTo = (fn: string) =>
  mockRpc.mock.calls
    .filter(([name]) => name === fn)
    .map(([, args]) => (args as { p_operation_id: string }).p_operation_id);

const props = {
  viewerId: 'user-1',
  mediaItemId: 'film-1',
  kind: 'movie' as const,
  title: 'Inception',
  seriesTitle: null,
  onClose: jest.fn(),
  surface: 'title' as const,
  onSent: jest.fn(),
};

beforeEach(() => {
  issued = 0;
  mockRpc.mockReset();
  mockRpcResults = {};
  mockRpcErrors = {};
  mockOutgoing = [];
  mockIncoming = [];
  props.onClose = jest.fn();
  props.onSent = jest.fn();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('who the sheet offers', () => {
  /**
   * The direction, and the bug it replaced (20260826000400).
   *
   * Bo is followed by the viewer and does not follow back — under the old mutual rule
   * Bo was silently missing from this list, which is the founder-reported defect. Cy
   * follows the viewer and is not followed back, which grants nothing: that is the
   * direction an unwanted sender controls.
   */
  it('offers everybody the viewer follows, and nobody who merely follows them', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'bo', 'Bo')];
    mockIncoming = [person('user-2', 'ada', 'Ada'), person('user-4', 'cy', 'Cy')];

    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());
    expect(view.getByText('Bo')).toBeTruthy();
    expect(view.queryByText('Cy')).toBeNull();
  });

  it('leaves out a suspended account that still holds its edges', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada', 'suspended')];

    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await waitFor(() =>
      expect(view.getByText('Nobody to recommend to yet')).toBeTruthy(),
    );
  });

  it('says what makes somebody eligible when nobody is', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await waitFor(() => expect(view.getByText('Nobody to recommend to yet')).toBeTruthy());
    // The off-Bingd path is still offered, because it is the answer to an empty list.
    expect(view.getByText('Share off bingd.')).toBeTruthy();
  });

  it('names the show a season belongs to in its heading', async () => {
    const view = await renderWithProviders(
      <RecommendSheet
        {...props}
        kind="season"
        title="Season 2"
        seriesTitle="Parks and Recreation"
      />,
    );

    expect(view.getByText(/Parks and Recreation, S2/)).toBeTruthy();
  });
});

describe('sending', () => {
  beforeEach(() => {
    mockOutgoing = [person('user-2', 'ada', 'Ada')];
    mockIncoming = [person('user-2', 'ada', 'Ada')];
  });

  /** Mark a person's row — each row is a checkbox now, not a send. */
  const pick = (view: Awaited<ReturnType<typeof renderWithProviders>>, label: string) =>
    fireEvent.press(view.getByLabelText(label));
  /** Press the one button that sends, whatever its count reads. */
  const sendNow = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
    fireEvent.press(view.getByText(/^Recommend to \d+$/));

  it('sends to a chosen person from the one button, and closes', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'recommend_title',
        expect.objectContaining({ p_recipient_id: 'user-2', p_media_item_id: 'film-1' }),
      ),
    );
    // The confirmation belongs to the screen underneath, which is still showing the
    // title. A second one in here would be a message nobody sees.
    expect(props.onSent).toHaveBeenCalledWith('Ada');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('counts the chosen on the button, and sends nothing while it reads zero', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // Disabled at zero: pressing it must not fire a send with nobody chosen.
    await fireEvent.press(view.getByText('Recommend to 0'));
    expect(mockRpc).not.toHaveBeenCalledWith('recommend_title', expect.anything());

    await pick(view, 'Ada, @ada');
    expect(view.getByText('Recommend to 1')).toBeTruthy();

    // A second tap on the row un-chooses — the row toggles, it does not send.
    await pick(view, 'Ada, @ada');
    expect(view.getByText('Recommend to 0')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalledWith('recommend_title', expect.anything());
  });

  it('sends to everybody chosen from one press', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Grace')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await pick(view, 'Grace, @grace');
    await fireEvent.press(view.getByText('Recommend to 2'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'recommend_title',
        expect.objectContaining({ p_recipient_id: 'user-3' }),
      ),
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'recommend_title',
      expect.objectContaining({ p_recipient_id: 'user-2' }),
    );
    expect(props.onSent).toHaveBeenCalledWith('Ada and Grace');
    expect(props.onClose).toHaveBeenCalled();
  });

  /**
   * **A batch that half-succeeds must say so in full, and lose nothing.**
   *
   * The stored half must not be resendable — a retry press that replayed a success
   * would spend a rate-limit slot and bump `recommended_at` for a send the person was
   * already shown. The failed half must stay chosen with the reason on the screen, so
   * "try again" means exactly them. And when the retry lands, the confirmation names
   * everybody this sheet sent, not just the stragglers of the final pass.
   */
  it('keeps the successes when one recipient fails, and retries only the failure', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    mockRpcResults.recommend_title = (args: unknown) =>
      (args as { p_recipient_id: string }).p_recipient_id === 'user-3'
        ? { status: 'refused', reason: 'too_many_pending' }
        : { status: 'ok', created: true, delivered: true };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Grace')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await pick(view, 'Grace, @grace');
    await fireEvent.press(view.getByText('Recommend to 2'));

    await waitFor(() =>
      expect(
        view.getByText(
          'Sent to Ada. Could not send to Grace. ' +
            'They already have several recommendations from you waiting.',
        ),
      ).toBeTruthy(),
    );
    // Open, with only the failed half still chosen.
    expect(props.onClose).not.toHaveBeenCalled();
    expect(view.getByText('Recommend to 1')).toBeTruthy();

    const sendsTo = (id: string) =>
      mockRpc.mock.calls.filter(
        ([name, args]) =>
          name === 'recommend_title' && (args as { p_recipient_id: string }).p_recipient_id === id,
      );

    mockRpcResults.recommend_title = { status: 'ok', created: true, delivered: true };
    await sendNow(view);

    // The retry asked about Grace alone; Ada's stored send was not replayed.
    await waitFor(() => expect(sendsTo('user-3')).toHaveLength(2));
    expect(sendsTo('user-2')).toHaveLength(1);
    // And the confirmation names the whole batch, both passes of it.
    expect(props.onSent).toHaveBeenCalledWith('Ada and Grace');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('explains a refusal in words rather than as a code, and stays open', async () => {
    // A refusal comes back in the body with a 200, not as an error — the server
    // returns it so that a refused attempt still costs a slot against the hourly
    // ceiling. Which means a 200 is not a success here, and the body has to be read.
    mockRpcResults.recommend_title = { status: 'refused', reason: 'not_following' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() =>
      expect(
        view.getByText(
          'Could not send to Ada. You can recommend titles to people you follow.',
        ),
      ).toBeTruthy(),
    );
    expect(props.onSent).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  /**
   * The ceiling, said without telling the sender what the recipient did.
   *
   * The refusal names how many are waiting and stops there — "they dismissed four of
   * yours" would be the behavioural oracle the whole state model is arranged to avoid
   * (§22, and §2 of `20260826000400`).
   */
  it('reports a full pending queue neutrally', async () => {
    mockRpcResults.recommend_title = { status: 'refused', reason: 'too_many_pending' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() =>
      expect(
        view.getByText(/They already have several recommendations from you waiting\./),
      ).toBeTruthy(),
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });

  /**
   * §17: the sender is not told where it landed.
   *
   * A recommendation held as a request is a plain `ok` on this side, and the sheet must
   * treat it exactly like a direct delivery — no "waiting for them to follow you", no
   * second state to explain.
   */
  it('says nothing about whether a send was delivered or is waiting', async () => {
    mockRpcResults.recommend_title = { status: 'ok', created: true, delivered: false };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() => expect(props.onSent).toHaveBeenCalledWith('Ada'));
    expect(props.onClose).toHaveBeenCalled();
    expect(view.queryByText(/waiting/i)).toBeNull();
    expect(view.queryByText(/follow you/i)).toBeNull();
  });

  it('names the ceiling rather than the SQLSTATE when the rate limit bites', async () => {
    mockRpcErrors.recommend_title = { code: '53400', message: 'too many' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() =>
      expect(
        view.getByText(/You have sent a lot of recommendations today\. Try again later\./),
      ).toBeTruthy(),
    );
  });

  it('does not treat a refused 200 as a send', async () => {
    mockRpcResults.recommend_title = { status: 'refused', reason: 'not_recommendable' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);

    await waitFor(() =>
      expect(
        view.getByText(/You can recommend a film or a season, not a whole series\./),
      ).toBeTruthy(),
    );
    expect(props.onSent).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  /**
   * **A send that commits and loses its reply, then the tap that follows it.**
   *
   * Independent review 21i. The unique key on (sender, recipient, title) stops a second
   * *row* — and stops nothing else. A replay with a fresh id passes `_claim_operation`,
   * spends a second slot against `recommendations.max_per_hour`, and takes the `else`
   * branch that moves `recommended_at` to now, reordering the recipient's list on the
   * strength of a send they had already been shown. One tap, a wrong quota and a wrong
   * screen, and nothing raised anywhere.
   */
  it('replays an unanswered send under the id the first attempt used', async () => {
    mockRpcErrors.recommend_title = { code: '', message: 'TypeError: Network request failed' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // A failed send keeps its person selected, so the retry is the same button again.
    await pick(view, 'Ada, @ada');
    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(1));

    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(2));

    const [first, second] = idsSentTo('recommend_title');
    // A real id, not two undefineds — `expo-crypto` has no native module under jest.
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });

  it('takes a fresh id after a refusal, which spent the first one', async () => {
    // A `refused` arrives as a 200 and **keeps its claim on purpose** — a raise would
    // roll the claim back and make refused attempts free (`20260817001300`). Reusing a
    // spent id would have the next attempt answered `already_applied`: a send that
    // reports success and stores nothing, which is the worst outcome on this sheet.
    mockRpcResults.recommend_title = { status: 'refused', reason: 'not_mutual' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(1));

    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(2));

    const [first, second] = idsSentTo('recommend_title');
    expect(second).not.toBe(first);
  });

  it('takes a fresh id after a refusal the server raised', async () => {
    // 53400 is the rate limiter, which raises — so the claim rolls back with it and the
    // outcome is established either way. Nothing to hold.
    mockRpcErrors.recommend_title = { code: '53400', message: 'too many' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(1));

    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(2));

    const [first, second] = idsSentTo('recommend_title');
    expect(second).not.toBe(first);
  });

  it('holds one id per recipient rather than one for the batch', async () => {
    // Each name is its own intent, even inside one press. Sharing an id across them
    // would have the second person's send answered `already_applied` — a press that
    // reports success and sends nothing to anybody past the first.
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    mockIncoming = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    mockRpcErrors.recommend_title = { code: '', message: 'TypeError: Network request failed' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Grace')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await pick(view, 'Grace, @grace');
    await sendNow(view);
    await waitFor(() => expect(idsSentTo('recommend_title')).toHaveLength(2));

    const [first, second] = idsSentTo('recommend_title');
    expect(second).not.toBe(first);
  });

  it('selects on a row tap and offers no per-row send', async () => {
    // The 2026-08-27 shape: each row is a checkbox — the mark sits where the
    // paper-plane used to — and the only thing that sends is the counted button.
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(view.getByRole('checkbox', { name: 'Ada, @ada' })).toBeTruthy();
    await pick(view, 'Ada, @ada');
    // Choosing is not sending: nothing has been asked of the server yet.
    expect(mockRpc).not.toHaveBeenCalledWith('recommend_title', expect.anything());
    expect(view.queryByLabelText('Recommend to Ada, @ada')).toBeNull();
  });
});

describe('sharing with somebody who is not on bingd.', () => {
  it('carries the reader’s invite link and records that it was created', async () => {
    mockRpcResults.create_invite_link = { status: 'ok', token: 'abc123' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith(
        'create_invite_link',
        expect.objectContaining({ p_media_item_id: 'film-1' }),
      ),
    );

    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(shared.message).toContain('https://bingd.app/title/film-1');
    expect(shared.message).toContain('https://bingd.app/i/abc123');
  });

  it('still shares the title when the link could not be minted', async () => {
    // The invite link is instrumentation; the share is the point. Failing the whole
    // share because the growth record was unavailable would be the tail wagging the dog.
    mockRpcErrors.create_invite_link = { code: '53400', message: 'too many' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() => expect(Share.share as jest.Mock).toHaveBeenCalled());
    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(shared.message).toContain('https://bingd.app/title/film-1');
    expect(shared.message).not.toContain('/i/');
  });

  /**
   * **The degradation above is what invites the retry, and the retry used to be counted.**
   *
   * `create_invite_link` reuses the caller's token but inserts an `invite_link_creations`
   * row unconditionally. So: the insert commits, the reply is lost, this returns null, the
   * share goes out without the link — and pressing Share again *because that is not what
   * they wanted* minted a fresh operation id, walked past `_claim_operation`, and recorded
   * a second creation for one intent. One wrong number, no exception, plausible state.
   *
   * Independent review 21h, after 21g's PASS: it was the last writer minting its own id
   * whose RPC is not idempotent by shape.
   */
  it('claims the same slot when a link mint went unanswered', async () => {
    // No SQLSTATE: never answered, so the creation may well be recorded already.
    mockRpcErrors.create_invite_link = { code: '', message: 'TypeError: Network request failed' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(1));

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(2));

    const [first, second] = idsSentTo('create_invite_link');
    expect(typeof first).toBe('string');
    // The server's ledger can only refuse a replay it recognises.
    expect(second).toBe(first);
  });

  it('takes a fresh slot once a link has actually been minted', async () => {
    // Released on the *mint*, not on the share: a minted link means the creation is
    // definitely recorded, so the next press is a second creation and should say so.
    mockRpcResults.create_invite_link = { status: 'ok', token: 'abc123' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(1));

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(2));

    const [first, second] = idsSentTo('create_invite_link');
    expect(second).not.toBe(first);
  });

  it('still claims the same slot when the share sheet itself was dismissed', async () => {
    // The release cannot hang off `Share.share`. Dismissing the OS sheet resolves rather
    // than throwing, so tying it there would free the id on exactly the path where the
    // creation is still in doubt.
    mockRpcErrors.create_invite_link = { code: '08007', message: 'transaction resolution unknown' };
    (Share.share as jest.Mock).mockResolvedValue({ action: 'dismissedAction' } as never);
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(1));

    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(idsSentTo('create_invite_link')).toHaveLength(2));

    const [first, second] = idsSentTo('create_invite_link');
    expect(second).toBe(first);
  });
});

describe('filtering the list', () => {
  const people: Recipient[] = [
    { id: '1', username: 'ada', name: 'Ada Lovelace', avatarUri: null },
    { id: '2', username: 'grace', name: 'Grace Hopper', avatarUri: null },
  ];

  it('matches on the name and on the handle', () => {
    expect(filterRecipients(people, 'love').map((p) => p.id)).toEqual(['1']);
    expect(filterRecipients(people, 'grace').map((p) => p.id)).toEqual(['2']);
    expect(filterRecipients(people, '  ').map((p) => p.id)).toEqual(['1', '2']);
  });

  it('treats a leading @ as the handle sigil, the way Search teaches it', () => {
    expect(filterRecipients(people, '@grace').map((p) => p.id)).toEqual(['2']);
    expect(filterRecipients(people, '@').map((p) => p.id)).toEqual(['1', '2']);
  });
});
