import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

import { CommentSheet } from './CommentSheet';
import { DEFAULT_REACTION, REACTIONS, REACTION_GLYPH } from './use-reactions';

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
/** What `comment_reactors` answers — the reactor list behind a cluster (§18). */
let mockReactorRows: Record<string, unknown>[] = [];
const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockRpcError: unknown = null;
/** The list read's own failure, kept apart from the writers' so one cannot mask the other. */
let mockReadError: unknown = null;
/** Held open to keep a write in flight while the sheet moves on. */
let mockRpcGate: Promise<void> | null = null;

jest.mock('@/lib/supabase', () => ({
  supabase: {
    // Writes that create a notification nudge push-sender afterwards
    // (notifications/push.ts). It chooses nothing and this suite asserts nothing about
    // it; the stub is here so the nudge is exercised rather than swallowed by its own
    // guard.
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    /**
     * The list is an RPC now, not a `from('comments')` select with a profile embed.
     *
     * `20260826000600` replaced the two round trips with `activity_comments`, which
     * resolves the visibility oracle once per event and once per distinct author instead
     * of once per row — a measured 11.35ms across two requests down to 2.22ms in one.
     * The read is mocked here rather than in `from` because that is where it now lives;
     * the reads are separated from the writes below so a write assertion still cannot
     * accidentally match a read.
     */
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'activity_comments') {
        return { data: mockCommentRows, error: mockReadError };
      }
      // A read like the list above, kept out of the writer ledger for the same
      // reason: a write assertion must not accidentally match a read. It is still
      // recorded, because *what it was asked about* is its own assertion.
      if (name === 'comment_reactors') {
        mockRpcCalls.push({ name, args });
        return { data: mockReactorRows, error: null };
      }
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

/**
 * One row as `activity_comments` returns it.
 *
 * Flat, because the function joins the author itself rather than leaving PostgREST to
 * resolve a `profiles:author_id(...)` embed in a second statement. A row whose author
 * the reader may not see never arrives at all now — the join is inner — which is why
 * the "author did not resolve" case below constructs its absence differently than it
 * used to.
 */
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
  // The two the function grew in 20260827000500, when a comment gained the same six
  // meanings an activity carries.
  reaction_kinds: [],
  my_reaction: null,
  ...over,
});

/**
 * Opens the sheet and waits for the comment query to have answered.
 *
 * The wait is the point. **The composer is always on screen, and it carries its own
 * "Contains spoilers" toggle** — the file says so itself further down, where two matches
 * are asserted and one of them is the composer. So
 * `waitFor(() => getAllByText('Contains spoilers').length > 0)`, which is how most of the
 * spoiler tests used to begin, is satisfied on its first poll by a control that is
 * present before a single comment has loaded. It waited for nothing, and everything
 * after it ran against a list still reading "Loading comments…".
 *
 * On a quiet machine the rows had arrived anyway and it did not matter. On a contended
 * one they had not: CI run 32323036230 failed at `getByText('Show')` with the loading
 * text still in the printed tree, one line after a `waitFor` that had "passed".
 *
 * So the anchor is the sheet's own loading copy, which is the one signal that means the
 * rows are in. It covers the error and empty states too, where the list is replaced
 * wholesale and the copy goes with it.
 */
const open = async (over: Partial<React.ComponentProps<typeof CommentSheet>> = {}) => {
  const view = await renderWithProviders(
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

  await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
  return view;
};

/**
 * Alert is a native module, so the confirmation button has to be invoked directly.
 * Recording the buttons is also the only way to assert that a destructive action was
 * *not* taken — a spy on the RPC alone cannot tell 'refused' from 'never confirmed'.
 */
const alertButtons: { text?: string; onPress?: () => void }[] = [];
/**
 * The title and message of every alert raised, in order.
 *
 * Recorded as well as the buttons because reporting's whole outcome *is* an alert: it
 * has no confirmation step and no visible state change, so "did the report succeed"
 * and "was the failure explained" can only be read here.
 */
const alertTitles: string[] = [];
const alertMessages: string[] = [];
jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
  alertTitles.push(title);
  alertMessages.push(message ?? '');
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
  mockReactorRows = [];
  mockRpcCalls.length = 0;
  mockRpcError = null;
  mockRpcGate = null;
  alertButtons.length = 0;
  alertTitles.length = 0;
  alertMessages.length = 0;
});

// ---------------------------------------------------------------------------

describe('spoilers', () => {
  it('does not put a masked body in the tree at all', async () => {
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: new Set() });

    // Two: the mask on the row, and the composer's own toggle. Counted rather than "at
    // least one", which the composer satisfies by itself with no comment on screen.
    expect(view.getAllByText('Contains spoilers')).toHaveLength(2);
    // Not "is clipped", not "is behind an overlay". Absent. A string in the tree is
    // read aloud by a screen reader and copied by a selection whatever is drawn on
    // top of it.
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });

  it('reveals on tap, locally', async () => {
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ watched: new Set() });
    expect(view.getAllByText('Contains spoilers')).toHaveLength(2);

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
    // comment says about itself, and somebody who has seen the film reads the words
    // rather than tapping through to them. Two matches: the marker on the comment, and
    // the composer's own toggle, which is always present. Both now say the same three
    // words the ranking sheet and the note control say.
    expect(view.getAllByText('Contains spoilers')).toHaveLength(2);
  });

  it('masks a season comment for somebody who has only watched another season', async () => {
    // Exact-entity semantics. The id passed in is the event's media item, and a
    // season is its own media item, so this holds by comparison rather than by a rule.
    mockCommentRows = [comment({ has_spoilers: true })];

    const view = await open({ mediaItemId: SEASON_2, watched: new Set([SEASON_1]) });

    expect(view.getAllByText('Contains spoilers')).toHaveLength(2);
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

    expect(view.getAllByText('Contains spoilers')).toHaveLength(2);
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * The Feed's comments icon still opens a **sheet**, which is the founder's explicit
 * instruction for this pass: a comment *notification* opens the dedicated thread page,
 * and the comments *button* on a feed card goes on doing what it always did.
 *
 * Worth asserting rather than assuming, because `20260826000600` moved the entire body of
 * this component into `CommentThread` so the page could share it. The obvious way for
 * that refactor to go wrong is for the sheet to stop being a sheet — everything else in
 * this file would still pass.
 */
describe('the Feed interaction, unchanged', () => {
  it('opens as a sheet rather than as a screen', async () => {
    mockCommentRows = [comment()];
    const view = await open({ watched: new Set([FILM]) });

    // `Sheet` announces itself by its label and is the app's one modal pattern
    // (design-system.md §8). A page would have neither.
    expect(view.getByLabelText('Comments')).toBeTruthy();
    expect(view.getByText(/recontextualises/)).toBeTruthy();
  });

  it('draws nothing at all when no activity is open', async () => {
    const view = await renderWithProviders(
      <CommentSheet
        eventId={null}
        mediaItemId={FILM}
        title="Sinners"
        viewerId={VIEWER}
        watched={new Set()}
        onClose={jest.fn()}
        onPressPerson={jest.fn()}
      />,
    );

    // Closing the sheet is `eventId: null`, and a visible sheet with nothing in it would
    // animate an empty panel up every time the feed closed one.
    expect(view.queryByLabelText('Comments')).toBeNull();
  });
});

describe('the list', () => {
  it('says so when there is nothing yet', async () => {
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());
  });

  /**
   * **The "drop an unnameable author" rule moved to the server, and this is what is
   * left of it here.**
   *
   * This used to send a row with `profiles: null` and assert the client dropped it —
   * `use-feed.ts`'s rule, applied to comments: a remark attributed to nobody is worse
   * than one fewer remark. The rule has not been relaxed; it has moved somewhere
   * stronger. `activity_comments` joins authors with an *inner* join, so a comment whose
   * author this reader may not see never leaves the database, and there is no shape the
   * client can receive that would need filtering. That half is asserted where it now
   * lives — `supabase/tests/comment-threads.test.mjs`, "omits a comment whose author the
   * caller cannot see, rather than anonymising it".
   *
   * What remains client-side is the *naming* fallback, and it is worth keeping: a
   * profile with no display name is ordinary rather than exceptional, and the handle is
   * the right thing to print for it. "Someone" must never appear.
   */
  it('names an author by handle when they have set no display name', async () => {
    mockCommentRows = [comment({ display_name: null, username: 'anna' })];

    const view = await open({ watched: new Set([FILM]) });

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
    expect(view.getByText('anna')).toBeTruthy();
    expect(view.queryByText('Someone')).toBeNull();
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

  /**
   * **The retry a lost reply invites, and the second comment it used to produce.**
   *
   * `add_comment` inserts. `_claim_operation` exists to refuse a replayed intent, but it
   * can only recognise a replay that carries the id it already saw — and this module
   * minted a fresh one inside the writer, so the ledger never got the chance. A post
   * whose reply is lost is reported as a failure with the draft still in the box, which
   * is an invitation to press Post again: two identical comments, no exception, and the
   * second as legitimate-looking as the first.
   *
   * Every other writer behind this pattern is idempotent by shape — a follow, a reaction,
   * a tag set and a profile save all assign, and `recommend_title` is keyed on
   * sender/recipient/title — which is why nothing accumulated anywhere else and why this
   * went unseen.
   */
  it('replays a failed post under the id the first attempt used', async () => {
    mockRpcError = { code: '', message: 'TypeError: Network request failed' };

    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'worth saying once');
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));

    // The same words, pressed again — which is what somebody told "could not post" does.
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(2));

    expect(mockRpcCalls[1]!.args.p_operation_id).toBe(mockRpcCalls[0]!.args.p_operation_id);
    // And it is a real id rather than both being undefined, which would pass for the
    // wrong reason.
    expect(typeof mockRpcCalls[0]!.args.p_operation_id).toBe('string');
  });

  it('gives different words an id of their own', async () => {
    // The id belongs to the intent. Editing the draft and pressing Post is a different
    // thing to say, and replaying it under the old id would have the server answer
    // `already_applied` to something nobody has stored.
    mockRpcError = { code: '', message: 'TypeError: Network request failed' };

    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'first thought');
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'second thought');
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(2));

    expect(mockRpcCalls[1]!.args.p_operation_id).not.toBe(mockRpcCalls[0]!.args.p_operation_id);
  });

  it('starts a fresh id after one has landed', async () => {
    // Otherwise the next comment replays the stored one and the server answers
    // `already_applied` to a thing nobody wrote — a post that silently does nothing.
    const view = await open();
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'one');
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'two');
    await fireEvent.press(view.getByText('Post'));
    await waitFor(() => expect(mockRpcCalls).toHaveLength(2));

    expect(mockRpcCalls[1]!.args.p_operation_id).not.toBe(mockRpcCalls[0]!.args.p_operation_id);
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

describe('an opening, not an activity id', () => {
  // Independent review 11c, Minor. Open A, close, reopen A: two different composers
  // that share an event id, so comparing ids alone let the first one's slow write
  // clear the second one's draft.

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

  it('does not let a slow post survive a close and reopen of the same activity', async () => {
    let release: (() => void) | null = null;
    mockRpcGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const view = await open({ watched: new Set([FILM]) });
    await waitFor(() => expect(view.getByText('No comments yet')).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'first attempt');
    await fireEvent.press(view.getByText('Post'));

    // Same activity, but a different opening of it.
    await view.rerender(sheet(null));
    await view.rerender(sheet('e1'));
    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'second attempt');

    release!();
    mockRpcGate = null;
    await waitFor(() => expect(mockRpcCalls).toHaveLength(1));

    expect(view.getByDisplayValue('second attempt')).toBeTruthy();
  });
});


/**
 * Reporting a comment.
 *
 * The control sits in the branch Edit and Delete do not, so a good deal of what is worth
 * asserting here is about *absence*: on your own comment there must be no Report at all,
 * because `report()` refuses a self-report with a 22023 and a control whose only possible
 * outcome is an error message is worse than no control.
 */
describe('reporting a comment', () => {
  it("offers Report on somebody else's comment and not on your own", async () => {
    mockCommentRows = [
      comment({ id: 'theirs', author_id: AUTHOR }),
      comment({
        id: 'mine',
        author_id: VIEWER,
        body: 'my own remark',
        profiles: { username: 'me', display_name: 'Me', avatar_path: null },
      }),
    ];

    const view = await open();

    // One Report, for the one comment that is not the viewer's.
    expect(view.getAllByText('Report')).toHaveLength(1);
    expect(view.getByLabelText("Report Anna's comment")).toBeTruthy();

    // And the viewer's own comment keeps its own two controls.
    expect(view.getByLabelText('Edit your comment')).toBeTruthy();
    expect(view.getByLabelText('Delete your comment')).toBeTruthy();
  });

  it('files the chosen reason against the comment id, and sends no owner', async () => {
    mockCommentRows = [comment({ id: 'c-abusive', author_id: AUTHOR })];
    const view = await open();

    await fireEvent.press(view.getByLabelText("Report Anna's comment"));
    await fireEvent.press(view.getByText('Harassment or bullying'));

    await waitFor(() => expect(mockRpcCalls.filter((c) => c.name === 'report')).toHaveLength(1));
    const call = mockRpcCalls.find((c) => c.name === 'report');

    /**
     * **Exactly these three arguments.** The whole reason `report()` resolves the author
     * from `comments.author_id` is that a client-supplied owner would let anybody
     * attribute a report to an account of their choosing — and a call that passed one
     * would still succeed, because the server ignores what it did not ask for. So the
     * absence has to be asserted on this side.
     */
    expect(call?.args).toEqual({
      p_subject_type: 'comment',
      p_subject_id: 'c-abusive',
      p_reason: 'harassment',
    });
  });

  it('uses the backend taxonomy rather than a second set of reasons', async () => {
    mockCommentRows = [comment({ author_id: AUTHOR })];
    const view = await open();
    await fireEvent.press(view.getByLabelText("Report Anna's comment"));

    // Eight, matching `reports_known_reason`. A ninth invented here would produce
    // reports the triage process has no column for.
    for (const label of [
      'Harassment or bullying',
      'Hate speech',
      'Self-harm or suicide',
      'Sexual content',
      'Pretending to be someone',
      'Illegal content',
      'Spam or a scam',
      'Something else',
    ]) {
      expect(view.getByText(label)).toBeTruthy();
    }
  });

  it('thanks the reporter without claiming the report was new', async () => {
    mockCommentRows = [comment({ author_id: AUTHOR })];
    const view = await open();

    await fireEvent.press(view.getByLabelText("Report Anna's comment"));
    await fireEvent.press(view.getByText('Spam or a scam'));

    await waitFor(() => expect(alertTitles).toContain('Thanks for telling us'));
    // The server's receipt cannot distinguish "filed" from "you already reported this",
    // deliberately — so the confirmation must not assert either.
    expect(alertTitles.concat(alertMessages).join(' ')).not.toMatch(/already|first|new report/i);
  });

  /**
   * A stale row: the comment was deleted between the list loading and a reason being
   * chosen. The server answers P0002, and the sheet has to say so rather than throw.
   */
  it('fails gracefully when the comment has already been removed', async () => {
    mockCommentRows = [comment({ author_id: AUTHOR })];
    const view = await open();

    mockRpcError = { code: 'P0002', message: 'no such subject' };
    await fireEvent.press(view.getByLabelText("Report Anna's comment"));
    await fireEvent.press(view.getByText('Hate speech'));

    await waitFor(() => expect(alertTitles).toContain('Could not report'));
    expect(alertMessages).toContain('That has already been removed.');
  });

  it('does not block anybody as a side effect of reporting them', async () => {
    mockCommentRows = [comment({ author_id: AUTHOR })];
    const view = await open();

    await fireEvent.press(view.getByLabelText("Report Anna's comment"));
    await fireEvent.press(view.getByText('Hate speech'));

    await waitFor(() => expect(mockRpcCalls.some((c) => c.name === 'report')).toBe(true));
    // Report and Block are separate acts with separate consequences. Bundling them would
    // silently block somebody who only meant to flag one remark.
    expect(mockRpcCalls.map((c) => c.name)).not.toContain('block');
  });
});

/**
 * Reactions on a comment, which since 20260827000500 are the feed's reactions.
 *
 * The founder found the two apart on a device: holding the control on a feed row offered
 * six meanings, holding it on a comment offered nothing, and the same gesture doing
 * different things one swipe apart is the inconsistency. What these tests pin is that the
 * *grammar* is the same one — tap toggles the heart, hold opens the six, the cluster
 * shows what everybody chose — rather than a second picker that merely resembles it.
 *
 * The taxonomy itself is asserted against `REACTIONS`, not against a copied list, so a
 * seventh meaning added there has to appear here without this file being edited.
 */
describe('reacting to a comment', () => {
  const reactionCalls = () => mockRpcCalls.filter((call) => call.name === 'set_comment_reaction');

  /** The arguments of the one reaction write, failing loudly if none was made. */
  const reactionArgs = (index = 0) => {
    const call = reactionCalls()[index];
    if (!call) throw new Error(`no set_comment_reaction call at index ${index}`);
    return call.args;
  };

  /** The control on the one comment, found the way a screen reader finds it. */
  const control = (view: Awaited<ReturnType<typeof open>>) =>
    view.getByLabelText(/^(React to|You reacted to)/);

  const mine = (kind: string) => ({
    reaction_count: 1,
    reacted_by_me: true,
    reaction_kinds: [kind],
    my_reaction: kind,
  });

  it('sends the default heart on a plain tap, as the feed does', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    await fireEvent.press(control(view));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_kind: DEFAULT_REACTION });
    // The boolean the old control sent is gone: the argument name is what tells the two
    // server signatures apart, so sending `p_on` would silently reach the compatibility
    // one and store a heart whatever the reader chose.
    expect(reactionArgs()).not.toHaveProperty('p_on');
  });

  it('takes the heart back when it is already mine', async () => {
    mockCommentRows = [comment(mine('love'))];
    const view = await open();

    await fireEvent.press(control(view));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_kind: null });
  });

  /**
   * The feed's rule verbatim: a tap on a row already carrying some *other* reaction
   * replaces it with the heart rather than clearing it. The gesture means "react", and
   * the way to remove a reaction you can see is to tap the one you chose.
   */
  it('replaces another reaction with the heart rather than clearing it', async () => {
    mockCommentRows = [comment(mine('wow'))];
    const view = await open();

    await fireEvent.press(control(view));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_kind: DEFAULT_REACTION });
  });

  it('opens the same six on a long press, and no others', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    await act(async () => fireEvent(control(view), 'longPress'));

    for (const reaction of REACTIONS) {
      expect(view.getByLabelText(reaction.label)).toBeTruthy();
    }
    expect(view.getByLabelText('Close reactions')).toBeTruthy();
  });

  it('sends whichever of the six was chosen', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    await act(async () => fireEvent(control(view), 'longPress'));
    await fireEvent.press(view.getByLabelText('Funny'));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_kind: 'funny' });
  });

  it('offers to remove the one already chosen, from inside the picker', async () => {
    mockCommentRows = [comment(mine('wow'))];
    const view = await open();

    await act(async () => fireEvent(control(view), 'longPress'));
    await fireEvent.press(view.getByLabelText('Remove Wow'));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_kind: null });
  });

  it('closes the picker without sending when it is dismissed', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    await act(async () => fireEvent(control(view), 'longPress'));
    await fireEvent.press(view.getByLabelText('Close reactions'));

    expect(view.queryByLabelText('Close reactions')).toBeNull();
    expect(reactionCalls()).toHaveLength(0);
  });

  /**
   * The cluster is the feed's: the distinct meanings, most common first, capped at three
   * so a busy comment does not turn its own row into a legend.
   */
  it('shows the glyphs other people chose, beside the count', async () => {
    mockCommentRows = [
      comment({
        reaction_count: 5,
        reacted_by_me: false,
        reaction_kinds: ['love', 'funny', 'wow', 'moved'],
        my_reaction: null,
      }),
    ];
    const view = await open();

    expect(view.getByText('5')).toBeTruthy();
    for (const kind of ['love', 'funny', 'wow'] as const) {
      expect(view.getByText(REACTION_GLYPH[kind], { includeHiddenElements: true })).toBeTruthy();
    }
    // The fourth is not drawn: three is the cap `ActivityRow` sets.
    expect(
      view.queryByText(REACTION_GLYPH.moved, { includeHiddenElements: true }),
    ).toBeNull();
  });

  it('shows no count at all on a comment nobody has reacted to', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    // A nought beside every remark is a scoreboard nobody asked for.
    expect(view.queryByText('0')).toBeNull();
  });

  it('says whether the reaction is mine, for a screen reader', async () => {
    mockCommentRows = [comment(mine('love'))];
    const view = await open();

    expect(view.getByLabelText(/^You reacted to Anna/)).toBeTruthy();
    expect(view.getByLabelText(/long press to change/)).toBeTruthy();
  });

  /**
   * A reply is a comment, and the server puts a reaction on it through the same writer.
   * Refusing one here would be the visible half of a rule the reader cannot know about.
   */
  it('reacts to a reply exactly as it does to a root', async () => {
    mockCommentRows = [
      comment(),
      comment({ id: 'c2', parent_id: 'c1', body: 'Agreed.', username: 'bo', display_name: 'Bo' }),
    ];
    const view = await open();

    const controls = view.getAllByLabelText(/^React to/);
    expect(controls).toHaveLength(2);

    const reply = controls[1];
    if (!reply) throw new Error('expected a control on the reply');
    await act(async () => fireEvent(reply, 'longPress'));
    await fireEvent.press(view.getByLabelText('Moved'));

    await waitFor(() => expect(reactionCalls()).toHaveLength(1));
    expect(reactionArgs()).toMatchObject({ p_comment_id: 'c2', p_kind: 'moved' });
  });

  it('offers nothing to react to on a retracted comment', async () => {
    mockCommentRows = [
      comment({ deleted_at: new Date().toISOString(), body: null }),
      comment({ id: 'c2', parent_id: 'c1', body: 'Still here.', username: 'bo', display_name: 'Bo' }),
    ];
    const view = await open();

    // One control, and it belongs to the reply — the tombstone is a place in the
    // conversation and not a comment.
    expect(view.getAllByLabelText(/^React to/)).toHaveLength(1);
  });
});

/**
 * The people behind the cluster (founder, 2026-08-27 §18).
 *
 * The count and the glyphs are an aggregate; holding — or tapping — them opens the
 * feed's own `ReactionDetail` over the identities, from `comment_reactors`, which
 * restates `activity_comments`' visibility gates so the number on the row and the
 * people in the sheet cannot disagree.
 */
describe('who reacted to a comment', () => {
  const reacted = () =>
    comment({
      reaction_count: 2,
      reacted_by_me: false,
      reaction_kinds: ['funny', 'love'],
      my_reaction: null,
    });

  const reactors = [
    { user_id: 'u1', username: 'abisola', display_name: 'Abisola', avatar_path: null, kind: 'funny' },
    { user_id: 'u2', username: 'ravi', display_name: 'Ravi', avatar_path: null, kind: 'love' },
  ];

  it('opens the people on a long press of the cluster, each with their reaction', async () => {
    mockCommentRows = [reacted()];
    mockReactorRows = reactors;
    const view = await open();

    await act(async () => fireEvent(view.getByLabelText('2 reactions. See who reacted.'), 'longPress'));

    // Person and meaning together — the founder's "Abisola ❤️" list, as the feed
    // already draws it.
    await waitFor(() =>
      expect(view.getByLabelText('Abisola, reacted Funny. Open their profile.')).toBeTruthy(),
    );
    expect(view.getByLabelText('Ravi, reacted Love. Open their profile.')).toBeTruthy();
    expect(
      mockRpcCalls.filter((call) => call.name === 'comment_reactors').map((call) => call.args),
    ).toEqual([{ p_comment_id: 'c1' }]);
  });

  it('opens on a plain tap too — a target this small does not demand the rarer gesture', async () => {
    mockCommentRows = [reacted()];
    mockReactorRows = reactors;
    const view = await open();

    await fireEvent.press(view.getByLabelText('2 reactions. See who reacted.'));

    await waitFor(() =>
      expect(view.getByLabelText('Abisola, reacted Funny. Open their profile.')).toBeTruthy(),
    );
  });

  it('asks about the reply whose cluster was held, not the root', async () => {
    mockCommentRows = [
      comment(),
      comment({
        id: 'c2',
        parent_id: 'c1',
        body: 'Agreed.',
        username: 'bo',
        display_name: 'Bo',
        reaction_count: 1,
        reaction_kinds: ['wow'],
      }),
    ];
    mockReactorRows = [
      { user_id: 'u3', username: 'silky', display_name: 'Silky', avatar_path: null, kind: 'wow' },
    ];
    const view = await open();

    await act(async () => fireEvent(view.getByLabelText('1 reaction. See who reacted.'), 'longPress'));

    await waitFor(() =>
      expect(view.getByLabelText('Silky, reacted Wow. Open their profile.')).toBeTruthy(),
    );
    expect(
      mockRpcCalls.filter((call) => call.name === 'comment_reactors').map((call) => call.args),
    ).toEqual([{ p_comment_id: 'c2' }]);
  });

  it('offers no way in on a comment nobody has reacted to', async () => {
    mockCommentRows = [comment()];
    const view = await open();

    expect(view.queryByLabelText(/See who reacted/)).toBeNull();
  });
});

/**
 * The operation id, held while the outcome is unknown — the feed's rule, here too.
 *
 * `set_comment_reaction` is rate-limited, so a replay is not free even though the row
 * converges: a write that commits and loses its reply is reported as a failure, the
 * reader taps the same control again, and a fresh id spends a second slot for one
 * intent. That is the defect `lib/operation-intent.ts` exists to close, and the id was
 * minted per call here until independent review of this tranche pointed at it.
 */
describe('a comment reaction whose answer was lost', () => {
  const reactionIds = () =>
    mockRpcCalls
      .filter((call) => call.name === 'set_comment_reaction')
      .map((call) => call.args.p_operation_id);

  const control = (view: Awaited<ReturnType<typeof open>>) =>
    view.getByLabelText(/^(React to|You reacted to)/);

  it('replays under the id the first attempt used', async () => {
    mockCommentRows = [comment()];
    // No code at all is what a dropped socket looks like through postgrest-js, and
    // `classifyWrite` calls that 'unknown' — the one outcome that holds the id.
    mockRpcError = { message: 'network request failed' };
    const view = await open();

    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(1));

    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(2));

    expect(reactionIds()[0]).toBeDefined();
    expect(reactionIds()[1]).toBe(reactionIds()[0]);
  });

  it('takes a fresh id once the server has answered', async () => {
    mockCommentRows = [comment()];
    mockRpcError = { message: 'network request failed' };
    const view = await open();

    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(1));

    // The server answers this time, which spends the claim — so the next intent must not
    // reuse it, or it would be met with `already_applied` and store nothing.
    mockRpcError = null;
    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(2));
    expect(reactionIds()[1]).toBe(reactionIds()[0]);

    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(3));
    expect(reactionIds()[2]).not.toBe(reactionIds()[0]);
  });

  /**
   * A different meaning is a different thing to say, so it is a different intent — the
   * key carries the kind for the reason `useSetReaction`'s does.
   */
  it('gives a different meaning an id of its own', async () => {
    mockCommentRows = [comment()];
    mockRpcError = { message: 'network request failed' };
    const view = await open();

    await fireEvent.press(control(view));
    await waitFor(() => expect(reactionIds()).toHaveLength(1));

    await act(async () => fireEvent(control(view), 'longPress'));
    await fireEvent.press(view.getByLabelText('Funny'));
    await waitFor(() => expect(reactionIds()).toHaveLength(2));

    expect(reactionIds()[1]).not.toBe(reactionIds()[0]);
  });
});
