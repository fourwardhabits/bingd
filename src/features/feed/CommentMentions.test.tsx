import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CommentSheet } from './CommentSheet';

/**
 * @mentions, from the composer's side — `20260830000100`.
 *
 * `mentions.test.ts` owns the text model and `supabase/tests/comment-mentions.test.mjs`
 * owns eligibility and the dedupe ledger. What is left, and what this file is for, is
 * the seam between them: does typing `@` ask the right question, does choosing a row put
 * the right thing in the box, and — the one that actually matters — **does the right set
 * of ids reach the server when Post is pressed**.
 *
 * That last one is the whole feature. Everything the database does to keep a mention
 * associated with a person rather than a handle is worthless if the client posts the
 * wrong array, and the two ways it could are both asserted here: a handle nobody chose
 * must not be sent (no arbitrary-user lookup), and a person chosen and then deleted from
 * the text must not be sent either (deleting the name is how a mention is removed).
 */

const VIEWER = 'viewer-1';
const AUTHOR = 'author-1';
const FILM = 'film-1';

let mockCommentRows: Record<string, unknown>[] = [];
let mockCandidateRows: Record<string, unknown>[] = [];
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'activity_comments') return { data: mockCommentRows, error: null };
      // Recorded as well as answered: *what the candidate list was asked about* is one
      // of this file's assertions, and it is the only place the fragment is observable.
      if (name === 'mention_candidates') {
        mockRpcCalls.push({ name, args });
        return { data: mockCandidateRows, error: null };
      }
      mockRpcCalls.push({ name, args });
      return { data: null, error: null };
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => Promise.resolve({ data: [], error: null }),
        then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
  startSessionRefresh: () => () => {},
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  parent_id: null,
  author_id: AUTHOR,
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  body: 'The ending recontextualises everything.',
  has_spoilers: false,
  created_at: new Date().toISOString(),
  edited_at: null,
  deleted_at: null,
  reaction_count: 0,
  reacted_by_me: false,
  reaction_kinds: [],
  my_reaction: null,
  mentions: [],
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'ravi-id',
  username: 'ravi',
  display_name: 'Ravi',
  avatar_path: null,
  participant: false,
  ...over,
});

const open = async () => {
  const view = await renderWithProviders(
    <CommentSheet
      eventId="e1"
      mediaItemId={FILM}
      title="Sinners"
      viewerId={VIEWER}
      watched={new Set()}
      onClose={jest.fn()}
      onPressPerson={jest.fn()}
    />,
  );
  await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
  return view;
};

/** The composer, which is the one field on this surface. */
const composerOf = (view: Awaited<ReturnType<typeof open>>) =>
  view.getByLabelText('Add a comment');

/**
 * Types into the composer the way the platform does: the text event, then the selection
 * event. Both, and in that order, because the component guesses the caret on a pure
 * append and lets the selection handler correct anything else — a test that fired only
 * one of them would be asserting half the mechanism.
 */
const type = async (input: ReturnType<typeof composerOf>, text: string) => {
  await fireEvent.changeText(input, text);
  await fireEvent(input, 'selectionChange', {
    nativeEvent: { selection: { start: text.length, end: text.length } },
  });
};

/** What the last `add_comment` was told, or undefined if none was sent. */
const lastWrite = (name: string) =>
  [...mockRpcCalls].reverse().find((call) => call.name === name)?.args;

beforeEach(() => {
  mockCommentRows = [];
  mockCandidateRows = [candidate()];
  mockRpcCalls.length = 0;
});

// ---------------------------------------------------------------------------
describe('the suggestion list', () => {
  it('appears on the @ itself, before anything is typed after it', async () => {
    const view = await open();
    await type(composerOf(view), 'hey @');

    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    expect(view.getByText('@ravi')).toBeTruthy();
  });

  it('asks the server about the fragment, for this conversation', async () => {
    const view = await open();
    await type(composerOf(view), 'hey @rav');

    await waitFor(() => {
      const call = lastWrite('mention_candidates');
      expect(call).toEqual({ p_feed_event_id: 'e1', p_query: 'rav' });
    });
  });

  it('closes once the mention is finished', async () => {
    const view = await open();
    const input = composerOf(view);
    await type(input, 'hey @rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());

    await type(input, 'hey @ravi great');
    await waitFor(() => expect(view.queryByTestId('mention-suggestions')).toBeNull());
  });

  it('shows the name and the handle, and nothing else', async () => {
    const view = await open();
    await type(composerOf(view), '@');

    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    expect(view.getByText('Ravi')).toBeTruthy();
    expect(view.getByText('@ravi')).toBeTruthy();
  });

  /**
   * The founder's restraint clause. A strip that appears to announce it has nothing is
   * worse than one that stays away — the reader is mid-word.
   */
  it('draws nothing when there is nobody to offer', async () => {
    mockCandidateRows = [];
    const view = await open();
    await type(composerOf(view), '@zzz');

    await waitFor(() => expect(lastWrite('mention_candidates')).toBeTruthy());
    expect(view.queryByTestId('mention-suggestions')).toBeNull();
  });

  it('inserts the handle and closes itself', async () => {
    const view = await open();
    const input = composerOf(view);
    await type(input, 'hey @rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));

    expect(input.props.value).toBe('hey @ravi ');
    // Choosing must not leave the fragment live, or the list would reopen on the handle
    // it has just inserted.
    expect(view.queryByTestId('mention-suggestions')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('what reaches the server', () => {
  const post = async (view: Awaited<ReturnType<typeof open>>) => {
    await fireEvent.press(view.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(lastWrite('add_comment')).toBeTruthy());
    return lastWrite('add_comment');
  };

  it('sends the id of somebody chosen from the list', async () => {
    const view = await open();
    const input = composerOf(view);
    await type(input, '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));
    await type(input, '@ravi great film');

    expect((await post(view))?.p_mention_ids).toEqual(['ravi-id']);
  });

  it('sends several, once each', async () => {
    mockCandidateRows = [candidate(), candidate({ id: 'abi-id', username: 'abisola', display_name: 'Abisola' })];
    const view = await open();
    const input = composerOf(view);

    await type(input, '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));

    await type(input, '@ravi @abi');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Abisola, at abisola'));

    await type(input, '@ravi @abisola both of you');

    expect((await post(view))?.p_mention_ids).toEqual(['ravi-id', 'abi-id']);
  });

  /**
   * The no-arbitrary-lookup rule, from the client's side. A handle typed by hand has no
   * id in this composer, so it is ordinary text — and there is deliberately no query
   * this file could run to turn it into one.
   */
  it('sends nothing for a handle nobody chose', async () => {
    const view = await open();
    await type(composerOf(view), '@stranger hello');

    expect((await post(view))?.p_mention_ids).toEqual([]);
  });

  /** Deleting the name is how a mention is removed. There is no second gesture. */
  it('drops somebody chosen and then deleted from the text', async () => {
    const view = await open();
    const input = composerOf(view);
    await type(input, '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));
    await type(input, 'never mind');

    expect((await post(view))?.p_mention_ids).toEqual([]);
  });

  /**
   * The empty array is sent rather than the key omitted, and it is load-bearing:
   * `20260830000100` gave `p_mention_ids` **no default** so that five keys resolve to the
   * old signature and six to the new one. Omitting it when nobody is mentioned would
   * silently take the old path.
   */
  it('always sends the key, so PostgREST resolves the new signature', async () => {
    const view = await open();
    await type(composerOf(view), 'no mentions here');

    const call = await post(view);
    expect(call).toHaveProperty('p_mention_ids');
    expect(call?.p_mention_ids).toEqual([]);
  });

  it('carries the mentions on a reply too', async () => {
    mockCommentRows = [comment()];
    const view = await open();
    await fireEvent.press(view.getByLabelText('Reply to Anna'));

    // The row's Reply button and the composer share a label once a reply is open — the
    // button says what it does and the field says what it is for, and both are "Reply to
    // Anna". The placeholder is what tells them apart without either needing a testID.
    const input = view.getByPlaceholderText('Reply to Anna');
    await type(input, '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));
    await type(input, '@ravi agreed');

    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(lastWrite('add_comment')).toBeTruthy());

    const call = lastWrite('add_comment');
    expect(call?.p_parent_id).toBe('c1');
    expect(call?.p_mention_ids).toEqual(['ravi-id']);
  });

  /**
   * **The edit case, and the reason `activity_comments` returns mentions at all.**
   *
   * Reopening a comment to fix a typo must re-send the ids it already carries. Without
   * the seed the handles would be in the text with nothing behind them, the array would
   * go out empty, and every mention on the comment would be deactivated — nobody
   * notified twice, but the relation quietly rotted, and it is the relation that
   * survives a rename.
   */
  it('re-sends the ids a comment already carries when it is edited', async () => {
    mockCommentRows = [
      comment({
        author_id: VIEWER,
        username: 'me',
        display_name: 'Me',
        body: '@ravi great film',
        mentions: [{ id: 'ravi-id', username: 'ravi' }],
      }),
    ];
    const view = await open();
    await fireEvent.press(view.getByLabelText('Edit your comment'));

    const input = view.getByLabelText('Your comment');
    await type(input, '@ravi great film actually');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastWrite('edit_comment')).toBeTruthy());
    expect(lastWrite('edit_comment')?.p_mention_ids).toEqual(['ravi-id']);
  });

  it('drops a mention removed during an edit', async () => {
    mockCommentRows = [
      comment({
        author_id: VIEWER,
        username: 'me',
        display_name: 'Me',
        body: '@ravi great film',
        mentions: [{ id: 'ravi-id', username: 'ravi' }],
      }),
    ];
    const view = await open();
    await fireEvent.press(view.getByLabelText('Edit your comment'));

    await type(view.getByLabelText('Your comment'), 'great film');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastWrite('edit_comment')).toBeTruthy());
    expect(lastWrite('edit_comment')?.p_mention_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
/**
 * Independent review 68 — the two ways the "picked, and still in the text" rule leaked.
 *
 * Both are about the map of handles the author has chosen, and they fail in opposite
 * directions: one let it live too long, the other let it die too early.
 */
describe('what a picked handle does and does not authorise', () => {
  const post = async (view: Awaited<ReturnType<typeof open>>, label = 'Post') => {
    await fireEvent.press(view.getByRole('button', { name: label }));
    await waitFor(() => expect(lastWrite('add_comment')).toBeTruthy());
    return lastWrite('add_comment');
  };

  /**
   * **One selection must not authorise every later comment in the thread.**
   *
   * The map used to be cleared only when the *activity* changed, so choosing Ravi once
   * and then hand-typing `@ravi` in the next comment resolved to his id — which is the
   * "a handle nobody chose is not a mention" rule failing, and it turns one deliberate
   * choice into a way to keep naming somebody by typing.
   */
  it('forgets a picked handle once the comment carrying it is posted', async () => {
    const view = await open();
    const input = composerOf(view);

    await type(input, '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));
    await type(input, '@ravi first');
    expect((await post(view))?.p_mention_ids).toEqual(['ravi-id']);

    mockRpcCalls.length = 0;
    // A second comment, in the same thread, naming him by hand.
    await type(composerOf(view), '@ravi second');
    expect((await post(view))?.p_mention_ids).toEqual([]);
  });

  it('forgets it when the composer switches to a reply instead', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    await type(composerOf(view), '@rav');
    await waitFor(() => expect(view.getByTestId('mention-suggestions')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Mention Ravi, at ravi'));

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await type(view.getByPlaceholderText('Reply to Anna'), '@ravi agreed');

    expect((await post(view, 'Reply'))?.p_mention_ids).toEqual([]);
  });

  /**
   * **And the opposite failure: a rename must not drop a mention on the next typo fix.**
   *
   * The body says `@ravi` and Ravi is now `ravinder`. Seeding only the current handle
   * resolves nothing, the array goes out empty, and the server deactivates a mention that
   * is plainly still in the text. `activity_comments` returns both spellings for exactly
   * this, and the composer seeds both.
   */
  it('keeps a mention through an edit after the person renamed', async () => {
    mockCommentRows = [
      comment({
        author_id: VIEWER,
        username: 'me',
        display_name: 'Me',
        body: '@ravi great film',
        mentions: [{ id: 'ravi-id', username: 'ravinder', handle: 'ravi' }],
      }),
    ];
    const view = await open();
    await fireEvent.press(view.getByLabelText('Edit your comment'));

    await type(view.getByLabelText('Your comment'), '@ravi great film actually');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastWrite('edit_comment')).toBeTruthy());
    expect(lastWrite('edit_comment')?.p_mention_ids).toEqual(['ravi-id']);
  });

  it('also accepts the new spelling, if the author retypes it', async () => {
    mockCommentRows = [
      comment({
        author_id: VIEWER,
        username: 'me',
        display_name: 'Me',
        body: '@ravi great film',
        mentions: [{ id: 'ravi-id', username: 'ravinder', handle: 'ravi' }],
      }),
    ];
    const view = await open();
    await fireEvent.press(view.getByLabelText('Edit your comment'));

    await type(view.getByLabelText('Your comment'), '@ravinder great film');
    await fireEvent.press(view.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastWrite('edit_comment')).toBeTruthy());
    expect(lastWrite('edit_comment')?.p_mention_ids).toEqual(['ravi-id']);
  });
});
