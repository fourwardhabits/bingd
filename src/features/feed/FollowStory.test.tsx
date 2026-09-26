import { fireEvent, waitFor } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { renderWithProviders } from '@/test-utils/render';
import { ActivityRow } from '@/ui/components';

import { followTail } from './activity';
import { FollowStoryRow } from './FollowStoryRow';
import { FollowStorySheet } from './FollowStorySheet';
import type { FeedItem, FollowedPerson } from './use-feed';

/**
 * Follow activity, on the client (founder §§A9–A14, `20260912000100`).
 *
 * **What is deliberately not here.** Every rule about *who* a story may name — the
 * `can_identify_profile` filter, the block and suspension exclusions, the caller's own
 * exclusion, the actor gate — lives in `follow_activity_people` and is asserted against real
 * policies in `supabase/tests/follow-activity.test.mjs`. A client test about privacy would
 * pass against a server that had stopped enforcing it, which is the worst kind of green.
 *
 * What is asserted here is what only the client can get wrong: the sentence, whose count is
 * in it, which taps go where, and that a story of one is not a modal waiting to open.
 */

const mockRpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let mockRpcResults: Record<string, unknown> = {};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: mockRpcResults[name] ?? [], error: null });
    },
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'operation-id' }));

beforeEach(() => {
  mockRpcCalls.length = 0;
  mockRpcResults = {};
});

const person = (name: string, over: Partial<FollowedPerson> = {}): FollowedPerson => ({
  id: `${name.toLowerCase()}-id`,
  username: name.toLowerCase(),
  name,
  avatarUri: null,
  isPrivate: false,
  ...over,
});

/**
 * A follow story, with only the fields either component reads.
 *
 * Cast rather than spelled out in full: `FeedItem` carries twenty fields about titles, and a
 * fixture that filled them all in with nulls would suggest a follow story has a poster, a
 * score and a note. It does not, and the cast is the honest statement of that.
 */
const story = (followed: FollowedPerson[], over: Partial<FeedItem> = {}): FeedItem =>
  ({
    id: 'story-1',
    type: 'follow_added',
    actorId: 'abi-id',
    actorUsername: 'abi',
    actorName: 'Abi',
    actorAvatarUri: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    followed,
    ...over,
  }) as FeedItem;

describe('the sentence', () => {
  it('names one person and adds no tail', async () => {
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText('Abi')).toBeTruthy();
    expect(view.getByText('Ravi')).toBeTruthy();
    expect(view.queryByText(/other/)).toBeNull();
    // The row's second line is the time and nothing else.
    expect(view.getByText('5m ago')).toBeTruthy();
  });

  it('names the first and counts the rest', async () => {
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi'), person('Ben'), person('Cy'), person('Di'), person('Eve')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText('Ravi')).toBeTruthy();
    expect(view.getByText(/and 4 others/)).toBeTruthy();
  });

  /**
   * **The count is the viewer's, not the actor's** (§A12), and this is where that is
   * visible: the array arrives already filtered by `follow_activity_people`, so a story the
   * actor made about five people reaches a reader who may see two as "and 1 other". A row
   * that printed the true total would promise four people the sheet then refuses to list.
   */
  it('counts only the people this reader was given', async () => {
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi'), person('Ben')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.getByText(/and 1 other$/)).toBeTruthy();
  });

  it('draws nothing at all when the reader may see nobody', async () => {
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );

    // `hydrate` drops such a row before it reaches here; this is the second lock, and it
    // matters because "Abi followed" is a sentence with a hole in it.
    expect(view.queryByText('Abi')).toBeNull();
  });
});

describe('what a tap does', () => {
  it('opens the named person from their name', async () => {
    const onPressPerson = jest.fn();
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi'), person('Ben')])}
        onPressActor={() => {}}
        onPressPerson={onPressPerson}
        onOpenList={() => {}}
      />,
    );

    await fireEvent.press(view.getByText('Ravi'));

    expect(onPressPerson).toHaveBeenCalledWith('ravi');
  });

  it('opens the list from the rest of the row, once there is a list', async () => {
    const onOpenList = jest.fn();
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi'), person('Ben')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={onOpenList}
      />,
    );

    await fireEvent.press(view.getByLabelText('Abi followed Ravi and 1 other'));

    expect(onOpenList).toHaveBeenCalled();
  });

  /**
   * A sheet listing one row the reader can already see is a modal that says nothing, so a
   * single-person story has no list to open and does not announce one. `getByLabelText`
   * would find a button that should not exist, which is what makes this the right assertion
   * rather than a press that happens not to fire.
   */
  it('offers no list on a story about one person', async () => {
    const view = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );

    expect(view.queryByLabelText(/^Abi followed Ravi/)).toBeNull();
  });
});

describe('the list of everyone', () => {
  it('lists each person with the control the relationship implies', async () => {
    mockRpcResults.follow_state_with = [
      { user_id: 'ravi-id', following: 'approved', followed_by: null, blocked: false },
      { user_id: 'ben-id', following: null, followed_by: null, blocked: false },
      { user_id: 'cy-id', following: 'pending', followed_by: null, blocked: false },
    ];

    const view = await renderWithProviders(
      <FollowStorySheet
        event={story([person('Ravi'), person('Ben'), person('Cy', { isPrivate: true })])}
        viewerId="viewer"
        onPressPerson={() => {}}
        onClose={() => {}}
      />,
    );

    expect(view.getByText('Abi followed')).toBeTruthy();
    // The controls appear once `follow_state_with` has answered — until then the sheet draws
    // skeletons rather than flashing `Follow` at somebody it is already following.
    await waitFor(() => expect(view.getByText('Following')).toBeTruthy());
    expect(view.getByText('Follow')).toBeTruthy();
    expect(view.getByText('Requested')).toBeTruthy();
    // A private member is legitimately in the list, marked, and reached by asking.
    expect(view.getByLabelText('Cy, @cy, Private')).toBeTruthy();
  });

  it('resolves the whole list in one round trip', async () => {
    await renderWithProviders(
      <FollowStorySheet
        event={story([person('Ravi'), person('Ben'), person('Cy')])}
        viewerId="viewer"
        onPressPerson={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() =>
      expect(mockRpcCalls.filter((call) => call.name === 'follow_state_with')).toHaveLength(1),
    );
  });

  it('closes before it navigates, so the profile is not opened under a sheet', async () => {
    const onPressPerson = jest.fn();
    const onClose = jest.fn();
    mockRpcResults.follow_state_with = [
      { user_id: 'ravi-id', following: null, followed_by: null, blocked: false },
    ];

    const view = await renderWithProviders(
      <FollowStorySheet
        event={story([person('Ravi')])}
        viewerId="viewer"
        onPressPerson={onPressPerson}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(view.getByLabelText('Ravi, @ravi')).toBeTruthy());
    await fireEvent.press(view.getByLabelText('Ravi, @ravi'));

    expect(onClose).toHaveBeenCalled();
    expect(onPressPerson).toHaveBeenCalledWith('ravi');
  });
});

/**
 * The row's box, against the row it sits between.
 *
 * A follow story is deliberately a *lighter* row than an activity row — fewer elements, a
 * third of the height — and for a while it was also an *unbounded* one: it carried the
 * gutters and the vertical padding but not the closing hairline, so on a device it fell into
 * the whitespace of the ranking beneath it and the feed lost its rhythm exactly where the
 * list changes subject.
 *
 * Asserted by comparing the two rows rather than against literals. The numbers are allowed
 * to change; what may not change is that they are the *same* numbers, and a test that
 * restated `theme.layout.gutter` here would go green on the day one row moved and the other
 * did not.
 */
describe('the row sits in the list the same way an activity row does', () => {
  /**
   * The row container's resolved style.
   *
   * Found by descending rather than read off `toJSON()`, because the root of a rendered
   * tree here is `SafeAreaProvider`'s own flex box — an unstyled wrapper whose padding is
   * `undefined`, which is exactly the value that makes two rows look identical to a
   * comparison while one of them is missing its rule. The row is the first box that
   * actually sets vertical padding, and both components draw that box first.
   */
  const box = (tree: unknown): ViewStyle => {
    let found: ViewStyle | undefined;
    const walk = (node: unknown) => {
      if (found || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const element = node as { props?: Record<string, unknown>; children?: unknown[] };
      const style = (StyleSheet.flatten(element.props?.style) ?? {}) as ViewStyle;
      if (typeof style.paddingVertical === 'number') {
        found = style;
        return;
      }
      (element.children ?? []).forEach(walk);
    };
    walk(tree);
    if (!found) throw new Error('no padded row container in the tree');
    return found;
  };

  /** An ordinary activity row, with only the props that are not optional. */
  const activityRow = (
    <ActivityRow
      actorName="Abi"
      verb="ranked"
      title="Sinners"
      timeLabel="5m ago"
      onPressTitle={() => {}}
    />
  );

  it('uses the same gutters, vertical padding and closing rule', async () => {
    const follow = await renderWithProviders(
      <FollowStoryRow
        event={story([person('Ravi'), person('Maya')])}
        onPressActor={() => {}}
        onPressPerson={() => {}}
        onOpenList={() => {}}
      />,
    );
    const activity = await renderWithProviders(activityRow);

    const a = box(follow.toJSON());
    const b = box(activity.toJSON());

    expect(a.paddingHorizontal).toBe(b.paddingHorizontal);
    expect(a.paddingVertical).toBe(b.paddingVertical);
    expect(a.borderBottomWidth).toBe(b.borderBottomWidth);
    expect(a.borderBottomColor).toBe(b.borderBottomColor);
    // The regression itself, stated plainly: whatever the shared number is, it is a rule
    // and not zero.
    expect(Number(a.borderBottomWidth ?? 0)).toBeGreaterThan(0);
  });
});

/**
 * The arithmetic, without a render.
 *
 * Singular and plural spelled out rather than `other(s)`, which is the convention every
 * other count in this app follows.
 */
describe('followTail', () => {
  it('says nothing about a story of one', () => {
    expect(followTail(1)).toBeNull();
  });

  it('says nothing about an empty story either', () => {
    // Not reachable — `hydrate` drops it — but a negative count reaching a template is how
    // "and -1 others" ends up on somebody's screen.
    expect(followTail(0)).toBeNull();
  });

  it('counts the others rather than the total', () => {
    expect(followTail(2)).toBe('and 1 other');
    expect(followTail(6)).toBe('and 5 others');
  });
});
