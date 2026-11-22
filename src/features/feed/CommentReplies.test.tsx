import { act, fireEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, StyleSheet, TextInput, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

import { CommentSheet } from './CommentSheet';
import { CommentThread, FOCUS_HIGHLIGHT_MS } from './CommentThread';

/**
 * Reply versus new comment (founder, 2026-11-22), and the controlled reproduction behind it.
 *
 * Production had 43 top-level comments and 7 replies, and in the reported thread the
 * post's author answered a question as a new top-level comment. Stored data cannot say
 * which route created it, so these tests establish the next best thing: **no path in the
 * composer loses a reply target, and no path turns a reply into a top-level comment
 * without the reader asking.** Each `it` names the path it drives — a refetch, a failed
 * refetch, the parent vanishing, a reply to a reply, switching, cancelling, an ambiguous
 * network failure.
 *
 * Every behaviour is asserted twice, on the Feed's sheet and on the thread as the full
 * Comments page renders it (`scroll="inherited"`), because the founder's rule is one
 * implementation for both and the only proof of that is the same test passing on each.
 */

const VIEWER = 'viewer-1';

let mockCommentRows: Record<string, unknown>[] = [];
const mockWrites: { name: string; args: Record<string, unknown> }[] = [];
/** What the next write answers. Consumed in order; the default is success. */
let mockWriteResults: { data?: unknown; error: unknown }[] = [];
let mockReadError: unknown = null;
let mockThreadReads = 0;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'activity_comments') {
        mockThreadReads += 1;
        return mockReadError
          ? { data: null, error: mockReadError }
          : { data: mockCommentRows, error: null };
      }
      if (name === 'mention_candidates') return { data: [], error: null };
      mockWrites.push({ name, args });
      return mockWriteResults.shift() ?? { data: { status: 'ok' }, error: null };
    },
  },
  startSessionRefresh: () => () => {},
}));

let issued = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `operation-${(issued += 1)}` }));

jest.spyOn(Alert, 'alert').mockImplementation(() => {});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  parent_id: null,
  author_id: 'anna-id',
  username: 'anna',
  display_name: 'Anna',
  avatar_path: null,
  body: 'What did you think of the ending?',
  has_spoilers: false,
  created_at: minutesAgo(30),
  edited_at: null,
  deleted_at: null,
  reaction_count: 0,
  reacted_by_me: false,
  reaction_kinds: [],
  my_reaction: null,
  mentions: [],
  ...over,
});

/** Anna's root, Bo's reply under it, and Cy's separate root. */
const conversation = () => [
  comment(),
  comment({
    id: 'r1',
    parent_id: 'c1',
    author_id: 'bo-id',
    username: 'bo',
    display_name: 'Bo',
    body: 'Loved it',
    created_at: minutesAgo(20),
  }),
  comment({
    id: 'c2',
    author_id: 'cy-id',
    username: 'cy',
    display_name: 'Cy',
    body: 'A separate thought',
    created_at: minutesAgo(10),
  }),
];

type Surface = {
  name: string;
  render: (props?: {
    focusCommentId?: string | null;
    onFocusOffset?: (y: number) => void;
  }) => Promise<Awaited<ReturnType<typeof renderWithProviders>>>;
};

const base = {
  eventId: 'e1',
  mediaItemId: 'film-1',
  title: 'Sinners',
  viewerId: VIEWER,
  watched: new Set<string>(),
  onPressPerson: jest.fn(),
};

const settle = async (view: Awaited<ReturnType<typeof renderWithProviders>>) => {
  await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
  return view;
};

const SURFACES: Surface[] = [
  {
    name: 'the Feed sheet',
    render: async (props = {}) =>
      settle(
        await renderWithProviders(<CommentSheet {...base} onClose={jest.fn()} {...props} />),
      ),
  },
  {
    name: 'the full Comments page',
    render: async (props = {}) =>
      settle(
        await renderWithProviders(<CommentThread {...base} scroll="inherited" {...props} />),
      ),
  },
];

const adds = () => mockWrites.filter((write) => write.name === 'add_comment');

beforeEach(() => {
  mockCommentRows = conversation();
  mockWrites.length = 0;
  mockWriteResults = [];
  mockReadError = null;
  mockThreadReads = 0;
});

describe.each(SURFACES)('on $name', ({ render }) => {
  it('is one composer: Reply changes what the same input says, and adds no second one', async () => {
    const view = await render();
    // Every text field on the surface, by what every field has: a placeholder.
    const inputs = () => view.getAllByPlaceholderText(/.+/);
    expect(inputs()).toHaveLength(1);

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.props.placeholder).toBe('Reply to Anna…');
    // No separate "new comment" control appears alongside it.
    expect(view.queryByText(/new comment/i)).toBeNull();
    expect(view.queryByRole('button', { name: 'Post' })).toBeNull();

    // The indicator's ✕ is the Cancel: back to Add a comment / Post.
    await fireEvent.press(view.getByRole('button', { name: 'Cancel reply to Anna' }));
    expect(inputs()).toHaveLength(1);
    expect(view.getByLabelText('Add a comment')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Post' })).toBeTruthy();
  });

  it('posts a new top-level comment from the default composer', async () => {
    const view = await render();

    // The default state says what it is: a new comment, posted with Post. No banner.
    const box = view.getByLabelText('Add a comment');
    expect(box.props.placeholder).toBe('Add a comment');
    expect(view.getByRole('button', { name: 'Post' })).toBeTruthy();
    expect(view.queryByText(/^Replying to/)).toBeNull();

    await fireEvent.changeText(box, 'A thought of my own');
    await fireEvent.press(view.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args).toMatchObject({ p_body: 'A thought of my own', p_parent_id: null });
  });

  it('replies to a root: a visible reply state, focused, then back to a new comment', async () => {
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));

    expect(view.getByText('Replying to Anna · under their comment')).toBeTruthy();
    const box = view.getByLabelText('Your reply to Anna');
    expect(box.props.placeholder).toBe('Reply to Anna…');
    expect(view.getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Post' })).toBeNull();
    // The box takes focus, so the keyboard rises where the reader is about to type.
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();

    await fireEvent.changeText(box, 'The last shot!');
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));

    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args).toMatchObject({ p_body: 'The last shot!', p_parent_id: 'c1' });

    // And the next thing typed is a new comment again: no reply target is inherited.
    await waitFor(() => expect(view.getByLabelText('Add a comment')).toBeTruthy());
    expect(view.queryByText(/^Replying to/)).toBeNull();
  });

  it('replies to a reply: addressed to the person tapped, in the root’s thread', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Bo'));

    // Bo, not Anna — the visible context never implies the reply went to the root's
    // author — and where it will appear, since the server keeps one level.
    expect(view.getByText("Replying to Bo · in Anna's thread")).toBeTruthy();
    // No @mention is inserted: the box starts empty, and the server notifies Bo directly
    // (`add_comment` files `reply_to` against the comment tapped).
    expect(view.getByLabelText('Your reply to Bo').props.value).toBe('');

    await fireEvent.changeText(view.getByLabelText('Your reply to Bo'), 'Same');
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));

    await waitFor(() => expect(adds()).toHaveLength(1));
    // The comment tapped, which the server re-points at the thread's root.
    expect(adds()[0]!.args.p_parent_id).toBe('r1');
  });

  it('cancels a reply, and the next post is a top-level comment', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'never mind');
    await fireEvent.press(view.getByLabelText('Cancel reply to Anna'));

    expect(view.queryByText(/^Replying to/)).toBeNull();
    const box = view.getByLabelText('Add a comment');
    expect(box.props.value).toBe('');

    await fireEvent.changeText(box, 'On reflection, a new comment');
    await fireEvent.press(view.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args.p_parent_id).toBeNull();
  });

  it('switches Reply between two threads without carrying the first recipient', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.press(view.getByLabelText('Reply to Cy'));

    expect(view.queryByText(/Replying to Anna/)).toBeNull();
    expect(view.getByText('Replying to Cy · under their comment')).toBeTruthy();

    await fireEvent.changeText(view.getByLabelText('Your reply to Cy'), 'Agreed, Cy');
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));

    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args.p_parent_id).toBe('c2');
  });

  it('keeps the reply target and the words through a refetch', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'half-written');

    const reads = mockThreadReads;
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });
    await waitFor(() => expect(mockThreadReads).toBeGreaterThan(reads));

    expect(view.getByText('Replying to Anna · under their comment')).toBeTruthy();
    expect(view.getByLabelText('Your reply to Anna').props.value).toBe('half-written');

    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args.p_parent_id).toBe('c1');
  });

  it('keeps the reply target through a refetch that fails', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'still here');

    mockReadError = { message: 'TypeError: Network request failed' };
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });

    // A dropped connection is not a deletion: the list stays, and so does the reply.
    expect(view.getByText('Replying to Anna · under their comment')).toBeTruthy();
    expect(view.getByText('What did you think of the ending?')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Reply' })).not.toBeDisabled();
  });

  it('never posts top-level when the parent is deleted mid-compose; offers a choice', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'my careful reply');

    // Anna deletes her comment (no replies to keep it as a tombstone in this fixture).
    mockCommentRows = conversation().filter((row) => row.id !== 'c1' && row.id !== 'r1');
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });

    await waitFor(() =>
      expect(view.getByText(/Anna’s comment is no longer available/)).toBeTruthy(),
    );
    // The words are kept, Reply cannot be pressed, and nothing was sent.
    expect(view.getByDisplayValue('my careful reply')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Reply' })).toBeDisabled();
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));
    expect(adds()).toHaveLength(0);

    // The explicit recovery, in the same composer: dismiss the indicator, which keeps the
    // words and returns to Add a comment / Post, then press the ordinary Post.
    await fireEvent.press(view.getByLabelText('Dismiss, keep your text'));
    expect(view.getByLabelText('Add a comment').props.value).toBe('my careful reply');
    expect(adds()).toHaveLength(0);
    await fireEvent.press(view.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(adds()).toHaveLength(1));
    expect(adds()[0]!.args).toMatchObject({ p_body: 'my careful reply', p_parent_id: null });
  });

  it('lets the reader drop it instead when the parent has gone', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Cy'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Cy'), 'too late');

    mockCommentRows = conversation().filter((row) => row.id !== 'c2');
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });
    await waitFor(() =>
      expect(view.getByText(/Cy’s comment is no longer available/)).toBeTruthy(),
    );

    await fireEvent.press(view.getByLabelText('Dismiss, keep your text'));
    await fireEvent.changeText(view.getByLabelText('Add a comment'), '');
    expect(view.getByRole('button', { name: 'Post' })).toBeDisabled();
    expect(adds()).toHaveLength(0);
  });

  it('treats a parent retracted to a tombstone as unavailable too', async () => {
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'hmm');

    mockCommentRows = conversation().map((row) =>
      row.id === 'c1' ? { ...row, body: null, deleted_at: minutesAgo(1) } : row,
    );
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });

    await waitFor(() =>
      expect(view.getByText(/Anna’s comment is no longer available/)).toBeTruthy(),
    );
    expect(view.getByRole('button', { name: 'Reply' })).toBeDisabled();
  });

  it('keeps the words when the server says the parent is gone before the list does', async () => {
    // Blocked or deleted between the last read and the press: `add_comment` refuses with
    // P0002 "no such comment" and wrote nothing.
    mockWriteResults = [{ error: { code: 'P0002', message: 'no such comment' } }];
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'for Anna');
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));

    await waitFor(() =>
      expect(view.getByText(/Anna’s comment is no longer available/)).toBeTruthy(),
    );
    // One write, the reply — never a silent second attempt at the top level.
    expect(adds()).toHaveLength(1);
    expect(adds()[0]!.args.p_parent_id).toBe('c1');
    expect(view.getByDisplayValue('for Anna')).toBeTruthy();
  });

  it('keeps the draft when the reader deletes the comment they were replying to', async () => {
    mockCommentRows = [
      ...conversation(),
      comment({
        id: 'mine',
        author_id: VIEWER,
        username: 'me',
        display_name: 'Me',
        body: 'My own remark',
        created_at: minutesAgo(5),
      }),
    ];
    const buttons: { text?: string; onPress?: () => void }[] = [];
    (Alert.alert as jest.Mock).mockImplementation((_t, _m, b) =>
      buttons.splice(0, 9, ...(b ?? [])),
    );
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Me'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Me'), 'a note to self');
    await fireEvent.press(view.getByLabelText('Delete your comment'));
    mockCommentRows = conversation();
    await act(async () => {
      buttons.find((b) => b.text === 'Delete')?.onPress?.();
    });

    await waitFor(() =>
      expect(view.getByText(/Me’s comment is no longer available/)).toBeTruthy(),
    );
    expect(view.getByDisplayValue('a note to self')).toBeTruthy();
    (Alert.alert as jest.Mock).mockImplementation(() => {});
  });

  it('replays an ambiguous reply failure under one id and one parent: no duplicate', async () => {
    // A dropped socket after the server may have committed. The reader is told it failed
    // and presses Reply again; the second attempt carries the first one's id, which
    // `_claim_operation` answers `already_applied` instead of inserting a second reply.
    mockWriteResults = [{ error: { code: '', message: 'TypeError: Network request failed' } }];
    const view = await render();

    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'said once');
    const reads = mockThreadReads;
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(adds()).toHaveLength(1));
    // The unknown outcome is reconciled: the thread is read again.
    await waitFor(() => expect(mockThreadReads).toBeGreaterThan(reads));

    // Still a reply to Anna, with the words kept.
    expect(view.getByText('Replying to Anna · under their comment')).toBeTruthy();
    mockWriteResults = [{ data: { status: 'already_applied' }, error: null }];
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(adds()).toHaveLength(2));

    expect(adds()[1]!.args.p_operation_id).toBe(adds()[0]!.args.p_operation_id);
    expect(adds()[1]!.args.p_parent_id).toBe('c1');
  });

  it('marks the comment being replied to in the list', async () => {
    const view = await render();
    const row = () =>
      StyleSheet.flatten(view.getByTestId('comment-row-c1').props.style) as ViewStyle;

    expect(row().backgroundColor).toBeUndefined();
    await fireEvent.press(view.getByLabelText('Reply to Anna'));
    expect(row().backgroundColor).toBe(theme.surface.sunken);
    await fireEvent.press(view.getByLabelText('Cancel reply to Anna'));
    expect(row().backgroundColor).toBeUndefined();
  });

  /**
   * The usability check, asserted as visible text. After tapping Reply, can a person tell
   * at once (1) new comment or reply, (2) to whom, (3) where it will appear, and (4) how
   * to cancel or switch?
   */
  it('answers the four questions a reader has after tapping Reply', async () => {
    const view = await render();
    await fireEvent.press(view.getByLabelText('Reply to Bo'));

    const banner = view.getByText(/^Replying to/);
    // (1) A reply, not a new comment: the banner, the placeholder and the button say so.
    expect(banner).toHaveTextContent(/^Replying to/);
    expect(view.getByLabelText('Your reply to Bo').props.placeholder).toBe('Reply to Bo…');
    expect(within(view.getByRole('button', { name: 'Reply' })).getByText('Reply')).toBeTruthy();
    // (2) To whom: the person tapped, by name.
    expect(banner).toHaveTextContent(/Replying to Bo/);
    // (3) Where: in Anna's thread (one level), and the row answered is marked.
    expect(banner).toHaveTextContent(/in Anna's thread$/);
    // (4) How to cancel: the indicator's own ✕, named for what it does; and how to
    // switch — every other comment still offers its own Reply.
    expect(view.getByRole('button', { name: 'Cancel reply to Bo' })).toBeTruthy();
    expect(view.getByLabelText('Reply to Anna')).toBeTruthy();
    expect(view.getByLabelText('Reply to Cy')).toBeTruthy();
    // And for a screen reader the mode is in the names and hints, not only on screen.
    expect(view.getByLabelText('Your reply to Bo').props.accessibilityHint).toBe(
      "A reply to Bo, shown in Anna's thread",
    );
    await fireEvent.changeText(view.getByLabelText('Your reply to Bo'), 'x');
    expect(view.getByRole('button', { name: 'Reply' }).props.accessibilityHint).toBe(
      'Posts your reply to Bo',
    );
  });
});

/**
 * The ordering bug, with the reported thread's shape: C1 the oldest root, C2 a later
 * root by the post's author, C3 a reply to C2 — and ids chosen so their sort disagrees
 * with time, exactly as `activity_comments`' `order by coalesce(parent_id, id)` does.
 */
describe('order', () => {
  const C1 = 'f1000000-0000-4000-8000-000000000001';
  const C2 = '21000000-0000-4000-8000-000000000002';
  const C3 = '91000000-0000-4000-8000-000000000003';
  const reported = () => [
    // The order the server returns: C2's thread first, because its id sorts first.
    comment({
      id: C2,
      author_id: 'author',
      display_name: 'Author',
      body: 'C2',
      created_at: minutesAgo(25),
    }),
    comment({
      id: C3,
      parent_id: C2,
      author_id: VIEWER,
      display_name: 'Me',
      body: 'C3',
      created_at: minutesAgo(23),
    }),
    comment({
      id: C1,
      author_id: VIEWER,
      display_name: 'Me',
      body: 'C1',
      created_at: minutesAgo(30),
    }),
  ];

  it.each(SURFACES)(
    'puts the oldest root first, with its replies under it, on $name',
    async ({ render }) => {
      mockCommentRows = reported();
      const view = await render();

      const threads = view.getAllByTestId(/^comment-thread-/).map((node) => node.props.testID);
      expect(threads).toEqual([`comment-thread-${C1}`, `comment-thread-${C2}`]);
      expect(within(view.getByTestId(`comment-replies-${C2}`)).getByText('C3')).toBeTruthy();
    },
  );

  it('connects replies to their root, and never one top-level comment to another', async () => {
    const view = await SURFACES[1]!.render();
    const flat = (id: string) =>
      StyleSheet.flatten(view.getByTestId(id).props.style ?? {}) as ViewStyle;

    // The connector: Anna's replies hang from a rule down from her comment.
    expect(flat('comment-replies-c1').borderLeftWidth).toBeGreaterThan(0);
    // Cy's comment has no replies, so no connector at all.
    expect(view.queryByTestId('comment-replies-c2')).toBeNull();
    // And the two threads are separated by space alone: no border, no rule between them.
    const second = flat('comment-thread-c2');
    expect(second.marginTop).toBe(theme.space[2]);
    expect(second.borderTopWidth ?? 0).toBe(0);
    expect(second.borderLeftWidth ?? 0).toBe(0);
    expect(
      view
        .getByTestId('comment-thread-c2')
        .children.filter((child) => typeof child !== 'string' && !child.props.testID),
    ).toHaveLength(0);
  });

  it('orders replies by time within a thread, and breaks a tie by id', async () => {
    const at = minutesAgo(10);
    mockCommentRows = [
      comment({ id: 'r-b', parent_id: 'c1', body: 'second (tie, id b)', created_at: at }),
      comment({ id: 'r-late', parent_id: 'c1', body: 'third', created_at: minutesAgo(5) }),
      comment({ id: 'r-a', parent_id: 'c1', body: 'first (tie, id a)', created_at: at }),
      comment(),
    ];
    const view = await SURFACES[0]!.render();
    const bodies = within(view.getByTestId('comment-replies-c1'))
      .getAllByText(/first|second|third/)
      .map((node) => node.props.children);
    expect(bodies.join('|')).toMatch(/first.*\|.*second.*\|.*third/);
  });
});

describe('arriving at one comment (a notification)', () => {
  const layout = (y: number) => ({
    nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
  });

  it('scrolls to the thread, marks the comment briefly, and starts no reply', async () => {
    jest.useFakeTimers();
    try {
      const onFocusOffset = jest.fn();
      const view = await SURFACES[1]!.render({ focusCommentId: 'r1', onFocusOffset });

      // The container, the thread, its replies and the reply report where they are.
      await fireEvent(view.getByTestId('comment-thread-c1').parent!, 'layout', layout(400));
      await fireEvent(view.getByTestId('comment-thread-c1'), 'layout', layout(0));
      await fireEvent(view.getByTestId('comment-replies-c1'), 'layout', layout(90));
      await fireEvent(view.getByTestId('comment-row-r1').parent!, 'layout', layout(0));

      // The root and the reply both fit, so the thread's top is the landing: context first.
      expect(onFocusOffset).toHaveBeenCalledTimes(1);
      expect(onFocusOffset).toHaveBeenCalledWith(400);

      const style = () =>
        StyleSheet.flatten(view.getByTestId('comment-row-r1').props.style) as ViewStyle;
      expect(style().backgroundColor).toBe(theme.surface.sunken);
      // Not a reply in progress: the default composer, and Reply on that comment works.
      expect(view.getByLabelText('Add a comment')).toBeTruthy();
      expect(view.queryByText(/^Replying to/)).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(FOCUS_HIGHLIGHT_MS + 10);
      });
      expect(style().backgroundColor).toBeUndefined();

      await fireEvent.press(view.getByLabelText('Reply to Bo'));
      expect(view.getByText(/^Replying to Bo/)).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says so, and still opens the conversation, when that comment has gone', async () => {
    const view = await SURFACES[1]!.render({ focusCommentId: 'deleted-one' });
    expect(view.getByText('That comment is no longer available.')).toBeTruthy();
    expect(view.getByText('What did you think of the ending?')).toBeTruthy();
  });
});
