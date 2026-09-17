import { waitFor } from '@testing-library/react-native';

import type { Postgrest } from '@/test-utils/postgrest';
import { renderHookWithProviders } from '@/test-utils/render';
import { eventIds, reactionsOn } from '@/test-utils/volume';

import { useCommentCounts } from './use-comments';
import { useReactions } from './use-reactions';

/**
 * **The Feed's reactions and comment counts at the size a long scroll reaches**
 * (2026-09-16, pre-outreach hardening).
 *
 * Both hooks were one query keyed by every event loaded so far. Each page that landed was
 * a new key, so the whole list was read again, every pill and count on screen blanked
 * until it answered, and the reactions GET, an `in.(...)` list as long as the scroll,
 * stopped reaching PostgREST at about 390 ids on staging.
 *
 * The stand-in runs with the ceilings a real deployment has (`maxRows`, `maxInList`), and a
 * gate holds replies back so the moment between a page landing and its reads answering
 * can be looked at.
 */

let mockGate: Promise<void> | null = null;

jest.mock('@/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPostgrest } = require('@/test-utils/postgrest');
  const client = createPostgrest();
  (globalThis as { __pg?: unknown }).__pg = client;
  const held = <T>(answer: () => PromiseLike<T>) =>
    (mockGate ?? Promise.resolve()).then(answer);
  return {
    supabase: {
      from: (table: string) => {
        const chain = client.from(table) as { then: (resolve: (v: unknown) => unknown) => unknown };
        const serve = chain.then;
        chain.then = (resolve) => held(() => serve(resolve) as PromiseLike<unknown>);
        return chain;
      },
      rpc: (name: string, args: Record<string, unknown>) => held(() => client.rpc(name, args)),
    },
    startSessionRefresh: () => () => {},
  };
});

const pg = () => (globalThis as unknown as { __pg: Postgrest }).__pg;

const VIEWER = 'viewer';
const PAGE = 20;
const ALL = eventIds(400);

let shown: string[] = [];

const openGate = () => {
  let release = () => {};
  mockGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    mockGate = null;
    release();
  };
};

const reactionReads = () => pg().reads.filter((read) => read.table === 'reactions');

beforeEach(() => {
  const client = pg();
  client.reads.length = 0;
  client.rpcCalls.length = 0;
  client.requests = {};
  client.tables.reactions = reactionsOn(ALL, 3);
  client.rpcAnswers = {};
  client.maxRows = 1000;
  client.maxInList = null;
  mockGate = null;
  shown = [];
});

describe('reactions on a Feed that keeps loading pages', () => {
  it('reads each event once while the list grows to 400, and never past the URL ceiling', async () => {
    pg().maxInList = 390;
    shown = ALL.slice(0, PAGE);
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    for (let pages = 2; pages * PAGE <= ALL.length; pages += 1) {
      shown = ALL.slice(0, pages * PAGE);
      await view.rerender(undefined);
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    }

    const sizes = reactionReads().map((read) => read.in[0]?.[1] ?? 0);
    // One read per page, each the page's own twenty. The single query read 20 + 40 + … + 400.
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(ALL.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PAGE);
    expect(view.result.current.isError).toBe(false);

    // And nothing was cut by the row cap: 1,200 reactions in all, every one counted.
    const data = view.result.current.data!;
    expect(data.size).toBe(ALL.length);
    expect([...data.values()].every((summary) => summary.total === 3)).toBe(true);
  });

  it('keeps the reactions already on screen while the next page’s are read', async () => {
    shown = ALL.slice(0, PAGE);
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    const release = openGate();
    shown = ALL.slice(0, PAGE * 2);
    await view.rerender(undefined);

    // The first page is still drawn, and the new rows are known to be unread.
    expect(view.result.current.data?.get(ALL[0]!)?.total).toBe(3);
    expect(view.result.current.data?.get(ALL[PAGE]!)).toBeUndefined();
    expect(view.result.current.isSuccess).toBe(false);

    release();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data?.get(ALL[PAGE]!)?.total).toBe(3);
    // The first page was not read a second time.
    expect(reactionReads()).toHaveLength(2);
  });

  it('does not blank the rows above a short page when the chunks shift under them', async () => {
    // A page can hold fewer than twenty (own follow stories are dropped after the read).
    shown = ALL.slice(0, 15);
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    const release = openGate();
    shown = ALL.slice(0, 35);
    await view.rerender(undefined);

    // The first chunk's key changed (15 ids to 20), so it has no answer of its own yet.
    // What the reader was already looking at stays drawn, and is not reported as settled.
    expect(view.result.current.data?.get(ALL[0]!)?.total).toBe(3);
    expect(view.result.current.data?.get(ALL[14]!)?.total).toBe(3);
    expect(view.result.current.isSuccess).toBe(false);
    expect(view.result.current.isPending).toBe(true);

    release();
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data?.size).toBe(35);
  });

  it('forgets a reaction that was removed, rather than keeping a borrowed one', async () => {
    shown = ALL.slice(0, 15);
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    // Every reaction on the first event is taken back, then the list grows.
    pg().tables.reactions = reactionsOn(ALL.slice(1), 3);
    shown = ALL.slice(0, 35);
    await view.rerender(undefined);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    expect(view.result.current.data?.get(ALL[0]!)).toBeUndefined();
    expect(view.result.current.data?.get(ALL[1]!)?.total).toBe(3);
  });

  it('refreshes every chunk when a write invalidates the viewer’s reactions', async () => {
    shown = ALL.slice(0, PAGE * 3);
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(reactionReads()).toHaveLength(3);

    // `useSetReaction` reconciles with exactly this prefix.
    await view.client.invalidateQueries({ queryKey: ['reactions', VIEWER] });
    await waitFor(() => expect(reactionReads()).toHaveLength(6));
  });

  it('reports nothing settled before there is anything to ask about', async () => {
    shown = [];
    const view = await renderHookWithProviders(() => useReactions(shown, VIEWER));
    // `app/activity/[id].tsx` draws a count only once this is true, and passes no ids
    // until the activity itself has resolved.
    expect(view.result.current.isSuccess).toBe(false);
    expect(view.result.current.data).toBeUndefined();
    expect(reactionReads()).toHaveLength(0);
  });
});

describe('comment counts on a Feed that keeps loading pages', () => {
  it('asks for each page’s events once rather than the whole list again', async () => {
    shown = ALL.slice(0, PAGE);
    const view = await renderHookWithProviders(() => useCommentCounts(shown, VIEWER));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));

    for (let pages = 2; pages <= 5; pages += 1) {
      shown = ALL.slice(0, pages * PAGE);
      await view.rerender(undefined);
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    }

    const asked = pg()
      .rpcCalls.filter((call) => call.name === 'activity_comment_counts')
      .map((call) => (call.args.p_feed_event_ids as string[]).length);
    expect(asked).toEqual([PAGE, PAGE, PAGE, PAGE, PAGE]);
  });
});
