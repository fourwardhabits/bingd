import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useSocialWrites } from '@/features/profile/use-social';

import { CompanionPicker, normalise } from './CompanionPicker';
import { useTaggablePeople, type Person } from './use-companions';

/**
 * **The founder's P1, end to end** (QA, 2026-11-19): follow somebody back, open a watch's
 * "Who I watched with", and they are not there until the app restarts.
 *
 * Two causes, both asserted against the real hooks and one long-lived QueryClient — which
 * is what "without a restart" means — over a stand-in mockServer whose follow graph the RPCs
 * and the other phone actually change:
 *
 *   1. `useTaggablePeople` held its list for five minutes and `useSocialWrites.refresh()`
 *      never told it the graph had moved.
 *   2. A follow-back made on the OTHER person's phone moves nothing here at all, so the
 *      picker asks again every time it opens.
 */

const mockMe = 'user-1';
type Edge = { follower_id: string; followee_id: string };

/** The follow graph as the mockServer holds it: what every read of `follows` returns. */
let mockServer: Edge[] = [];
let mockFollowReads = 0;

const mockProfile = (id: string) => ({
  id,
  username: id === mockMe ? 'sai' : `${id}_name`,
  display_name: id === mockMe ? 'Sai' : `Person ${id}`,
  avatar_path: null,
});

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'follows') mockFollowReads += 1;
        return Promise.resolve({
          data:
            table === 'follows'
              ? mockServer.map((edge) => ({
                  ...edge,
                  follower: mockProfile(edge.follower_id),
                  followee: mockProfile(edge.followee_id),
                }))
              : [],
          error: null,
        });
      };
      for (const step of ['select', 'eq', 'in', 'or', 'order', 'limit', 'gt']) {
        chain[step] = () => chain;
      }
      chain.then = (resolve: (value: unknown) => unknown) => answer().then(resolve);
      return chain;
    },
    rpc: (name: string, args: Record<string, string>) => {
      if (name === 'follow') mockServer.push({ follower_id: mockMe, followee_id: args.p_followee_id! });
      if (name === 'unfollow') {
        mockServer = mockServer.filter((e) => !(e.follower_id === mockMe && e.followee_id === args.p_followee_id));
      }
      if (name === 'block') {
        // `block` deletes both edges between the pair.
        const them = args.p_blocked_id;
        mockServer = mockServer.filter((e) => e.follower_id !== them && e.followee_id !== them);
      }
      return Promise.resolve({ data: { status: 'ok', state: 'approved' }, error: null });
    },
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => `op-${Math.random()}` }));
jest.mock('@/features/notifications/push', () => ({ nudgePushDelivery: jest.fn() }));
jest.mock('@/features/notifications/push-permission', () => ({
  offerPushPermission: jest.fn(() => Promise.resolve()),
}));

const mutual = (id: string): Edge[] => [
  { follower_id: mockMe, followee_id: id },
  { follower_id: id, followee_id: mockMe },
];

beforeEach(() => {
  mockServer = [];
  mockFollowReads = 0;
});

/** What the hosts draw: the picker when the row is open, nothing when it is closed. */
const handle: { social?: ReturnType<typeof useSocialWrites> } = {};

function Host({ open, max = 10 }: { open: boolean; max?: number }) {
  const people = useTaggablePeople(mockMe);
  const social = useSocialWrites(mockMe, 'profile');
  useEffect(() => {
    handle.social = social;
  });
  const [selected, setSelected] = useState<string[]>([]);
  if (!open) return <Text>closed</Text>;
  return (
    <CompanionPicker
      people={people.data ?? []}
      loading={people.isPending}
      selected={selected}
      onToggle={(id) =>
        setSelected((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]))
      }
      max={max}
    />
  );
}

/** One app session: one QueryClient for the whole test, as a running app has. */
const session = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}
      >
        {node}
      </SafeAreaProvider>
    </QueryClientProvider>
  );
  const view = await render(wrap(<Host open={false} />));
  // Let the cached read land, as it would have long before the reader opened a watch.
  await waitFor(() => expect(mockFollowReads).toBeGreaterThan(0));
  return {
    view,
    open: () => view.rerender(wrap(<Host open />)),
    close: () => view.rerender(wrap(<Host open={false} />)),
  };
};

describe('the people a watch can be tagged with, without a restart', () => {
  it('a follow-back made on this phone is taggable the next time the picker opens', async () => {
    // Anna follows the reader; the reader has not followed back. Not a mutual yet.
    mockServer = [{ follower_id: 'anna', followee_id: mockMe }];
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getByText('Nobody to tag yet')).toBeTruthy());
    await app.close();

    await act(async () => {
      await handle.social!.follow({ userId: 'anna', priorState: 'none' });
    });

    await app.open();
    await waitFor(() => expect(app.view.getByLabelText('Person anna')).toBeTruthy());
  });

  it('a follow-back made on the other phone is taggable when the picker opens', async () => {
    mockServer = [{ follower_id: mockMe, followee_id: 'raj' }];
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getByText('Nobody to tag yet')).toBeTruthy());
    await app.close();

    // Raj follows back from his own phone. Nothing on this phone is told.
    mockServer.push({ follower_id: 'raj', followee_id: mockMe });

    await app.open();
    await waitFor(() => expect(app.view.getByLabelText('Person raj')).toBeTruthy());
  });

  it('an unfollow takes the person out of the picker', async () => {
    mockServer = [...mutual('anna'), ...mutual('raj')];
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getByLabelText('Person anna')).toBeTruthy());
    await app.close();

    await act(async () => {
      await handle.social!.unfollow({ userId: 'anna' });
    });

    await app.open();
    await waitFor(() => expect(app.view.queryByLabelText('Person anna')).toBeNull());
    expect(app.view.getByLabelText('Person raj')).toBeTruthy();
  });

  it('a block takes the person out of the picker', async () => {
    mockServer = [...mutual('anna'), ...mutual('raj')];
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getByLabelText('Person raj')).toBeTruthy());
    await app.close();

    await act(async () => {
      await handle.social!.block({ userId: 'raj' });
    });

    await app.open();
    await waitFor(() => expect(app.view.queryByLabelText('Person raj')).toBeNull());
    expect(app.view.getByLabelText('Person anna')).toBeTruthy();
  });
});

describe('a long list of people', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => mutual(`p${String(i).padStart(3, '0')}`)).flat();

  it('draws every mutual, searchable by name and by username', async () => {
    mockServer = many(150);
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getByLabelText('Person p149')).toBeTruthy());
    expect(app.view.getAllByRole('checkbox')).toHaveLength(150);
    expect(app.view.getByTestId('companion-list').props.showsVerticalScrollIndicator).toBe(true);

    await fireEvent.changeText(app.view.getByTestId('companion-search'), 'p14');
    expect(app.view.getAllByRole('checkbox')).toHaveLength(10);

    await fireEvent.changeText(app.view.getByTestId('companion-search'), '@p007_NAME');
    expect(app.view.getAllByRole('checkbox').map((n) => n.props.accessibilityLabel)).toEqual([
      'Person p007',
    ]);

    await fireEvent.changeText(app.view.getByTestId('companion-search'), 'nobody-like-this');
    expect(app.view.queryAllByRole('checkbox')).toHaveLength(0);
    expect(app.view.getByTestId('companion-no-match')).toBeTruthy();
  });

  it('chooses several, keeps them in view while filtered, and stops at ten', async () => {
    mockServer = many(14);
    const app = await session();
    await app.open();
    await waitFor(() => expect(app.view.getAllByRole('checkbox')).toHaveLength(14));

    for (let i = 0; i < 10; i += 1) {
      await fireEvent.press(app.view.getByLabelText(`Person p${String(i).padStart(3, '0')}`));
    }
    expect(app.view.getByTestId('companion-count').props.children).toBe('10 of 10 selected');
    expect(app.view.getByText('That is the most you can tag on one watch.')).toBeTruthy();
    // The eleventh is offered but disabled, with the reason said.
    const eleventh = app.view.getByLabelText('Person p010');
    expect(eleventh.props.accessibilityState).toMatchObject({ checked: false, disabled: true });

    // Filtered to one unchosen name: all ten chosen stay visible as chips.
    await fireEvent.changeText(app.view.getByTestId('companion-search'), 'p013');
    expect(app.view.getAllByRole('checkbox')).toHaveLength(1);
    for (let i = 0; i < 10; i += 1) {
      expect(app.view.getByLabelText(`Remove Person p${String(i).padStart(3, '0')}`)).toBeTruthy();
    }

    // Removing one from its chip frees a place.
    await fireEvent.press(app.view.getByLabelText('Remove Person p000'));
    expect(app.view.getByTestId('companion-count').props.children).toBe('9 of 10 selected');
    expect(app.view.getByLabelText('Person p013').props.accessibilityState.disabled).toBe(false);
  });
});

describe('normalise', () => {
  it('ignores case and accents', () => {
    expect(normalise('Zoë')).toBe('zoe');
    expect(normalise('  JOSÉ ')).toBe('jose');
  });
});

/** Keeps `Person` referenced so the type import documents the shape the picker takes. */
export type { Person };
