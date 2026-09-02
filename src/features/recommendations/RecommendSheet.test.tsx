import { fireEvent, waitFor } from '@testing-library/react-native';
import { Share, useWindowDimensions } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { RecommendSheet } from './RecommendSheet';
import { filterRecipients, type Recipient } from './use-recommend';

// A fresh id every call, so a module-level constant cannot pass for a generator — and so
// the retry assertions below are about two real ids rather than two undefineds.
// `expo-crypto` has no native module under jest and `randomUUID` answers undefined without this.
let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `share-${(issued += 1)}` }));

// The footer decides its own layout from the viewport, so the viewport has to be a thing
// this suite can set. The same hook and the same mock `ScoresSection.test.tsx` uses.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions');
const mockWindow = useWindowDimensions as unknown as jest.Mock;
/** The device the founder is holding, unless a test says otherwise. */
const setViewport = (width: number, fontScale = 1) =>
  mockWindow.mockReturnValue({ width, height: 844, scale: 3, fontScale });

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
  // An ordinary phone unless a layout test says otherwise. Set before every render,
  // because the footer reads it during render and would otherwise destructure undefined.
  setViewport(412);
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
  /** Press the one button that sends. Its label is static — see the label test. */
  const sendNow = (view: Awaited<ReturnType<typeof renderWithProviders>>) =>
    fireEvent.press(view.getByText('Recommend'));

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

  /**
   * The label does not count, and that is the founder's instruction of 2026-08-27.
   *
   * It read `Recommend to N` and renamed itself on every tap, which made the widest
   * control on the sheet a moving target and pushed the button beside it into the squeeze
   * this tranche is fixing. How many people are chosen is already said by the checkboxes
   * above; the button says what pressing it does.
   */
  it('says Recommend however many are chosen, and sends nothing at zero', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // Disabled at zero: pressing it must not fire a send with nobody chosen.
    expect(view.getByText('Recommend')).toBeTruthy();
    await fireEvent.press(view.getByText('Recommend'));
    expect(mockRpc).not.toHaveBeenCalledWith('recommend_title', expect.anything());

    await pick(view, 'Ada, @ada');
    expect(view.getByText('Recommend')).toBeTruthy();
    expect(view.queryByText(/Recommend to/)).toBeNull();

    // A second tap on the row un-chooses — the row toggles, it does not send.
    await pick(view, 'Ada, @ada');
    expect(view.getByText('Recommend')).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalledWith('recommend_title', expect.anything());
  });

  it('still says Recommend with two chosen', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Grace')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await pick(view, 'Grace, @grace');
    expect(view.getByText('Recommend')).toBeTruthy();
    expect(view.queryByText(/Recommend to/)).toBeNull();
  });

  it('sends to everybody chosen from one press', async () => {
    mockOutgoing = [person('user-2', 'ada', 'Ada'), person('user-3', 'grace', 'Grace')];
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Grace')).toBeTruthy());

    await pick(view, 'Ada, @ada');
    await pick(view, 'Grace, @grace');
    await fireEvent.press(view.getByText('Recommend'));

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
    await fireEvent.press(view.getByText('Recommend'));

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
    expect(view.getByText('Recommend')).toBeTruthy();

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

/**
 * The share that stopped recruiting.
 *
 * This block used to assert the opposite of what it asserts now: that an off-platform
 * title share carried the sender's reusable invite link underneath the title, and that
 * pressing Share held one operation id across the retries a failed mint invites. All of
 * that machinery is gone, because the message it protected was one the sender did not
 * choose to send — a recommendation of a film with a recruitment link stapled to it.
 *
 * What is left is the contract worth pinning: one link, the title's, and no second
 * acquisition CTA anywhere in the payload. The growth loop moved to bingd.app, where the
 * install page answers a recipient who does not have the app (`web/src/page.mjs`).
 */
describe('sharing with somebody who is not on bingd.', () => {
  it('sends the title link and nothing else', async () => {
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() => expect(Share.share as jest.Mock).toHaveBeenCalled());
    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string; url: string };

    expect(shared.message).toContain('https://bingd.app/title/film-1');
    expect(shared.url).toBe('https://bingd.app/title/film-1');
    // The three shapes of the old second link, each named so a reinstatement cannot pass
    // by changing the wording.
    expect(shared.message).not.toContain('/i/');
    expect(shared.message).not.toMatch(/join me on bingd/i);
    expect(shared.message).not.toMatch(/invite/i);
  });

  it('mints no invite link, so a title share is not an invitation', async () => {
    // `create_invite_link` writes an `invite_link_creations` row and offers the push
    // permission prompt. Neither belongs to somebody sharing a film: the row would
    // inflate the one funnel the founder watches for growth with shares that invited
    // nobody, and the prompt would arrive on a tap that was not about joining.
    mockRpcResults.create_invite_link = { status: 'ok', token: 'abc123' };
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() => expect(Share.share as jest.Mock).toHaveBeenCalled());
    expect(mockRpc).not.toHaveBeenCalledWith('create_invite_link', expect.anything());
  });

  it('carries no sender identity in the payload', async () => {
    // The recipient is being told about a film, not about an account. The viewer's
    // handle, id and name are all absent from the message by construction, and this is
    // the assertion that keeps them absent.
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() => expect(Share.share as jest.Mock).toHaveBeenCalled());
    const shared = (Share.share as jest.Mock).mock.calls[0][0] as { message: string };
    expect(shared.message).not.toContain('user-1');
    expect(shared.message).not.toContain('@');
  });

  it('reports a share that could not be opened, and stays open', async () => {
    // The one failure path left now that nothing is minted first.
    (Share.share as jest.Mock).mockRejectedValueOnce(new Error('Sharing failed.'));
    const view = await renderWithProviders(<RecommendSheet {...props} />);

    await fireEvent.press(view.getByText('Share off bingd.'));

    await waitFor(() => expect(view.getByText('Sharing failed.')).toBeTruthy());
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

/**
 * The footer, which is where the founder's Android screenshot pointed.
 *
 * It rendered `[ Recommend to 1 ------------- ] [ Share off bi / ngd. ]`: the secondary
 * squeezed into a column too narrow for its own label, breaking a word in half. The row
 * was `flexWrap: 'wrap'` over two children with hand-picked `flexBasis` values and
 * `flexShrink: 1` on both, and Yoga gives a flex item no automatic minimum size — so
 * shrinking below the content width always succeeded and the wrap never fired.
 *
 * The layout decision is a boolean derived from the viewport now, which is the thing
 * these tests can actually pin. Reading `flexDirection` off the one container the two
 * buttons share is `ScoresSection.test.tsx`'s method, for its reason: there is no role
 * for "two columns", and matching on tree shape passes for any stack with a row in it.
 */
describe('the footer at different widths', () => {
  beforeEach(() => {
    mockOutgoing = [person('user-2', 'ada', 'Ada')];
  });

  const layout = (view: Awaited<ReturnType<typeof renderWithProviders>>) => {
    const style = view.getByTestId('recommend-actions').props.style;
    return (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style) as {
      flexDirection?: string;
    };
  };

  it('puts the two actions side by side on an ordinary phone', async () => {
    setViewport(412);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('row');
  });

  // 360 is the narrowest width in ordinary use — a small Android, an iPhone 12 mini.
  // The pair still fits there, and must, or the common device gets the taller layout.
  it('still fits the pair on the narrowest ordinary Android', async () => {
    setViewport(360);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('row');
  });

  it('stacks them on a 320-class screen rather than crushing either', async () => {
    setViewport(320);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('column');
  });

  it('stacks them when type is scaled past what two columns can hold', async () => {
    setViewport(412, 1.6);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('column');
  });

  /**
   * The case a fixed floor plus a font-scale ceiling would have missed.
   *
   * Independent review of this tranche found it: at 360pt the pair fits at scale 1, and
   * a separate "stack above 1.3" rule leaves 360-at-1.3 side by side — each half still
   * nominally wide enough while the label inside it no longer is. `fit` stops shrinking
   * at 85%, so past that it clips, which is the crushed CTA arrived at from the other
   * direction. The floor scales with the type instead, so this stacks.
   */
  it('stacks a narrow phone whose type is only somewhat larger', async () => {
    setViewport(360, 1.3);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('column');
  });

  it('still pairs a large phone at a slightly larger type size', async () => {
    // 412 at 1.15 has room for both at their scaled width, so the pair survives — the
    // rule is a measurement, not a blanket refusal above default type.
    setViewport(412, 1.15);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    expect(layout(view).flexDirection).toBe('row');
  });

  /**
   * Recommend first in both layouts, so stacking is not also a reordering — the primary
   * act must not end up underneath the way out of the sheet.
   */
  it('keeps Recommend above Share off bingd. when stacked', async () => {
    setViewport(320);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    const order = view
      .getAllByText(/^(Recommend|Share off bingd\.)$/)
      .map((node) => node.props.children);
    expect(order).toEqual(['Recommend', 'Share off bingd.']);
  });

  /**
   * The contract that makes `bi / ngd.` unrepresentable at any width.
   *
   * `fit` is what caps each label at one line and shrinks it slightly instead of
   * wrapping it (`Button`'s own note has the arithmetic). Without it no width threshold
   * is enough, because Dynamic Type can always take a label past its column.
   */
  it('never lets either label wrap, which is what broke the word', async () => {
    setViewport(360);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    for (const label of ['Recommend', 'Share off bingd.']) {
      expect(view.getByText(label).props.numberOfLines).toBe(1);
    }
  });

  it('offers Share off bingd. whatever the selection is', async () => {
    setViewport(412);
    const view = await renderWithProviders(<RecommendSheet {...props} />);
    await waitFor(() => expect(view.getByText('Ada')).toBeTruthy());

    // Nobody chosen, and it is still there and still pressable — it shares the title,
    // not the selection.
    expect(view.getByText('Share off bingd.')).toBeTruthy();
    await fireEvent.press(view.getByText('Share off bingd.'));
    await waitFor(() => expect(Share.share).toHaveBeenCalled());
  });
});
