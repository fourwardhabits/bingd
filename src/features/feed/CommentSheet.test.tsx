import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

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
/** Held open to keep a write in flight while the sheet moves on. */
let mockRpcGate: Promise<void> | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (mockRpcGate) await mockRpcGate;
      mockRpcCalls.push({ name, args });
      return { data: null, error: mockRpcError };
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

/**
 * Alert is a native module, so the confirmation button has to be invoked directly.
 * Recording the buttons is also the only way to assert that a destructive action was
 * *not* taken — a spy on the RPC alone cannot tell 'refused' from 'never confirmed'.
 */
const alertButtons: { text?: string; onPress?: () => void }[] = [];
jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
  alertButtons.length = 0;
  for (const button of buttons ?? []) alertButtons.push(button);
});

const confirmLastAlert = (text: string) => {
  const button = alertButtons.find((b) => b.text === text);
  if (!button?.onPress) throw new Error(`no "${text}" button on the last alert`);
  button.onPress();
};

beforeEach(() => {
  mockCommentRows = [];
  mockRpcCalls.length = 0;
  mockRpcError = null;
  mockRpcGate = null;
  alertButtons.length = 0;
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

describe('work already in flight belongs to the activity that started it', () => {
  // Independent review 11b. Resetting state on a change of event does nothing for
  // callbacks made before the change: a slow write and a native confirmation both
  // outlive the render that created them.

  const sheet = (eventId: string | null) => (
    <CommentSheet
      eventId={eventId}
      mediaItemId={FILM}
      title="Sinners"
      viewerId={VIEWER}
      watched={new Set([FILM])}
      onClose={jest.fn()}
      onPressPerson={jest.fn()}
    />
  );

  it('does not let a slow post clear the next activity’s draft', async () => {
    let release: (() => void) | null = null;
    mockRpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'about event A');
    await fireEvent.press(view.getByText('Post'));

    // Still in flight. Move to another activity and start typing.
    await view.rerender(sheet('e2'));
    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'about event B');

    release!();
    mockRpcGate = null;
    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));

    // A's write happened, against A. B's draft survived it.
    expect(mockRpcCalls[0]!.args.p_feed_event_id).toBe('e1');
    expect(view.getByDisplayValue('about event B')).toBeTruthy();
  });

  it('abandons a delete confirmed against an activity that is no longer on screen', async () => {
    mockCommentRows = [comment({ author_id: VIEWER, body: 'from event A' })];

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('from event A')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Delete your comment'));
    // The alert is up. The sheet moves underneath it, which a native modal allows.
    await view.rerender(sheet('e2'));

    // Now the user confirms.
    confirmLastAlert('Delete');

    // Deliberately not `waitFor(() => expect(mockRpcCalls).toHaveLength(0))`, which
    // is vacuous: waitFor returns the moment its assertion passes, and an empty array
    // passes before the continuation has had a chance to run. It was written that way
    // first and did not fail when the guard was removed. This drains the queue.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockRpcCalls).toHaveLength(0);
  });

  it('still deletes when the sheet has not moved', async () => {
    // The other half: the guard must not break the ordinary path.
    mockCommentRows = [comment({ author_id: VIEWER, body: 'from event A' })];

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('from event A')).toBeTruthy());

    await fireEvent.press(view.getByLabelText('Delete your comment'));
    confirmLastAlert('Delete');

    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));
    expect(mockRpcCalls[0]!.name).toBe('delete_comment');
    expect(mockRpcCalls[0]!.args.p_comment_id).toBe('c1');
  });
});
