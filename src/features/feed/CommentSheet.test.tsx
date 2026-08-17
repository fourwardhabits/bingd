import { fireEvent, waitFor } from '@testing-library/react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CommentSheet } from './CommentSheet';

/**
 * Comments V1 — the surface.
 *
 * The founder's spoiler rule is the reason most of this file exists: *no text preview
 * may leak masked spoiler content*. That is asserted here the only way it can be
 * asserted honestly — by looking for the string in the rendered tree and requiring it
 * to be absent, rather than by checking that a mask component was rendered over it.
 */

const VIEWER = 'viewer-1';
const AUTHOR = 'author-1';
const FILM = 'film-1';
const SEASON_1 = 'season-1';
const SEASON_2 = 'season-2';

let mockCommentRows: Record<string, unknown>[] = [];
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockRpcError: unknown = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: mockRpcError });
    },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => Promise.resolve({ data: mockCommentRows, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({ data: mockCommentRows, error: null }),
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
  feed_event_id: 'e1',
  author_id: AUTHOR,
  body: 'The ending recontextualises everything.',
  has_spoilers: false,
  created_at: new Date().toISOString(),
  edited_at: null,
  profiles: { username: 'anna', display_name: 'Anna', avatar_path: null },
  ...over,
});

const open = (over: Partial<React.ComponentProps<typeof CommentSheet>> = {}) =>
  renderWithProviders(
    <CommentSheet
      eventId="e1"
      mediaItemId={FILM}
      title="Sinners"
      viewerId={VIEWER}
      watched={new Set()}
      onClose={jest.fn()}
      onPressPerson={jest.fn()}
      {...over}
    />,
  );

beforeEach(() => {
  mockCommentRows = [];
  mockRpcCalls.length = 0;
  mockRpcError = null;
});

// ---------------------------------------------------------------------------

describe('spoilers', () => {
  it('does not put a masked body in the tree at all', async () => {
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: new Set() });

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    // Not "is clipped", not "is behind an overlay". Absent. A string in the tree is
    // read aloud by a screen reader and copied by a selection whatever is drawn on
    // top of it.
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });

  it('reveals on tap, locally', async () => {
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: new Set() });
    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());

    await fireEvent.press(view.getByText('Show'));

    expect(view.getByText(/recontextualises/)).toBeTruthy();
    // Nothing was written to reveal it.
    expect(mockRpcCalls).toHaveLength(0);
  });

  it('shows it normally, with a marker, to somebody who has watched the exact title', async () => {
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: new Set([FILM]) });

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
    // The founder's "subtle spoiler indication" — the claim is still part of what the
    // comment says about itself. Two matches: the marker on the comment, and the
    // composer's own toggle, which is always present.
    expect(view.getAllByText('Spoilers')).toHaveLength(2);
    expect(view.queryByText('Contains spoilers')).toBeNull();
  });

  it('masks a season comment for somebody who has only watched another season', async () => {
    // Exact-entity semantics. The id passed in is the event's media item, and a
    // season is its own media item, so this holds by comparison rather than by a rule.
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ mediaItemId: SEASON_2, watched: new Set([SEASON_1]) });

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });

  it('does not mask an author from their own words', async () => {
    mockCommentRows = [comment({ has_spoilers: true, author_id: VIEWER })];

    const view = await open({ watched: new Set() });

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
  });

  it('masks while the watched set is still loading', async () => {
    // Undefined resolves to masked. The failure modes are not symmetric: a mask shown
    // to somebody who has seen the film is one tap, and the reverse is the thing the
    // feature exists to prevent.
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: undefined });

    await waitFor(() => expect(view.getByText('Contains spoilers')).toBeTruthy());
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the list', () => {
  it('says so when there is nothing yet', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());
  });

  it('drops a comment whose author did not resolve rather than crediting nobody', async () => {
    mockCommentRows = [comment(), comment({ id: 'c2', body: 'orphaned', profiles: null })];

    const view = await open({ watched: new Set([FILM]) });

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
    expect(view.queryByText('orphaned')).toBeNull();
  });

  it('marks an edited comment as edited', async () => {
    mockCommentRows = [comment({ edited_at: new Date().toISOString() })];

    const view = await open({ watched: new Set([FILM]) });

    await waitFor(() => expect(view.getByText(/edited/)).toBeTruthy());
  });

  it('offers Edit and Delete on your own and on nobody else’s', async () => {
    mockCommentRows = [comment(), comment({ id: 'c2', author_id: VIEWER, body: 'mine' })];

    const view = await open({ watched: new Set([FILM]) });

    await waitFor(() => expect(view.getByText('mine')).toBeTruthy());
    // One of each, for the one comment that is the viewer's.
    expect(view.getAllByText('Edit')).toHaveLength(1);
    expect(view.getAllByText('Delete')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('writing one', () => {
  it('posts what was typed, with the spoiler claim the author set', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), '  Loved it  ');
    await fireEvent.press(view.getByLabelText('Mark this comment as containing spoilers'));
    await fireEvent.press(view.getByText('Post'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]!.name).toBe('add_comment');
    // Trimmed here as well as in the database, so what is sent is what was meant.
    expect(mockRpcCalls[0]!.args.p_body).toBe('Loved it');
    expect(mockRpcCalls[0]!.args.p_has_spoilers).toBe(true);
    expect(mockRpcCalls[0]!.args.p_feed_event_id).toBe('e1');
    // Idempotency is not optional on a write that creates a row.
    expect(mockRpcCalls[0]!.args.p_operation_id).toBeTruthy();
  });

  it('will not post an empty comment', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), '    ');
    await fireEvent.press(view.getByText('Post'));

    expect(mockRpcCalls).toHaveLength(0);
  });

  it('edits through the same composer, and sends the comment id', async () => {
    mockCommentRows = [comment({ author_id: VIEWER, body: 'frist' })];

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('frist')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Edit your comment'));
    expect(view.getByText('Editing your comment')).toBeTruthy();

    await fireEvent.changeText(view.getByLabelText('Your comment'), 'first');
    await fireEvent.press(view.getByText('Save'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]!.name).toBe('edit_comment');
    expect(mockRpcCalls[0]!.args.p_comment_id).toBe('c1');
    expect(mockRpcCalls[0]!.args.p_body).toBe('first');
  });

  it('keeps the draft when the write fails, so nothing the user typed is lost', async () => {
    mockRpcError = { message: 'network is down' };

    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'worth keeping');
    await fireEvent.press(view.getByText('Post'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(view.getByDisplayValue('worth keeping')).toBeTruthy();
  });

  it('clears the draft once it lands', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'said it');
    await fireEvent.press(view.getByText('Post'));

    await waitFor(() => expect(view.queryByDisplayValue('said it')).toBeNull());
  });
});

describe('the composer belongs to one activity', () => {
  // Independent review 11, Major. The sheet stays mounted between openings, so its
  // state outlived the event it was written against.

  it('drops a draft when the sheet moves to another activity', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'about event A');
    await view.rerender(
      <CommentSheet
        eventId="e2"
        mediaItemId={FILM}
        title="Sinners"
        viewerId={VIEWER}
        watched={new Set()}
        onClose={jest.fn()}
        onPressPerson={jest.fn()}
      />,
    );

    expect(view.queryByDisplayValue('about event A')).toBeNull();
  });

  it('does not carry an open edit onto the next activity', async () => {
    // The dangerous half. `editing` held a comment from the first event, so Save on
    // the second rewrote a comment that was not on screen.
    mockCommentRows = [comment({ author_id: VIEWER, body: 'from event A' })];

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('from event A')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Edit your comment'));
    expect(view.getByText('Editing your comment')).toBeTruthy();

    mockCommentRows = [];
    await view.rerender(
      <CommentSheet
        eventId="e2"
        mediaItemId={FILM}
        title="Sinners"
        viewerId={VIEWER}
        watched={new Set([FILM])}
        onClose={jest.fn()}
        onPressPerson={jest.fn()}
      />,
    );

    expect(view.queryByText('Editing your comment')).toBeNull();
    // And what the composer would now send is an add against the new event, not an
    // edit of the old comment.
    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'about event B');
    await fireEvent.press(view.getByText('Post'));

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]!.name).toBe('add_comment');
    expect(mockRpcCalls[0]!.args.p_feed_event_id).toBe('e2');
  });

  it('clears the draft when the sheet is closed and reopened', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());
    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'unsent');

    const props = {
      mediaItemId: FILM,
      title: 'Sinners',
      viewerId: VIEWER,
      watched: new Set<string>(),
      onClose: jest.fn(),
      onPressPerson: jest.fn(),
    };
    await view.rerender(<CommentSheet eventId={null} {...props} />);
    await view.rerender(<CommentSheet eventId="e1" {...props} />);

    expect(view.queryByDisplayValue('unsent')).toBeNull();
  });
});
