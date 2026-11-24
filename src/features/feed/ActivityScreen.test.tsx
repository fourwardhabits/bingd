import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { Keyboard, ScrollView, StyleSheet, TextInput, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { theme } from '@/ui/tokens';

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
let mockGroupTitles: Record<string, unknown>[] = [];
/** The route's search params: `id`, and `comment` or `notification` from a notification tap. */
let mockParams: Record<string, string> = { id: 'event-1' };
/** What `my_notifications` answers, for a push tap that names only its notification. */
let mockInbox: Record<string, unknown>[] = [];
/** How many times the inbox was read, and what the first read answers if not `mockInbox`. */
let mockInboxReads = 0;
/** The comment writes the page sent. */
const mockWrites: { name: string; args: Record<string, unknown> }[] = [];
let mockFirstInbox: Record<string, unknown>[] | null = null;

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
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
    rpc: async (name: string, args: Record<string, unknown> = {}) =>
      ['add_comment', 'edit_comment', 'delete_comment'].includes(name)
        ? (mockWrites.push({ name, args }), { data: { status: 'ok' }, error: null })
        : name === 'activity_comments'
          ? { data: mockComments, error: null }
          : name === 'watchlist_group_titles'
            ? { data: mockGroupTitles, error: null }
            : name === 'my_notifications'
              ? {
                  data:
                    (mockInboxReads += 1) === 1 && mockFirstInbox ? mockFirstInbox : mockInbox,
                  error: null,
                }
              : { data: null, error: null },
  },
  startSessionRefresh: () => () => {},
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));

/**
 * **Reactions, mocked at the shared hook rather than at the table.**
 *
 * The point of the 2026-08-29 change is that this screen reads reactions through exactly
 * the hook the Feed reads them through, so the seam worth faking is that hook — a fake
 * `from('reactions')` would prove only that a query was shaped, not that the canonical
 * summary reaches the canonical control. `REACTION_GLYPH` and `DEFAULT_REACTION` stay
 * real, so the glyphs asserted below are the ones the product draws.
 */
const mockReactions = {
  /** The summary the shared hook resolves to, or null for an activity with none. */
  summary: null as Record<string, unknown> | null,
  /** Which event ids the screen actually asked about, most recent call last. */
  askedAbout: [] as string[][],
  /** Every `setReaction(eventId, kind)` the screen made. */
  set: [] as [string, string | null][],
  /** Whether the read has landed. A `Map` with no entry cannot say this by itself. */
  settled: true,
  failed: false,
  /** What `setReaction` answers. */
  result: { ok: true } as Record<string, unknown>,
};

jest.mock('@/features/feed/use-reactions', () => {
  const actual = jest.requireActual('@/features/feed/use-reactions');
  return {
    ...actual,
    useReactions: (ids: string[]) => {
      mockReactions.askedAbout.push(ids);
      const data = new Map<string, unknown>();
      if (ids[0] && mockReactions.summary) data.set(ids[0], mockReactions.summary);
      return {
        data,
        isSuccess: mockReactions.settled && !mockReactions.failed,
        isError: mockReactions.failed,
        isPending: !mockReactions.settled,
        refetch: jest.fn(),
      };
    },
    useSetReaction: () => ({
      setReaction: async (eventId: string, kind: string | null) => {
        mockReactions.set.push([eventId, kind]);
        return mockReactions.result;
      },
    }),
  };
});

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
  mockGroupTitles = [];
  mockParams = { id: 'event-1' };
  mockInbox = [];
  mockInboxReads = 0;
  mockFirstInbox = null;
  mockWrites.length = 0;
  mockAuth.status = 'ready';
  mockReactions.summary = null;
  mockReactions.askedAbout = [];
  mockReactions.set = [];
  mockReactions.settled = true;
  mockReactions.failed = false;
  mockReactions.result = { ok: true };
});

/**
 * **The post's reactions, which this screen used not to show at all** (founder,
 * 2026-08-29).
 *
 * The founder opened a comment notification, looked at the post above the thread and
 * could not find reactions they knew were on it. The cause was not caching and not a
 * false zero: the screen fetched no reaction data and rendered no control, deliberately,
 * alongside the comment, watchlist and recommend controls it still omits.
 *
 * These pin the parity that replaced it — same hook, same control, same grammar — and
 * the omissions that survive it.
 */
describe('the reactions on the post above the conversation', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    total: 6,
    mine: null,
    kinds: ['love', 'mind_blown'],
    byKind: { love: 5, mind_blown: 1 },
    people: [],
    ...over,
  });

  it('asks about the activity on screen, and about nothing else', async () => {
    mockReactions.summary = summary();
    await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(mockReactions.askedAbout.at(-1)).toEqual(['event-1']));
  });

  it('shows the count the shared summary carries, not one it worked out', async () => {
    mockReactions.summary = summary({ total: 6 });
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText('6 reactions')).toBeTruthy());
  });

  /**
   * **The post is the Feed's card without its action row** (founder, 2026-11-23): the
   * discussion and the composer are this page's actions, so Like · Comment · Share is not
   * repeated above the thread. What a reaction *is* stays — the summary, and who reacted —
   * read from the same shared summary the Feed reads.
   */
  it('shows who reacted to the post, and opens them, with only a Like', async () => {
    mockReactions.summary = summary({
      total: 1,
      kinds: ['love'],
      byKind: { love: 1 },
      people: [
        {
          userId: 'priya',
          username: 'priya',
          name: 'Priya Raman',
          avatarUri: null,
          kind: 'love',
        },
      ],
    });
    const view = await renderWithProviders(<ActivityScreen />);

    const who = await waitFor(() =>
      view.getByLabelText('Priya Raman likes this. See who reacted.'),
    );
    // The Like alone (2026-11-24): no Comment, no Share above the conversation.
    expect(view.getByLabelText(/^React to Anna's activity/)).toBeTruthy();
    expect(view.queryByLabelText(/^Share/)).toBeNull();
    expect(view.queryByTestId('feed-card-comment')).toBeNull();

    await act(async () => {
      fireEvent.press(who as never);
    });
    await waitFor(() => expect(view.getAllByText('Priya Raman').length).toBeGreaterThan(0));
  });

  it('counts and names the viewer’s own reaction to their own post', async () => {
    mockEvent = event({
      actorId: 'viewer-1',
      actorUsername: 'sai',
      actorName: 'Sai',
      title: 'Logan',
      year: 2017,
    });
    mockReactions.summary = summary({
      total: 2,
      mine: 'love',
      kinds: ['love'],
      byKind: { love: 2 },
      people: [
        { userId: 'viewer-1', username: 'sai', name: 'Sai', avatarUri: null, kind: 'love' },
        {
          userId: 'priya',
          username: 'priya',
          name: 'Priya Raman',
          avatarUri: null,
          kind: 'love',
        },
      ],
    });
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() =>
      expect(
        view.getByLabelText('You and Priya Raman like this. See who reacted.'),
      ).toBeTruthy(),
    );
  });

  /**
   * **A reaction from the conversation** (founder, 2026-11-24): the Feed's own Like — the
   * same hook, mutation and picker — so the count here and on the Feed are one number.
   */
  it('likes the post on a tap, and takes it back on the next', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    const like = await waitFor(() => view.getByLabelText(/^React to Anna's activity/));
    fireEvent.press(like as never);
    await waitFor(() => expect(mockReactions.set).toEqual([['event-1', 'love']]));

    mockReactions.set = [];
    mockReactions.summary = summary({ mine: 'love' });
    const again = await renderWithProviders(<ActivityScreen />);
    const liked = await waitFor(() => again.getByLabelText(/^Liked\. You reacted to Sinners/));
    fireEvent.press(liked as never);
    await waitFor(() => expect(mockReactions.set).toEqual([['event-1', null]]));
  });

  it('changes the reaction from the picker on a long press', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    const like = await waitFor(() => view.getByLabelText(/^React to Anna's activity/));
    fireEvent(like as never, 'longPress');
    await waitFor(() => expect(view.getByLabelText('Liked')).toBeTruthy());
  });

  it('offers the Like on the reader’s own post too', async () => {
    mockEvent = event({ actorId: 'viewer-1', actorUsername: 'sai', actorName: 'Sai' });
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText(/^React to Sai's activity/)).toBeTruthy());
  });

  it('stays quiet on an activity nobody has reacted to', async () => {
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());
    expect(view.queryByText(/reaction/)).toBeNull();
    expect(view.queryByLabelText(/See who reacted/)).toBeNull();
  });

  /**
   * An award or goal keeps the compact row, exactly as the Feed draws it — and with it the
   * row's own reaction control, which is not the card's action row.
   */
  it('keeps the compact row, and its reaction, for an award', async () => {
    mockEvent = event({
      type: 'award_earned',
      mediaItemId: null,
      title: 'Comment Gremlin',
      award: {
        key: 'comment-gremlin',
        tierKey: 'whisper',
        title: 'Whisper',
        achievement: 'Wrote 20 comments',
      },
    });
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText('Wrote 20 comments')).toBeTruthy());
    expect(view.queryByTestId('feed-card')).toBeNull();
    fireEvent.press(view.getByLabelText(/^React to Anna's activity/) as never);
    await waitFor(() => expect(mockReactions.set).toEqual([['event-1', 'love']]));
  });

  /**
   * An activity the viewer may not see resolves to no row at all, so there is nothing to
   * ask about — a hidden post is never probed for the reactions `reactions_read` would
   * refuse anyway.
   */
  it('asks for nothing when the activity itself is unavailable', async () => {
    mockEvent = null;
    await renderWithProviders(<ActivityScreen />);

    await waitFor(() =>
      expect(mockReactions.askedAbout.every((ids) => ids.length === 0)).toBe(true),
    );
  });

  /**
   * **A read that has not landed is not a zero** (Codex review of 2026-08-29).
   *
   * `useReactions` resolves to a `Map`, and an activity nobody has reacted to is simply
   * absent from it — so "no entry" means either nobody reacted or nobody has looked.
   * Collapsing the two drew a confident `0` on a post the Feed was showing with six, and
   * a timed-out request kept drawing it while the detail sheet opened empty against it.
   *
   * So the control appears only once the query has settled. Absent is honest; wrong is
   * not, and the row is still the sentence and the face it always was.
   */
  it('draws no reaction control while the read is still in flight', async () => {
    mockReactions.settled = false;
    mockReactions.summary = summary({ total: 6 });
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());
    expect(view.queryByLabelText(/^React to Anna's activity/)).toBeNull();
    expect(view.queryByLabelText(/You reacted to Sinners/)).toBeNull();
    // And above all: no count claimed.
    expect(view.queryByText('0')).toBeNull();
  });

  it('draws no reaction control when the read failed, rather than a zero', async () => {
    mockReactions.settled = true;
    mockReactions.failed = true;
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());
    expect(view.queryByLabelText(/^React to Anna's activity/)).toBeNull();
    expect(view.queryByText('0')).toBeNull();
  });

  /** The three controls that were omitted with reactions and stay omitted. */
  it('still offers no comments, watchlist or recommend control', async () => {
    mockReactions.summary = summary();
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());
    expect(view.queryByLabelText(/watchlist/i)).toBeNull();
    expect(view.queryByLabelText(/Recommend/i)).toBeNull();
    expect(view.queryByLabelText(/comments on/i)).toBeNull();
  });
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
      comment({
        id: 'c2',
        parent_id: 'c1',
        body: 'Agreed',
        username: 'ben',
        display_name: 'Ben',
      }),
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

/**
 * **One rule between the post and the conversation, and no band of empty page.**
 *
 * The founder's physical report, 2026-08-30: "a small bar of empty space between the
 * activity and the comments", opening a comment notification. It reproduced from the
 * direct Feed tap as well, which is the fact that named the cause -- both routes render
 * this one subtree, so it was never route-specific and never a loading state.
 *
 * It was two rules with a gap trapped between them. `ActivityRow` ends in a
 * `borderBottomWidth` of its own -- the separator the Feed draws between cards -- and
 * this screen added a second `View` with a `borderTopWidth` and `marginTop` beneath it.
 * The removed one is the second; the row's own is the legitimate divider and stays.
 *
 * Asserted structurally rather than by measuring a gap. A pixel assertion would pass on
 * a rewrite that reintroduced the strip with different numbers, and it would fail on an
 * unrelated spacing change that was fine; what has to stay true is that **nothing sits
 * between the post and the thread**, which is a fact about the tree.
 */
describe('the seam between the post and the conversation', () => {
  /**
   * Every element in the tree, flat, with its resolved style.
   *
   * `toJSON` rather than a query, because what is being looked for is a view nothing
   * can address: the removed spacer had no text, no label and no role. A findable
   * element is not the failure mode.
   */
  const nodes = (tree: unknown): { style: ViewStyle; children: unknown[] }[] => {
    const out: { style: ViewStyle; children: unknown[] }[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const element = node as { props?: Record<string, unknown>; children?: unknown[] };
      // The post's own card is the Feed's component, styled by the Feed; the seam is what
      // lies between it and the thread, so its insides are not this test's business.
      if (element.props?.testID === 'feed-card') return;
      out.push({
        style: (StyleSheet.flatten(element.props?.style) ?? {}) as ViewStyle,
        children: element.children ?? [],
      });
      (element.children ?? []).forEach(walk);
    };
    walk(tree);
    return out;
  };

  it('draws no empty ruled strip anywhere on the page', async () => {
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());

    // The exact signature of what was removed: a childless box whose only content is a
    // border. Nothing else in this screen is drawn that way, and nothing should be --
    // a separator belongs to the row it separates, which is where `ActivityRow` keeps
    // its own.
    const strips = nodes(view.toJSON()).filter(
      (n) => n.children.length === 0 && Number(n.style.borderTopWidth ?? 0) > 0,
    );
    expect(strips).toEqual([]);
  });

  it('keeps the post own bottom rule, which is the divider that belongs there', async () => {
    // The fix must not have been "delete the line". The canonical feed card carries its
    // own separator and this screen draws the canonical card, so the seam is still a
    // rule -- it is simply one rule instead of two with a gap between them.
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());

    // Since 2026-11-23 the post is the Feed's card, whose outline closes it.
    const ruled = nodes(view.toJSON()).filter(
      (n) =>
        Number(n.style.borderBottomWidth ?? n.style.borderWidth ?? 0) > 0 &&
        n.children.length > 0,
    );
    expect(ruled.length).toBeGreaterThan(0);
  });

  it('reads the same with no comments on the activity at all', async () => {
    // The empty case is where a reserved container would show: a thread with nothing in
    // it draws an empty state, and a screen that held space open for a list it does not
    // have would look exactly like the founder's bar.
    mockComments = [];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByLabelText(/Sinners, 2025/)).toBeTruthy());

    const strips = nodes(view.toJSON()).filter(
      (n) => n.children.length === 0 && Number(n.style.borderTopWidth ?? 0) > 0,
    );
    expect(strips).toEqual([]);
  });

  it('uses no negative margin to close the gap', async () => {
    // The other way this could have been "fixed". A negative margin pulls the thread up
    // over the rule rather than removing the thing that opened the gap, and it breaks
    // the moment the row's padding changes.
    mockComments = [comment()];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/recontextualises/)).toBeTruthy());

    for (const { style } of nodes(view.toJSON())) {
      for (const key of ['margin', 'marginTop', 'marginBottom', 'marginVertical'] as const) {
        const value = style[key];
        if (typeof value === 'number') expect(value).toBeGreaterThanOrEqual(0);
      }
    }
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
      const style = StyleSheet.flatten(node.props.contentContainerStyle) as
        ViewStyle | undefined;
      if (style) return style;
      node = node.parent as typeof node;
    }
    return null;
  };

  beforeEach(() => {
    // A comment to reply to, which the default fixture does not have.
    mockComments = [comment()];
    mockKeyboard.clear();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((
      event: string,
      listener: (payload: unknown) => void,
    ) => {
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
    /**
     * **The composer is not the anchor, and this test is where that mattered.**
     *
     * It waited on "Add a comment", which is on screen from the first paint — the box
     * exists before the conversation does. So the press below could land while the list
     * still said "Loading comments…", and there was no Reply button to press. It passed
     * on a quiet machine and failed in the release gate, which is exactly the shape
     * `CommentSheet.test.tsx`'s header describes: a `waitFor` that is satisfied by
     * something present during loading has waited for nothing.
     *
     * The loading copy is the one signal that means the rows are in, and it covers the
     * error and empty states too — the list is replaced wholesale there and the copy goes
     * with it.
     */
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
    expect(view.getByLabelText('Add a comment')).toBeTruthy();

    await act(async () => {
      fireEvent.press(view.getByLabelText('Reply to Anna'));
    });
    // The composer the reply retargeted, under its reply-mode name — the row's button
    // says "Reply to Anna", the box says whose reply it holds. One box, so a reply is
    // covered by exactly the same fix.
    expect(view.getByLabelText('Your reply to Anna')).toBeTruthy();
    expect(view.getByText(/^Replying to Anna/)).toBeTruthy();

    await showKeyboard(300);
    expect(contentPadding(view, 'Your reply to Anna')?.paddingBottom).toBe(300);
    // And the keyboard took nothing from the reply: still a reply, still to Anna.
    expect(view.getByText(/^Replying to Anna/)).toBeTruthy();
  });
});

/**
 * **A grouped watchlist post, reached from a comment notification** (20261125000100).
 * The page draws the post the Feed draws: the same sentence and count, the same members,
 * and the conversation below is the post's own, never a member's.
 */
describe('a grouped watchlist post above the conversation', () => {
  it('reads "and 2 others", opens the members, and a member opens its title', async () => {
    mockEvent = event({
      type: 'watchlist_added',
      title: 'Dune',
      year: 2021,
      watchlistCount: 3,
      position: null,
      score: null,
      bucket: null,
      category: null,
    });
    mockGroupTitles = [
      { media_item_id: 'media-1', kind: 'movie', title: 'Dune', release_date: '2021-10-22' },
      { media_item_id: 'arrival', kind: 'movie', title: 'Arrival', release_date: '2016-11-11' },
      { media_item_id: 'enemy', kind: 'movie', title: 'Enemy', release_date: '2013-09-08' },
    ];
    const view = await renderWithProviders(<ActivityScreen />);

    fireEvent.press(await waitFor(() => view.getByText('2 others')));
    await waitFor(() => expect(view.getByTestId('watchlist-group-rows')).toBeTruthy());
    fireEvent.press(view.getByLabelText('Arrival, 2016'));
    expect(mockNav.pushed).toContain('/title/arrival');
  });

  it('draws a single-title or legacy post with no count at all', async () => {
    mockEvent = event({ type: 'watchlist_added', title: 'Dune', watchlistCount: null });
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/to their watchlist/)).toBeTruthy());
    expect(view.queryByText(/\bothers?\b/)).toBeNull();
  });
});

/**
 * **Arriving at one comment** (2026-11-22). A comment, reply or mention notification opens
 * this page with `?comment=` (an inbox row) or `?notification=` (a push, which carries no
 * comment id), and the page scrolls to that comment's thread and marks it — without
 * starting a reply. Older links carry neither and open the conversation as before.
 */
describe('a notification that names one comment', () => {
  /**
   * Anna's root (the post's author), then Bo's root, then Cy's reply to Bo — the reply a
   * "Cy replied to your comment" notification is about. The viewer is Sai, who is Bo for
   * the purposes of the story: the person being answered.
   */
  const thread = () => [
    comment({ id: 'c1', created_at: new Date(Date.now() - 60 * 60_000).toISOString() }),
    comment({
      id: 'c2',
      author_id: 'bo-id',
      username: 'bo',
      display_name: 'Bo',
      body: 'A later remark',
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    }),
    comment({
      id: 'c3',
      parent_id: 'c2',
      author_id: 'cy-id',
      username: 'cy',
      display_name: 'Cy',
      body: 'Cy answers Bo',
      created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    }),
  ];
  const layout = (y: number) => ({
    nativeEvent: { layout: { x: 0, y, width: 320, height: 80 } },
  });
  const marked = (view: Awaited<ReturnType<typeof renderWithProviders>>, id: string) =>
    (StyleSheet.flatten(view.getByTestId(`comment-row-${id}`).props.style) as ViewStyle)
      .backgroundColor !== undefined;
  const inboxRow = (payload: Record<string, unknown>) => ({
    id: 'n-1',
    kind: 'comment',
    created_at: new Date().toISOString(),
    read_at: null,
    actor_id: 'cy-id',
    actor_username: 'cy',
    actor_display_name: 'Cy',
    actor_avatar_path: null,
    media_item_id: null,
    media_title: null,
    media_kind: null,
    series_title: null,
    subject_type: 'feed_event',
    subject_id: 'event-1',
    payload,
  });

  beforeEach(() => {
    mockComments = thread();
  });

  it('opens at the comment (?comment=), in reply mode to its author, with no keyboard', async () => {
    mockParams = { id: 'event-1', comment: 'c3' };
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    focus.mockClear();
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
    scrollTo.mockClear();

    // Only the conversation the notification is about, and the way to the rest.
    expect(view.queryByTestId('comment-thread-c1')).toBeNull();
    expect(view.getByTestId('comment-thread-c2')).toBeTruthy();
    expect(view.getByText('See all 3 comments')).toBeTruthy();
    expect(marked(view, 'c3')).toBe(true);

    // Reply mode, to Cy, in Bo's thread — without opening the keyboard.
    expect(view.getByText('Replying to Cy')).toBeTruthy();
    expect(view.getByLabelText('Your reply to Cy').props.placeholder).toBe('Reply to Cy…');
    expect(view.getByRole('button', { name: 'Reply' })).toBeTruthy();
    // The focus mock is shared by every native component, so ask which one was focused.
    expect(
      focus.mock.contexts.some((c) => (c as TextInput | undefined)?.props?.placeholder),
    ).toBe(false);
    focus.mockRestore();

    // Brought into view past the post: the top of the focused conversation.
    await fireEvent(view.getByTestId('comment-thread-c2').parent!, 'layout', layout(500));
    await fireEvent(view.getByTestId('comment-thread-c2'), 'layout', layout(40));
    await fireEvent(view.getByTestId('comment-replies-c2'), 'layout', layout(90));
    await fireEvent(view.getByTestId('comment-row-c3').parent!, 'layout', layout(0));
    expect(scrollTo).toHaveBeenCalledWith({ y: 500 - theme.space[2], animated: true });
  });

  it('posts what is typed there as a reply in that thread, to the comment notified about', async () => {
    mockParams = { id: 'event-1', comment: 'c3' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());

    await fireEvent.changeText(view.getByLabelText('Your reply to Cy'), 'Thanks Cy');
    await fireEvent.press(view.getByRole('button', { name: 'Reply' }));

    await waitFor(() =>
      expect(mockWrites.filter((w) => w.name === 'add_comment')).toHaveLength(1),
    );
    // The comment tapped-through-to: the server attaches it to Bo's root and notifies Cy.
    expect(mockWrites.find((w) => w.name === 'add_comment')!.args).toMatchObject({
      p_parent_id: 'c3',
      p_body: 'Thanks Cy',
    });
  });

  it('expands to every conversation in place, keeping the reply and the draft', async () => {
    mockParams = { id: 'event-1', comment: 'c3' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());
    await fireEvent.changeText(view.getByLabelText('Your reply to Cy'), 'half a thought');

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'See all 3 comments' }));
    });
    expect(view.getAllByTestId(/^comment-thread-/).map((n) => n.props.testID)).toEqual([
      'comment-thread-c1',
      'comment-thread-c2',
    ]);
    expect(view.getByText(/^Replying to Cy/)).toBeTruthy();
    expect(view.getByDisplayValue('half a thought')).toBeTruthy();

    // And back again, still the same reply.
    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: 'Show only this conversation' }));
    });
    expect(view.queryByTestId('comment-thread-c1')).toBeNull();
    expect(view.getByDisplayValue('half a thought')).toBeTruthy();
  });

  it('targets the root’s author for a notification about a root', async () => {
    mockParams = { id: 'event-1', comment: 'c2' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText('Replying to Bo')).toBeTruthy());
  });

  it('opens in reply mode from a push (?notification=), found in the inbox', async () => {
    mockParams = { id: 'event-1', notification: 'n-1' };
    mockInbox = [inboxRow({ comment_id: 'c3', reply_to: 'c2' })];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(marked(view, 'c3')).toBe(true));
    expect(view.getByText('Replying to Cy')).toBeTruthy();
  });

  it('opens in reply mode from a mention', async () => {
    mockParams = { id: 'event-1', notification: 'n-1' };
    mockInbox = [{ ...inboxRow({ comment_id: 'c3', reply: true }), kind: 'mention' }];
    const view = await renderWithProviders(<ActivityScreen />);

    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());
  });

  it('opens the whole conversation when a new top-level comment is posted from it', async () => {
    // Codex review, PR #374: a new root is a thread the focused view would not show.
    mockParams = { id: 'event-1', comment: 'c3' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Cancel reply to Cy' }));
    await fireEvent.changeText(view.getByLabelText('Add a comment'), 'A thought of my own');
    await fireEvent.press(view.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(view.getByTestId('comment-thread-c1')).toBeTruthy());
    expect(mockWrites.find((w) => w.name === 'add_comment')!.args.p_parent_id).toBeNull();
    expect(view.getByRole('button', { name: 'Show only this conversation' })).toBeTruthy();
  });

  it('stays on Add a comment once the reader cancels, through a refetch', async () => {
    mockParams = { id: 'event-1', comment: 'c3' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());

    await fireEvent.press(view.getByRole('button', { name: 'Cancel reply to Cy' }));
    expect(view.getByLabelText('Add a comment')).toBeTruthy();
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });
    expect(view.getByLabelText('Add a comment')).toBeTruthy();
    expect(view.queryByText(/^Replying to/)).toBeNull();
  });

  it('keeps the reply through a refetch of the conversation', async () => {
    mockParams = { id: 'event-1', comment: 'c3' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.getByText(/^Replying to Cy/)).toBeTruthy());
    await fireEvent.changeText(view.getByLabelText('Your reply to Cy'), 'still going');

    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['comments'] });
    });
    expect(view.getByText(/^Replying to Cy/)).toBeTruthy();
    expect(view.getByDisplayValue('still going')).toBeTruthy();
  });

  it('leaves the composer on Add a comment for the reader’s own comment or a retracted one', async () => {
    mockComments = thread().map((row) =>
      row.id === 'c3' ? { ...row, author_id: 'viewer-1', display_name: 'Sai' } : row,
    );
    mockParams = { id: 'event-1', comment: 'c3' };
    const own = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(marked(own, 'c3')).toBe(true));
    expect(own.getByLabelText('Add a comment')).toBeTruthy();
    await own.unmount();

    mockComments = [
      ...thread().map((row) =>
        row.id === 'c2' ? { ...row, body: null, deleted_at: new Date().toISOString() } : row,
      ),
    ];
    mockParams = { id: 'event-1', comment: 'c2' };
    const gone = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(gone.getByText('Comment deleted')).toBeTruthy());
    expect(gone.getByLabelText('Add a comment')).toBeTruthy();
  });

  it('opens normally — the whole conversation, Add a comment — with no notification', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());

    expect(view.getAllByTestId(/^comment-thread-/)).toHaveLength(2);
    expect(view.queryByText(/^See all/)).toBeNull();
    expect(view.getByLabelText('Add a comment')).toBeTruthy();
    expect(view.queryByText(/^Replying to/)).toBeNull();
  });

  it('asks the inbox again when a fresh cache predates the push', async () => {
    // Codex review, PR #365: an inbox read just before the notification was written is
    // inside its staleTime and cannot hold the row. Missing from a successful read means
    // one more read, not "unavailable".
    mockParams = { id: 'event-1', notification: 'n-1' };
    mockFirstInbox = [];
    mockInbox = [
      {
        id: 'n-1',
        kind: 'comment',
        created_at: new Date().toISOString(),
        read_at: null,
        actor_id: 'bo-id',
        actor_username: 'bo',
        actor_display_name: 'Bo',
        actor_avatar_path: null,
        media_item_id: null,
        media_title: null,
        media_kind: null,
        series_title: null,
        subject_type: 'feed_event',
        subject_id: 'event-1',
        payload: { comment_id: 'c3' },
      },
    ];
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());

    await waitFor(() => expect(marked(view, 'c3')).toBe(true));
    expect(mockInboxReads).toBe(2);
    expect(view.getByText(/^Replying to Cy/)).toBeTruthy();
  });

  it('opens the activity as before when the push names a notification it cannot find', async () => {
    mockParams = { id: 'event-1', notification: 'n-unknown' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());

    expect(view.getByLabelText('Sinners, 2025')).toBeTruthy();
    expect(marked(view, 'c3')).toBe(false);
    expect(view.getByLabelText('Add a comment')).toBeTruthy();
    // Asked once more, and only once: no loop for a row that is genuinely not there.
    await waitFor(() => expect(mockInboxReads).toBe(2));
    expect(view.queryByText('That comment is no longer available.')).toBeNull();
  });

  it('says the comment is gone, and still shows the conversation, for a deleted target', async () => {
    mockParams = { id: 'event-1', comment: 'gone' };
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());

    expect(view.getByText('That comment is no longer available.')).toBeTruthy();
    expect(view.getByText('A later remark')).toBeTruthy();
  });

  it('lists the threads oldest first, whatever order the server sent', async () => {
    mockComments = [...thread()].reverse();
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());

    expect(view.getAllByTestId(/^comment-thread-/).map((n) => n.props.testID)).toEqual([
      'comment-thread-c1',
      'comment-thread-c2',
    ]);
  });
});

/**
 * **A failed background refetch of the post must not take the composer with it.** It
 * used to: `activity.isError` replaced the page while the post was still held, so a reply
 * in progress — target and words — was unmounted by one dropped request.
 */
describe('a reply in progress on the page', () => {
  beforeEach(() => {
    mockComments = [comment()];
  });

  it('survives a refetch of the post that fails while the post is still held', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
    await act(async () => {
      fireEvent.press(view.getByLabelText('Reply to Anna'));
    });
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'half a thought');

    mockEventError = true;
    await view.rerender(<ActivityScreen />);

    expect(view.queryByText('Could not load this')).toBeNull();
    expect(view.getByText(/^Replying to Anna/)).toBeTruthy();
    expect(view.getByDisplayValue('half a thought')).toBeTruthy();
  });

  it('is kept while the reader visits a profile and comes back (the screen stays mounted)', async () => {
    const view = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(view.queryByText('Loading comments…')).toBeNull());
    await act(async () => {
      fireEvent.press(view.getByLabelText('Reply to Anna'));
    });
    await fireEvent.changeText(view.getByLabelText('Your reply to Anna'), 'still mine');

    await act(async () => {
      // The comment's author, not the post's (both are Anna here).
      fireEvent.press(view.getAllByLabelText("Anna's profile").at(-1)!);
    });
    expect(mockNav.pushed).toContain('/u/anna');
    // The stack keeps this screen; the reply is still visibly a reply to Anna.
    expect(view.getByText(/^Replying to Anna/)).toBeTruthy();
    expect(view.getByDisplayValue('still mine')).toBeTruthy();
  });

  it('is gone after leaving the conversation and opening it again: no stale target', async () => {
    const first = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(first.queryByText('Loading comments…')).toBeNull());
    await act(async () => {
      fireEvent.press(first.getByLabelText('Reply to Anna'));
    });
    await fireEvent.changeText(first.getByLabelText('Your reply to Anna'), 'abandoned');
    await first.unmount();

    const again = await renderWithProviders(<ActivityScreen />);
    await waitFor(() => expect(again.queryByText('Loading comments…')).toBeNull());
    expect(again.getByLabelText('Add a comment').props.value).toBe('');
    expect(again.queryByText(/^Replying to/)).toBeNull();
  });
});
