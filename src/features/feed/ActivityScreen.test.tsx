import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Keyboard, ScrollView, StyleSheet, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';

/**
 * The dedicated comment-thread page (founder follow-up part A).
 *
 * A friend reported the app freezing after tapping a comment notification. The tap
 * routed to `/title/{id}`, a real and working screen that renders no comments — so
 * somebody told "Ada commented on your activity" arrived where the remark is invisible,
 * scrolled looking for it, and concluded the app had stopped.
 *
 * This asserts the three things that had to be true for the replacement to be an
 * improvement rather than a second dead end:
 *
 *   1. **The conversation is on the screen**, under the post it is about.
 *   2. **An unreachable activity is a sentence, not a blank.** Deleted, gone private, and
 *      blocked all produce the same one, deliberately — telling them apart would confirm
 *      the activity exists to somebody who is no longer allowed to know that.
 *   3. **Back always reaches the Feed**, including on a cold start from a notification
 *      tap, where there is nothing behind this screen to go back to.
 */

/**
 * **The keyboard, captured rather than simulated.**
 *
 * `Keyboard` is a `NativeEventEmitter` with no public way to emit, and there is no
 * native side under Jest. The screen subscribes through `useKeyboardHeight`, so the
 * test takes the listener the hook registered and calls it with the frame Android would
 * have sent — which is precisely what the emitter does with it.
 */
const mockKeyboard = new Map<string, (event: unknown) => void>();

const showKeyboard = async (height = 300) =>
  act(async () => {
    const listener =
      mockKeyboard.get('keyboardWillShow') ?? mockKeyboard.get('keyboardDidShow');
    if (!listener) throw new Error('the screen subscribed to no keyboard event');
    listener({ endCoordinates: { height } });
  });

const hideKeyboard = async () =>
  act(async () => {
    const listener =
      mockKeyboard.get('keyboardWillHide') ?? mockKeyboard.get('keyboardDidHide');
    if (!listener) throw new Error('the screen subscribed to no keyboard event');
    listener({});
  });

const mockNav = { pushed: [] as string[], replaced: [] as string[], back: 0, canGoBack: true };
let mockEvent: Record<string, unknown> | null = null;
let mockEventError = false;
let mockComments: Record<string, unknown>[] = [];

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'event-1' }),
  useRouter: () => ({
    push: (href: string) => mockNav.pushed.push(href),
    replace: (href: string) => mockNav.replaced.push(href),
    back: () => {
      mockNav.back += 1;
    },
    canGoBack: () => mockNav.canGoBack,
  }),
  useFocusEffect: () => {},
}));

const mockAuth = { status: 'ready' as string };

jest.mock('@/features/auth', () => ({
  useAuth: () => 
    mockAuth.status === 'ready'
      ? {
          status: 'ready',
          userId: 'viewer-1',
          profile: { id: 'viewer-1', username: 'sai', display_name: 'Sai', avatarUri: null },
        }
      : { status: mockAuth.status },
}));

jest.mock('@/features/collection/use-watched', () => ({
  useWatched: () => ({ data: new Set<string>() }),
  shouldMask: () => false,
}));

jest.mock('@/features/feed/use-feed', () => ({
  useActivityEvent: () => ({
    data: mockEvent,
    isPending: false,
    isError: mockEventError,
    refetch: jest.fn(),
  }),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    rpc: async (name: string) =>
      name === 'activity_comments'
        ? { data: mockComments, error: null }
        : { data: null, error: null },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));

import ActivityScreen from '../../../app/activity/[id]';

const event = (over: Record<string, unknown> = {}) => ({
  id: 'event-1',
  type: 'title_ranked',
  actorId: 'author-1',
  actorUsername: 'anna',
  actorName: 'Anna',
  actorAvatarUri: null,
  mediaItemId: 'media-1',
  kind: 'movie',
  title: 'Sinners',
  year: 2025,
  posterPath: null,
  genres: [],
  certification: null,
  runtimeMinutes: null,
  episodeCount: null,
  createdAt: new Date().toISOString(),
  position: 1,
  score: 9.4,
  bucket: 'loved',
  category: 'movies',
  note: null,
  companions: [],
  ...over,
});

const comment = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  parent_id: null,
  author_id: 'author-1',
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
  ...over,
});

beforeEach(() => {
  mockNav.pushed = [];
  mockNav.replaced = [];
  mockNav.back = 0;
  mockNav.canGoBack = true;
  mockEvent = event();
  mockEventError = false;
  mockComments = [];
  mockAuth.status = 'ready';
});

describe('the activity above the conversation', () => {
  it('draws the post the notification was about', async () => {
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());
    // The canonical feed card, not a reduced copy: a reader arriving from a notification
    // should recognise the post as the one they would have scrolled past.
    expect(view.getAllByLabelText(/Anna/).length).toBeGreaterThan(0);
  });

  /**
   * The whole point of the screen, and the thing the title page could not do.
   */
  it('shows the comment the notification was about, in context', async () => {
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
  });

  it('shows replies under the comment they answer', async () => {
    mockComments = [
      comment(),
      comment({ id: 'c2', parent_id: 'c1', body: 'Agreed', username: 'ben', display_name: 'Ben' }),
    ];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText('Agreed')).toBeTruthy());
    expect(view.getByText(/recontextualises/)).toBeTruthy();
  });

  it('draws a retracted comment as a place rather than as words', async () => {
    mockComments = [
      comment({ deleted_at: new Date().toISOString(), body: null }),
      comment({ id: 'c2', parent_id: 'c1', body: 'still here' }),
    ];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText('Comment deleted')).toBeTruthy());
    // The reply survives, which is the only reason the tombstone is drawn at all.
    expect(view.getByText('still here')).toBeTruthy();
    // And nothing attributes the retraction to anybody.
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });

  it('offers no comments button, because the comments are already here', async () => {
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
    // A control that scrolls you six points down the screen you are on is noise.
    expect(view.queryByLabelText(/comments/i)).toBeNull();
  });
});

describe('arriving before the session has resolved', () => {
  /**
   * The cold start, which is how this screen is *usually* reached: a tap on a
   * notification starts the process, and `getSession` is still in flight when the route
   * mounts.
   *
   * Every other protected screen opens with `useCurrentProfile()`, which throws outside a
   * ready session — correct for them, because they are reached from inside the app. Here
   * it would turn "not known yet" into a caught error, so this one waits instead.
   * Independent review 43 raised the cold-start path; this is the half of it that belongs
   * to the route.
   */
  it('waits rather than throwing', async () => {
    mockAuth.status = 'loading';
    const view = await renderWithProviders(<ActivityScreen />);

    expect(view.queryByText('This conversation is no longer available.')).toBeNull();
    expect(view.queryByLabelText(/Sinners/)).toBeNull();
  });

  it('renders the conversation once the session arrives', async () => {
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);

    // The ready case, asserted next to the loading one so the pair reads as a transition
    // rather than as two unrelated states.
    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());
  });
});

describe('an activity that is no longer reachable', () => {
  /**
   * Deleted, gone private, or blocked — one sentence for all three.
   *
   * `useActivityEvent` reads one `feed_events` row, so `feed_events_read` decides and
   * all three produce the same absence. Telling them apart would be the disclosure:
   * "you may not see this" confirms the activity exists on an account that has since
   * decided this reader should not know that.
   */
  it('says so, and does not blank', async () => {
    mockEvent = null;
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() =>
      expect(view.getByText('This conversation is no longer available.')).toBeTruthy(),
    );
    expect(view.getByText('Back to Feed')).toBeTruthy();
  });

  it('does not run the comment read for an activity it could not resolve', async () => {
    mockEvent = null;
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() =>
      expect(view.getByText('This conversation is no longer available.')).toBeTruthy(),
    );
    // The thread is not mounted at all, so a reader who may not see the activity is not
    // shown its conversation by a second query that happened to succeed.
    expect(view.queryByText(/recontextualises/)).toBeNull();
  });

  it('offers a retry when the read itself failed, which is a different thing', async () => {
    mockEvent = null;
    mockEventError = true;
    const view = await renderWithProviders(<ActivityScreen />);

    // A dropped connection is not a permission decision and must not be reported as one.
    await waitFor(() => expect(view.getByText('Could not load this')).toBeTruthy());
    expect(view.getByText('Try again')).toBeTruthy();
  });
});

describe('back', () => {
  it('pops when there is somewhere to pop to', async () => {
    mockEvent = null;
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText('Back to Feed')).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByText('Back to Feed'));
    });

    expect(mockNav.back).toBe(1);
    expect(mockNav.replaced).toEqual([]);
  });

  /**
   * The cold-start case, which is the one the founder named.
   *
   * A tap on a notification that launches the process pushes this onto a stack whose
   * only other entry is `/`, which renders nothing — so `back()` alone lands on a blank
   * screen and waits for `useAuthRouting` to notice. Going to the Feed explicitly when
   * there is no history is "Back should still produce a valid Feed state rather than
   * blank navigation".
   */
  it('goes to the Feed when there is no history behind it', async () => {
    mockNav.canGoBack = false;
    mockEvent = null;
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText('Back to Feed')).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByText('Back to Feed'));
    });

    expect(mockNav.back).toBe(0);
    expect(mockNav.replaced).toEqual(['/(tabs)/feed']);
  });
});

describe('leaving the conversation', () => {
  it('opens the author’s profile from a comment', async () => {
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());

    await act(async () => {
      // The avatar and the name are two controls with one label, deliberately: both open
      // the same profile, and a screen reader announcing them identically is correct.
      const [avatar] = view.getAllByLabelText("Anna's profile");
      fireEvent.press(avatar!);
    });

    expect(mockNav.pushed).toContain('/u/anna');
  });

  it('opens the title from the card', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByLabelText(/Sinners, 2025/));
    });

    expect(mockNav.pushed).toContain('/title/media-1');
  });
});

// ---------------------------------------------------------------------------

/**
 * **The keyboard must not cover the composer** (founder physical bug, Android).
 *
 * The Feed's comment *sheet* was already handled: `Sheet` measures the keyboard and
 * lifts. This screen is not a sheet — the composer is simply the last thing in a page
 * `ScrollView` — so under Android edge-to-edge, where the window never resizes and
 * `adjustResize` has nothing to adjust, the keyboard was drawn straight over it.
 *
 * Two assertions, because the fix is two things: room at the foot of the content, and
 * the scroll that puts the composer into what is left of the screen. And a third for
 * the way this kind of fix goes wrong — padding that is never given back.
 */
describe('the keyboard and the composer', () => {
  /**
   * The page's content container, walked up from the composer inside it.
   *
   * `contentContainerStyle` rather than `style`: that is the prop the room is declared
   * on, and it is the only one that scrolls with the content — padding on the scroll
   * view itself would shrink the viewport instead of extending what is inside it.
   * `Screen` declares a `paddingBottom` of its own further out, which is the
   * safe-area inset and a different thing entirely.
   */
  const contentPadding = (
    view: Awaited<ReturnType<typeof renderWithProviders>>,
    // The composer answers to "Add a comment" until Reply retargets it, at which point
    // it answers to the person being replied to. Both are the same box.
    composerLabel = 'Add a comment',
  ) => {
    let node: { parent: unknown; props: Record<string, unknown> } | null =
      view.getAllByLabelText(composerLabel).at(-1) ?? null;
    while (node) {
      const style = StyleSheet.flatten(node.props.contentContainerStyle) as ViewStyle | undefined;
      if (style) return style;
      node = node.parent as typeof node;
    }
    return null;
  };

  beforeEach(() => {
    // A comment to reply to, which the default fixture does not have.
    mockComments = [comment()];
    mockKeyboard.clear();
    jest
      .spyOn(Keyboard, 'addListener')
      .mockImplementation(((event: string, listener: (payload: unknown) => void) => {
        mockKeyboard.set(event, listener);
        return { remove: () => mockKeyboard.delete(event) };
      }) as never);
  });

  it('makes room under the content for the measured keyboard', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText('Add a comment')).toBeTruthy());

    const before = contentPadding(view)?.paddingBottom;
    await showKeyboard(300);

    // Measured, never assumed: the hook is handed the frame and this is that number.
    expect(contentPadding(view)?.paddingBottom).toBe(300);
    expect(before).not.toBe(300);
  });

  it('scrolls the composer into what is left of the screen', async () => {
    /**
     * Room alone is not enough — the page can be scrolled anywhere when the keyboard
     * arrives, and padding under content the reader is not looking at shows them
     * nothing. The composer is the last thing on the page, so "scroll to the end" *is*
     * "show me what I am typing", for a new comment and for a reply alike.
     */
    const scrollToEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd');
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText('Add a comment')).toBeTruthy());
    scrollToEnd.mockClear();

    await showKeyboard(300);
    expect(scrollToEnd).toHaveBeenCalled();
  });

  it('gives the room back when the keyboard goes down', async () => {
    // No permanent strip of whitespace under the conversation, which is the way a
    // padding-based fix usually fails.
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText('Add a comment')).toBeTruthy());

    const resting = contentPadding(view)?.paddingBottom;
    await showKeyboard(300);
    await hideKeyboard();

    expect(contentPadding(view)?.paddingBottom).toBe(resting);
  });

  it('keeps replying to a comment on the same composer', async () => {
    // The reply banner and the box are one control, so a reply is covered by exactly
    // the same fix — and this is the assertion that says so rather than assuming it.
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText('Add a comment')).toBeTruthy());

    await act(async () => {
      fireEvent.press(view.getByLabelText('Reply to Anna'));
    });
    // Two controls answer to that sentence once the reply is open — the row's button
    // and the composer it retargeted — which is itself the evidence that a reply uses
    // the same box, and so is covered by the same fix.
    expect(view.getAllByLabelText('Reply to Anna')).toHaveLength(2);
    expect(view.getByText('Replying to Anna')).toBeTruthy();

    await showKeyboard(300);
    expect(contentPadding(view, 'Reply to Anna')?.paddingBottom).toBe(300);
  });
});
